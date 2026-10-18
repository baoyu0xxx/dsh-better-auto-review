#!/usr/bin/env node
/**
 * Offline self-check: no DSH, no network, no node_modules.
 *
 * This is the acceptance table a reader can run after `git clone` to see what
 * the rules actually decide. It reuses the 17 PreToolUse cases the previous
 * guard on this machine passed, marks the two verdicts this design deliberately
 * changes, and adds the cases the guard did not cover.
 *
 * `npm test` runs the full suite; this is the read-at-a-glance version.
 */
import { ALLOW, DENY, ESCALATE, evaluate, maskQuoted, scanSegments } from './lib/engine.js'
import { createDefaults, resolveConfig } from './lib/config.js'
import { parseDecision } from './lib/reviewer.js'
import { redact } from './lib/audit.js'

const ENVIRONMENT = { home: 'C:\\Users\\28055', dshHome: 'C:\\Users\\28055\\.dsh', platform: 'win32' }
const CWD = 'D:\\pyproject\\paper-forecast'
const config = resolveConfig({}, ENVIRONMENT)

let pass = 0
let fail = 0

/** Judge one shell command. */
const shell = (command, overrides) => evaluate(
  { toolName: 'pwsh', args: { command } },
  { config: overrides === undefined ? config : resolveConfig(overrides, ENVIRONMENT), cwd: CWD, workspaceRoot: CWD },
)

/** Judge one non-shell tool call. */
const tool = (toolName, args, overrides) => evaluate(
  { toolName, args },
  { config: overrides === undefined ? config : resolveConfig(overrides, ENVIRONMENT), cwd: CWD, workspaceRoot: CWD },
)

function expect(want, got, label, detail) {
  const ok = got.verdict === want
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'}  want=${want.padEnd(8)} got=${got.verdict.padEnd(8)} ${label}`)
  if (!ok || detail === true) console.log(`        ${got.ruleId}: ${got.reason}`)
}

function check(label, ok, detail = '') {
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('=== the 17 cases the previous PreToolUse guard passed ===')
expect(DENY, shell('Remove-Item -Recurse -Force C:\\Users\\28055\\.dsh\\sessions'), 'deny  rm -rf the harness home')
expect(DENY, shell('rm -rf "$env:USERPROFILE\\.dsh"'), 'deny  delete .dsh via variable')
expect(DENY, shell('Remove-Item -Recurse "C:\\Users\\28055\\.dsh\\storages"'), 'deny  delete storages subtree')
expect(DENY, shell('format D: /q'), 'deny  format a volume')
expect(DENY, shell('vssadmin delete shadows /all /quiet'), 'deny  delete shadow copies')
expect(ESCALATE, tool('write', { file_path: 'C:\\Users\\28055\\.dsh\\sessions\\--D-pyproject--\\session-x\\session.v4.jsonl.zstd', content: 'x' }), 'ask   edit a session log')
expect(ESCALATE, shell('Remove-Item -Recurse -Force *'), 'ask   recursive delete, unknown scope')
expect(ESCALATE, shell('Remove-Item -Recurse "C:\\Users\\28055\\Desktop\\经济数学作业\\w6"'), 'ask   delete under Desktop')
expect(ESCALATE, shell('Set-Content "C:\\Users\\28055\\AppData\\Roaming\\x\\y.json" "{}"'), 'ask   write into AppData')
expect(ESCALATE, shell('dsh plugin --profile desktop add @deepseek-ai/dsh-hooks-claude-code'), 'ask   plugin/package change')
expect(ALLOW, shell('git status --short'), 'allow git status')
expect(ALLOW, tool('write', { file_path: 'D:\\pyproject\\paper-forecast\\notes\\x.md', content: 'x' }), 'allow write inside the workspace')
expect(ALLOW, shell('Remove-Item .\\tmp\\scratch.txt -Force'), 'allow deleting a temp file in the workspace')
expect(ALLOW, shell('echo hi'), 'allow echo hi')

console.log('\n=== two deliberate changes to that guard\'s verdicts ===')
console.log('    (its `allow` was a no-op: a PreToolUse hook cannot pre-approve. Here')
console.log('     `allow` really authorizes, so "not provably ordinary" must escalate.)')
expect(ESCALATE, shell('node scripts/run.mjs --dry-run'), 'escalate  node script in the workspace (guard allowed)')
expect(ESCALATE, shell('xelatex -interaction=nonstopmode 例题3.10.tex'), 'escalate  xelatex on course work (guard allowed)')
expect(ALLOW, shell('xelatex -interaction=nonstopmode 例题3.10.tex', { rules: { fastAllowCommands: ['^xelatex\\b'] } }), 'allow     the same command once whitelisted')

console.log('\n=== cases the guard did not cover ===')
expect(DENY, shell('rm -rf /'), 'deny  rm -rf the filesystem root')
expect(DENY, shell('bash -c "format C:"'), 'deny  format hidden inside bash -c')
expect(DENY, shell('python -c "import shutil; shutil.rmtree(\'C:/Users/28055/.dsh\')"'), 'deny  .NET/fs deletion one-liner')
expect(DENY, shell('Get-Date; diskpart'), 'deny  dangerous command after a separator')
expect(DENY, shell('Remove-Item -Recurse -Force D:\\dsh_back_good\\guard\\_decoy\\.dsh\\sessions'), 'deny  the decoy harness deletion')
expect(ALLOW, shell('Write-Output "a|format C:"'), 'allow a dangerous command merely mentioned in a string')
expect(ALLOW, shell('Write-Output "vssadmin delete shadows /all"'), 'allow a rule name merely mentioned in a string')
expect(ALLOW, shell('Remove-Item -Recurse .\\sessions'), 'allow a project\'s own "sessions" directory')
expect(DENY, shell('Remove-Item -Recurse .\\session_projcache'), 'deny  the DSH-unique projection cache')
expect(ESCALATE, shell('Write-Output "abc; Remove-Item -Recurse -Force C:\\x'), 'escalate an unterminated quote')
expect(ESCALATE, tool('mcp__foo__bar', {}), 'escalate an unclassified tool')
expect(ALLOW, tool('read', { file_path: 'D:\\pyproject\\paper-forecast\\a.txt' }), 'allow a read-only tool')

console.log('\n=== helper invariants ===')
check('maskQuoted preserves offsets', maskQuoted('echo "danger here" tail') === 'echo "           " tail', maskQuoted('echo "a"'))
check('quoted separators do not split commands', scanSegments('echo "a|b"').length === 1)
check('bash -c yields an inner command position', scanSegments('bash -c "format C:"').length === 2)

console.log('\n=== the reviewer protocol ===')
check('a valid allow parses', parseDecision('{"risk":"low","decision":"allow"}').decision === 'allow')
check('a fenced answer parses', parseDecision('```json\n{"risk":"high","decision":"deny","reason":"leak"}\n```').risk === 'high')
let refused = false
try {
  parseDecision('{"risk":"high","decision":"allow"}')
} catch {
  refused = true
}
check('high + allow is refused', refused)

console.log('\n=== the audit log redacts ===')
check('an api key is redacted', redact({ apiKey: 'sk-abcdefghijklmnopqrstuv' }).apiKey === '[redacted]')
check('a github token is redacted', redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') === '[redacted]')
check('ordinary text survives', redact({ command: 'git status' }).command === 'git status')

console.log('\n=== configuration defaults are the safe ones ===')
check('the gate defaults to the preset mode', createDefaults(ENVIRONMENT).gate.mode === 'preset')
check('a reviewer failure asks by default', config.review.onError === 'ask')
check('the shipped protect list includes ~/.dsh', config.rules.protectPaths.includes('C:\\Users\\28055\\.dsh'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
