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

import { BlockAssembler } from './block-assembler.js'
import zs from '@deepseek-ai/schemastery'

import { createAudit } from './audit.js'
import { createDefaults, createSettingsSchema, resolveConfig } from './config.js'
import { HARD_DENY_RULES, evaluate } from './engine.js'
import { createReviewGate } from './gate.js'
import { catalogFromProviders, projectReviewerModelCatalog } from './model-catalog.js'

export const name = 'better-auto-review'

/**
 * native: the exact service set the shipped Auto review waits for, minus
 * `sessionController`: it is optional here (the model picker falls back to the
 * `llm` listing), and a required service that is absent would prevent the whole
 * plugin — including the gate — from loading.
 */
export const inject = ['approval', 'llm', 'permissionPresets', 'sessions', 'tools']

const NAMESPACE = 'better-auto-review'
const VERSION = '0.1.0'
const RUN_CODE_NAME = 'run_code'

/** Largest management request body accepted (a full config is far smaller). */
const MAX_BODY_BYTES = 1024 * 1024

/** How long one projected model catalog is reused. */
const MODELS_TTL_MS = 30000

function dshHomePath(...parts) {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), ...parts)
}

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

  // ---- session facts -----------------------------------------------------
  // Split on purpose. `sessionFacts` reads plain fields plus the incremental
  // request header and runs for every tool call; `reviewContext` is the
  // expensive one (the host re-copies its event log on every append) and is
  // requested only when a review will run.
  const sessionFacts = (agent) => {
    const session = agent.session
    const cwd = safe(() => session.header.cwd, '') || process.cwd()
    const header = safe(() => session.requestHeader(), undefined)
    return { cwd, workspaceRoot: cwd, sessionId: safe(() => session.id, ''), headerConfig: header?.config ?? {} }
  }

  const reviewContext = (agent) => {
    const session = agent.session
    return { events: safe(() => session.snapshotEvents(), []) }
  }

  const gate = createReviewGate({
    getConfig: () => resolved,
    isActive,
    approvalPolicy: (agent) => safe(() => ctx.approval.overrideOf(agent.session), 'ask'),
    runCodeName: RUN_CODE_NAME,
    createAssembler: () => new BlockAssembler(),
    streamReview: (request) => ctx.llm.stream(request),
    sessionFacts,
    reviewContext,
    audit,
  })

  let accepting = true
  ctx.effect(function* () {
    yield ctx.on('tools/pre-execute', async (execution, next) => (accepting ? gate.handler(execution, next) : { kind: 'cancel' }), { prepend: true })

    if (typeof ctx.tools?.guard === 'function') {
      try {
        const dispose = ctx.tools.guard(gate.guard)
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
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    /** Read a JSON body. `undefined` means the error response was already sent. */
    const readJsonBody = async (req, res) => {
      const chunks = []
      let size = 0
      try {
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > MAX_BODY_BYTES) {
            send(res, 413, { ok: false, error: 'request body too large' })
            return undefined
          }
          chunks.push(buffer)
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        return JSON.parse(raw.length > 0 ? raw : '{}')
      } catch {
        send(res, 400, { ok: false, error: 'body must be JSON' })
        return undefined
      }
    }

    const register = (method, path, handlerFn) => {
      try {
        webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => (req.method !== method ? send(res, 405, { ok: false, error: 'method not allowed' }) : handlerFn(req, res)),
        })
      } catch (error) {
        log(`route ${path} registration failed:`, error)
      }
    }

    // The catalog can be slow on a cold provider and the page asks for it on
    // every open and every Reload; one fetch serves all of them for 30 s.
    let modelsCache = null
    let modelsPending = null
    const loadCatalog = async (force) => {
      if (force !== true && modelsCache !== null && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.value
      if (modelsPending !== null) return modelsPending
      modelsPending = (async () => {
        const controller = safe(() => ctx.get('sessionController'), undefined)
        if (typeof controller?.modelCatalog === 'function') {
          try {
            const native = projectReviewerModelCatalog(await controller.modelCatalog())
            if (native.groups.length > 0) return native
          } catch {
            // An unavailable native catalog falls back to the adapter listing.
          }
        }
        return catalogFromProviders(safe(() => ctx.get('llm'), undefined))
      })()
      try {
        const value = await modelsPending
        modelsCache = { at: Date.now(), value }
        return value
      } finally {
        modelsPending = null
      }
    }

    register('GET', '/better-auto-review/state', async (req, res) => {
      send(res, 200, {
        ok: true,
        version: VERSION,
        preset: resolved.gate.preset,
        settingsAvailable: scope !== null,
        auditPath: audit.path,
        config: resolved,
        hardDenyRuleCount: HARD_DENY_RULES.length,
      })
    })

    register('GET', '/better-auto-review/models', async (req, res) => {
      const force = safe(() => new URL(req.url ?? '/', 'http://x').searchParams.get('force') === '1', false)
      send(res, 200, { ok: true, catalog: await loadCatalog(force) })
    })

    // The page is the source of truth for edits, but validation stays here: the
    // client cannot persist a shape the engine would misread.
    register('POST', '/better-auto-review/config', async (req, res) => {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
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

    register('POST', '/better-auto-review/reset', async (req, res) => {
      if (scope === null) return send(res, 503, { ok: false, error: 'settings unavailable' })
      try {
        await scope.update(defaults)
      } catch (error) {
        return send(res, 500, { ok: false, error: `persist failed: ${error?.message ?? error}` })
      }
      adopt({ ...(rowConfig ?? {}), ...(scope.get() ?? defaults) })
      return send(res, 200, { ok: true, config: resolved })
    })

    register('GET', '/better-auto-review/audit', async (req, res) => {
      const limit = safe(() => Number(new URL(req.url ?? '/', 'http://x').searchParams.get('limit')) || 50, 50)
      send(res, 200, { ok: true, path: audit.path, entries: audit.read(Math.min(500, Math.max(1, limit))) })
    })

    // A dry run of layer 1 only: nothing is executed and the reviewer is never
    // called, so the management page can show exactly which rule would fire.
    register('POST', '/better-auto-review/check', async (req, res) => {
      const body = await readJsonBody(req, res)
      if (body === undefined) return
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
