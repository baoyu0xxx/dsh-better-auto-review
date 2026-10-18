/**
 * Append-only review audit log.
 *
 * The shipped Auto review records nothing — "risk, prompt, reasoning and raw
 * response are not persisted, so do not expect it to serve as an audit log"
 * (its own README). That is the single biggest operational gap in it: after a
 * refusal nobody can say which rule fired or which model decided. This log
 * closes that gap with one JSON line per decision.
 *
 * Deliberate limits:
 *   - argument bodies are NOT recorded unless `audit.recordArguments` is on;
 *   - anything that looks like a credential is redacted even then;
 *   - one rotation at `audit.maxBytes`, so the log can never grow without bound.
 *
 * @module dsh-better-auto-review/audit
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Keys whose values never reach the log. */
const SECRET_KEY_RE = /(pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|credential|cookie|private[-_]?key)/i

/** Values that look like a credential even under an innocent key. */
const SECRET_VALUE_RE = /(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

/** Replace secret-looking values in a JSON-shaped structure. */
export function redact(value, depth = 0) {
  if (depth > 12) return '[depth-limit]'
  if (typeof value === 'string') return SECRET_VALUE_RE.test(value) ? '[redacted]' : value
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redact(value[key], depth + 1)
    }
    return out
  }
  return value
}

/** One-line summary of a value, safe to log and bounded in length. */
export function summarize(value, maxChars) {
  let text
  try {
    text = typeof value === 'string' ? value : JSON.stringify(redact(value))
  } catch {
    text = '[unserializable]'
  }
  if (typeof text !== 'string') text = String(text)
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

/**
 * Create the audit sink.
 *
 * @param {object} options - `{ directory, config }`.
 * @returns {object} `{ path, record, read, stats, disabled }`.
 */
export function createAudit(options) {
  let config = options?.config ?? {}
  const directory = options?.directory
  const path = typeof directory === 'string' && directory.length > 0 ? join(directory, 'audit.jsonl') : null
  const enabledNow = () => config.enabled !== false && path !== null
  const maxBytesNow = () => (Number.isFinite(config.maxBytes) ? config.maxBytes : 4194304)

  const stats = {
    reviewed: 0,
    allowedByRule: 0,
    deniedByRule: 0,
    escalated: 0,
    allowedByModel: 0,
    deniedByModel: 0,
    failed: 0,
    asked: 0,
    totalRuleMs: 0,
    totalModelMs: 0,
  }

  let ready = false
  const ensureDirectory = () => {
    if (ready || path === null) return
    mkdirSync(dirname(path), { recursive: true })
    ready = true
  }

  /** Rotate once when the file outgrows its budget. */
  const rotate = () => {
    if (path === null) return
    try {
      if (statSync(path).size < maxBytesNow()) return
      renameSync(path, path + '.1')
    } catch {
      // A missing file or a failed rotation never blocks a review.
    }
  }

  return {
    path,
    disabled: !enabledNow(),
    stats,
    /** Point the sink at new audit settings without losing its counters. */
    configure(next) {
      config = next ?? {}
    },
    /** Append one decision. Never throws: an audit failure must not fail a tool call. */
    record(entry) {
      if (!enabledNow()) return
      try {
        ensureDirectory()
        rotate()
        writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { encoding: 'utf8', flag: 'a' })
      } catch {
        // Swallowed on purpose: the gate's verdict must not depend on the log.
      }
    },
    /** Read the tail of the log, newest last. */
    read(limit = 50) {
      if (path === null) return []
      try {
        const text = readFileSync(path, 'utf8')
        return text
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .slice(-limit)
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return { at: null, malformed: true }
            }
          })
      } catch {
        return []
      }
    },
  }
}
