import test from 'node:test'
import assert from 'node:assert/strict'
import { BlockAssembler } from '../lib/block-assembler.js'

test('BlockAssembler groups adjacent text deltas and ignores other chunks', () => {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'reasoning-delta', text: 'ignore' })
  assembler.push({ type: 'text-delta', text: 'a' })
  assembler.push({ type: 'text-delta', text: 'b' })
  assembler.push({ type: 'tool-call', text: 'ignore' })
  assembler.push({ type: 'text-delta', text: 'c' })
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'abc' }])
})
