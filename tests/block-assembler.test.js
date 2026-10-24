import test from 'node:test'
import assert from 'node:assert/strict'
import { BlockAssembler } from '../lib/block-assembler.js'

test('BlockAssembler keeps reasoning and text blocks and ignores other chunks', () => {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'reasoning-delta', text: 'thin' })
  assembler.push({ type: 'reasoning-delta', text: 'king' })
  assembler.push({ type: 'text-delta', text: 'a' })
  assembler.push({ type: 'text-delta', text: 'b' })
  assembler.push({ type: 'tool-call', text: 'ignore' })
  assembler.push({ type: 'text-delta', text: 'c' })
  assert.deepEqual(assembler.blocks(), [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'abc' },
  ])
})

test('BlockAssembler starts a new block when the kind alternates', () => {
  const assembler = new BlockAssembler()
  assembler.push({ type: 'text-delta', text: 'one' })
  assembler.push({ type: 'reasoning-delta', text: 'two' })
  assembler.push({ type: 'text-delta', text: 'three' })
  assert.deepEqual(assembler.blocks(), [
    { type: 'text', text: 'one' },
    { type: 'reasoning', text: 'two' },
    { type: 'text', text: 'three' },
  ])
})
