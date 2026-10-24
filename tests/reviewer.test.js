/**
 * Layer-2 reviewer tests: the closed decision protocol, response tolerance, the
 * route/`sessionId` contract, and history budgets. All offline.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  REVIEW_POLICY, TruncatedReviewError, budgetForAttempt, buildRequest, classifyEvent,
  collectHistory, collectProjectInstructions, describeAction, parseDecision, readDecision,
  renderUserText, resolveReasoningEffort, resolveRoute,
} from '../lib/reviewer.js'
import { createAudit, redact, summarize } from '../lib/audit.js'
import { BlockAssembler } from '../lib/block-assembler.js'

test('non-mutating inspection does not require a detailed plan, regardless of tool', () => {
  assert.match(REVIEW_POLICY, /Non-mutating inspection actions.*are low/)
  assert.match(REVIEW_POLICY, /browsing, search, opening links, screenshots, reading page content, queries, previews, and status checks/)
  assert.match(REVIEW_POLICY, /do not require a detailed plan or separate approval/)
  assert.match(REVIEW_POLICY, /an opaque tool description or unspecified incidental effects are not themselves evidence of risk/)
  assert.match(REVIEW_POLICY, /submitting forms, sending messages, purchasing, editing or deleting external data, changing account settings/)
  assert.match(REVIEW_POLICY, /When the action and arguments indicate reading, querying, inspection, preview, or navigation, treat unspecified side effects as absent and allow/)
  assert.match(REVIEW_POLICY, /For non-mutating inspection actions, broad tool capabilities, missing detailed plans, or unstated incidental effects are not ambiguity/)
  assert.match(REVIEW_POLICY, /Fail closed only when the pending action or its target indicates a plausible listed medium or high effect/)
  assert.doesNotMatch(REVIEW_POLICY, /browser-plugin tools|in a browser remain medium/)
})

test('reasonable task-supporting actions are judged by impact, not literal enumeration', () => {
  assert.match(REVIEW_POLICY, /A human task implicitly authorizes ordinary, proportionate steps reasonably needed to complete it, even when not individually listed/)
  assert.match(REVIEW_POLICY, /A past tool call may prove the exact object this session created or that a child process\/job was started by this session for the current task/)
  assert.match(REVIEW_POLICY, /Stopping a known child process or job started by this same session for the current task is low/)
  assert.match(REVIEW_POLICY, /when no unsaved work, partial-write, data-loss, system-service, or other-user impact is indicated/)
  assert.match(REVIEW_POLICY, /Stopping unrelated, shared, production, or system processes.*remain medium/)
  assert.match(REVIEW_POLICY, /Assess the reason, necessity, target ownership, reversibility, and likely file or data harm/)
  assert.match(REVIEW_POLICY, /lack of a verbatim instruction is not by itself grounds to deny/)
})

// ---------------------------------------------------------------------------
// The decision protocol
// ---------------------------------------------------------------------------

test('every valid shape is accepted', () => {
  assert.deepEqual(parseDecision('{"risk":"low","decision":"allow"}'), { risk: 'low', decision: 'allow' })
  assert.deepEqual(parseDecision('{"risk":"medium","decision":"allow"}'), { risk: 'medium', decision: 'allow' })
  assert.deepEqual(parseDecision('{"risk":"medium","decision":"deny"}'), { risk: 'medium', decision: 'deny' })
  assert.deepEqual(parseDecision('{"risk":"medium","decision":"deny","reason":"wipes a pre-existing store"}'), { risk: 'medium', decision: 'deny', reason: 'wipes a pre-existing store' })
  assert.deepEqual(parseDecision('{"risk":"high","decision":"deny"}'), { risk: 'high', decision: 'deny' })
  assert.deepEqual(parseDecision('{"risk":"high","decision":"deny","reason":"credentials to an external host"}'), { risk: 'high', decision: 'deny', reason: 'credentials to an external host' })
})

test('invalid combinations are refused, not coerced', () => {
  for (const bad of [
    '{"risk":"low","decision":"deny"}',
    '{"risk":"high","decision":"allow"}',
    '{"risk":"low","decision":"allow","reason":"why not"}',
    '{"risk":"medium","decision":"allow","reason":"because"}',
    '{"risk":"medium","decision":"maybe"}',
    '{"risk":"extreme","decision":"deny"}',
    '{"risk":"medium","decision":"deny","reason":42}',
    '{"risk":"medium","decision":"deny","extra":true}',
    '{"decision":"allow"}',
    '{}',
  ]) {
    assert.throws(() => parseDecision(bad), /does not match the risk\/decision protocol|no JSON object/, bad)
  }
})

test('a duplicated member cannot smuggle an allow past the protocol', () => {
  // JSON.parse keeps the LAST duplicate, so this would otherwise read as a deny
  // with three members, or as an allow depending on order.
  assert.throws(() => parseDecision('{"risk":"low","decision":"allow","risk":"high"}'), /repeats a JSON member/)
})

test('a fenced, prose-wrapped or reasoning-led answer still parses', () => {
  assert.deepEqual(parseDecision('```json\n{"risk":"low","decision":"allow"}\n```'), { risk: 'low', decision: 'allow' })
  assert.deepEqual(parseDecision('Here is my verdict:\n{"risk":"low","decision":"allow"}\nDone.'), { risk: 'low', decision: 'allow' })
  assert.deepEqual(parseDecision('{"risk":"low","decision":"allow"} trailing note'), { risk: 'low', decision: 'allow' })
})

test('the LAST balanced object wins, so an example shape does not decide', () => {
  const text = 'Example: {"risk":"low","decision":"allow"}\nVerdict: {"risk":"high","decision":"deny","reason":"exfiltration"}'
  assert.deepEqual(parseDecision(text), { risk: 'high', decision: 'deny', reason: 'exfiltration' })
})

test('braces inside strings do not confuse the object scan', () => {
  assert.deepEqual(parseDecision('{"risk":"medium","decision":"deny","reason":"a } brace and a { brace"}'), {
    risk: 'medium', decision: 'deny', reason: 'a } brace and a { brace',
  })
})

test('an empty or non-JSON answer is an error', () => {
  assert.throws(() => parseDecision(''), /empty response/)
  assert.throws(() => parseDecision('I cannot decide.'), /no JSON object/)
  assert.throws(() => parseDecision('[1,2,3]'), /no JSON object/)
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** The real assembler production uses; reasoning blocks included. */
const assemblerFactory = () => new BlockAssembler()

/** A scripted chunk stream. */
async function* script(chunks) {
  for (const chunk of chunks) yield chunk
}

const stop = { type: 'finish', reason: { kind: 'stop' } }

test('a reasoning block followed by one text block is read', async () => {
  const decision = await readDecision(
    script([{ type: 'reasoning-delta', text: 'thinking…' }, { type: 'text-delta', text: '{"risk":"low",' }, { type: 'text-delta', text: '"decision":"allow"}' }, stop]),
    assemblerFactory,
  )
  assert.deepEqual(decision, { risk: 'low', decision: 'allow' })
})

test('a truncation is an error, never a decision', async () => {
  await assert.rejects(
    () => readDecision(script([{ type: 'text-delta', text: '{"risk":"hi' }, { type: 'finish', reason: { kind: 'max-tokens' } }]), assemblerFactory),
    (error) => error instanceof TruncatedReviewError,
  )
})

test('provider errors, aborts and a missing finish are errors', async () => {
  await assert.rejects(
    () => readDecision(script([{ type: 'finish', reason: { kind: 'error', failure: { code: 'X', message: 'boom' } } }]), assemblerFactory),
    /ended with error X: boom/,
  )
  await assert.rejects(
    () => readDecision(script([{ type: 'finish', reason: { kind: 'aborted' } }]), assemblerFactory),
    /ended with aborted/,
  )
  await assert.rejects(() => readDecision(script([{ type: 'text-delta', text: 'x' }]), assemblerFactory), /no terminal finish/)
  await assert.rejects(
    () => readDecision(script([stop, { type: 'text-delta', text: 'late' }]), assemblerFactory),
    /after its terminal finish/,
  )
})

test('a response with no text block, or with two, is an error', async () => {
  await assert.rejects(() => readDecision(script([{ type: 'reasoning-delta', text: 'only thinking' }, stop]), assemblerFactory), /exactly one text block/)
  await assert.rejects(
    () => readDecision(script([{ type: 'text-delta', text: 'a' }, { type: 'reasoning-delta', text: 'b' }, { type: 'text-delta', text: 'c' }, stop]), assemblerFactory),
    /exactly one text block/,
  )
})

// ---------------------------------------------------------------------------
// Route, sessionId, effort
// ---------------------------------------------------------------------------

test('the reviewer inherits the conversation route by default', () => {
  assert.deepEqual(resolveRoute({ headerConfig: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, settings: {} }), {
    provider: 'opencode-go', model: 'deepseek-v4.1-flash', inherited: true,
  })
})

test('an explicit pair overrides, a half-configured pair does not', () => {
  assert.deepEqual(resolveRoute({ headerConfig: { provider: 'a', model: 'b' }, settings: { provider: 'x', model: 'y' } }), {
    provider: 'x', model: 'y', inherited: false,
  })
  assert.deepEqual(resolveRoute({ headerConfig: { provider: 'a', model: 'b' }, settings: { provider: 'x', model: '' } }), {
    provider: 'a', model: 'b', inherited: true,
  })
})

test('buildRequest ALWAYS carries the session id — the opencode-go fix', () => {
  const request = buildRequest({
    route: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
    userText: 'ENVIRONMENT\n{}',
    maxTokens: 8192,
    sessionId: 'session-3d06223b-1a6c-4e49-9c54-c6baba0ac09f',
  })
  assert.equal(request.sessionId, 'session-3d06223b-1a6c-4e49-9c54-c6baba0ac09f')
  assert.equal(request.provider, 'opencode-go')
  assert.equal(request.model, 'deepseek-v4.1-flash')
  assert.equal(request.system, REVIEW_POLICY)
  assert.equal(request.maxTokens, 8192)
  // A null temperature must be OMITTED, not sent as 0: gateways that reject the
  // field reject the request outright.
  assert.equal('temperature' in request, false)
  assert.equal('reasoningEffort' in request, false)
})

test('temperature and effort are only sent when configured', () => {
  const request = buildRequest({
    route: { provider: 'p', model: 'm' },
    userText: 'x',
    maxTokens: 100,
    sessionId: 'session-1',
    temperature: 0,
    reasoningEffort: 'low',
    signal: undefined,
  })
  assert.equal(request.temperature, 0)
  assert.equal(request.reasoningEffort, 'low')
  assert.equal('signal' in request, false)
})

test('effort resolution prefers the lowest advertised level', () => {
  assert.equal(resolveReasoningEffort({ configured: 'high', advertised: ['low', 'high'] }), 'high')
  assert.equal(resolveReasoningEffort({ configured: '', advertised: ['max', 'high', 'low'] }), 'low')
  assert.equal(resolveReasoningEffort({ configured: '', advertised: { medium: 'medium', low: 'low' } }), 'low')
  assert.equal(resolveReasoningEffort({ configured: '', advertised: [] }), undefined)
  assert.equal(resolveReasoningEffort({ configured: '', advertised: undefined }), undefined)
})

test('the truncation budget doubles and stops at the ceiling', () => {
  assert.equal(budgetForAttempt({ attempt: 0, maxTokens: 8192, maxTokensLimit: 32768 }), 8192)
  assert.equal(budgetForAttempt({ attempt: 1, maxTokens: 8192, maxTokensLimit: 32768 }), 16384)
  assert.equal(budgetForAttempt({ attempt: 2, maxTokens: 8192, maxTokensLimit: 32768 }), 32768)
  assert.equal(budgetForAttempt({ attempt: 9, maxTokens: 8192, maxTokensLimit: 32768 }), 32768)
})

// ---------------------------------------------------------------------------
// History and action
// ---------------------------------------------------------------------------

test('events are classified by source, not by position', () => {
  assert.deepEqual(
    classifyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'delete the build dir' }], source: { kind: 'user' } } }),
    { role: 'human-instruction', text: 'delete the build dir' },
  )
  assert.deepEqual(
    classifyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'child task' }], source: { kind: 'agent' } } }),
    { role: 'direct-parent-instruction', text: 'child task' },
  )
  assert.equal(
    classifyEvent({ type: 'system/message', data: { message: { content: [{ type: 'text', text: 'you are an agent' }] } } }).role,
    'constraint',
  )
  assert.equal(
    classifyEvent({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'done' }] } }).role,
    'fact',
  )
  assert.equal(classifyEvent({ type: 'turn/start', data: {} }), null)
  assert.equal(classifyEvent({ type: 'user/message', data: { content: [] } }), null)
  // Workspace instructions are carried by PROJECT_INSTRUCTIONS instead.
  assert.equal(
    classifyEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'rules' }], source: { kind: 'agent-instructions' } } }),
    null,
  )
})

test('project instructions are collected once, newest kept', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'old rules' }], source: { kind: 'agent-instructions' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'new rules' }], source: { kind: 'agent-instructions' } } },
  ]
  assert.deepEqual(collectProjectInstructions(events, { maxProjectInstructionChars: 1000 }), ['old rules', 'new rules'])
  // Under pressure the OLDER instruction set is dropped, not truncated in place.
  assert.deepEqual(collectProjectInstructions(events, { maxProjectInstructionChars: 10 }), ['new rules'])
  // A single instruction set bigger than the whole budget is truncated in place.
  assert.deepEqual(collectProjectInstructions(events, { maxProjectInstructionChars: 4 }), ['new …[truncated]'])
})

test('the oldest history is dropped first and the loss is declared', () => {
  const events = []
  for (let index = 0; index < 10; index += 1) {
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(100) + index }], source: { kind: 'user' } } })
  }
  const history = collectHistory(events, { maxHistoryChars: 250 })
  assert.equal(history[0].role, 'checkpoint')
  assert.match(history[0].text, /omitted-context: \d+ earlier history item/)
  const kept = history.slice(1)
  assert.ok(kept.length > 0)
  assert.ok(kept.reduce((sum, item) => sum + item.text.length, 0) <= 250)
  // The NEWEST items are the ones that survive.
  assert.match(kept[kept.length - 1].text, /9$/)
  assert.equal(history.some((item) => item.text.includes('xxxxxxxxxx0')), false)
})

test('history within budget is passed through untouched', () => {
  const events = [{ type: 'user/message', data: { content: [{ type: 'text', text: 'short' }], source: { kind: 'user' } } }]
  assert.deepEqual(collectHistory(events, { maxHistoryChars: 1000 }), [{ role: 'human-instruction', text: 'short' }])
})

test('describeAction flags truncation instead of hiding it', () => {
  const small = describeAction({ toolName: 'pwsh', args: { command: 'git status' } }, { maxActionChars: 1000 })
  assert.equal(small.truncated, false)
  assert.deepEqual(small.action, { tool: 'pwsh', arguments: { command: 'git status' } })

  const big = describeAction({ toolName: 'write', args: { content: 'x'.repeat(5000) } }, { maxActionChars: 200 })
  assert.equal(big.truncated, true)
  assert.equal(big.action.argumentsTruncated, true)
  assert.ok(big.text.length < 300)
})

test('renderUserText emits the four sections in order', () => {
  const text = renderUserText({ cwd: 'D:\\p', projectInstructions: ['a'], history: [], action: { tool: 'pwsh' } })
  const order = ['ENVIRONMENT', 'PROJECT_INSTRUCTIONS', 'FILTERED_HISTORY', 'PENDING_ACTION'].map((section) => text.indexOf(section))
  assert.ok(order.every((at) => at >= 0))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
  // Compact JSON: indentation used to consume a visible share of the budget.
  assert.ok(text.includes('{"cwd":"D:\\\\p"}'))
})

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** A throwaway directory that the test removes afterwards. */
function tempDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'bar-audit-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('credentials never reach the audit log', () => {
  assert.deepEqual(redact({ apiKey: 'sk-abcdefghijklmnopqrstuv', command: 'echo hi' }), { apiKey: '[redacted]', command: 'echo hi' })
  assert.equal(redact('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), '[redacted]')
  assert.equal(redact({ nested: { password: 'hunter2' } }).nested.password, '[redacted]')
  assert.equal(redact({ note: 'plain text' }).note, 'plain text')
})

test('summaries are bounded', () => {
  assert.equal(summarize('abcdef', 3), 'abc…')
  assert.equal(summarize({ a: 1 }, 100), '{"a":1}')
})

test('the audit sink writes, reads back and can be disabled', (t) => {
  const directory = tempDir(t)
  const disabled = createAudit({ directory: join(directory, 'off'), config: { enabled: false } })
  disabled.record({ verdict: 'allow' })
  assert.deepEqual(disabled.read(10), [])

  const audit = createAudit({ directory: join(directory, 'on'), config: { enabled: true } })
  audit.record({ tool: 'pwsh', verdict: 'allow', layer: 1 })
  audit.record({ tool: 'write', verdict: 'deny', layer: 1 })
  const entries = audit.read(1)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].tool, 'write')
  assert.equal(typeof entries[0].at, 'string')
})

test('argument bodies are recorded only when enabled, redacted and bounded', (t) => {
  const directory = tempDir(t)
  const off = createAudit({ directory: join(directory, 'off'), config: { enabled: true } })
  off.record({ tool: 'pwsh', arguments: { command: 'echo hi', apiKey: 'sk-abcdefghijklmnopqrstuv' } })
  assert.equal(off.read(1)[0].arguments, undefined)

  const on = createAudit({ directory: join(directory, 'on'), config: { enabled: true, recordArguments: true, maxArgChars: 200 } })
  on.record({ tool: 'pwsh', arguments: { command: 'echo hi', apiKey: 'sk-abcdefghijklmnopqrstuv' } })
  const entry = on.read(1)[0]
  assert.match(entry.arguments, /\[redacted\]/)

  const short = createAudit({ directory: join(directory, 'short'), config: { enabled: true, recordArguments: true, maxArgChars: 10 } })
  short.record({ tool: 'pwsh', arguments: { command: 'echo hi' } })
  assert.ok(short.read(1)[0].arguments.endsWith('…'))
})

test('the audit tail is read without parsing the whole file, and rotates', (t) => {
  const directory = tempDir(t)
  const audit = createAudit({ directory, config: { enabled: true, maxBytes: 200 } })
  for (let index = 0; index < 20; index += 1) {
    audit.record({ tool: 'pwsh', verdict: 'allow', reason: 'x'.repeat(50) })
  }
  assert.equal(existsSync(join(directory, 'audit.jsonl.1')), true)
  const entries = audit.read(3)
  assert.ok(entries.length > 0 && entries.length <= 3)
  assert.equal(entries.at(-1).tool, 'pwsh')
})
