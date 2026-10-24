/**
 * Config tests: the defaults, the schema and the resolved document must agree,
 * and every fallback must come from the environment it was given rather than
 * from this machine.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import zs from '@deepseek-ai/schemastery'
import { createDefaults, createSettingsSchema, resolveConfig } from '../lib/config.js'

const PINNED = { home: 'D:\\fake-home', dshHome: 'D:\\fake-dsh', platform: 'win32' }

test('fallbacks come from the supplied environment, not the host machine', () => {
  // An unusable entry forces `requiredList` to fall back; that fallback used to
  // be the host's real defaults even when a different environment was passed.
  const config = resolveConfig({ rules: { protectPaths: ['   '] } }, PINNED)
  assert.ok(config.rules.protectPaths.some((value) => value.includes('fake-home')))
  assert.ok(!config.rules.protectPaths.some((value) => value.includes('28055')))
})

test('the settings schema is exactly the defaults plus the two enums', () => {
  const defaults = createDefaults(PINNED)
  const schema = createSettingsSchema(zs, PINNED)
  assert.deepEqual(schema({}), defaults)
  assert.equal(schema({ gate: { mode: 'always' } }).gate.mode, 'always')
  assert.equal(schema({ review: { onError: 'deny' } }).review.onError, 'deny')
  assert.throws(() => schema({ gate: { mode: 'sometimes' } }))
})

test('the dead input budget is gone from every surface', () => {
  assert.equal('maxInputChars' in createDefaults(PINNED).review, false)
  assert.equal('maxInputChars' in resolveConfig({}, PINNED).review, false)
  assert.equal('maxInputChars' in createSettingsSchema(zs, PINNED)({}).review, false)
})

test('numbers are clamped instead of trusted', () => {
  const config = resolveConfig({
    review: { maxTokens: -1, tokenLimitRetries: -3, temperature: 9, timeoutMs: 0 },
    audit: { maxBytes: 0, maxArgChars: -1 },
  }, PINNED)
  assert.equal(config.review.maxTokens, createDefaults(PINNED).review.maxTokens)
  assert.equal(config.review.tokenLimitRetries, 0)
  assert.equal(config.review.temperature, 2)
  assert.equal(config.review.timeoutMs, createDefaults(PINNED).review.timeoutMs)
  assert.equal(config.audit.maxBytes, createDefaults(PINNED).audit.maxBytes)
  assert.equal(config.audit.maxArgChars, createDefaults(PINNED).audit.maxArgChars)
})
