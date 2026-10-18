// dsh-better-auto-review — Client half: the configuration page.
//
// Registered as a tab of Settings → Plugins, next to the shipped plugin
// inventory. `settings.plugins.tab` is declared by
// `@deepseek-ai/dsh-client-ui-settings-plugins` (verified in this build), and
// `slots.inject` defers the registration until that declaration exists, so no
// load-order dependency is required.
//
// The Host half owns every fact: validation, persistence, the rule set and the
// audit log. This half only ever sends JSON to the plugin's own routes
// (/better-auto-review/*) and renders what comes back — it never imports a
// Harness package and never writes configuration directly.
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

    // ---- theme-token styling (no hardcoded palette) -----------------------
    const border = '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35))'
    const card = {
      border,
      borderRadius: '10px',
      padding: '12px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
    }
    const wrap = { display: 'flex', flexDirection: 'column', gap: '14px', width: '100%', maxWidth: '880px', paddingBottom: '24px' }
    const title = { fontSize: '16px', fontWeight: 600, margin: 0 }
    const subtitle = { fontSize: '12px', lineHeight: '18px', opacity: 0.7, margin: 0 }
    const hint = { fontSize: '12px', lineHeight: '17px', opacity: 0.68, margin: 0 }
    const row = { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }
    const control = {
      padding: '5px 9px',
      border,
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      minWidth: 0,
    }
    const mono = { ...control, font: '12px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
    const lines = { ...mono, width: '100%', minHeight: '76px', resize: 'vertical', boxSizing: 'border-box' }
    const labelStyle = { fontSize: '12px', fontWeight: 600, minWidth: '190px' }
    const field = { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 260px', minWidth: 0 }
    const sectionTitle = { fontSize: '13px', fontWeight: 600, margin: 0, opacity: 0.9 }

    /** One labelled control with an optional hint underneath. */
    function Field(props) {
      return h('div', { style: field },
        h('span', { style: labelStyle }, props.label),
        props.children,
        props.hint ? h('span', { style: hint }, props.hint) : null)
    }

    /** A titled group of fields. */
    function Section(props) {
      return h('section', { style: card },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
          h('h3', { style: sectionTitle }, props.title),
          props.hint ? h('span', { style: hint }, props.hint) : null),
        props.children)
    }

    /** A checkbox bound to a boolean config field. */
    function Toggle(props) {
      return h('label', { style: { ...row, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked: props.checked === true, onChange: (event) => props.onChange(event.target.checked) }),
        h('span', { style: { fontSize: '13px' } }, props.label),
        props.hint ? h('span', { style: hint }, props.hint) : null)
    }

    /** A one-entry-per-line editor for a string-list config field. */
    function Lines(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('textarea', {
          style: lines,
          spellCheck: false,
          value: (props.value ?? []).join('\n'),
          onChange: (event) => props.onChange(event.target.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)),
        }))
    }

    /** A text config field. */
    function Text(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('input', { style: control, type: 'text', value: props.value ?? '', placeholder: props.placeholder, onChange: (event) => props.onChange(event.target.value) }))
    }

    /** A number config field. */
    function Num(props) {
      return h(Field, { label: props.label, hint: props.hint },
        h('input', { style: control, type: 'number', value: props.value ?? 0, min: props.min, max: props.max, step: props.step ?? 1, onChange: (event) => props.onChange(Number(event.target.value)) }))
    }

    function apply(ctx) {
      function Page() {
        const [remote, setRemote] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [status, setStatus] = React.useState('')
        const [error, setError] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [audit, setAudit] = React.useState([])
        const [probe, setProbe] = React.useState('')
        const [probeResult, setProbeResult] = React.useState(null)

        const load = React.useCallback(async () => {
          try {
            const response = await fetch(`${BASE}/state`)
            const body = await response.json()
            if (body.ok !== true) throw new Error(body.error ?? 'state request failed')
            setRemote(body)
            setDraft(body.config)
            setError('')
            const log = await fetch(`${BASE}/audit?limit=15`)
            const logBody = await log.json()
            setAudit(Array.isArray(logBody.entries) ? logBody.entries.slice().reverse() : [])
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          }
        }, [])

        React.useEffect(() => {
          load()
        }, [load])

        const patch = (path, value) => {
          setDraft((current) => {
            const next = { ...current }
            let node = next
            for (const key of path.slice(0, -1)) {
              node[key] = { ...node[key] }
              node = node[key]
            }
            node[path[path.length - 1]] = value
            return next
          })
          setStatus('unsaved changes')
        }

        const save = async () => {
          setBusy(true)
          try {
            const response = await fetch(`${BASE}/config`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ config: draft }),
            })
            const body = await response.json()
            if (body.ok !== true) throw new Error(body.error ?? 'save failed')
            setDraft(body.config)
            setStatus('saved')
            setError('')
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setBusy(false)
          }
        }

        const reset = async () => {
          setBusy(true)
          try {
            const response = await fetch(`${BASE}/reset`, { method: 'POST' })
            const body = await response.json()
            if (body.ok !== true) throw new Error(body.error ?? 'reset failed')
            setDraft(body.config)
            setStatus('restored the defaults')
            setError('')
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setBusy(false)
          }
        }

        const runProbe = async () => {
          if (probe.trim().length === 0) return
          try {
            const response = await fetch(`${BASE}/check`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ command: probe }),
            })
            const body = await response.json()
            setProbeResult(body.ok === true ? body : { verdict: 'error', reason: body.error ?? 'check failed' })
          } catch (failure) {
            setProbeResult({ verdict: 'error', reason: String(failure?.message ?? failure) })
          }
        }

        if (draft === null && error === '') {
          return h('div', { style: wrap }, h('p', { style: subtitle }, 'Loading…'))
        }
        if (draft === null) {
          return h('div', { style: wrap },
            h('h2', { style: title }, LABEL),
            h('p', { style: { ...subtitle, color: 'var(--dsw-alias-label-error, inherit)' } }, error),
            h('button', { style: control, onClick: load }, 'Retry'))
        }

        const verdictColour = probeResult === null
          ? undefined
          : probeResult.verdict === 'deny' ? 'var(--dsw-alias-label-error, inherit)' : probeResult.verdict === 'allow' ? 'var(--dsw-alias-label-success, inherit)' : undefined

        return h('div', { style: wrap },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
            h('h2', { style: title }, LABEL),
            h('span', { style: subtitle }, `v${remote?.version ?? '?'} · layer 1 rules + layer 2 review`),
            remote?.settingsAvailable === false ? h('span', { style: { ...subtitle, color: 'var(--dsw-alias-label-error, inherit)' } }, 'settings store unavailable') : null),
          h('p', { style: subtitle },
            'Every tool call is judged by the deterministic rules first: a proven-ordinary call runs immediately, a proven-catastrophic one is refused. Only what the rules cannot settle reaches the reviewer model. ',
            `The gate is armed only while the "${remote?.preset ?? 'better-auto-review'}" permission preset is selected.`),

          h(Section, { title: 'Gate', hint: 'when the two layers run' },
            h('div', { style: row },
              h(Toggle, { label: 'Enabled', checked: draft.enabled, hint: 'off means every call passes through untouched', onChange: (value) => patch(['enabled'], value) }),
              h(Field, { label: 'Mode', hint: draft.gate.mode === 'preset' ? `only while the "${draft.gate.preset}" preset is selected` : 'every session, whatever the preset' },
                h('select', { style: control, value: draft.gate.mode, onChange: (event) => patch(['gate', 'mode'], event.target.value) },
                  h('option', { value: 'preset' }, 'preset — opt in per session'),
                  h('option', { value: 'always' }, 'always — every session'))),
              h(Text, { label: 'Preset name', value: draft.gate.preset, hint: 'must match the preset key in cordis.patch.yml', onChange: (value) => patch(['gate', 'preset'], value) }))),

          h(Section, { title: 'Reviewer', hint: 'layer 2 — the model, and what happens when it cannot answer' },
            h('div', { style: row },
              h(Text, { label: 'Provider', value: draft.review.provider, placeholder: 'empty = the conversation main model', onChange: (value) => patch(['review', 'provider'], value) }),
              h(Text, { label: 'Model', value: draft.review.model, placeholder: 'empty = the conversation main model', onChange: (value) => patch(['review', 'model'], value) }),
              h(Text, { label: 'Reasoning effort', value: draft.review.reasoningEffort, placeholder: 'empty = the model lowest level', onChange: (value) => patch(['review', 'reasoningEffort'], value) })),
            h('div', { style: row },
              h(Num, { label: 'Output budget', value: draft.review.maxTokens, min: 256, step: 256, hint: 'doubled once per truncation', onChange: (value) => patch(['review', 'maxTokens'], value) }),
              h(Num, { label: 'Budget ceiling', value: draft.review.maxTokensLimit, min: 256, step: 256, onChange: (value) => patch(['review', 'maxTokensLimit'], value) }),
              h(Num, { label: 'Timeout (ms)', value: draft.review.timeoutMs, min: 1000, step: 1000, onChange: (value) => patch(['review', 'timeoutMs'], value) })),
            h('div', { style: row },
              h(Field, { label: 'On review failure', hint: draft.review.onError === 'ask' ? 'the human is asked; the reviewer never silently allows' : 'the call is refused outright, as the shipped Auto review does' },
                h('select', { style: control, value: draft.review.onError, onChange: (event) => patch(['review', 'onError'], event.target.value) },
                  h('option', { value: 'ask' }, 'ask the human'),
                  h('option', { value: 'deny' }, 'refuse the call'))),
              h(Num, { label: 'History budget (chars)', value: draft.review.maxHistoryChars, min: 0, step: 2000, hint: 'oldest dropped first', onChange: (value) => patch(['review', 'maxHistoryChars'], value) }),
              h(Num, { label: 'Action budget (chars)', value: draft.review.maxActionChars, min: 1000, step: 1000, hint: 'never judged truncated', onChange: (value) => patch(['review', 'maxActionChars'], value) }))),

          h(Section, { title: 'Layer 1 rules', hint: `${remote?.hardDenyRules?.length ?? 17} built-in hard refusals, then the paths and toggles below` },
            h('div', { style: row },
              h(Toggle, { label: 'Hard-deny floor', checked: draft.rules.hardDeny, hint: 'disk, boot, security controls, the harness state', onChange: (value) => patch(['rules', 'hardDeny'], value) }),
              h(Toggle, { label: 'Fast-allow workspace writes', checked: draft.rules.fastAllowWorkspaceWrites, onChange: (value) => patch(['rules', 'fastAllowWorkspaceWrites'], value) }),
              h(Toggle, { label: 'Fast-allow read-only shell', checked: draft.rules.fastAllowReadOnlyShell, onChange: (value) => patch(['rules', 'fastAllowReadOnlyShell'], value) })),
            h('div', { style: row },
              h(Lines, { label: 'Protected paths', value: draft.rules.protectPaths, hint: 'deleting under these always asks; one per line', onChange: (value) => patch(['rules', 'protectPaths'], value) })),
            h('div', { style: row },
              h(Lines, { label: 'Sensitive write paths', value: draft.rules.sensitiveWritePaths, hint: 'writing into these always asks; one per line', onChange: (value) => patch(['rules', 'sensitiveWritePaths'], value) })),
            h('div', { style: row },
              h(Lines, { label: 'Extra allowed roots', value: draft.rules.extraAllowedRoots, hint: 'more roots treated as the workspace; one per line', onChange: (value) => patch(['rules', 'extraAllowedRoots'], value) })),
            h('div', { style: row },
              h(Lines, { label: 'Fast-allow command patterns', value: draft.rules.fastAllowCommands, hint: 'regexes; a last resort, applied only when no deny or escalation matched. Put everyday commands here (a compiler, a test runner) to stop them costing a model request.', onChange: (value) => patch(['rules', 'fastAllowCommands'], value) }))),

          h(Section, { title: 'Try a command against layer 1', hint: 'dry run — nothing is executed, the reviewer is not called' },
            h('div', { style: row },
              h('input', { style: { ...mono, flex: '1 1 340px' }, type: 'text', spellCheck: false, value: probe, placeholder: 'e.g. Remove-Item -Recurse -Force C:\\Users\\me\\.dsh', onChange: (event) => setProbe(event.target.value), onKeyDown: (event) => { if (event.key === 'Enter') runProbe() } }),
              h('button', { style: control, onClick: runProbe }, 'Check')),
            probeResult === null ? null : h('div', { style: { ...field, gap: '2px' } },
              h('span', { style: { ...labelStyle, color: verdictColour } }, `${probeResult.verdict} · ${probeResult.rule ?? ''}`),
              h('span', { style: hint }, probeResult.reason ?? ''))),

          h(Section, { title: 'Audit log', hint: remote?.auditPath ?? 'disabled' },
            h('div', { style: row },
              h(Toggle, { label: 'Record decisions', checked: draft.audit.enabled, onChange: (value) => patch(['audit', 'enabled'], value) }),
              h(Toggle, { label: 'Record arguments', checked: draft.audit.recordArguments, hint: 'credential-shaped values are always redacted', onChange: (value) => patch(['audit', 'recordArguments'], value) })),
            audit.length === 0
              ? h('p', { style: hint }, 'No decisions recorded yet.')
              : h('div', { style: { ...mono, maxHeight: '200px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' } },
                audit.map((entry, index) => h('span', { key: `${entry.at ?? 'x'}-${index}` },
                  `${entry.at ?? '?'}  L${entry.layer ?? '?'}  ${entry.verdict ?? '?'}  ${entry.tool ?? '?'}  ${entry.rule ?? entry.risk ?? ''}`)))),

          h('div', { style: { ...row, position: 'sticky', bottom: 0, paddingTop: '4px' } },
            h('button', { style: control, disabled: busy, onClick: save }, busy ? 'Working…' : 'Save'),
            h('button', { style: control, disabled: busy, onClick: reset }, 'Restore defaults'),
            h('button', { style: control, disabled: busy, onClick: load }, 'Reload'),
            h('span', { style: status === 'unsaved changes' ? hint : subtitle }, status),
            error.length > 0 ? h('span', { style: { ...hint, color: 'var(--dsw-alias-label-error, inherit)' } }, error) : null))
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
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
