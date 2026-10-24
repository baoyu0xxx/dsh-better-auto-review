import assert from 'node:assert/strict'
import test from 'node:test'

import { catalogFromProviders, projectReviewerModelCatalog } from '../lib/model-catalog.js'

test('projects only selectable model metadata and route defaults', () => {
  const result = projectReviewerModelCatalog({
    default: { provider: 'router', model: 'small', reasoningEffort: 'low' },
    groups: [{
      id: 'router',
      name: 'Router',
      models: [{
        id: 'small',
        name: 'Small model',
        apiKey: 'must not leave the host',
        reasoning: {
          defaultEffort: 'low',
          efforts: [{ id: 'low', name: 'Low', description: 'Fast' }, { id: 'high' }],
        },
      }, { id: '' }],
    }, { id: 'empty', models: [] }],
  })

  assert.deepEqual(result, {
    available: true,
    default: { provider: 'router', model: 'small', reasoningEffort: 'low' },
    groups: [{
      id: 'router',
      name: 'Router',
      models: [{
        id: 'small',
        name: 'Small model',
        reasoning: {
          defaultEffort: 'low',
          efforts: [{ id: 'low', name: 'Low', description: 'Fast' }, { id: 'high' }],
        },
      }],
    }],
  })
})

test('degrades cleanly when the host has no usable model catalog', () => {
  assert.deepEqual(projectReviewerModelCatalog(undefined), { available: false, default: null, groups: [] })
  assert.deepEqual(projectReviewerModelCatalog({ groups: 'invalid' }), { available: true, default: null, groups: [] })
})

test('the llm fallback builds the same shape and survives a failing provider', async () => {
  const llm = {
    listProviders: () => [{ id: 'router', name: 'Router' }, { id: 'broken' }, { id: '' }],
    listModels: async (id) => {
      if (id === 'broken') throw new Error('provider unavailable')
      return [{ id: 'small', name: 'Small model' }, { model: 'tiny' }, { id: '' }]
    },
  }
  const catalog = await catalogFromProviders(llm)
  assert.equal(catalog.available, true)
  assert.deepEqual(catalog.groups, [{
    id: 'router',
    name: 'Router',
    models: [{ id: 'small', name: 'Small model' }, { id: 'tiny' }],
  }])
})

test('a missing llm service is an empty catalog, not a crash', async () => {
  assert.deepEqual(await catalogFromProviders(undefined), { available: false, default: null, groups: [] })
  assert.deepEqual(
    await catalogFromProviders({ listProviders: () => { throw new Error('no') } }),
    { available: false, default: null, groups: [] },
  )
})
