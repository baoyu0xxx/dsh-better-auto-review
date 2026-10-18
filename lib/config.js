/**
 * Configuration for dsh-better-auto-review.
 *
 * This module is deliberately PURE: it imports nothing but `node:os`, so the
 * rule engine and the reviewer can be exercised by `node --test` in a checkout
 * that has no `node_modules`. The schemastery schema is built here too, but
 * only through the `createSettingsSchema(zs)` factory, which receives the
 * schemastery module from the Host half — the settings service is the one
 * place that needs it.
 *
 * @module dsh-better-auto-review/config
 */
import { homedir } from 'node:os'

/** Default preset name this plugin contributes (must match cordis.patch.yml). */
export const PRESET = 'better-auto-review'

/** Directory roots whose destruction is never an agent's decision. */
const DESTRUCTIVE_PROTECTED_LEAVES = ['Desktop', 'Documents', 'Downloads', 'OneDrive', 'Pictures']

/** Writing here is a configuration change, not ordinary work. */
const SENSITIVE_WRITE_LEAVES = ['.ssh', '.aws', '.config', '.codex', '.claude', '.openviking']

/** Roots whose destruction breaks the machine, not just a file. */
function systemRoots(platform) {
  if (platform !== 'win32') return ['/etc', '/usr', '/var', '/boot', '/System', '/Library']
  return ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
}

/**
 * Build the default rule inputs for one environment.
 *
 * @param {object} [environment] - overrides used by tests.
 * @param {string} [environment.home] - the user's home directory.
 * @param {string} [environment.dshHome] - the harness state directory.
 * @param {string} [environment.platform] - `process.platform`.
 * @returns {object} a fresh, deeply independent defaults object.
 */
export function createDefaults(environment = {}) {
  const home = environment.home ?? homedir()
  const platform = environment.platform ?? process.platform
  const dshHome = environment.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh')

  const protectPaths = [
    dshHome,
    ...DESTRUCTIVE_PROTECTED_LEAVES.map((leaf) => join(home, leaf)),
    ...systemRoots(platform),
  ]
  const sensitiveWritePaths = [
    dshHome,
    join(home, 'AppData'),
    ...systemRoots(platform),
    ...SENSITIVE_WRITE_LEAVES.map((leaf) => join(home, leaf)),
  ]

  return {
    /** Master switch. */
    enabled: true,
    /**
     * `preset` — the gate runs only while the session's permission preset is
     * {@link PRESET} (same posture as the shipped Auto review).
     * `always` — the deterministic floor runs in every session, whatever the
     * preset, which is how a PreToolUse guard behaves. Never loosens anything:
     * under a sandboxed preset the gate can only refuse or escalate.
     */
    gate: {
      mode: 'preset',
      preset: PRESET,
    },
    review: {
      /** Empty means "inherit the conversation's main provider/model". */
      provider: '',
      model: '',
      /** Empty means "pick a low reasoning level if the model advertises one". */
      reasoningEffort: '',
      maxTokens: 8192,
      /** Ceiling for the truncation retries below. */
      maxTokensLimit: 32768,
      tokenLimitRetries: 2,
      /**
       * `0` keeps the review deterministic — what a classification wants, and
       * what the shipped Auto review hardcodes. A non-finite value means "send
       * no temperature at all", for a gateway that rejects the field.
       */
      temperature: 0,
      timeoutMs: 120000,
      /** `ask` hands a reviewer failure to the human; `deny` refuses outright. */
      onError: 'ask',
      maxInputChars: 180000,
      maxHistoryChars: 60000,
      maxProjectInstructionChars: 30000,
      /** The pending action itself is never truncated to fit `maxInputChars`. */
      maxActionChars: 12000,
    },
    rules: {
      protectPaths,
      sensitiveWritePaths,
      /** Extra roots a rule may treat as ordinary project work. */
      extraAllowedRoots: [],
      /** Tools that cannot mutate anything. */
      readOnlyTools: ['read', 'glob', 'grep', 'ls', 'read_image'],
      /** Shell tools whose command string the rule engine reads. */
      shellTools: ['pwsh', 'bash', 'sh', 'cmd'],
      /** Tools that mutate one named file. */
      writeTools: ['write', 'edit'],
      fastAllowWorkspaceWrites: true,
      fastAllowReadOnlyShell: true,
      /**
       * Regexes (as strings) that fast-allow a shell command as a LAST resort,
       * after every deny and escalation rule has declined it. This is the
       * pressure valve for a project whose ordinary commands the rules cannot
       * recognise (a compiler, a test runner): without it each one costs a
       * model request. A hard-deny and a sensitive-path escalation can never be
       * whitelisted away, so a bad entry cannot open the floor.
       */
      fastAllowCommands: [],
      /** The hard-deny floor (disk / security / boot level commands). */
      hardDeny: true,
    },
    audit: {
      enabled: true,
      maxBytes: 4194304,
      /** Argument bodies stay out of the log unless explicitly enabled. */
      recordArguments: false,
      maxArgChars: 240,
    },
  }
}

/** Join without importing `node:path` twice; POSIX and Windows both handled. */
function join(base, leaf) {
  if (base === undefined || base === null || base === '') return leaf
  const separator = base.includes('\\') ? '\\' : '/'
  return base.replace(/[\\/]+$/, '') + separator + leaf
}

/** The defaults for this process. */
export const DEFAULTS = createDefaults()

/** Whether a value is a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Deep-merge `overrides` onto `base` without mutating either.
 *
 * Arrays REPLACE rather than concatenate: a user who sets `protectPaths` means
 * exactly that list, and silently unioning it with the defaults would make a
 * root impossible to remove.
 *
 * @param {object} base - the lower-precedence object.
 * @param {object} overrides - the higher-precedence object.
 * @returns {object} a new object.
 */
export function merge(base, overrides) {
  if (!isPlainObject(overrides)) return cloneValue(base)
  const out = {}
  for (const key of Object.keys(base)) {
    const next = overrides[key]
    out[key] = isPlainObject(base[key]) && isPlainObject(next) ? merge(base[key], next) : cloneValue(next === undefined ? base[key] : next)
  }
  for (const key of Object.keys(overrides)) {
    if (!(key in out)) out[key] = cloneValue(overrides[key])
  }
  return out
}

/** Clone JSON-shaped values so no caller can mutate a shared default. */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value)) out[key] = cloneValue(value[key])
    return out
  }
  return value
}

/** Coerce to a finite number, falling back when the value is unusable. */
function numberOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Coerce to a positive integer. */
function positiveIntOr(value, fallback) {
  const parsed = Math.trunc(numberOr(value, fallback))
  return parsed > 0 ? parsed : fallback
}

/**
 * Normalize an OPTIONAL list setting, honouring an explicitly empty array.
 *
 * Empty is a meaningful value here ("no read-only tools", "no extra roots"), so
 * a user who clears the list gets exactly that. A non-array (a typo) still falls
 * back to the defaults rather than silently emptying the setting.
 */
function optionalList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
}

/**
 * Normalize a SAFETY-FLOOR list, which can never become empty.
 *
 * `protectPaths` and `sensitiveWritePaths` are the floor under everything else;
 * a stray edit that empties them must not be allowed to disarm the gate, so an
 * empty result falls back to the defaults. Removing a root is still possible —
 * it just has to be replaced with another one.
 */
function requiredList(value, fallback) {
  const out = optionalList(value, fallback)
  return out.length > 0 ? out : fallback
}

/**
 * Build the effective configuration from stored settings.
 *
 * Every field is validated and clamped here rather than at each use site, so
 * a hand-edited settings document can never put the gate into a state that
 * throws mid-review: an unreadable value falls back to its default.
 *
 * @param {object} [stored] - the settings document's `better-auto-review` section.
 * @param {object} [environment] - environment overrides, for tests.
 * @returns {object} a complete, validated configuration.
 */
export function resolveConfig(stored = {}, environment = {}) {
  const merged = merge(createDefaults(environment), isPlainObject(stored) ? stored : {})
  const review = merged.review
  const rules = merged.rules
  const audit = merged.audit
  const gate = merged.gate

  return {
    enabled: merged.enabled !== false,
    gate: {
      mode: gate.mode === 'always' ? 'always' : 'preset',
      preset: typeof gate.preset === 'string' && gate.preset.length > 0 ? gate.preset : PRESET,
    },
    review: {
      provider: typeof review.provider === 'string' ? review.provider.trim() : '',
      model: typeof review.model === 'string' ? review.model.trim() : '',
      reasoningEffort: typeof review.reasoningEffort === 'string' ? review.reasoningEffort.trim() : '',
      maxTokens: positiveIntOr(review.maxTokens, DEFAULTS.review.maxTokens),
      maxTokensLimit: positiveIntOr(review.maxTokensLimit, DEFAULTS.review.maxTokensLimit),
      tokenLimitRetries: Math.max(0, Math.trunc(numberOr(review.tokenLimitRetries, DEFAULTS.review.tokenLimitRetries))),
      temperature: review.temperature === null || review.temperature === undefined || review.temperature === ''
        ? null
        : Math.min(2, Math.max(0, numberOr(review.temperature, DEFAULTS.review.temperature))),
      timeoutMs: positiveIntOr(review.timeoutMs, DEFAULTS.review.timeoutMs),
      onError: review.onError === 'deny' ? 'deny' : 'ask',
      maxInputChars: positiveIntOr(review.maxInputChars, DEFAULTS.review.maxInputChars),
      maxHistoryChars: Math.max(0, Math.trunc(numberOr(review.maxHistoryChars, DEFAULTS.review.maxHistoryChars))),
      maxProjectInstructionChars: Math.max(0, Math.trunc(numberOr(review.maxProjectInstructionChars, DEFAULTS.review.maxProjectInstructionChars))),
      maxActionChars: positiveIntOr(review.maxActionChars, DEFAULTS.review.maxActionChars),
    },
    rules: {
      protectPaths: requiredList(rules.protectPaths, DEFAULTS.rules.protectPaths),
      sensitiveWritePaths: requiredList(rules.sensitiveWritePaths, DEFAULTS.rules.sensitiveWritePaths),
      extraAllowedRoots: optionalList(rules.extraAllowedRoots, []),
      readOnlyTools: optionalList(rules.readOnlyTools, DEFAULTS.rules.readOnlyTools),
      shellTools: optionalList(rules.shellTools, DEFAULTS.rules.shellTools),
      writeTools: optionalList(rules.writeTools, DEFAULTS.rules.writeTools),
      fastAllowWorkspaceWrites: rules.fastAllowWorkspaceWrites !== false,
      fastAllowReadOnlyShell: rules.fastAllowReadOnlyShell !== false,
      fastAllowCommands: optionalList(rules.fastAllowCommands, []),
      hardDeny: rules.hardDeny !== false,
    },
    audit: {
      enabled: audit.enabled !== false,
      maxBytes: positiveIntOr(audit.maxBytes, DEFAULTS.audit.maxBytes),
      recordArguments: audit.recordArguments === true,
      maxArgChars: positiveIntOr(audit.maxArgChars, DEFAULTS.audit.maxArgChars),
    },
  }
}

/**
 * Build the schemastery schema behind the plugin's settings namespace.
 *
 * Two deliberate choices:
 *
 *  - **Environment-aware list defaults.** The schema is what `scope.get()`
 *    returns for keys the user has never touched, so an empty `[]` default
 *    would silently disarm layer 1 for `readOnlyTools` / `shellTools` /
 *    `writeTools` — every ordinary call would stop being fast-allowed. The real
 *    defaults are baked in here instead.
 *  - **No `.volatile()`.** schemastery parses a volatile field into a reference
 *    read with `.get()`, and dsh-rtk's settings registration — proven in
 *    production on this machine — reads and writes a plain schema directly.
 *    This plugin's own management page is the configuration surface, so the
 *    plain form is both the safer and the sufficient one.
 *
 * @param {object} zs - the `@deepseek-ai/schemastery` module.
 * @param {object} [environment] - `{ home, dshHome, platform }`.
 * @returns {object} the schema.
 */
export function createSettingsSchema(zs, environment = {}) {
  const base = createDefaults(environment)
  const list = (fallback) => zs.array(zs.string()).default([...fallback])
  const group = (shape) => zs.object(shape)
  return zs.object({
    enabled: zs.boolean().default(base.enabled),
    gate: group({
      mode: zs.union(['preset', 'always']).default(base.gate.mode),
      preset: zs.string().default(base.gate.preset),
    }),
    review: group({
      provider: zs.string().default(base.review.provider),
      model: zs.string().default(base.review.model),
      reasoningEffort: zs.string().default(base.review.reasoningEffort),
      maxTokens: zs.number().default(base.review.maxTokens),
      maxTokensLimit: zs.number().default(base.review.maxTokensLimit),
      tokenLimitRetries: zs.number().default(base.review.tokenLimitRetries),
      temperature: zs.number().default(base.review.temperature),
      timeoutMs: zs.number().default(base.review.timeoutMs),
      onError: zs.union(['ask', 'deny']).default(base.review.onError),
      maxInputChars: zs.number().default(base.review.maxInputChars),
      maxHistoryChars: zs.number().default(base.review.maxHistoryChars),
      maxProjectInstructionChars: zs.number().default(base.review.maxProjectInstructionChars),
      maxActionChars: zs.number().default(base.review.maxActionChars),
    }),
    rules: group({
      protectPaths: list(base.rules.protectPaths),
      sensitiveWritePaths: list(base.rules.sensitiveWritePaths),
      extraAllowedRoots: list(base.rules.extraAllowedRoots),
      readOnlyTools: list(base.rules.readOnlyTools),
      shellTools: list(base.rules.shellTools),
      writeTools: list(base.rules.writeTools),
      fastAllowWorkspaceWrites: zs.boolean().default(base.rules.fastAllowWorkspaceWrites),
      fastAllowReadOnlyShell: zs.boolean().default(base.rules.fastAllowReadOnlyShell),
      fastAllowCommands: list(base.rules.fastAllowCommands),
      hardDeny: zs.boolean().default(base.rules.hardDeny),
    }),
    audit: group({
      enabled: zs.boolean().default(base.audit.enabled),
      maxBytes: zs.number().default(base.audit.maxBytes),
      recordArguments: zs.boolean().default(base.audit.recordArguments),
      maxArgChars: zs.number().default(base.audit.maxArgChars),
    }),
  })
}
