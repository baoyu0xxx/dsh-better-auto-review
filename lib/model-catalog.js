function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function optionalText(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The first non-empty string among several alias fields. */
function firstText(...values) {
  for (const value of values) {
    const text = optionalText(value)
    if (text !== undefined) return text
  }
  return undefined
}

function routeOf(value) {
  if (!record(value)) return null
  const provider = optionalText(value.provider)
  const model = optionalText(value.model)
  if (provider === undefined || model === undefined) return null
  const reasoningEffort = optionalText(value.reasoningEffort)
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function modelOf(value) {
  if (!record(value)) return null
  const id = optionalText(value.id)
  if (id === undefined) return null
  const name = optionalText(value.name)
  const reasoning = record(value.reasoning) ? value.reasoning : null
  const efforts = Array.isArray(reasoning?.efforts)
    ? reasoning.efforts.flatMap((effort) => {
      if (!record(effort)) return []
      const effortId = optionalText(effort.id)
      if (effortId === undefined) return []
      const effortName = optionalText(effort.name)
      const description = optionalText(effort.description)
      return [{
        id: effortId,
        ...(effortName === undefined ? {} : { name: effortName }),
        ...(description === undefined ? {} : { description }),
      }]
    })
    : []
  const defaultEffort = optionalText(reasoning?.defaultEffort)
  const projectedReasoning = efforts.length > 0 || defaultEffort !== undefined
    ? {
      efforts,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    }
    : undefined
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(projectedReasoning === undefined ? {} : { reasoning: projectedReasoning }),
  }
}

/** Project the host model catalog to the public, non-sensitive fields the picker needs. */
export function projectReviewerModelCatalog(value) {
  if (!record(value)) return { available: false, default: null, groups: [] }
  const groups = Array.isArray(value.groups)
    ? value.groups.flatMap((group) => {
      if (!record(group)) return []
      const id = optionalText(group.id)
      if (id === undefined || !Array.isArray(group.models)) return []
      const models = group.models.map(modelOf).filter((model) => model !== null)
      if (models.length === 0) return []
      const name = optionalText(group.name)
      return [{ id, ...(name === undefined ? {} : { name }), models }]
    })
    : []
  return {
    available: true,
    default: routeOf(value.default),
    groups,
  }
}

/**
 * Build the same catalog shape from the `llm` service instead.
 *
 * This is the fallback for a host profile without a session controller (or
 * without the native catalog surface). It never advertises reasoning efforts:
 * `llm.listModels` does not carry the effort vocabulary the session controller
 * does, and inventing one would show effort choices the route cannot accept.
 *
 * @param {object} llm - `{ listProviders, listModels }`.
 * @returns {Promise<object>} the projected catalog.
 */
export async function catalogFromProviders(llm) {
  if (llm === null || typeof llm !== 'object' || typeof llm.listProviders !== 'function') {
    return { available: false, default: null, groups: [] }
  }
  let providers = []
  try {
    providers = await llm.listProviders()
  } catch {
    providers = []
  }
  const groups = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!record(provider)) continue
    const id = firstText(provider.provider, provider.route, provider.id)
    if (id === undefined) continue
    const name = firstText(provider.name, provider.displayName, provider.label, provider.title) ?? id
    let models = []
    try {
      models = await llm.listModels(id)
    } catch {
      models = []
    }
    const projected = (Array.isArray(models) ? models : []).flatMap((model) => {
      if (!record(model)) return []
      const modelId = firstText(model.id, model.model, model.name)
      if (modelId === undefined) return []
      const modelName = firstText(model.name, model.displayName, model.label, model.title)
      return [{
        id: modelId,
        ...(modelName === undefined ? {} : { name: modelName }),
        ...(record(model.reasoning) ? { reasoning: model.reasoning } : {}),
      }]
    })
    const catalog = projectReviewerModelCatalog({ groups: [{ id, name, models: projected }] })
    if (catalog.groups.length > 0) groups.push(catalog.groups[0])
  }
  return { available: groups.length > 0, default: null, groups }
}
