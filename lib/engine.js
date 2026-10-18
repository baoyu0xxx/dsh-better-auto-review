/**
 * Layer 1 — the deterministic fast review.
 *
 * A pure function over one pending tool call: no clock, no filesystem, no
 * network, no model. It answers in microseconds, which is precisely why it can
 * run on every call while the LLM reviewer cannot.
 *
 * The rule set is a hardened port of the PreToolUse guard that already ran on
 * this machine (`D:\dsh_back_good\guard\guard-hook.mjs`, 17/17 self-test plus a
 * real `dsh-hook-protocol` pipeline integration test), with deliberate
 * differences:
 *
 *   1. **Quoted text is masked, and hard rules match only at a command
 *      position.** The guard matched its rules against the whole command, so a
 *      string like `Write-Output "a|format C:"` tripped the volume-format rule.
 *      Here separators inside quotes do not split commands and quoted content
 *      is blanked before the rules run, while the inner script of `bash -c "…"`
 *      / `pwsh -Command "…"` is unwrapped and re-scanned on its own.
 *   2. **`bash`/`cmd` coverage** alongside PowerShell, plus `.NET` / `os` /
 *      `fs` deletion APIs rather than only shell verbs.
 *   3. **A narrowed harness-state match.** The guard treated ANY path segment
 *      named `sessions`, `storages` or `profiles` as harness state, which
 *      denied an ordinary project's own `.\sessions` directory. Only `.dsh`
 *      itself and the DSH-unique `session_projcache` count now; everything else
 *      is caught by the concrete `protectPaths` roots, which is where a
 *      user-configurable rule belongs.
 *   4. **Unrecognised commands escalate instead of being allowed.** The guard
 *      allowed anything it did not flag because a `PreToolUse` hook cannot
 *      pre-approve — its `allow` was a no-op. Here the gate really does grant
 *      access, so "we could not prove this is safe" must reach layer 2 rather
 *      than pass silently. `rules.fastAllowCommands` is the pressure valve for
 *      commands a given project runs constantly.
 *
 * Verdicts:
 *   `deny`     — never run the body. Reserved for effects that are
 *                unrecoverable or that destroy the machine's ability to boot or
 *                to be recovered (disk, boot, security controls, the harness
 *                state itself).
 *   `allow`    — provably ordinary work; skip the model entirely.
 *   `escalate` — a rule cannot settle it; hand it to layer 2.
 *
 * @module dsh-better-auto-review/engine
 */
import { homedir } from 'node:os'
import { win32 as winPath, posix as posixPath } from 'node:path'

/** Verdict vocabulary. */
export const ALLOW = 'allow'
export const DENY = 'deny'
export const ESCALATE = 'escalate'

/**
 * Commands whose only sensible verdict is "never".
 *
 * Each rule is matched against a MASKED command position (see
 * {@link scanSegments}), so writing one of these inside a string is safe.
 */
export const HARD_DENY_RULES = [
  { id: 'format-volume', re: /\bformat(\.com)?\b\s+[a-z]:/i, why: 'formats a volume' },
  { id: 'diskpart', re: /\bdiskpart\b/i, why: 'repartitions a disk' },
  { id: 'disk-management', re: /\b(clear-disk|initialize-disk|new-partition|remove-partition|set-disk|resize-partition)\b/i, why: 'rewrites the disk layout' },
  { id: 'mkfs', re: /\bmkfs(\.\w+)?\b/i, why: 'creates a filesystem over existing data' },
  { id: 'raw-device-write', re: /(^|\s)dd\s[^\n]*\bof=\/dev\/(sd|nvme|hd|disk)|\\\\\.\\physicaldrive/i, why: 'writes raw bytes to a physical device' },
  { id: 'vssadmin-delete-shadows', re: /vssadmin\s+delete\s+shadows/i, why: 'deletes shadow copies / restore points' },
  { id: 'shadow-copy-delete', re: /\b(gwmi|get-wmiobject|get-ciminstance)\b[^\n]*win32_shadowcopy[^\n]*\bdelete\b/i, why: 'deletes shadow copies / restore points' },
  { id: 'wbadmin-delete', re: /wbadmin\s+delete\b/i, why: 'deletes backups' },
  { id: 'bcdedit-delete', re: /bcdedit\s+\/delete/i, why: 'breaks the boot configuration' },
  { id: 'reg-delete-hklm', re: /\breg\s+delete\s+hklm\b/i, why: 'deletes a machine-wide registry key' },
  { id: 'defender-disable', re: /set-mppreference\s+[^\n]*-disablerealtimemonitoring/i, why: 'disables Defender real-time protection' },
  { id: 'firewall-disable', re: /\bnetsh\s+advfirewall\s+set\s+\w+\s+state\s+off/i, why: 'disables the firewall' },
  { id: 'restore-disable', re: /(disable-computerrestore|remove-computerrestorepoint)/i, why: 'disables restore points' },
  { id: 'takeown-r', re: /\btakeown\b\s+\/r/i, why: 'performs a mass ownership takeover' },
  { id: 'icacls-deny', re: /\bicacls\b[^\n]*\/deny\b/i, why: 'locks a path down with an ACL deny' },
  { id: 'eventlog-clear', re: /\bwevtutil\s+cl\b|clear-eventlog/i, why: 'erases the event log' },
  { id: 'rm-rf-system-root', re: /\brm\s+(-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*)\s+(\/|\/\*|~|\$home)(\s|$)/i, why: 'recursively deletes a filesystem root or the home directory' },
]

/** Shell verbs that remove or overwrite data. */
const DESTRUCTIVE_VERB = /(\bremove-item\b|\bri\b|\brm\b|\brmdir\b|\brd\b|\bdel\b|\berase\b|\bunlink\b|\bmove-item\b|\bmv\b|\bren\b|\brename-item\b|\bclear-content\b|\btruncate\b|\bformat\b|\bshred\b)/i

/** Language-level deletion: `.NET`, `os`, `fs`, `shutil`. */
const DESTRUCTIVE_API = /(\[io\.(directory|file)\]::(delete|move)\b|::delete\s*\(|\bos\.(remove|rmdir|unlink|removedirs)\b|\bfs\.(rm|rmdir|unlink)(sync)?\s*\(|\bshutil\.rmtree\b)/i

/** Verbs that write. */
const WRITE_VERB = /(\bset-content\b|\badd-content\b|\bout-file\b|\bnew-item\b|\bcopy-item\b|\bcp\b|\bmove-item\b|\bmv\b|\brename-item\b|\bremove-item\b|\bclear-content\b|\bmkdir\b|\bmd\b|>>|(?<![<>-])>\s*[^\s|]+)/i

/** Flags that widen a delete's blast radius. */
const RECURSIVE_OR_FORCE = /(-recurse|\/s\b|-force\b|\/f\b|\/q\b|--recursive\b|\s-r\b)/i

/** Commands that change the harness, an installed package, or a system service. */
const HARNESS_CHANGE = /\bdsh\b[^\n]*\bplugin\b|\bpnpm\b\s+(add|remove|rm|install|update)|\bnpm\b\s+(i|install|rm|uninstall)\b\s*-g|\bpip\b\s+install|\bschtasks\b\s+\/create|\breg\s+add\b|\bsc\b\s+(config|delete|stop)\b|\bstop-service\b|\benable-scheduledtask\b|\bnew-service\b/i

/**
 * The harness state, under any drive or user name.
 *
 * `session_projcache` is included because it is a DSH-only directory name;
 * bare `sessions` / `storages` / `profiles` are deliberately NOT, because they
 * are ordinary names in ordinary projects.
 */
const HARNESS_STATE_RE = /(^|[\\/])\.dsh([\\/]|$)|(^|[\\/])session_projcache([\\/]|$)/i

/** Single-token commands that cannot mutate anything. */
const READ_ONLY_COMMANDS = new Set([
  'get-date', 'get-childitem', 'gci', 'dir', 'ls', 'get-content', 'gc', 'cat', 'type',
  'get-item', 'gi', 'get-location', 'pwd', 'get-process', 'ps', 'select-string', 'sls',
  'test-path', 'measure-object', 'measure', 'resolve-path', 'get-filehash', 'get-command',
  'get-help', 'get-member', 'get-variable', 'get-psdrive', 'get-service', 'where.exe',
  'where', 'whoami', 'hostname', 'systeminfo', 'get-computerinfo', 'get-culture',
  'echo', 'write-output', 'write-host', 'test-connection', 'get-hotfix', 'get-volume',
])

/** Version probes that only print. */
const VERSION_PROBES = new Set(['-v', '-version', '--version'])

/** `git` subcommands that never write, and the flags that keep them read-only. */
const READ_ONLY_GIT = new Map([
  ['status', null],
  ['diff', null],
  ['log', null],
  ['show', null],
  ['rev-parse', null],
  ['ls-files', null],
  ['ls-remote', null],
  ['describe', null],
  ['blame', null],
  ['shortlog', null],
  ['whatchanged', null],
  ['branch', /^(-a|-r|-v|-vv|--all|--remotes|--list)$/],
  ['tag', /^(-l|--list|-n\d*)$/],
  ['remote', /^(-v|--verbose|show)$/],
  ['config', /^(--get|--get-all|--list|-l)$/],
  ['stash', /^(list|show)$/],
  ['worktree', /^(list)$/],
])

/** Wrapper commands to skip past when locating the real command. */
const WRAPPER_RE = /^(sudo|doas|timeout(\s+\S+)?|env(\s+\S+=\S+)*|nohup|xargs(\s+-\S+)*|command|exec|nice|ionice|stdbuf(\s+\S+)*|find(\s+\S+)+\s+-exec)\s+/i

/**
 * Pick the path flavor for one resolution.
 *
 * A RELATIVE token inherits its flavor from the directory it is resolved
 * against, not from its own text — `.\sessions` under a Windows cwd is a
 * Windows path, and resolving it with the POSIX flavor produces a path that
 * matches nothing and silently defeats every containment check.
 */
function pathFlavor(target, cwd) {
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(String(target))) return winPath
  if (/^[A-Za-z]:[\\/]|^\\\\/.test(String(cwd ?? ''))) return winPath
  if (String(target).startsWith('/') || String(cwd ?? '').startsWith('/')) return posixPath
  return process.platform === 'win32' ? winPath : posixPath
}

/** Resolve one path-shaped token to an absolute, normalized, comparable form. */
export function resolvePath(target, cwd) {
  const raw = String(target ?? '')
  if (raw.length === 0) return ''
  const expanded = raw.startsWith('~') ? String(homedir()) + raw.slice(1) : raw
  const base = cwd && cwd.length > 0 ? cwd : process.cwd()
  const api = pathFlavor(expanded, base)
  const absolute = api.isAbsolute(expanded) ? api.resolve(expanded) : api.resolve(base, expanded)
  return absolute.replace(/[\\/]+$/, '').toLowerCase()
}

/** Normalize a configured root the same way paths are compared. */
function normalizeRoot(root) {
  const api = pathFlavor(root, root)
  return api.resolve(String(root)).replace(/[\\/]+$/, '').toLowerCase()
}

/** Whether `child` is `root` or lives under it. */
function isUnder(child, root) {
  if (child.length === 0 || root.length === 0) return false
  return child === root || child.startsWith(root + '\\') || child.startsWith(root + '/')
}

/**
 * Blank the CONTENT of quoted regions, keeping the quotes and every offset.
 *
 * This is what makes the hard rules safe: a command that merely mentions
 * `format C:` inside a string is no longer confused with one that runs it.
 *
 * @param {string} text - the command text.
 * @returns {string} an equal-length copy with quoted content replaced by spaces.
 */
export function maskQuoted(text) {
  let out = ''
  let quote = null
  for (const char of String(text ?? '')) {
    if (quote !== null) {
      if (char === quote) {
        quote = null
        out += char
      } else {
        out += ' '
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      out += char
      continue
    }
    out += char
  }
  return out
}

/** Whether the text leaves a quote open, which makes any text analysis unsafe. */
export function hasUnbalancedQuote(text) {
  let quote = null
  for (const char of String(text ?? '')) {
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
  }
  return quote !== null
}

/**
 * Split a command line at real command positions and unwrap inner scripts.
 *
 * Separators inside quotes do not start a new command. The inner script of
 * `bash -c "…"` / `pwsh -Command "…"` / `cmd /c "…"` is returned as its own
 * segment so it is judged on its own text, with its own quoted content masked.
 *
 * @param {string} command - the raw command text.
 * @returns {{raw: string, masked: string}[]} one entry per command position,
 *   with common wrappers (`sudo`, `timeout 30`, `xargs …`, `find … -exec`)
 *   stripped.
 */
export function scanSegments(command) {
  const text = String(command ?? '')
  const starts = [0]
  let quote = null
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (quote !== null) {
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (char === ';' || char === '\n' || char === '\r' || char === '`') {
      starts.push(index + 1)
      index += 1
      continue
    }
    if (char === '&' || char === '|') {
      const doubled = text[index + 1] === char
      index += doubled ? 2 : 1
      starts.push(index)
      continue
    }
    if (char === '(' || (char === '$' && text[index + 1] === '(')) {
      index += char === '$' ? 2 : 1
      starts.push(index)
      continue
    }
    index += 1
  }

  const segments = []
  const push = (value) => {
    let segment = String(value)
    let previous = null
    while (segment !== previous) {
      previous = segment
      segment = segment.replace(/^\s+/, '').replace(WRAPPER_RE, '')
    }
    if (segment.length > 0) segments.push({ raw: segment, masked: maskQuoted(segment) })
  }

  for (const start of starts) {
    const tail = text.slice(start)
    push(tail)
    const inner = innerCommand(tail)
    if (inner !== null) push(inner)
  }
  return segments
}

/**
 * Extract the inner program text of a `-c` / `-Command` / `-e` invocation.
 *
 * The inner script of a shell or an interpreter is judged on its own text: an
 * inline `python -c "…"` or `node -e "…"` would otherwise hide entirely behind
 * the quotes that maskQuoted blanks.
 */
function innerCommand(segment) {
  if (!/^\s*(pwsh|powershell|bash|sh|zsh|cmd|python3?|node|deno|bun|ruby|perl)(\.exe)?\b/i.test(segment)) return null
  if (!/\s(-c|-command|-e|--eval|\/c)\s/i.test(segment)) return null
  const match = segment.match(/\s(?:-c|-command|-e|--eval|\/c)\s+(?:"([\s\S]*)"|'([\s\S]*)'|([\s\S]*))$/i)
  if (match === null) return null
  const inner = (match[1] ?? match[2] ?? match[3] ?? '').trim()
  return inner.length > 0 ? inner : null
}

/**
 * Whether any of the given characters appears OUTSIDE a quoted region.
 *
 * @param {string} text - the command text.
 * @param {string} chars - characters to look for.
 * @returns {boolean} true when at least one occurs unquoted.
 */
export function hasUnquoted(text, chars) {
  return hasUnquotedChar(text, (char) => chars.includes(char))
}

/** Whether a substring occurs outside quoted regions. */
function hasUnquotedToken(text, token) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (text.startsWith(token, index)) return true
  }
  return false
}

/** Generic unquoted-character scan. */
function hasUnquotedChar(text, predicate) {
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (predicate(char, text, index)) return true
  }
  return false
}

/**
 * Path-shaped tokens in a command line: quoted or bare, absolute or relative.
 *
 * @param {string} command - the command text.
 * @returns {string[]} the candidate targets.
 */
export function pathTokens(command) {
  const out = []
  const pattern = /"([^"]+)"|'([^']+)'|([A-Za-z]:\\[^\s"']+|\\\\[^\s"']+|\.{1,2}[\\/][^\s"']+|[A-Za-z0-9_\-\u4e00-\u9fff]+[\\/][^\s"']*)/g
  for (const match of String(command ?? '').matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3]
    if (value !== undefined && value.length > 0) out.push(value)
  }
  return out
}

/** The first bare word of a segment, lowercased, without quotes. */
function firstToken(segment) {
  const match = String(segment).match(/^\s*("[^"]*"|'[^']*'|[^\s]+)/)
  if (match === null) return ''
  return match[1].replace(/^["']|["']$/g, '').toLowerCase()
}

/**
 * Classify one target against the protected and sensitive roots.
 *
 * @param {string} target - a path-shaped token.
 * @param {string} cwd - the session working directory.
 * @param {string[]} roots - the roots to test.
 * @returns {{kind: 'harness'|'root'|'drive', root?: string}|undefined}
 */
export function hit(target, cwd, roots) {
  const raw = String(target ?? '')
  if (raw.length === 0) return undefined
  if (HARNESS_STATE_RE.test(raw.replace(/\//g, '\\'))) return { kind: 'harness' }
  const absolute = resolvePath(raw, cwd)
  if (absolute.length === 0) return undefined
  if (HARNESS_STATE_RE.test(absolute.replace(/\//g, '\\'))) return { kind: 'harness' }
  for (const root of roots) {
    const normalized = normalizeRoot(root)
    if (isUnder(absolute, normalized)) return { kind: 'root', root }
  }
  if (/^[a-z]:$/.test(absolute) || absolute === '/' || /^[a-z]:[\\/]$/.test(absolute)) return { kind: 'drive' }
  return undefined
}

/** Describe a hit for a human-readable reason. */
function describeHit(found) {
  if (found.kind === 'harness') return 'the harness state (.dsh)'
  if (found.kind === 'drive') return 'a drive root'
  return found.root
}

/** Unique hits for a list of targets. */
function hitsFor(targets, cwd, roots) {
  const seen = new Map()
  for (const target of targets) {
    const found = hit(target, cwd, roots)
    if (found === undefined) continue
    const key = found.kind + ':' + (found.root ?? '')
    if (!seen.has(key)) seen.set(key, found)
  }
  return [...seen.values()]
}

/** Whether a git invocation is one of the read-only forms. */
function isReadOnlyGit(rest) {
  const tokens = rest.trim().split(/\s+/).filter((token) => token.length > 0)
  const sub = (tokens[0] ?? '').toLowerCase()
  if (!READ_ONLY_GIT.has(sub)) return false
  const allowedFlag = READ_ONLY_GIT.get(sub)
  if (allowedFlag === null) return true
  return tokens.length === 1 || (tokens.length === 2 && allowedFlag.test(tokens[1]))
}

/** Whether a command is a literal, argument-free version probe. */
function isVersionProbe(command, rest) {
  const trimmed = rest.trim().toLowerCase()
  if (VERSION_PROBES.has(trimmed)) return true
  return trimmed.length === 0 && ['pwsh', 'node', 'npm', 'python', 'python3', 'git', 'dotnet', 'java', 'go'].includes(command)
}

/**
 * Layer-1 verdict for one pending call.
 *
 * @param {object} execution - `{ toolName, args }` for the pending call.
 * @param {object} context - `{ config, cwd, workspaceRoot }`.
 * @returns {{verdict: string, ruleId: string, reason: string}}
 */
export function evaluate(execution, context) {
  const tool = String(execution?.toolName ?? '')
  const args = execution?.args ?? {}
  const config = context?.config ?? { rules: {} }
  const rules = config.rules ?? {}
  const cwd = context?.cwd && context.cwd.length > 0 ? context.cwd : process.cwd()
  const workspaceRoot = context?.workspaceRoot && context.workspaceRoot.length > 0 ? context.workspaceRoot : cwd

  const readOnlyTools = new Set((rules.readOnlyTools ?? []).map((name) => name.toLowerCase()))
  const shellTools = new Set((rules.shellTools ?? []).map((name) => name.toLowerCase()))
  const writeTools = new Set((rules.writeTools ?? []).map((name) => name.toLowerCase()))
  const protectPaths = rules.protectPaths ?? []
  const sensitiveWritePaths = rules.sensitiveWritePaths ?? []
  const allowedRoots = [workspaceRoot, ...(rules.extraAllowedRoots ?? [])].filter((root) => typeof root === 'string' && root.length > 0)

  const lowerTool = tool.toLowerCase()

  if (shellTools.has(lowerTool)) {
    return evaluateShell(String(args.command ?? ''), { cwd, allowedRoots, protectPaths, sensitiveWritePaths, rules })
  }

  if (writeTools.has(lowerTool)) {
    const target = String(args.file_path ?? args.path ?? '')
    if (target.length === 0) {
      return { verdict: ESCALATE, ruleId: 'write-unresolved-target', reason: 'the write has no resolvable file_path, so what it modifies cannot be checked' }
    }
    const found = hit(target, cwd, sensitiveWritePaths)
    if (found !== undefined) {
      return {
        verdict: ESCALATE,
        ruleId: found.kind === 'harness' ? 'write-harness-state' : 'write-sensitive-path',
        reason: `this writes ${describeHit(found)}; confirm the exact target`,
      }
    }
    if (rules.fastAllowWorkspaceWrites !== false) {
      const absolute = resolvePath(target, cwd)
      if (allowedRoots.some((root) => isUnder(absolute, normalizeRoot(root)))) {
        return { verdict: ALLOW, ruleId: 'write-inside-workspace', reason: 'a write inside the session workspace' }
      }
    }
    return { verdict: ESCALATE, ruleId: 'write-outside-workspace', reason: 'this writes outside the session workspace' }
  }

  if (readOnlyTools.has(lowerTool)) {
    return { verdict: ALLOW, ruleId: 'read-only-tool', reason: `"${tool}" cannot mutate anything` }
  }

  return { verdict: ESCALATE, ruleId: 'unclassified-tool', reason: `"${tool}" is not classified by the rule set, so only the reviewer can judge it` }
}

/** Layer-1 verdict for one shell command. */
function evaluateShell(command, state) {
  const text = String(command ?? '')
  if (text.trim().length === 0) {
    return { verdict: ALLOW, ruleId: 'empty-command', reason: 'an empty command does nothing' }
  }

  // An unterminated quote makes every text-level conclusion unreliable
  // (masking would swallow the rest of the line), so nothing below may allow.
  if (hasUnbalancedQuote(text)) {
    return {
      verdict: ESCALATE,
      ruleId: 'unbalanced-quote',
      reason: 'the command leaves a quote open, so what it actually runs cannot be read; only the reviewer can judge it',
    }
  }

  const segments = scanSegments(text)
  // Judge verbs against every command position, not just the head: an inline
  // script's own code (already unwrapped into its own segment, and masked only
  // where IT quotes something) is reachable nowhere else.
  const maskedAll = segments.map((segment) => segment.masked).join('\n')

  if (state.rules.hardDeny !== false) {
    for (const segment of segments) {
      for (const rule of HARD_DENY_RULES) {
        if (rule.re.test(segment.masked)) {
          return {
            verdict: DENY,
            ruleId: `hard-deny:${rule.id}`,
            reason: `this command ${rule.why}. If that is genuinely intended, the user must run it by hand.`,
          }
        }
      }
    }
  }

  // Every recognisable target, taken from the whole command AND from each
  // command position: an inline script's own arguments are only reachable
  // through its segment, because masking blanked them in the outer text.
  const tokenSet = new Set(pathTokens(text))
  for (const segment of segments) {
    for (const token of pathTokens(segment.raw)) tokenSet.add(token)
  }
  const tokens = [...tokenSet]
  const destructive = DESTRUCTIVE_VERB.test(maskedAll) || DESTRUCTIVE_API.test(maskedAll)
  const writes = WRITE_VERB.test(maskedAll)
  const hits = hitsFor(tokens, state.cwd, state.protectPaths)

  if (destructive) {
    const harness = hits.find((found) => found.kind === 'harness')
    if (harness !== undefined) {
      return {
        verdict: DENY,
        ruleId: 'hard-deny:harness-state',
        reason: 'this deletes or overwrites the harness state (.dsh — session logs, storages, projection caches, profiles, skills, plugins). Recovering it takes a full day. It must be done by the user, by hand, with the harness closed.',
      }
    }
    const protectedHits = hits.filter((found) => found.kind !== 'harness')
    if (protectedHits.length > 0) {
      return {
        verdict: ESCALATE,
        ruleId: 'destructive-protected-root',
        reason: `this removes or overwrites data under ${[...new Set(protectedHits.map(describeHit))].join(', ')}. Confirm the exact path and scope.`,
      }
    }
    if (tokens.length === 0 && RECURSIVE_OR_FORCE.test(maskedAll)) {
      return {
        verdict: ESCALATE,
        ruleId: 'destructive-unresolved-scope',
        reason: 'a recursive or forced delete whose target cannot be read from the command text; the scope cannot be verified.',
      }
    }
    const wildcard = tokens.some((token) => /[*?]|%[A-Za-z_]+%|\$env:|\$home|\$profile/i.test(token))
    if (wildcard) {
      return {
        verdict: ESCALATE,
        ruleId: 'destructive-wildcard-target',
        reason: 'a delete whose target is a wildcard or an unresolved variable; the scope cannot be verified.',
      }
    }
  }

  if (HARNESS_CHANGE.test(maskedAll)) {
    return {
      verdict: ESCALATE,
      ruleId: 'harness-or-service-change',
      reason: 'this changes the harness installation, an installed package, or a system service or scheduled task.',
    }
  }

  if (writes) {
    const sensitive = hitsFor(tokens, state.cwd, state.sensitiveWritePaths).filter((found) => found.kind !== 'drive')
    if (sensitive.length > 0) {
      return {
        verdict: ESCALATE,
        ruleId: 'write-sensitive-location',
        reason: `this writes into ${[...new Set(sensitive.map(describeHit))].join(', ')}. Confirm the destination.`,
      }
    }
  }

  if (state.rules.fastAllowWorkspaceWrites !== false && tokens.length > 0 && (destructive || writes)) {
    const outside = tokens.filter((token) => {
      const absolute = resolvePath(token, state.cwd)
      if (absolute.length === 0) return true
      return !state.allowedRoots.some((root) => isUnder(absolute, normalizeRoot(root)))
    })
    if (outside.length === 0) {
      return { verdict: ALLOW, ruleId: 'write-inside-workspace', reason: 'every recognisable target is inside the session workspace' }
    }
  }

  if (state.rules.fastAllowReadOnlyShell !== false && isLiteralReadOnly(text, segments)) {
    return { verdict: ALLOW, ruleId: 'literal-read-only-shell', reason: 'a literal read-only command' }
  }

  // Last resort, and deliberately last: every deny and every sensitive-path
  // escalation above has already declined, so a whitelist entry can only
  // rescue a command the rules merely failed to recognise.
  for (const pattern of state.rules.fastAllowCommands ?? []) {
    let re = null
    try {
      re = new RegExp(pattern, 'i')
    } catch {
      continue
    }
    if (re.test(text)) {
      return { verdict: ALLOW, ruleId: 'configured-fast-allow', reason: `matches the configured fast-allow pattern ${JSON.stringify(pattern)}` }
    }
  }

  return { verdict: ESCALATE, ruleId: 'unclassified-shell', reason: 'no rule can prove what this command does' }
}

/**
 * Whether a command is *provably* read-only: a single allowlisted command with
 * no unquoted separator, redirect, substitution, wildcard or variable.
 *
 * Anything that cannot be proven escalates rather than being guessed at.
 */
function isLiteralReadOnly(command, segments) {
  if (hasUnquoted(command, '|><;&`')) return false
  if (hasUnquoted(command, '*?')) return false
  for (const token of ['$(', '${', '$env:', '%~', '!']) {
    if (hasUnquotedToken(command, token)) return false
  }
  if (/%[A-Za-z_]+%/.test(command)) return false
  if (segments.length !== 1) return false

  const segment = segments[0].raw
  const head = firstToken(segment)
  if (head.length === 0) return false
  const rest = segment.slice(segment.indexOf(head) + head.length).trim()

  const base = head.replace(/^.*[\\/]/, '').replace(/\.exe$/, '')
  if (base === 'git') return isReadOnlyGit(rest)
  if (READ_ONLY_COMMANDS.has(base)) return true
  if (isVersionProbe(base, rest)) return true
  return false
}
