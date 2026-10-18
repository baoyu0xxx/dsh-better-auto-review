/**
 * DSH adapter for `dsh-better-auto-review`.
 *
 * This file is the ONLY place that knows about DSH. It resolves host services,
 * reads the live session facts the gate needs, exposes the management page's
 * HTTP surface, and hands everything else to the pure modules:
 *
 *   engine.js    layer 1 — deterministic rules, microseconds, every call
 *   reviewer.js  layer 2 — the LLM reviewer, pure logic + an injected stream
 *   gate.js      the two layers wired into one decision
 *   config.js    the configuration surface and its validation
 *   audit.js     the decision log
 *
 * Host facts confirmed against the shipped
 * `@deepseek-ai/dsh-experimental-auto-review` (extracted from `app.asar`) are
 * marked "native:" where they matter, because getting one of these wrong fails
 * silently rather than loudly.
 *
 * @module dsh-better-auto-review
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RUN_CODE_NAME } from '@deepseek-ai/dsh-tools'
import zs from '@deepseek-ai/schemastery'

import { createAudit } from './audit.js'
import { createDefaults, createSettingsSchema, resolveConfig } from './config.js'
import { HARD_DENY_RULES, evaluate } from './engine.js'
import { createPreExecuteHandler } from './gate.js'
import { collectProjectInstructions } from './reviewer.js'

export const name = 'better-auto-review'

/** native: the exact service set the shipped Auto review waits for. */
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools']

const NAMESPACE = 'better-auto-review'
const VERSION = '0.1.0'

/** Run a host accessor that may throw, returning a fallback instead. */
function safe(fn, fallback) {
  try {
    const value = fn()
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** The environment the config defaults are derived from. */
function environment() {
  return {
    home: safe(() => homedir(), ''),
    dshHome: safe(() => dshHomePath(), ''),
    platform: process.platform,
  }
}

/**
 * Install the gate, the settings namespace, the management routes and `/bar`.
 *
 * @param {object} ctx - the cordis context.
 * @param {object} [rowConfig] - the `cordis.patch.yml` row config, if any.
 */
export function apply(ctx, rowConfig) {
  const env = environment()
  const defaults = createDefaults(env)

  let resolved = resolveConfig(rowConfig ?? {}, env)
  let scope = null

  const auditDirectory = safe(() => join(dshHomePath('plugin-state'), NAMESPACE), null)
  const audit = createAudit({ directory: auditDirectory, config: resolved.audit })

  const log = (message, error) => console.warn(`[${NAMESPACE}] ${message}`, error?.message ?? '')

  /** Adopt one full config object and keep the audit sink in step. */
  const adopt = (value) => {
    resolved = resolveConfig(value ?? {}, env)
    audit.configure(resolved.audit)
  }

  // ---- settings namespace ------------------------------------------------
  // native-analogue: `settings` publishes asynchronously, so it must be reached
  // through an injection edge. `ctx.get('settings')` at apply time returns
  // undefined and the registration is silently skipped (dsh-rtk hit exactly
  // this: every write answered 503 "settings unavailable").
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (settings === undefined) return
    try {
      scope = settings.register(NAMESPACE, createSettingsSchema(zs, env), { applies: 'live' })
      adopt({ ...(rowConfig ?? {}), ...scope.get() })
      scope.watch((next) => adopt({ ...(rowConfig ?? {}), ...next }))
    } catch (error) {
      log('settings namespace registration failed:', error)
    }
  })

  // ---- whether the gate runs for one session -----------------------------
  const isActive = (agent) => {
    if (resolved.enabled !== true) return false
    if (resolved.gate.mode === 'always') return true
    // native: activation is the preset key, so a session that never selects the
    // preset is untouched and installing this plugin changes nothing.
    return safe(() => ctx.permissionPresets.current(agent.session) === resolved.gate.preset, false)
  }

  // ---- session facts for one decision ------------------------------------
  const buildContext = (agent, execution) => {
    const session = agent.session
    const events = safe(() => session.snapshotEvents(), [])
    const header = safe(() => session.requestHeader(), undefined)
    const cwd = safe(() => session.header.cwd, '') || process.cwd()
    return {
      cwd,
      workspaceRoot: cwd,
      sessionId: safe(() => session.id, ''),
      // native: the reviewer route comes from the session's own request header.
      headerConfig: header?.config ?? {},
      advertisedEfforts: undefined,
      projectInstructions: collectProjectInstructions(events, resolved.review),
      historyEvents: events,
    }
  }

  const handler = createPreExecuteHandler({
    getConfig: () => resolved,
    isActive,
    approvalPolicy: (agent) => safe(() => ctx.approval.overrideOf(agent.session), 'ask'),
    runCodeName: RUN_CODE_NAME,
    createAssembler: () => new BlockAssembler(),
    streamReview: (request) => ctx.llm.stream(request),
    buildContext,
    audit,
  })

  // ---- the synchronous hard floor ----------------------------------------
  // A waterfall listener can be pre-empted by another plugin's prepended
  // listener; `tools.guard` cannot. It re-runs only the deny rules, and only
  // when the gate is active for this session, so it never widens or surprises.
  const guard = (execution) => {
    if (resolved.enabled !== true || resolved.rules.hardDeny === false) return undefined
    const agent = execution?.agent
    if (agent === undefined || agent === null) return undefined
    if (execution.parent === undefined && execution.name === RUN_CODE_NAME) return undefined
    if (!isActive(agent)) return undefined
    const facts = buildContext(agent, execution)
    const verdict = evaluate(
      { toolName: execution.name, args: execution.arguments },
      { config: resolved, cwd: facts.cwd, workspaceRoot: facts.workspaceRoot },
    )
    return verdict.verdict === 'deny' ? verdict.reason : undefined
  }

  let accepting = true
  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', async (execution, next) => (accepting ? handler(execution, next) : { kind: 'cancel' }), { prepend: true })

    if (typeof ctx.tools?.guard === 'function') {
      try {
        const dispose = ctx.tools.guard(guard)
        if (typeof dispose === 'function') yield dispose
      } catch (error) {
        log('tools.guard registration failed:', error)
      }
    }

    yield () => {
      accepting = false
    }
  }, `${NAMESPACE} lifecycle`)

  // ---- management page routes --------------------------------------------
  // Reached through an injection edge, NOT `ctx.get('webServer')`. Services
  // publish asynchronously, so a `get` at apply time can return undefined and
  // the whole management surface would silently never register — the failure
  // dsh-rtk documents for `settings` (every write answered 503 "settings
  // unavailable"). The edge also keeps `webServer` from being a hard
  // requirement of this plugin.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined) return
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const readBody = async (req) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      return JSON.parse(raw.length > 0 ? raw : '{}')
    }
    const register = (path, handlerFn) => {
      try {
        webServer.register({ kind: 'exact', path, handler: handlerFn })
      } catch (error) {
        log(`route ${path} registration failed:`, error)
      }
    }

    register('/better-auto-review/state', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' })
      send(res, 200, {
        ok: true,
        version: VERSION,
        namespace: NAMESPACE,
        preset: resolved.gate.preset,
        settingsAvailable: scope !== null,
        auditPath: audit.path,
        config: resolved,
        defaults,
        hardDenyRules: HARD_DENY_RULES.map((rule) => ({ id: rule.id, why: rule.why })),
        stats: audit.stats,
      })
    })

    // The page is the source of truth for edits, but validation stays here: the
    // client cannot persist a shape the engine would misread.
    register('/better-auto-review/config', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      let body = null
      try {
        body = await readBody(req)
      } catch {
        return send(res, 400, { ok: false, error: 'body must be JSON' })
      }
      const next = resolveConfig(body?.config ?? {}, env)
      if (scope === null) return send(res, 503, { ok: false, error: 'settings unavailable' })
      try {
        await scope.update(next)
      } catch (error) {
        return send(res, 500, { ok: false, error: `persist failed: ${error?.message ?? error}` })
      }
      adopt({ ...(rowConfig ?? {}), ...(scope.get() ?? next) })
      return send(res, 200, { ok: true, config: resolved })
    })

    register('/better-auto-review/reset', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      if (scope === null) return send(res, 503, { ok: false, error: 'settings unavailable' })
      try {
        await scope.update(defaults)
      } catch (error) {
        return send(res, 500, { ok: false, error: `persist failed: ${error?.message ?? error}` })
      }
      adopt({ ...(rowConfig ?? {}), ...(scope.get() ?? defaults) })
      return send(res, 200, { ok: true, config: resolved })
    })

    register('/better-auto-review/audit', async (req, res) => {
      if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' })
      const limit = safe(() => Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 50, 50)
      send(res, 200, { ok: true, path: audit.path, entries: audit.read(Math.min(500, Math.max(1, limit))) })
    })

    // A dry run of layer 1 only: nothing is executed and the reviewer is never
    // called, so the management page can show exactly which rule would fire.
    register('/better-auto-review/check', async (req, res) => {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' })
      let body = null
      try {
        body = await readBody(req)
      } catch {
        return send(res, 400, { ok: false, error: 'body must be JSON' })
      }
      const command = typeof body?.command === 'string' ? body.command : ''
      if (command.trim().length === 0) return send(res, 400, { ok: false, error: 'command must be a non-empty string' })
      const verdict = evaluate({ toolName: 'pwsh', args: { command } }, { config: resolved, cwd: process.cwd(), workspaceRoot: process.cwd() })
      return send(res, 200, { ok: true, verdict: verdict.verdict, rule: verdict.ruleId, reason: verdict.reason })
    })
  })

  // ---- /bar command ------------------------------------------------------
  ctx.inject(['commands'], (commandCtx) => {
    const commands = commandCtx.commands
    if (commands === undefined) return
    try {
      commands.register({
        name: 'bar',
        description: 'Better auto review: status, on/off, gate mode, a rules-only dry check',
        input: { hint: '[on|off|always|preset|check <command>|audit [n]]' },
        handler: (invocation) => {
          const raw = String(invocation?.rawInput ?? '').trim()
          const [verb, ...rest] = raw.split(/\s+/)
          const tail = rest.join(' ')

          if (verb === '' || verb === 'status') {
            return {
              kind: 'success',
              text: [
                `${NAMESPACE} ${VERSION}`,
                `enabled     : ${resolved.enabled}`,
                `gate        : ${resolved.gate.mode}${resolved.gate.mode === 'preset' ? ` (preset "${resolved.gate.preset}")` : ''}`,
                `reviewer    : ${resolved.review.provider && resolved.review.model ? `${resolved.review.provider}/${resolved.review.model}` : 'the conversation main model'}`,
                `on failure  : ${resolved.review.onError === 'deny' ? 'refuse the call' : 'ask the human'}`,
                `audit       : ${audit.path ?? 'disabled'}`,
              ].join('\n'),
            }
          }

          const setConfig = (patch, message) => {
            if (scope === null) return { kind: 'error', text: 'settings unavailable; edit the plugin page instead' }
            const next = resolveConfig({ ...resolved, ...patch }, env)
            scope.update(next).then(() => adopt({ ...(rowConfig ?? {}), ...(scope.get() ?? next) })).catch((error) => log('save failed:', error))
            return { kind: 'success', text: message }
          }

          if (verb === 'on' || verb === 'off') {
            return setConfig({ enabled: verb === 'on' }, `Better auto review: ${verb.toUpperCase()}`)
          }
          if (verb === 'always' || verb === 'preset') {
            return setConfig({ gate: { ...resolved.gate, mode: verb } }, `Gate mode: ${verb}${verb === 'preset' ? ` (only while the "${resolved.gate.preset}" preset is selected)` : ' (every session)'}`)
          }
          if (verb === 'check') {
            if (tail.length === 0) return { kind: 'error', text: 'Usage: /bar check <command>' }
            const cwd = safe(() => invocation?.agent?.session?.header?.cwd, '') || process.cwd()
            const verdict = evaluate({ toolName: 'pwsh', args: { command: tail } }, { config: resolved, cwd, workspaceRoot: cwd })
            return {
              kind: 'success',
              text: `layer 1 on "${tail}"\n  verdict : ${verdict.verdict}\n  rule    : ${verdict.ruleId}\n  because : ${verdict.reason}${verdict.verdict === 'escalate' ? '\n  (escalate would call the reviewer in a real session)' : ''}`,
            }
          }
          if (verb === 'audit') {
            const limit = Math.min(50, Math.max(1, Number(tail) || 10))
            const entries = audit.read(limit)
            if (entries.length === 0) return { kind: 'success', text: `No audit entries yet (${audit.path ?? 'audit disabled'}).` }
            return { kind: 'success', text: entries.map((entry) => `${entry.at ?? '?'}  ${entry.tool ?? '?'}  L${entry.layer ?? '?'}  ${entry.verdict ?? '?'}  ${entry.rule ?? ''} ${entry.reason ?? ''}`.trim()).join('\n') }
          }
          return { kind: 'error', text: 'Usage: /bar [on|off|always|preset|check <command>|audit [n]]' }
        },
      })
    } catch (error) {
      log('/bar command registration failed:', error)
    }
  })
}
