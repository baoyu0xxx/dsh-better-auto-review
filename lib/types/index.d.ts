/**
 * Public types for `dsh-better-auto-review`.
 *
 * The package ships plain JavaScript and imports nothing from DSH outside the
 * Host half, so these declarations exist to document the configuration surface
 * and the decision vocabulary rather than to type a build.
 */

/** Layer-1 verdict vocabulary. */
export type Verdict = 'allow' | 'deny' | 'escalate'

/** Risk class the reviewer must assign. */
export type Risk = 'low' | 'medium' | 'high'

/** One validated reviewer decision. */
export interface Decision {
  risk: Risk
  decision: 'allow' | 'deny'
  reason?: string
}

/** One entry of the append-only audit log. */
export interface AuditEntry {
  at: string
  session?: string
  tool?: string
  layer?: 1 | 2
  verdict?: 'allow' | 'deny' | 'ask' | 'deny-final' | 'fail-ask' | 'fail-closed'
  rule?: string
  risk?: Risk
  reason?: string
  model?: string
  inherited?: boolean
  attempt?: number
  ruleMs?: number
  modelMs?: number
  /** Only present when `audit.recordArguments` is on; redacted and bounded. */
  arguments?: string
}

/** How the gate is armed. */
export interface GateConfig {
  /** `preset` runs only while `preset` is the session's permission preset. */
  mode: 'preset' | 'always'
  preset: string
}

/** Layer-2 reviewer settings. */
export interface ReviewConfig {
  /** Empty inherits the conversation's own provider. */
  provider: string
  /** Empty inherits the conversation's own model. */
  model: string
  /** Empty picks the model's lowest advertised level. */
  reasoningEffort: string
  maxTokens: number
  maxTokensLimit: number
  tokenLimitRetries: number
  /** A non-finite value sends no `temperature` field at all. */
  temperature: number
  timeoutMs: number
  /** `ask` hands a reviewer failure to the human; `deny` refuses outright. */
  onError: 'ask' | 'deny'
  maxHistoryChars: number
  maxProjectInstructionChars: number
  maxActionChars: number
}

/** Layer-1 rule settings. */
export interface RulesConfig {
  protectPaths: string[]
  sensitiveWritePaths: string[]
  extraAllowedRoots: string[]
  readOnlyTools: string[]
  shellTools: string[]
  writeTools: string[]
  fastAllowWorkspaceWrites: boolean
  fastAllowReadOnlyShell: boolean
  /** Regexes tried last: they can never override a deny or a sensitive hit. */
  fastAllowCommands: string[]
  hardDeny: boolean
}

/** Audit-log settings. */
export interface AuditConfig {
  enabled: boolean
  maxBytes: number
  recordArguments: boolean
  maxArgChars: number
}

/** The complete validated configuration. */
export interface Config {
  enabled: boolean
  gate: GateConfig
  review: ReviewConfig
  rules: RulesConfig
  audit: AuditConfig
}

/** The `GET /better-auto-review/state` response body. */
export interface StateResponse {
  ok: true
  version: string
  preset: string
  settingsAvailable: boolean
  auditPath: string | null
  config: Config
  hardDenyRuleCount: number
}

/** One projected model catalog entry. */
export interface CatalogModel {
  id: string
  name?: string
  reasoning?: { efforts: { id: string; name?: string; description?: string }[]; defaultEffort?: string }
}

/** One provider group in the projected model catalog. */
export interface CatalogGroup {
  id: string
  name?: string
  models: CatalogModel[]
}

/** The `GET /better-auto-review/models` response body. */
export interface ModelsResponse {
  ok: true
  catalog: { available: boolean; default: { provider: string; model: string; reasoningEffort?: string } | null; groups: CatalogGroup[] }
}

/** The `POST /better-auto-review/check` response body. */
export interface CheckResponse {
  ok: true
  verdict: Verdict
  rule: string
  reason: string
}

/** The permission-preset key this plugin's gate is armed by. */
export declare const PRESET: string

/** Environment the path defaults are derived from. */
export interface Environment {
  home?: string
  dshHome?: string
  platform?: string
}

/** Build the platform defaults for one environment. */
export declare function createDefaults(environment?: Environment): Config

/** Validate, clamp and complete a stored configuration. */
export declare function resolveConfig(stored?: Partial<Config>, environment?: Environment): Config

/** Judge one pending call with layer 1 only. */
export declare function evaluate(
  execution: { toolName: string; args?: Record<string, unknown> },
  context: { config: Config; cwd: string; workspaceRoot: string },
): { verdict: Verdict; ruleId: string; reason: string }
