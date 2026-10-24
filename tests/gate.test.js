/**
 * Gate tests: the two layers wired into one listener, including the `ask`/`never`
 * fork, the truncation retry, and the failure policy. No DSH and no network.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createReviewGate, DENIED_ERROR_CODE, DENIED_ERROR_NAME } from '../lib/gate.js'
import { BlockAssembler } from '../lib/block-assembler.js'
import { resolveConfig } from '../lib/config.js'

const ENVIRONMENT = { home: 'C:\\Users\\28055', dshHome: 'C:\\Users\\28055\\.dsh', platform: 'win32' }
const CWD = 'D:\\pyproject\\paper-forecast'

/** A scripted reviewer response. */
function reply(text) {
  return async function* stream() {
    yield { type: 'text-delta', text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A reviewer that ran out of output budget. */
async function* truncated() {
  yield { type: 'text-delta', text: '{"risk":"hi' }
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

/** A reviewer that failed outright. */
async function* broken() {
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'E', message: 'provider exploded' } } }
}

/**
 * Build a handler over a fake host.
 *
 * @param {object} options - `{ settings, replies, policy, active, next }`.
 */
function harness(options = {}) {
  const config = resolveConfig(options.settings ?? {}, ENVIRONMENT)
  const requests = []
  const audit = []
  const replies = [...(options.replies ?? [])]
  let policy = options.policy ?? 'ask'
  let active = options.active ?? true
  let contextCalls = 0
  let factsCalls = 0

  const agent = options.agent ?? { session: { id: 'session-abc', header: { cwd: CWD, origin: 'human' } } }

  const gate = createReviewGate({
    getConfig: () => config,
    isActive: () => active,
    approvalPolicy: () => policy,
    runCodeName: 'run_code',
    createAssembler: () => new BlockAssembler(),
    streamReview: (request) => {
      requests.push(request)
      const next = replies.shift()
      if (next === undefined) throw new Error('no scripted reviewer reply left')
      return next(request)
    },
    sessionFacts: () => {
      factsCalls += 1
      return {
        cwd: CWD,
        workspaceRoot: CWD,
        sessionId: 'session-abc',
        headerConfig: options.headerConfig ?? { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
      }
    },
    reviewContext: () => {
      contextCalls += 1
      return { events: options.events ?? [], advertisedEfforts: options.advertisedEfforts }
    },
    audit: { record: (entry) => audit.push(entry) },
  })

  return {
    handler: gate.handler,
    guard: gate.guard,
    requests,
    audit,
    agent,
    contextCalls: () => contextCalls,
    factsCalls: () => factsCalls,
    setPolicy: (value) => { policy = value },
    setActive: (value) => { active = value },
  }
}

/** Call the handler with a tool call. */
function invoke(handler, name, args, options = {}) {
  // `agent: undefined` must stay undefined rather than fall back to the default:
  // one case asserts the agentless path is left alone.
  const agent = 'agent' in options ? options.agent : { session: { id: 'session-abc', header: { cwd: CWD, origin: 'human' } } }
  const execution = {
    name,
    arguments: args,
    agent,
    parent: options.parent,
    signal: options.signal ?? new AbortController().signal,
  }
  const next = options.next ?? (async () => ({ kind: 'allow' }))
  return handler(execution, next)
}

// ---------------------------------------------------------------------------
// Layer 1 short-circuits
// ---------------------------------------------------------------------------

test('a rule that allows skips the reviewer entirely', async () => {
  const h = harness()
  const decision = await invoke(h.handler, 'pwsh', { command: 'git status --short' })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(h.requests.length, 0)
  assert.equal(h.audit.length, 1)
  assert.equal(h.audit[0].layer, 1)
  assert.equal(h.audit[0].rule, 'literal-read-only-shell')
})

test('a rule that denies never calls the reviewer and carries structured error info', async () => {
  const h = harness()
  const decision = await invoke(h.handler, 'pwsh', { command: 'Remove-Item -Recurse -Force C:\\Users\\28055\\.dsh' })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.name, DENIED_ERROR_NAME)
  assert.equal(decision.info.code, DENIED_ERROR_CODE)
  assert.equal(h.requests.length, 0)
  assert.equal(h.audit[0].verdict, 'deny')
})

test('the gate stands aside for the outer run_code transport', async () => {
  const h = harness()
  assert.deepEqual(await invoke(h.handler, 'run_code', { code: 'x' }), { kind: 'allow' })
  assert.equal(h.audit.length, 0)
})

test('the gate stands aside when it is not active for this session', async () => {
  const h = harness({ active: false })
  assert.deepEqual(await invoke(h.handler, 'pwsh', { command: 'npm run build' }), { kind: 'allow' })
  assert.equal(h.audit.length, 0)
})

test('a disabled plugin stands aside and an agentless call is left alone', async () => {
  const h = harness({ settings: { enabled: false } })
  assert.deepEqual(await invoke(h.handler, 'pwsh', { command: 'npm run build' }), { kind: 'allow' })
  assert.equal(h.requests.length, 0)

  const h2 = harness()
  assert.deepEqual(await invoke(h2.handler, 'pwsh', { command: 'npm run build' }, { agent: undefined }), { kind: 'allow' })
  assert.equal(h2.requests.length, 0)
})

test('an already-aborted call is cancelled rather than reviewed', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  assert.deepEqual(await invoke(h.handler, 'pwsh', { command: 'npm run build' }, { signal: controller.signal }), { kind: 'cancel' })
  assert.equal(h.requests.length, 0)
})

// ---------------------------------------------------------------------------
// Layer 2 decisions
// ---------------------------------------------------------------------------

test('an escalation reaches the reviewer on the inherited route with the session id', async () => {
  const h = harness({ replies: [reply('{"risk":"low","decision":"allow"}')] })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].provider, 'opencode-go')
  assert.equal(h.requests[0].model, 'deepseek-v4.1-flash')
  assert.equal(h.requests[0].sessionId, 'session-abc')
  assert.match(h.requests[0].messages[0].content[0].text, /PENDING_ACTION/)
  assert.equal(h.audit[0].layer, 2)
  assert.equal(h.audit[0].verdict, 'allow')
})

test('a reviewer refusal becomes a prompt under the ask policy', async () => {
  const h = harness({ replies: [reply('{"risk":"medium","decision":"deny","reason":"wipes a pre-existing store"}')] })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run clean' })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /wipes a pre-existing store/)
  assert.equal(typeof decision.displayReason.en, 'string')
  assert.equal(typeof decision.displayReason.zh, 'string')
  assert.match(decision.displayReason.zh, /双层自动审核/)
})

test('a reviewer refusal is final under the never policy', async () => {
  const h = harness({ replies: [reply('{"risk":"medium","decision":"deny"}')], policy: 'never' })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run clean' })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, DENIED_ERROR_CODE)
})

test('a refusal inside an in-process child is final regardless of policy', async () => {
  const h = harness({ replies: [reply('{"risk":"medium","decision":"deny"}')] })
  const child = { session: { id: 'session-child', header: { cwd: CWD, origin: 'subagent' } } }
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run clean' }, { agent: child })
  assert.equal(decision.kind, 'deny')
})

test('a high-risk refusal cannot be downgraded by a later listener', async () => {
  const h = harness({ replies: [reply('{"risk":"high","decision":"deny","reason":"credentials to an external host"}')] })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run send' })
  assert.equal(decision.kind, 'ask')
  // A downstream refusal wins over the prompt this gate would have raised.
  const h2 = harness({ replies: [reply('{"risk":"medium","decision":"deny"}')] })
  const downstream = await invoke(h2.handler, 'pwsh', { command: 'npm run clean' }, { next: async () => ({ kind: 'deny', reason: 'sandbox says no' }) })
  assert.deepEqual(downstream, { kind: 'deny', reason: 'sandbox says no' })
})

// ---------------------------------------------------------------------------
// Truncation and failure policy
// ---------------------------------------------------------------------------

test('a truncated review is retried with a doubled budget', async () => {
  const h = harness({ replies: [truncated, reply('{"risk":"low","decision":"allow"}')] })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.deepEqual(decision, { kind: 'allow' })
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[0].maxTokens, 8192)
  assert.equal(h.requests[1].maxTokens, 16384)
})

test('a truncation that never resolves follows the failure policy', async () => {
  const h = harness({ replies: [truncated, truncated, truncated] })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /ran out of output budget/)
  assert.equal(h.requests.length, 3)
  assert.equal(h.audit[0].rule, 'reviewer-truncated')

  const strict = harness({ replies: [truncated, truncated, truncated], settings: { review: { onError: 'deny' } } })
  const denied = await invoke(strict.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(denied.kind, 'deny')
})

test('a reviewer failure asks the human by default and denies when configured', async () => {
  const h = harness({ replies: [broken] })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /provider exploded/)
  assert.equal(h.audit[0].verdict, 'fail-ask')

  const strict = harness({ replies: [broken], settings: { review: { onError: 'deny' } } })
  const denied = await invoke(strict.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(denied.kind, 'deny')
  assert.equal(strict.audit[0].verdict, 'fail-closed')
})

test('a failure under the never policy is closed even with onError ask', async () => {
  const h = harness({ replies: [broken], policy: 'never' })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(decision.kind, 'deny')
})

test('a session with no route cannot be reviewed, and fails per policy', async () => {
  const h = harness({ headerConfig: { provider: '', model: '' } })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /no reviewer model is available/)
  assert.equal(h.requests.length, 0)
})

test('an action too large to describe is never judged from a truncation', async () => {
  const h = harness({ settings: { review: { maxActionChars: 50 } } })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run build --flag ' + 'x'.repeat(500) })
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /too large to describe/)
  assert.equal(h.requests.length, 0)
})

test('a refusal reason is carried into the model-facing message', async () => {
  const h = harness({ replies: [reply('{"risk":"high","decision":"deny","reason":"exfiltration"}')], policy: 'never' })
  const decision = await invoke(h.handler, 'pwsh', { command: 'npm run send' })
  assert.match(decision.reason, /exfiltration/)
  assert.match(decision.reason, /body was not executed/)
})

test('the configured reviewer model overrides the conversation route', async () => {
  const h = harness({
    replies: [reply('{"risk":"low","decision":"allow"}')],
    settings: { review: { provider: 'local', model: 'tiny', reasoningEffort: 'low' } },
  })
  await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(h.requests[0].provider, 'local')
  assert.equal(h.requests[0].model, 'tiny')
  assert.equal(h.requests[0].reasoningEffort, 'low')
})

test('the reviewer effort defaults to the lowest advertised level', async () => {
  const h = harness({ replies: [reply('{"risk":"low","decision":"allow"}')], advertisedEfforts: ['max', 'medium', 'low'] })
  await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(h.requests[0].reasoningEffort, 'low')
})

// ---------------------------------------------------------------------------
// Lazy context and the hard floor
// ---------------------------------------------------------------------------

test('rule decisions never read the session event log', async () => {
  const h = harness()
  await invoke(h.handler, 'pwsh', { command: 'git status --short' })
  assert.equal(h.contextCalls(), 0)
  await invoke(h.handler, 'pwsh', { command: 'Remove-Item -Recurse -Force C:\\Users\\28055\\.dsh' })
  assert.equal(h.contextCalls(), 0)
})

test('an oversized action and a routeless session also skip the event log', async () => {
  const large = harness({ settings: { review: { maxActionChars: 50 } } })
  await invoke(large.handler, 'pwsh', { command: 'npm run build --flag ' + 'x'.repeat(500) })
  assert.equal(large.contextCalls(), 0)

  const routeless = harness({ headerConfig: { provider: '', model: '' } })
  await invoke(routeless.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(routeless.contextCalls(), 0)
})

test('a reviewed call reads the event log exactly once', async () => {
  const h = harness({ replies: [reply('{"risk":"low","decision":"allow"}')] })
  await invoke(h.handler, 'pwsh', { command: 'npm run build' })
  assert.equal(h.contextCalls(), 1)
})

test('the hard floor skips what the listener decided and still denies the rest', async () => {
  const h = harness({ replies: [reply('{"risk":"low","decision":"allow"}')] })
  const execution = {
    name: 'pwsh',
    arguments: { command: 'npm run build' },
    agent: h.agent,
    parent: undefined,
    signal: new AbortController().signal,
  }
  await h.handler(execution, async () => ({ kind: 'allow' }))
  const factsAfterHandler = h.factsCalls()
  assert.equal(h.guard(execution), undefined)
  assert.equal(h.factsCalls(), factsAfterHandler, 'the guard must not re-evaluate a decided execution')

  const unseen = { ...execution, arguments: { command: 'format C:' } }
  assert.match(h.guard(unseen), /formats a volume/)
  assert.equal(h.factsCalls(), factsAfterHandler + 1)
})

test('the hard floor stands aside when the plugin is disabled', () => {
  const h = harness({ settings: { enabled: false } })
  const execution = { name: 'pwsh', arguments: { command: 'format C:' }, agent: h.agent, parent: undefined }
  assert.equal(h.guard(execution), undefined)
})
