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
import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Keys whose values never reach the log. */
const SECRET_KEY_RE = /(pass(word|wd)?|secret|token|api[-_]?key|apikey|authorization|credential|cookie|private[-_]?key)/i

/** Values that look like a credential even under an innocent key. */
const SECRET_VALUE_RE = /(ghp_|gho_|github_pat_|sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

/** Read the tail in bounded chunks instead of re-reading a 4 MiB log. */
const TAIL_CHUNK_BYTES = 64 * 1024

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
    const safe = redact(value)
    text = typeof safe === 'string' ? safe : JSON.stringify(safe)
  } catch {
    text = '[unserializable]'
  }
  if (typeof text !== 'string') text = String(text)
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text
}

/** Count `\n` bytes in one chunk. */
function countNewlines(buffer) {
  let count = 0
  for (const byte of buffer) if (byte === 0x0a) count += 1
  return count
}

/**
 * Create the audit sink.
 *
 * @param {object} options - `{ directory, config }`.
 * @returns {object} `{ path, configure, record, read }`.
 */
export function createAudit(options) {
  let config = options?.config ?? {}
  const directory = options?.directory
  const path = typeof directory === 'string' && directory.length > 0 ? join(directory, 'audit.jsonl') : null
  const enabledNow = () => config.enabled !== false && path !== null
  const maxBytesNow = () => (Number.isFinite(config.maxBytes) ? config.maxBytes : 4194304)
  const maxArgCharsNow = () => (Number.isFinite(config.maxArgChars) ? config.maxArgChars : 240)

  let ready = false
  const ensureDirectory = () => {
    if (ready || path === null) return
    mkdirSync(dirname(path), { recursive: true })
    ready = true
  }

  // Bytes written so far. `null` means "not measured yet": the first decision
  // stats the file once, then the counter tracks appends without another syscall.
  let bytes = null

  /** Rotate once when the file outgrows its budget. */
  const rotate = () => {
    if (path === null) return
    if (bytes === null) {
      try {
        bytes = statSync(path).size
      } catch {
        bytes = 0
      }
    }
    if (bytes < maxBytesNow()) return
    try {
      renameSync(path, path + '.1')
      bytes = 0
    } catch {
      // A missing file or a failed rotation never blocks a review.
    }
  }

  return {
    path,
    /** Point the sink at new audit settings without losing its position. */
    configure(next) {
      config = next ?? {}
    },
    /** Append one decision. Never throws: an audit failure must not fail a tool call. */
    record(entry) {
      if (!enabledNow()) return
      try {
        ensureDirectory()
        rotate()
        const { arguments: args, ...rest } = entry
        const line = { at: new Date().toISOString(), ...rest }
        if (config.recordArguments === true && args !== undefined) {
          line.arguments = summarize(args, maxArgCharsNow())
        }
        const text = JSON.stringify(line) + '\n'
        writeFileSync(path, text, { encoding: 'utf8', flag: 'a' })
        bytes = (bytes ?? 0) + Buffer.byteLength(text)
      } catch {
        // Swallowed on purpose: the gate's verdict must not depend on the log.
      }
    },
    /** Read the tail of the log, newest last, parsing only the requested lines. */
    read(limit = 50) {
      if (path === null) return []
      const count = Math.max(1, Math.trunc(Number(limit)) || 50)
      let fd = null
      try {
        fd = openSync(path, 'r')
        const size = statSync(path).size
        if (size === 0) return []
        const chunks = []
        let start = size
        let newlines = 0
        while (start > 0 && newlines <= count) {
          const length = Math.min(TAIL_CHUNK_BYTES, start)
          start -= length
          const buffer = Buffer.alloc(length)
          readSync(fd, buffer, 0, length, start)
          chunks.unshift(buffer)
          newlines += countNewlines(buffer)
        }
        return Buffer.concat(chunks)
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .slice(-count)
          .map((line) => {
            try {
              return JSON.parse(line)
            } catch {
              return { at: null, malformed: true }
            }
          })
      } catch {
        return []
      } finally {
        if (fd !== null) closeSync(fd)
      }
    },
  }
}
