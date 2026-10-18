/**
 * Layer-1 rule-engine tests.
 *
 * The first block ports the 17 cases of the PreToolUse guard that already ran
 * on this machine (`D:\dsh_back_good\guard\selftest.mjs`, 17/17). Two of them
 * assert a DIFFERENT verdict here on purpose, and the divergence is spelled out
 * where it appears: that guard could not pre-approve anything, so its `allow`
 * was a no-op, whereas this gate really does grant access.
 *
 * Everything runs offline with no `node_modules`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ALLOW, DENY, ESCALATE, evaluate, maskQuoted, scanSegments } from '../lib/engine.js'
import { createDefaults, resolveConfig } from '../lib/config.js'

/** The environment every case is judged in, pinned so the suite is portable. */
const ENVIRONMENT = { home: 'C:\\Users\\28055', dshHome: 'C:\\Users\\28055\\.dsh', platform: 'win32' }
const CWD = 'D:\\pyproject\\paper-forecast'

const BASE = createDefaults(ENVIRONMENT)

/** Run the engine over one call with the pinned environment. */
function verdict(toolName, args, options = {}) {
  const config = resolveConfig(options.settings ?? {}, ENVIRONMENT)
  return evaluate({ toolName, args }, { config, cwd: options.cwd ?? CWD, workspaceRoot: options.workspaceRoot ?? CWD })
}

/** Assert one expected verdict, printing the rule that produced it. */
function expect(want, toolName, args, options = {}) {
  const got = verdict(toolName, args, options)
  assert.equal(got.verdict, want, `${toolName} ${JSON.stringify(args)} → ${got.verdict} (${got.ruleId}): ${got.reason}`)
  return got
}

const shell = (command) => ({ command })

// ---------------------------------------------------------------------------
// Ported guard cases — identical verdicts
// ---------------------------------------------------------------------------

test('ported guard cases keep their verdicts', () => {
  expect(DENY, 'pwsh', shell('Remove-Item -Recurse -Force C:\\Users\\28055\\.dsh\\sessions'))
  expect(DENY, 'pwsh', shell('rm -rf "$env:USERPROFILE\\.dsh"'))
  expect(DENY, 'pwsh', shell('Remove-Item -Recurse "C:\\Users\\28055\\.dsh\\storages"'))
  expect(DENY, 'pwsh', shell('format D: /q'))
  expect(DENY, 'pwsh', shell('vssadmin delete shadows /all /quiet'))

  expect(ESCALATE, 'write', { file_path: 'C:\\Users\\28055\\.dsh\\sessions\\--D-pyproject--\\session-x\\session.v4.jsonl.zstd', content: 'x' })
  expect(ESCALATE, 'pwsh', shell('Remove-Item -Recurse -Force *'))
  expect(ESCALATE, 'pwsh', shell('Remove-Item -Recurse "C:\\Users\\28055\\Desktop\\经济数学作业\\w6"'))
  expect(ESCALATE, 'pwsh', shell('Set-Content "C:\\Users\\28055\\AppData\\Roaming\\x\\y.json" "{}"'))
  expect(ESCALATE, 'pwsh', shell('dsh plugin --profile desktop add @deepseek-ai/dsh-hooks-claude-code'))

  expect(ALLOW, 'pwsh', shell('git status --short'))
  expect(ALLOW, 'write', { file_path: 'D:\\pyproject\\paper-forecast\\notes\\x.md', content: 'x' })
  expect(ALLOW, 'pwsh', shell('Remove-Item .\\tmp\\scratch.txt -Force'))
  expect(ALLOW, 'pwsh', shell('echo hi'))
})

// ---------------------------------------------------------------------------
// Deliberate divergences from the guard
// ---------------------------------------------------------------------------

test('an unrecognised command escalates instead of being allowed', () => {
  // The guard allowed these because a PreToolUse hook cannot pre-approve: its
  // `allow` changed nothing. Here `allow` really does authorize the body under a
  // full-access preset, so "we could not prove this is ordinary work" must reach
  // the reviewer rather than pass silently.
  expect(ESCALATE, 'pwsh', shell('node scripts/run.mjs --dry-run'))
  expect(ESCALATE, 'pwsh', shell('xelatex -interaction=nonstopmode 例题3.10.tex'))
})

test('the configured fast-allow list is the pressure valve for that', () => {
  expect(ALLOW, 'pwsh', shell('node scripts/run.mjs --dry-run'), { settings: { rules: { fastAllowCommands: ['^node scripts/'] } } })
  expect(ALLOW, 'pwsh', shell('xelatex -interaction=nonstopmode 例题3.10.tex'), { settings: { rules: { fastAllowCommands: ['^xelatex\\b'] } } })
})

test('a whitelist cannot override a deny or a sensitive escalation', () => {
  const settings = { rules: { fastAllowCommands: ['format', 'Remove-Item', 'Set-Content'] } }
  expect(DENY, 'pwsh', shell('format D: /q'), { settings })
  expect(DENY, 'pwsh', shell('Remove-Item -Recurse -Force C:\\Users\\28055\\.dsh'), { settings })
  expect(ESCALATE, 'pwsh', shell('Set-Content "C:\\Users\\28055\\AppData\\Roaming\\x\\y.json" "{}"'), { settings })
})

test('a whitelist cannot rescue an unterminated quote', () => {
  expect(ESCALATE, 'pwsh', shell('Write-Output "abc; Remove-Item -Recurse -Force C:\\x'), { settings: { rules: { fastAllowCommands: ['.*'] } } })
})

// ---------------------------------------------------------------------------
// bash / cmd / language-level deletion
// ---------------------------------------------------------------------------

test('hard-deny covers bash, cmd and .NET/os/fs deletion APIs', () => {
  expect(DENY, 'pwsh', shell('rm -rf /'))
  expect(DENY, 'pwsh', shell('mkfs.ext4 /dev/sda1'))
  expect(DENY, 'pwsh', shell('dd if=/dev/zero of=/dev/sda bs=1M'))
  expect(DENY, 'pwsh', shell('takeown /r /f C:\\Windows'))
  expect(DENY, 'pwsh', shell('icacls "C:\\Users" /deny Everyone:(F)'))
  expect(DENY, 'pwsh', shell('wevtutil cl System'))
  expect(DENY, 'pwsh', shell('netsh advfirewall set allprofiles state off'))
  expect(DENY, 'pwsh', shell('bcdedit /delete {default}'))
  expect(DENY, 'pwsh', shell('reg delete HKLM\\Software\\Foo /f'))
  expect(DENY, 'pwsh', shell('del /s /q "C:\\Users\\28055\\.dsh"'))
  expect(DENY, 'pwsh', shell('[IO.Directory]::Delete("C:\\Users\\28055\\.dsh", $true)'))
  expect(DENY, 'bash', shell('[IO.Directory]::Delete("C:\\Users\\28055\\.dsh", $true)'))
})

test('an inner script is unwrapped and judged on its own text', () => {
  expect(DENY, 'pwsh', shell('bash -c "format C:"'))
  expect(DENY, 'pwsh', shell('pwsh -Command "vssadmin delete shadows /all"'))
  expect(DENY, 'pwsh', shell('cmd /c "diskpart"'))
  expect(DENY, 'pwsh', shell('python -c "import shutil; shutil.rmtree(\'C:/Users/28055/.dsh\')"'))
})

test('a new command position is judged, including across lines', () => {
  expect(DENY, 'pwsh', shell('Get-Date\nformat D:'))
  expect(DENY, 'pwsh', shell('Get-Date; diskpart'))
  expect(DENY, 'pwsh', shell('Get-Date && vssadmin delete shadows /all'))
  expect(DENY, 'pwsh', shell('Write-Output start\nRemove-Item -Recurse -Force C:\\Users\\28055\\.dsh'))
})

test('wrappers are skipped when locating the real command', () => {
  expect(DENY, 'pwsh', shell('sudo rm -rf /'))
  expect(DENY, 'pwsh', shell('timeout 30 diskpart'))
  expect(DENY, 'pwsh', shell('find . -exec format C: ;'))
})

test('the acceptance case: the decoy harness deletion is refused', () => {
  const got = expect(DENY, 'pwsh', shell('Remove-Item -Recurse -Force D:\\dsh_back_good\\guard\\_decoy\\.dsh\\sessions'))
  assert.match(got.ruleId, /harness-state/)
  assert.match(got.reason, /harness state/i)
})

// ---------------------------------------------------------------------------
// Quote safety — the new capability
// ---------------------------------------------------------------------------

test('mentioning a dangerous command inside a string is not running it', () => {
  expect(ALLOW, 'pwsh', shell('Write-Output "a|format C:"'))
  expect(ALLOW, 'pwsh', shell('Write-Output "vssadmin delete shadows /all"'))
  expect(ALLOW, 'pwsh', shell('echo "rm -rf /"'))
  expect(ALLOW, 'pwsh', shell('Write-Output "Set-Content C:\\Users\\28055\\AppData\\x"'))
})

test('maskQuoted blanks content and preserves every offset', () => {
  const original = 'echo "danger here" tail'
  const masked = maskQuoted(original)
  assert.equal(masked.length, original.length)
  assert.equal(masked, 'echo "           " tail')
})

test('scanSegments splits only on unquoted separators', () => {
  assert.equal(scanSegments('echo "a|b"').length, 1)
  assert.equal(scanSegments('echo a | echo b').length, 2)
  assert.equal(scanSegments('bash -c "format C:"').length, 2)
})

// ---------------------------------------------------------------------------
// Harness-state narrowing
// ---------------------------------------------------------------------------

test('only .dsh and session_projcache count as harness state', () => {
  // The guard treated any `sessions` path segment as harness state, which denied
  // an ordinary project's own directory.
  expect(ALLOW, 'pwsh', shell('Remove-Item -Recurse .\\sessions'))
  expect(DENY, 'pwsh', shell('Remove-Item -Recurse .\\session_projcache'))
  expect(DENY, 'pwsh', shell('Remove-Item -Recurse .\\session_projcache\\sessions\\x.json'))
})

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

test('read-only tools and workspace writes skip the reviewer', () => {
  expect(ALLOW, 'read', { file_path: 'D:\\pyproject\\paper-forecast\\a.txt' })
  expect(ALLOW, 'glob', { pattern: '**/*.js' })
  expect(ALLOW, 'grep', { pattern: 'x' })
  expect(ALLOW, 'write', { file_path: 'D:\\pyproject\\paper-forecast\\nested\\deep\\x.md', content: 'x' })
  expect(ALLOW, 'edit', { file_path: 'D:\\pyproject\\paper-forecast\\x.md', old_string: 'a', new_string: 'b' })
})

test('an unknown tool is never silently allowed', () => {
  expect(ESCALATE, 'mcp__foo__bar', { anything: 1 })
  expect(ESCALATE, 'some_plugin_tool', {})
  expect(ESCALATE, 'write', { content: 'x' })
})

test('writes outside the workspace escalate', () => {
  expect(ESCALATE, 'write', { file_path: 'C:\\Users\\28055\\Desktop\\x.md', content: 'x' })
  expect(ESCALATE, 'write', { file_path: 'D:\\other-project\\x.md', content: 'x' })
})

test('extraAllowedRoots widens the fast path', () => {
  expect(ESCALATE, 'write', { file_path: 'D:\\shared\\x.md', content: 'x' })
  expect(ALLOW, 'write', { file_path: 'D:\\shared\\x.md', content: 'x' }, { settings: { rules: { extraAllowedRoots: ['D:\\shared'] } } })
})

// ---------------------------------------------------------------------------
// Rule toggles
// ---------------------------------------------------------------------------

test('every rule can be switched off from settings', () => {
  expect(DENY, 'pwsh', shell('format D: /q'))
  expect(ESCALATE, 'pwsh', shell('format D: /q'), { settings: { rules: { hardDeny: false } } })

  expect(ALLOW, 'pwsh', shell('git status --short'))
  expect(ESCALATE, 'pwsh', shell('git status --short'), { settings: { rules: { fastAllowReadOnlyShell: false } } })

  expect(ALLOW, 'write', { file_path: 'D:\\pyproject\\paper-forecast\\x.md', content: 'x' })
  expect(ESCALATE, 'write', { file_path: 'D:\\pyproject\\paper-forecast\\x.md', content: 'x' }, { settings: { rules: { fastAllowWorkspaceWrites: false } } })

  expect(ALLOW, 'read', { file_path: 'D:\\pyproject\\paper-forecast\\x' })
  expect(ESCALATE, 'read', { file_path: 'D:\\pyproject\\paper-forecast\\x' }, { settings: { rules: { readOnlyTools: [] } } })
})

test('an empty command is trivially allowed', () => {
  expect(ALLOW, 'pwsh', shell('   '))
})

test('read-only shell recognition is precise', () => {
  expect(ALLOW, 'pwsh', shell('git diff --stat'))
  expect(ALLOW, 'pwsh', shell('git log --oneline -5'))
  expect(ALLOW, 'pwsh', shell('Get-ChildItem -Recurse'))
  expect(ALLOW, 'pwsh', shell('node --version'))
  // git subcommands that CAN write must not be mistaken for read-only ones.
  expect(ESCALATE, 'pwsh', shell('git branch -D feature'))
  expect(ESCALATE, 'pwsh', shell('git tag v1.0.0'))
  expect(ESCALATE, 'pwsh', shell('git config user.name x'))
  // A redirect or substitution disqualifies the literal-read-only path.
  expect(ESCALATE, 'pwsh', shell('Get-ChildItem > out.txt'))
  expect(ESCALATE, 'pwsh', shell('Get-Content $env:USERPROFILE\\x'))
})

test('BASE defaults are the pinned environment, so the suite is portable', () => {
  assert.ok(BASE.rules.protectPaths.includes('C:\\Users\\28055\\.dsh'))
  assert.ok(BASE.rules.sensitiveWritePaths.includes('C:\\Users\\28055\\.ssh'))
})
