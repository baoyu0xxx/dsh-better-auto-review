// dsh-better-auto-review — Client half: the configuration page.
//
// Registered as a tab of Settings → Plugins, next to the shipped plugin
// inventory, and as a section on this plugin's own detail page. Both surfaces
// share one data hook and one set of controls, so they cannot drift apart.
//
// The Host half owns every fact: validation, persistence, the rule set and the
// audit log. This half only ever sends JSON to the plugin's own routes
// (/better-auto-review/*) and renders what comes back — it never imports a
// Harness package and never writes configuration directly.
//
// Styling follows DSH's own settings surface: one scoped stylesheet with the
// verified design tokens (`--dsw-*`, `--ds-font-family-code`), 0.5px card
// strokes, the 12/13/14px type scale, 32px controls and the shared focus ring.
window.__ModuleLoader__.load({
  id: 'dsh-better-auto-review',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const BASE = '/better-auto-review'
    const inject = ['slots']
    const LABEL = 'Better Auto Review'
    const EMPTY_CATALOG = { available: false, default: null, groups: [] }
    const CATALOG_TTL_MS = 30000

    // ---- stylesheet -------------------------------------------------------
    // One scoped sheet, injected once. Class names are prefixed `bar-` so they
    // cannot collide with DSH's hashed classes, and every colour/radius/font
    // comes from the app's own tokens so both themes follow automatically.
    const CSS = `
.bar-wrap{display:flex;flex-direction:column;gap:16px;width:100%;max-width:820px;padding-bottom:24px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px}
.bar-head{display:flex;flex-direction:column;gap:6px}
.bar-title{margin:0;font-size:18px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}
.bar-caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.bar-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.bar-banner{padding:8px 12px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-md,12px);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.bar-section{display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3));border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1))}
.bar-section-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.bar-section-title{margin:0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.bar-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px;align-items:start}
.bar-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bar-row>.bar-field{flex:1 1 220px}
.bar-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.bar-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.bar-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.bar-input,.bar-select,.bar-textarea{box-sizing:border-box;width:100%;min-height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.bar-input::placeholder,.bar-textarea::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.bar-input:hover:not(:disabled),.bar-select:hover:not(:disabled),.bar-textarea:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.bar-input:focus-visible,.bar-select:focus-visible,.bar-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.bar-input:disabled,.bar-select:disabled,.bar-textarea:disabled{opacity:.6;cursor:not-allowed}
.bar-select{appearance:none;-webkit-appearance:none;padding-right:30px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5 6 7.5 9 4.5' fill='none' stroke='%2381858C' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
.bar-textarea{padding:8px 10px;min-height:76px;resize:vertical;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}
.bar-mono{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.bar-check{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:32px;cursor:pointer}
.bar-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}
.bar-check-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.bar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px}
.bar-btn{height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer}
.bar-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.bar-btn:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.bar-btn:disabled{opacity:.4;cursor:not-allowed}
.bar-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.bar-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-state-business-primary))}
.bar-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.bar-status[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}
.bar-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.bar-verdict{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.bar-verdict[data-verdict="allow"]{color:var(--dsw-alias-state-success-primary)}
.bar-verdict[data-verdict="deny"]{color:var(--dsw-alias-state-error-primary)}
.bar-verdict[data-verdict="escalate"]{color:var(--dsw-alias-state-business-primary)}
.bar-probe-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bar-probe-row .bar-input{flex:1 1 300px;width:auto}
.bar-audit{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow:auto;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1)}
.bar-audit-line{font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
@media (max-width:520px){.bar-wrap{gap:14px}.bar-section{padding:12px}}
`

    /** Inject the scoped stylesheet exactly once per document. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="dsh-better-auto-review/settings.css"]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', 'dsh-better-auto-review/settings.css')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ---- host calls -------------------------------------------------------

    /** One JSON request against this plugin's own routes. */
    async function request(path, init) {
      const response = await fetch(`${BASE}${path}`, init)
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (response.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    // One catalog fetch serves both surfaces and repeated opens; Reload forces
    // a fresh read. Both the value and the in-flight promise are shared.
    let catalogCache = null
    let catalogPending = null

    async function fetchCatalog(force) {
      if (force !== true && catalogCache !== null && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
      if (catalogPending !== null) return catalogPending
      catalogPending = (async () => {
        try {
          const body = await request(`/models${force === true ? '?force=1' : ''}`)
          const value = body.ok === true && body.catalog ? body.catalog : EMPTY_CATALOG
          catalogCache = { at: Date.now(), value }
          return value
        } catch {
          return EMPTY_CATALOG
        }
      })()
      try {
        return await catalogPending
      } finally {
        catalogPending = null
      }
    }

    async function fetchAudit() {
      try {
        const body = await request('/audit?limit=15')
        return Array.isArray(body.entries) ? body.entries.slice().reverse() : []
      } catch {
        return []
      }
    }

    // ---- state helpers ----------------------------------------------------

    /** Immutably set one nested path on the draft config. */
    function setIn(object, path, value) {
      const next = { ...object }
      let node = next
      for (const key of path.slice(0, -1)) {
        node[key] = { ...node[key] }
        node = node[key]
      }
      node[path[path.length - 1]] = value
      return next
    }

    /**
     * The state one management surface needs.
     *
     * @param {object} options - `{ enabled, withAudit }`.
     */
    function useReviewData(options) {
      const enabled = options?.enabled !== false
      const withAudit = options?.withAudit === true
      const [remote, setRemote] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [catalog, setCatalog] = React.useState(EMPTY_CATALOG)
      const [audit, setAudit] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('')
      const [error, setError] = React.useState('')

      const load = React.useCallback(async (force) => {
        try {
          // All three reads go out together; they are independent.
          const [state, models, entries] = await Promise.all([
            request('/state'),
            fetchCatalog(force === true),
            withAudit ? fetchAudit() : Promise.resolve(null),
          ])
          if (state.ok !== true) throw new Error(state.error ?? 'state request failed')
          setRemote(state)
          setDraft(state.config)
          setCatalog(models)
          if (entries !== null) setAudit(entries)
          setError('')
          setStatus('')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [withAudit])

      React.useEffect(() => {
        if (enabled) load(false)
      }, [enabled, load])

      const patch = React.useCallback((path, value) => {
        setDraft((current) => (current === null ? current : setIn(current, path, value)))
        setStatus('unsaved changes')
      }, [])

      const patchRoute = React.useCallback((provider, model) => {
        setDraft((current) => (current === null ? current : { ...current, review: { ...current.review, provider, model, reasoningEffort: '' } }))
        setStatus('unsaved changes')
      }, [])

      const save = React.useCallback(async () => {
        setBusy(true)
        try {
          const body = await request('/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ config: draft }),
          })
          if (body.ok !== true) throw new Error(body.error ?? 'save failed')
          setDraft(body.config)
          setRemote((current) => (current === null ? current : { ...current, config: body.config }))
          setStatus('saved')
          setError('')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }, [draft])

      const reset = React.useCallback(async () => {
        setBusy(true)
        try {
          const body = await request('/reset', { method: 'POST' })
          if (body.ok !== true) throw new Error(body.error ?? 'reset failed')
          setDraft(body.config)
          setRemote((current) => (current === null ? current : { ...current, config: body.config }))
          setStatus('restored the defaults')
          setError('')
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        } finally {
          setBusy(false)
        }
      }, [])

      return { remote, draft, catalog, audit, busy, status, error, load, patch, patchRoute, save, reset }
    }

    // ---- controls ---------------------------------------------------------

    /** A labelled control with an optional hint underneath. */
    function Field(props) {
      return h('label', { className: 'bar-field' },
        h('span', { className: 'bar-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'bar-hint' }, props.hint) : null)
    }

    /** A titled settings card. */
    function Section(props) {
      return h('section', { className: 'bar-section' },
        h('div', { className: 'bar-section-head' },
          h('h3', { className: 'bar-section-title' }, props.title),
          props.hint ? h('span', { className: 'bar-hint' }, props.hint) : null),
        props.children)
    }

    /** A checkbox bound to a boolean config field. */
    function Toggle(props) {
      return h('label', { className: 'bar-check' },
        h('input', { type: 'checkbox', checked: props.checked === true, onChange: (event) => props.onChange(event.target.checked) }),
        h('span', { className: 'bar-check-label' }, props.label),
        props.hint ? h('span', { className: 'bar-hint' }, props.hint) : null)
    }

    /** A one-entry-per-line editor for a string-list config field. */
    function Lines(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('textarea', {
          className: 'bar-textarea',
          spellCheck: false,
          value: (props.value ?? []).join('\n'),
          onChange: (event) => props.onChange(event.target.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)),
        }))
    }

    /** A text config field. */
    function Text(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('input', {
          className: 'bar-input',
          type: 'text',
          value: props.value ?? '',
          placeholder: props.placeholder,
          onChange: (event) => props.onChange(event.target.value),
        }))
    }

    /** A number config field. */
    function Num(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('input', {
          className: 'bar-input',
          type: 'number',
          value: props.value ?? 0,
          min: props.min,
          max: props.max,
          step: props.step ?? 1,
          onChange: (event) => props.onChange(Number(event.target.value)),
        }))
    }

    /** The model + reasoning-effort pair shared by both surfaces. */
    function ReviewerModelFields(props) {
      const review = props.review
      const catalog = props.catalog ?? EMPTY_CATALOG
      const provider = review.provider ?? ''
      const model = review.model ?? ''
      const effort = review.reasoningEffort ?? ''
      const selectedModel = catalog.groups
        .find((group) => group.id === provider)?.models.find((entry) => entry.id === model)
      const efforts = selectedModel?.reasoning?.efforts ?? []
      const inherited = provider.length === 0 || model.length === 0
      const savedModelUnknown = !inherited && selectedModel === undefined
      const modelValue = inherited ? '' : JSON.stringify([provider, model])
      const defaultRoute = catalog.default
      const inheritLabel = defaultRoute === null || defaultRoute === undefined
        ? 'Inherit from conversation'
        : `Inherit from conversation · ${defaultRoute.provider}/${defaultRoute.model}`

      const modelOptions = catalog.groups.flatMap((group) => [
        h('optgroup', { key: group.id, label: group.name ?? group.id },
          ...group.models.map((entry) => h('option', { key: entry.id, value: JSON.stringify([group.id, entry.id]) }, entry.name ?? entry.id))),
      ])

      const modelHint = catalog.groups.length === 0
        ? 'No model is currently advertised by a configured provider; the reviewer uses the conversation model.'
        : catalog.available
          ? 'Advertised models from the configured DSH providers.'
          : 'Models advertised by the configured providers.'

      let effortControl
      let effortHint
      if (inherited) {
        effortControl = h('select', { className: 'bar-select', value: '', disabled: true },
          h('option', { value: '' }, 'Follows the conversation model'))
        effortHint = 'Choose a model to pick its reasoning effort.'
      } else if (efforts.length === 0) {
        effortControl = h('select', { className: 'bar-select', value: '', disabled: true },
          h('option', { value: '' }, effort.length > 0 ? `Saved value · ${effort}` : 'Not advertised for this model'))
        effortHint = 'This model does not advertise reasoning efforts.'
      } else {
        const currentListed = efforts.some((entry) => entry.id === effort)
        effortControl = h('select', {
          className: 'bar-select',
          value: effort,
          onChange: (event) => props.onPatch(['review', 'reasoningEffort'], event.target.value),
        },
        h('option', { value: '' }, `Model default${selectedModel?.reasoning?.defaultEffort ? ` · ${selectedModel.reasoning.defaultEffort}` : ''}`),
        effort.length > 0 && !currentListed
          ? h('option', { value: effort }, `Saved value · ${effort}`)
          : null,
        ...efforts.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name ?? entry.id)))
        effortHint = 'Only efforts advertised for the selected model are selectable.'
      }

      return h('div', { className: 'bar-grid' },
        h(Field, { label: 'Model', hint: modelHint },
          h('select', {
            className: 'bar-select',
            value: modelValue,
            disabled: catalog.groups.length === 0 && !savedModelUnknown,
            onChange: (event) => {
              if (event.target.value === '') return props.onRouteChange('', '')
              const [nextProvider, nextModel] = JSON.parse(event.target.value)
              return props.onRouteChange(nextProvider, nextModel)
            },
          },
          h('option', { value: '' }, inheritLabel),
          savedModelUnknown ? h('option', { value: JSON.stringify([provider, model]) }, `Saved · ${provider}/${model} (not advertised)`) : null,
          ...modelOptions)),
        h(Field, { label: 'Reasoning effort', hint: effortHint }, effortControl))
    }

    /** Loading and hard-failure placeholders shared by both surfaces. */
    function Loading(props) {
      if (props.error) {
        return h('div', { className: 'bar-wrap' },
          h('div', { className: 'bar-head' }, h('h2', { className: 'bar-title' }, LABEL)),
          h('p', { className: 'bar-error', role: 'alert' }, props.error),
          h('div', { className: 'bar-actions' }, h('button', { className: 'bar-btn', type: 'button', onClick: props.onRetry }, 'Retry')))
      }
      return h('div', { className: 'bar-wrap' }, h('p', { className: 'bar-hint' }, 'Loading…'))
    }

    /** `<actions>` row: primary save, reload, status and error. */
    function Actions(props) {
      return h('div', { className: 'bar-actions' },
        h('button', { className: 'bar-btn bar-btn-primary', type: 'button', disabled: props.busy || !props.canSave, onClick: props.onSave }, props.busy ? 'Saving…' : 'Save'),
        props.showReset === true ? h('button', { className: 'bar-btn', type: 'button', disabled: props.busy || !props.canSave, onClick: props.onReset }, 'Restore defaults') : null,
        h('button', { className: 'bar-btn', type: 'button', disabled: props.busy, onClick: () => props.onLoad(true) }, 'Reload'),
        h('span', { className: 'bar-status', 'data-tone': props.status === 'saved' ? 'success' : undefined, 'aria-live': 'polite' }, props.status),
        props.error ? h('span', { className: 'bar-error', role: 'alert' }, props.error) : null)
    }

    // ---- surfaces ---------------------------------------------------------

    /** The plugin detail page's card: route only. */
    function PluginReviewerSettings(props) {
      ensureStyles()
      const isTarget = props.subject?.kind === 'bundle' && props.subject.pkg.name === 'dsh-better-auto-review'
      const data = useReviewData({ enabled: isTarget })
      if (!isTarget) return null
      const canSave = data.remote?.settingsAvailable !== false && data.draft !== null

      return h('section', { className: 'bar-section' },
        h('div', { className: 'bar-section-head' },
          h('h3', { className: 'bar-section-title' }, 'Reviewer model'),
          h('span', { className: 'bar-hint' }, 'Layer 2 — used only when the rules cannot decide.')),
        data.draft === null
          ? h('div', { className: 'bar-field' },
            h('span', { className: data.error ? 'bar-error' : 'bar-hint', role: data.error ? 'alert' : undefined }, data.error || 'Loading model settings…'),
            data.error ? h('div', { className: 'bar-actions' }, h('button', { className: 'bar-btn', type: 'button', onClick: () => data.load(false) }, 'Retry')) : null)
          : h(React.Fragment, null,
            h(ReviewerModelFields, { review: data.draft.review, catalog: data.catalog, onPatch: data.patch, onRouteChange: data.patchRoute }),
            h(Actions, {
              busy: data.busy,
              canSave,
              status: data.status,
              error: data.error,
              onSave: data.save,
              onLoad: data.load,
            })))
    }

    function apply(ctx) {
      ensureStyles()

      /** Settings → Plugins: the full management tab. */
      function Page() {
        const data = useReviewData({ withAudit: true })
        const [probe, setProbe] = React.useState('')
        const [probeResult, setProbeResult] = React.useState(null)
        const canSave = data.remote?.settingsAvailable !== false && data.draft !== null

        const runProbe = async () => {
          if (probe.trim().length === 0) return
          try {
            const body = await request('/check', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ command: probe }),
            })
            setProbeResult(body.ok === true ? body : { verdict: 'error', reason: body.error ?? 'check failed' })
          } catch (failure) {
            setProbeResult({ verdict: 'error', reason: String(failure?.message ?? failure) })
          }
        }

        if (data.draft === null) return h(Loading, { error: data.error, onRetry: () => data.load(false) })

        const draft = data.draft
        const remote = data.remote ?? {}
        const hardDenyCount = remote.hardDenyRuleCount ?? remote.hardDenyRules?.length ?? 17

        return h('div', { className: 'bar-wrap' },
          h('div', { className: 'bar-head' },
            h('h2', { className: 'bar-title' }, LABEL),
            h('span', { className: 'bar-caption' }, `v${remote.version ?? '?'} · layer 1 rules + layer 2 review`)),
          remote.settingsAvailable === false ? h('div', { className: 'bar-banner' }, 'The settings store is unavailable, so changes cannot be saved.') : null,
          h('p', { className: 'bar-intro' },
            'Every tool call is judged by the deterministic rules first: a proven-ordinary call runs immediately, a proven-catastrophic one is refused. Only what the rules cannot settle reaches the reviewer model. ',
            `The gate is armed only while the "${remote.preset ?? 'better-auto-review'}" permission preset is selected.`),

          h(Section, { title: 'Gate', hint: 'when the two layers run' },
            h('div', { className: 'bar-row' },
              h(Toggle, { label: 'Enabled', checked: draft.enabled, hint: 'off means every call passes through untouched', onChange: (value) => data.patch(['enabled'], value) }),
              h(Field, { label: 'Mode', hint: draft.gate.mode === 'preset' ? `only while the "${draft.gate.preset}" preset is selected` : 'every session, whatever the preset' },
                h('select', { className: 'bar-select', value: draft.gate.mode, onChange: (event) => data.patch(['gate', 'mode'], event.target.value) },
                  h('option', { value: 'preset' }, 'preset — opt in per session'),
                  h('option', { value: 'always' }, 'always — every session'))),
              h(Text, { label: 'Preset name', value: draft.gate.preset, hint: 'must match the preset key in cordis.patch.yml', onChange: (value) => data.patch(['gate', 'preset'], value) }))),

          h(Section, { title: 'Reviewer', hint: 'layer 2 — model route and request settings' },
            h(ReviewerModelFields, { review: draft.review, catalog: data.catalog, onPatch: data.patch, onRouteChange: data.patchRoute }),
            h('div', { className: 'bar-row' },
              h(Num, { label: 'Output budget', value: draft.review.maxTokens, min: 256, step: 256, hint: 'doubled once per truncation', onChange: (value) => data.patch(['review', 'maxTokens'], value) }),
              h(Num, { label: 'Budget ceiling', value: draft.review.maxTokensLimit, min: 256, step: 256, onChange: (value) => data.patch(['review', 'maxTokensLimit'], value) }),
              h(Num, { label: 'Timeout (ms)', value: draft.review.timeoutMs, min: 1000, step: 1000, onChange: (value) => data.patch(['review', 'timeoutMs'], value) })),
            h('div', { className: 'bar-row' },
              h(Field, { label: 'On review failure', hint: draft.review.onError === 'ask' ? 'the human is asked; the reviewer never silently allows' : 'the call is refused outright, as the shipped Auto review does' },
                h('select', { className: 'bar-select', value: draft.review.onError, onChange: (event) => data.patch(['review', 'onError'], event.target.value) },
                  h('option', { value: 'ask' }, 'ask the human'),
                  h('option', { value: 'deny' }, 'refuse the call'))),
              h(Num, { label: 'History budget (chars)', value: draft.review.maxHistoryChars, min: 0, step: 2000, hint: 'oldest dropped first', onChange: (value) => data.patch(['review', 'maxHistoryChars'], value) }),
              h(Num, { label: 'Action budget (chars)', value: draft.review.maxActionChars, min: 1000, step: 1000, hint: 'never judged truncated', onChange: (value) => data.patch(['review', 'maxActionChars'], value) }))),

          h(Section, { title: 'Layer 1 rules', hint: `${hardDenyCount} built-in hard refusals, then the paths and toggles below` },
            h('div', { className: 'bar-row' },
              h(Toggle, { label: 'Hard-deny floor', checked: draft.rules.hardDeny, hint: 'disk, boot, security controls, the harness state', onChange: (value) => data.patch(['rules', 'hardDeny'], value) }),
              h(Toggle, { label: 'Fast-allow workspace writes', checked: draft.rules.fastAllowWorkspaceWrites, onChange: (value) => data.patch(['rules', 'fastAllowWorkspaceWrites'], value) }),
              h(Toggle, { label: 'Fast-allow read-only shell', checked: draft.rules.fastAllowReadOnlyShell, onChange: (value) => data.patch(['rules', 'fastAllowReadOnlyShell'], value) })),
            h('div', { className: 'bar-row' },
              h(Lines, { label: 'Protected paths', value: draft.rules.protectPaths, hint: 'deleting under these always asks; one per line', onChange: (value) => data.patch(['rules', 'protectPaths'], value) })),
            h('div', { className: 'bar-row' },
              h(Lines, { label: 'Sensitive write paths', value: draft.rules.sensitiveWritePaths, hint: 'writing into these always asks; one per line', onChange: (value) => data.patch(['rules', 'sensitiveWritePaths'], value) })),
            h('div', { className: 'bar-row' },
              h(Lines, { label: 'Extra allowed roots', value: draft.rules.extraAllowedRoots, hint: 'more roots treated as the workspace; one per line', onChange: (value) => data.patch(['rules', 'extraAllowedRoots'], value) })),
            h('div', { className: 'bar-row' },
              h(Lines, { label: 'Fast-allow command patterns', value: draft.rules.fastAllowCommands, hint: 'regexes; a last resort, applied only when no deny or escalation matched. Put everyday commands here (a compiler, a test runner) to stop them costing a model request.', onChange: (value) => data.patch(['rules', 'fastAllowCommands'], value) }))),

          h(Section, { title: 'Try a command against layer 1', hint: 'dry run — nothing is executed, the reviewer is not called' },
            h('div', { className: 'bar-probe-row' },
              h('input', {
                className: 'bar-input bar-mono',
                type: 'text',
                spellCheck: false,
                value: probe,
                placeholder: 'e.g. Remove-Item -Recurse -Force C:\\Users\\me\\.dsh',
                onChange: (event) => setProbe(event.target.value),
                onKeyDown: (event) => { if (event.key === 'Enter') runProbe() },
              }),
              h('button', { className: 'bar-btn', type: 'button', onClick: runProbe }, 'Check')),
            probeResult === null ? null : h('div', { className: 'bar-field' },
              h('span', { className: 'bar-verdict', 'data-verdict': probeResult.verdict }, `${probeResult.verdict} · ${probeResult.rule ?? ''}`),
              h('span', { className: 'bar-hint' }, probeResult.reason ?? ''))),

          h(Section, { title: 'Audit log', hint: remote.auditPath ?? 'disabled' },
            h('div', { className: 'bar-row' },
              h(Toggle, { label: 'Record decisions', checked: draft.audit.enabled, onChange: (value) => data.patch(['audit', 'enabled'], value) }),
              h(Toggle, { label: 'Record arguments', checked: draft.audit.recordArguments, hint: 'credential-shaped values are always redacted', onChange: (value) => data.patch(['audit', 'recordArguments'], value) })),
            data.audit.length === 0
              ? h('p', { className: 'bar-hint' }, 'No decisions recorded yet.')
              : h('div', { className: 'bar-audit' },
                data.audit.map((entry, index) => h('span', { className: 'bar-audit-line', key: `${entry.at ?? 'x'}-${index}` },
                  `${entry.at ?? '?'}  L${entry.layer ?? '?'}  ${entry.verdict ?? '?'}  ${entry.tool ?? '?'}  ${entry.rule ?? entry.risk ?? ''}`)))),

          h(Actions, {
            busy: data.busy,
            canSave,
            status: data.status,
            error: data.error,
            showReset: true,
            onSave: data.save,
            onReset: data.reset,
            onLoad: data.load,
          }))
      }

      // Settings → Plugins, as its own tab beside the plugin inventory. The slot
      // is declared by the settings-plugins section, so `slots.inject` defers
      // this until the declaration exists.
      ctx.slots.inject('settings.plugins.tab', () => {
        try {
          ctx.slots.register({ name: 'settings.plugins.tab', id: 'better-auto-review', order: 60, label: LABEL }, Page)
        } catch (failure) {
          console.error('[dsh-better-auto-review] settings tab registration failed:', failure)
        }
      })

      ctx.slots.inject('plugins.detail.section', () => {
        try {
          ctx.slots.register({ name: 'plugins.detail.section', id: 'better-auto-review-reviewer', order: 20 }, PluginReviewerSettings)
        } catch (failure) {
          console.error('[dsh-better-auto-review] plugin detail settings registration failed:', failure)
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
