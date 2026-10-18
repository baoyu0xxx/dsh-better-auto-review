/**
 * The gate: layer 1 and layer 2 wired into one `tools/pre-execute` listener.
 *
 * Deliberately free of any DSH import. Every host fact arrives through the
 * `deps` object, so the entire decision path — including the `ask`/`never`
 * fork and the failure policy — is exercised by `node --test` with a fake
 * context, and `lib/index.js` stays a thin adapter.
 *
 * @module dsh-better-auto-review/gate
 */
import { ALLOW, DENY, ESCALATE, evaluate } from './engine.js'
import { TruncatedReviewError, budgetForAttempt, buildRequest, collectHistory, describeAction, readDecision, renderUserText, resolveReasoningEffort, resolveRoute } from './reviewer.js'

/** Structured error identity for every final denial this gate makes. */
export const DENIED_ERROR_NAME = 'BetterAutoReviewDeniedError'
export const DENIED_ERROR_CODE = 'BETTER_AUTO_REVIEW_DENIED'

/** The model-facing denial text. */
function denial(reason) {
  return `Better auto review rejected this call; its body was not executed${reason === undefined ? '' : `: ${reason}`}`
}

/** The UI copy shown when a refusal is handed to the human. */
function askDecision(reason) {
  return {
    kind: 'ask',
    reason: reason === undefined ? 'Better auto review denied this call' : `Better auto review denied this call: ${reason}`,
    displayReason: {
      en: reason === undefined ? 'Better auto review denied this call.' : `Better auto review denied this call: ${reason}`,
      zh: reason === undefined ? '双层自动审核拒绝了此调用。' : `双层自动审核拒绝了此调用：${reason}`,
    },
  }
}

/** A final, non-negotiable refusal. */
function finalDenial(reason) {
  return {
    kind: 'deny',
    reason: denial(reason),
    info: { name: DENIED_ERROR_NAME, code: DENIED_ERROR_CODE, ...(reason === undefined ? {} : { reason }) },
  }
}

/** Whether a session pins the `never` policy, which makes a refusal final. */
export function deniesFinal(deps, agent) {
  if (agent?.session?.header?.origin === 'subagent') return true
  return deps.approvalPolicy(agent) === 'never'
}

/**
 * Build the `tools/pre-execute` listener.
 *
 * @param {object} deps - the host facts and effectful seams.
 * @param {() => object} deps.getConfig - the resolved configuration.
 * @param {(agent: object) => boolean} deps.isActive - whether the gate should
 *   run for this agent at all (the preset test, plus `gate.mode`).
 * @param {(agent: object) => string} deps.approvalPolicy - `'ask'` or `'never'`.
 * @param {(request: object) => AsyncIterable<object>} deps.streamReview
 *   - `ctx.llm.stream`.
 * @param {() => object} deps.createAssembler - factory for a `BlockAssembler`.
 * @param {(agent: object, execution: object) => object} deps.buildContext
 *   - `{ cwd, workspaceRoot, sessionId, headerConfig, advertisedEfforts,
 *     projectInstructions, historyEvents }`.
 * @param {object} [deps.audit] - the audit sink.
 * @param {() => number} [deps.now] - monotonic clock, for the log.
 * @returns {(execution: object, next: Function) => Promise<object>}
 */
export function createPreExecuteHandler(deps) {
  const now = deps.now ?? (() => Date.now())

  return async function preExecute(execution, next) {
    const config = deps.getConfig()
    if (config.enabled !== true) return next()

    const agent = execution?.agent
    // Without an agent there is no session to attribute a review to, and no way
    // to route an `ask`; the call keeps whatever policy already governs it.
    if (agent === undefined || agent === null) return next()
    // The outer `run_code` transport is the PTC program itself, not a tool call
    // the reviewer can reason about; its inner calls are reviewed individually.
    if (deps.runCodeName !== undefined && execution.parent === undefined && execution.name === deps.runCodeName) return next()
    if (!deps.isActive(agent)) return next()

    if (execution.signal?.aborted === true) return { kind: 'cancel' }

    const startedAt = now()
    const facts = deps.buildContext(agent, execution)
    const rulesStarted = now()
    const verdict = evaluate(
      { toolName: execution.name, args: execution.arguments },
      { config, cwd: facts.cwd, workspaceRoot: facts.workspaceRoot },
    )
    const ruleMs = now() - rulesStarted

    if (verdict.verdict === ALLOW) {
      deps.audit?.record({ session: facts.sessionId, tool: execution.name, layer: 1, verdict: 'allow', rule: verdict.ruleId, reason: verdict.reason, ruleMs })
      return next()
    }

    if (verdict.verdict === DENY) {
      deps.audit?.record({ session: facts.sessionId, tool: execution.name, layer: 1, verdict: 'deny', rule: verdict.ruleId, reason: verdict.reason, ruleMs })
      return finalDenial(verdict.reason)
    }

    // ---- layer 2 ---------------------------------------------------------
    const action = describeAction({ toolName: execution.name, args: execution.arguments }, config.review)
    if (action.truncated) {
      return failOpenOrClosed(deps, execution, next, agent, facts, config, {
        rule: 'action-too-large',
        reason: 'the pending call is too large to describe to the reviewer in full, and a truncated action cannot be judged',
        startedAt,
      })
    }

    const route = resolveRoute({ headerConfig: facts.headerConfig, settings: config.review })
    if (route.provider.length === 0 || route.model.length === 0) {
      return failOpenOrClosed(deps, execution, next, agent, facts, config, {
        rule: 'no-route',
        reason: 'no reviewer model is available: the session header carries no provider/model and none is configured',
        startedAt,
      })
    }

    const history = collectHistory(facts.historyEvents, config.review)
    const projectInstructions = facts.projectInstructions ?? []
    const effort = resolveReasoningEffort({ configured: config.review.reasoningEffort, advertised: facts.advertisedEfforts })

    let lastError = null
    for (let attempt = 0; attempt <= config.review.tokenLimitRetries; attempt += 1) {
      const budget = budgetForAttempt({ attempt, maxTokens: config.review.maxTokens, maxTokensLimit: config.review.maxTokensLimit })
      const controller = new AbortController()
      const signals = [execution.signal, controller.signal].filter((signal) => signal !== undefined)
      const timer = setTimeout(() => controller.abort(new Error('review timeout')), config.review.timeoutMs)

      try {
        const request = buildRequest({
          route,
          userText: renderUserText({ cwd: facts.cwd, projectInstructions, history, action: action.action }),
          maxTokens: budget,
          sessionId: facts.sessionId,
          reasoningEffort: effort,
          temperature: config.review.temperature,
          signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
        })
        const decision = await readDecision(deps.streamReview(request), deps.createAssembler)
        clearTimeout(timer)

        const modelMs = now() - startedAt
        if (decision.decision === 'allow') {
          deps.audit?.record({ session: facts.sessionId, tool: execution.name, layer: 2, verdict: 'allow', risk: decision.risk, model: `${route.provider}/${route.model}`, inherited: route.inherited, attempt, ruleMs, modelMs })
          return next()
        }

        if (deniesFinal(deps, agent)) {
          deps.audit?.record({ session: facts.sessionId, tool: execution.name, layer: 2, verdict: 'deny-final', risk: decision.risk, reason: decision.reason, model: `${route.provider}/${route.model}`, attempt, ruleMs, modelMs })
          return finalDenial(decision.reason)
        }

        // Under `ask` the reviewer's refusal becomes a real prompt; if a later
        // listener already refuses or cancels, that stronger outcome wins.
        const downstream = await next()
        deps.audit?.record({ session: facts.sessionId, tool: execution.name, layer: 2, verdict: 'ask', risk: decision.risk, reason: decision.reason, model: `${route.provider}/${route.model}`, attempt, ruleMs, modelMs })
        if (downstream.kind !== 'allow') return downstream
        return askDecision(decision.reason)
      } catch (error) {
        clearTimeout(timer)
        lastError = error
        if (error instanceof TruncatedReviewError && attempt < config.review.tokenLimitRetries) continue
        break
      }
    }

    return failOpenOrClosed(deps, execution, next, agent, facts, config, {
      rule: lastError instanceof TruncatedReviewError ? 'reviewer-truncated' : 'reviewer-failed',
      reason: lastError === null ? 'the reviewer produced no decision' : `the reviewer failed: ${lastError.message}`,
      startedAt,
    })
  }
}

/**
 * Apply `review.onError` to a review that could not produce an answer.
 *
 * The default is `ask`: a review that did not happen must reach the human, never
 * pass silently. Under the `never` policy `ask` itself degrades to a denial, so
 * the failure direction stays safe either way.
 */
async function failOpenOrClosed(deps, execution, next, agent, facts, config, detail) {
  const deny = config.review.onError === 'deny' || deniesFinal(deps, agent)
  const elapsed = detail.startedAt === undefined ? undefined : (deps.now ?? (() => Date.now()))() - detail.startedAt
  deps.audit?.record({
    session: facts.sessionId,
    tool: execution.name,
    layer: 2,
    verdict: deny ? 'fail-closed' : 'fail-ask',
    rule: detail.rule,
    reason: detail.reason,
    ...(elapsed === undefined ? {} : { modelMs: elapsed }),
  })
  if (deny) return finalDenial(detail.reason)
  const downstream = await next()
  if (downstream.kind !== 'allow') return downstream
  return askDecision(detail.reason)
}

export { ALLOW, DENY, ESCALATE }
