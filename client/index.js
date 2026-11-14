// Web panel for CLI dispatch tasks.
//
// This is the conversation surface: a task list, the live dialogue for the open
// task, and a composer that sends the next turn to the same agent session.
//
// The bundle is hand-authored in the module format `dsh-client-modules` serves:
// a `window.__ModuleLoader__.load({ id, factory })` registration whose factory
// receives `require` for the shared baseline modules only. That keeps the panel
// loadable from a `link:` profile with no build step, which is what this
// repository's other local packages do.
//
// It reads the host routes registered by `lib/panel.js` over `fetch`, so the
// panel and the model-facing tools observe one registry.

window.__ModuleLoader__.load({
  id: '@local/dsh-cli-dispatch',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')

    const h = jsxRuntime.jsx
    const jsxs = jsxRuntime.jsxs
    const Fragment = jsxRuntime.Fragment

    const API = '/cli-dispatch'

    /** Small fetch helper: JSON in, JSON out, with the error text preserved. */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      let value = {}
      if (text !== '') {
        try {
          value = JSON.parse(text)
        } catch {
          value = { error: text }
        }
      }
      if (!response.ok) throw new Error(value.error ?? `request failed: ${response.status}`)
      return value
    }

    const KIND_STYLE = {
      user: { label: 'You', color: 'var(--dsh-color-text-primary, #e6e6e6)', weight: 600 },
      assistant: { label: 'Agent', color: 'var(--dsh-color-text-primary, #e6e6e6)', weight: 400 },
      reasoning: { label: 'thinking', color: 'var(--dsh-color-text-tertiary, #8b8b8b)', weight: 400, italic: true },
      tool: { label: 'tool', color: 'var(--dsh-color-text-secondary, #b4b4b4)', weight: 400, mono: true },
      system: { label: 'system', color: 'var(--dsh-color-text-tertiary, #8b8b8b)', weight: 400, mono: true },
      error: { label: 'error', color: 'var(--dsh-color-danger, #e5534b)', weight: 400, mono: true },
    }

    function timeOf(iso) {
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return ''
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    function StatusDot({ status }) {
      const color = status === 'running' || status === 'starting'
        ? 'var(--dsh-color-warning, #d29922)'
        : status === 'idle'
          ? 'var(--dsh-color-success, #3fb950)'
          : status === 'failed'
            ? 'var(--dsh-color-danger, #e5534b)'
            : 'var(--dsh-color-text-tertiary, #8b8b8b)'
      return h('span', {
        style: {
          display: 'inline-block',
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          flex: '0 0 auto',
        },
      })
    }

    function Entry({ entry }) {
      const style = KIND_STYLE[entry.kind] ?? KIND_STYLE.system
      return jsxs('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '58px 62px 1fr',
          gap: 8,
          padding: '4px 0',
          alignItems: 'baseline',
          fontFamily: style.mono === true ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
          fontSize: style.mono === true ? 11.5 : 13,
        },
        children: [
          h('span', {
            key: 'time',
            style: { color: 'var(--dsh-color-text-tertiary, #8b8b8b)', fontSize: 10.5, fontVariantNumeric: 'tabular-nums' },
          }, timeOf(entry.at)),
          h('span', {
            key: 'label',
            style: {
              color: style.color,
              fontWeight: style.weight,
              fontStyle: style.italic === true ? 'italic' : 'normal',
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            },
          }, style.label),
          h('span', {
            key: 'text',
            style: {
              color: style.color,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.5,
              opacity: entry.streaming === true ? 0.72 : 1,
            },
          }, entry.text),
        ],
      })
    }

    function TaskRow({ task, active, onSelect }) {
      const counts = task.counts ?? {}
      return jsxs('button', {
        onClick: () => onSelect(task.id),
        style: {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '7px 9px',
          marginBottom: 3,
          border: '1px solid ' + (active ? 'var(--dsh-color-border-strong, #3d3d3d)' : 'transparent'),
          borderRadius: 6,
          background: active ? 'var(--dsh-color-surface-raised, #232323)' : 'transparent',
          color: 'var(--dsh-color-text-primary, #e6e6e6)',
          cursor: 'pointer',
          font: 'inherit',
        },
        children: [
          jsxs('div', {
            key: 'head',
            style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 },
            children: [
              h(StatusDot, { key: 'dot', status: task.status }),
              h('span', {
                key: 'label',
                style: { fontSize: 11.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              }, task.label),
              h('span', {
                key: 'turns',
                style: { marginLeft: 'auto', fontSize: 10.5, color: 'var(--dsh-color-text-tertiary, #8b8b8b)' },
              }, `${task.turns}t`),
            ],
          }),
          h('div', {
            key: 'title',
            style: {
              fontSize: 11,
              color: 'var(--dsh-color-text-secondary, #b4b4b4)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, task.title),
          counts.assistant > 0
            ? h('div', {
              key: 'counts',
              style: { marginTop: 2, fontSize: 10, color: 'var(--dsh-color-text-tertiary, #8b8b8b)' },
            }, `${counts.user} you · ${counts.assistant} agent${counts.tool > 0 ? ` · ${counts.tool} tool` : ''}`)
            : null,
        ],
      })
    }

    function Panel() {
      const [tasks, setTasks] = react.useState([])
      const [selected, setSelected] = react.useState(null)
      const [task, setTask] = react.useState(null)
      const [entries, setEntries] = react.useState([])
      const [draft, setDraft] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState(null)
      const endRef = react.useRef(null)

      // Task list: refreshed while the panel is open so a task started from the
      // model's tool call shows up here without a reload.
      react.useEffect(() => {
        let cancelled = false
        const load = async () => {
          try {
            const value = await api('/tasks')
            if (cancelled) return
            setTasks(value.tasks ?? [])
            setSelected((current) => current ?? value.tasks?.[0]?.id ?? null)
          } catch (failure) {
            if (!cancelled) setError(failure.message)
          }
        }
        load()
        const timer = setInterval(load, 4_000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [])

      // One task's conversation: long-poll for new entries so streaming text
      // arrives as it is produced.
      react.useEffect(() => {
        if (selected === null) {
          setTask(null)
          setEntries([])
          return undefined
        }
        let cancelled = false
        let since = 0
        setEntries([])
        const pump = async () => {
          // Initial load: the detail route answers at once. Only after that does
          // the panel hold a cursor and long-poll for rows past it.
          try {
            const initial = await api(`/tasks/${encodeURIComponent(selected)}`)
            if (cancelled) return
            setTask(initial.task)
            const rows = initial.entries ?? []
            if (rows.length > 0) {
              setEntries(rows)
              since = rows[rows.length - 1].seq
            }
          } catch (failure) {
            if (!cancelled) setError(failure.message)
            return
          }
          while (!cancelled) {
            try {
              const value = await api(`/tasks/${encodeURIComponent(selected)}/events?since=${since}`)
              if (cancelled) return
              setTask(value.task)
              if (Array.isArray(value.entries) && value.entries.length > 0) {
                const incoming = value.entries
                setEntries((current) => {
                  const merged = new Map(current.map((row) => [row.seq, row]))
                  for (const row of incoming) merged.set(row.seq, row)
                  return [...merged.values()].sort((left, right) => left.seq - right.seq)
                })
                since = incoming[incoming.length - 1].seq
              }
              // `idle` only means this poll window ended; the task is still open
              // and may receive another turn, so keep following it.
              if (value.settled === true) break
            } catch (failure) {
              if (!cancelled) setError(failure.message)
              return
            }
          }
        }
        pump()
        return () => { cancelled = true }
      }, [selected])

      react.useEffect(() => {
        const node = endRef.current
        if (node !== null && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'end' })
        }
      }, [entries])

      const send = react.useCallback(async () => {
        const message = draft.trim()
        if (message === '' || selected === null || busy) return
        setBusy(true)
        setError(null)
        try {
          await api(`/tasks/${encodeURIComponent(selected)}/message`, {
            method: 'POST',
            body: JSON.stringify({ message }),
          })
          setDraft('')
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [draft, selected, busy])

      const stop = react.useCallback(async () => {
        if (selected === null) return
        setBusy(true)
        try {
          await api(`/tasks/${encodeURIComponent(selected)}/stop`, { method: 'POST' })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [selected])

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          send()
        }
      }

      const canSend = task !== null &&
        (task.status === 'idle' || task.status === 'running' || task.status === 'starting')

      return jsxs('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: '210px 1fr',
          height: '100%',
          minHeight: 0,
          fontFamily: 'var(--dsh-font-sans, system-ui, -apple-system, sans-serif)',
          color: 'var(--dsh-color-text-primary, #e6e6e6)',
        },
        children: [
          jsxs('div', {
            key: 'list',
            style: {
              borderRight: '1px solid var(--dsh-color-border, #2e2e2e)',
              overflowY: 'auto',
              padding: 8,
              minHeight: 0,
            },
            children: [
              h('div', {
                key: 'heading',
                style: {
                  fontSize: 10.5,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--dsh-color-text-tertiary, #8b8b8b)',
                  padding: '2px 4px 7px',
                },
              }, `dispatch tasks · ${tasks.length}`),
              tasks.length === 0
                ? h('div', {
                  key: 'empty',
                  style: { padding: 8, fontSize: 11.5, color: 'var(--dsh-color-text-tertiary, #8b8b8b)' },
                }, 'No tasks yet. Ask the agent to call cli_dispatch, or run /dispatch.')
                : tasks.map((entry) => h(TaskRow, {
                  key: entry.id,
                  task: entry,
                  active: entry.id === selected,
                  onSelect: setSelected,
                })),
            ],
          }),
          jsxs('div', {
            key: 'detail',
            style: { display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
            children: [
              jsxs('div', {
                key: 'head',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '9px 12px',
                  borderBottom: '1px solid var(--dsh-color-border, #2e2e2e)',
                  flex: '0 0 auto',
                },
                children: [
                  task === null ? null : h(StatusDot, { key: 'dot', status: task.status }),
                  h('span', {
                    key: 'title',
                    style: { fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  }, task === null ? 'select a task' : task.title),
                  task === null
                    ? null
                    : h('span', {
                      key: 'meta',
                      style: { fontSize: 10.5, color: 'var(--dsh-color-text-tertiary, #8b8b8b)', whiteSpace: 'nowrap' },
                    }, `${task.status} · ${task.turns} turn(s)${task.sessionId === undefined ? '' : ` · ${task.sessionId}`}`),
                  task === null
                    ? null
                    : h('button', {
                      key: 'stop',
                      onClick: stop,
                      disabled: busy || task.status === 'cancelled' || task.status === 'failed',
                      style: {
                        marginLeft: 'auto',
                        padding: '3px 9px',
                        fontSize: 11,
                        borderRadius: 5,
                        border: '1px solid var(--dsh-color-border-strong, #3d3d3d)',
                        background: 'transparent',
                        color: 'var(--dsh-color-text-secondary, #b4b4b4)',
                        cursor: 'pointer',
                        font: 'inherit',
                      },
                    }, 'Stop'),
                ],
              }),
              jsxs('div', {
                key: 'log',
                style: { flex: '1 1 auto', overflowY: 'auto', padding: '8px 12px', minHeight: 0 },
                children: [
                  entries.length === 0
                    ? h('div', {
                      key: 'empty',
                      style: { color: 'var(--dsh-color-text-tertiary, #8b8b8b)', fontSize: 12, padding: '10px 0' },
                    }, task === null ? '' : 'Waiting for the first turn…')
                    : entries.map((entry) => h(Entry, { key: entry.seq, entry })),
                  h('div', { key: 'end', ref: endRef }),
                ],
              }),
              error === null
                ? null
                : h('div', {
                  key: 'error',
                  style: {
                    padding: '6px 12px',
                    fontSize: 11.5,
                    color: 'var(--dsh-color-danger, #e5534b)',
                    borderTop: '1px solid var(--dsh-color-border, #2e2e2e)',
                  },
                }, error),
              jsxs('div', {
                key: 'composer',
                style: {
                  display: 'flex',
                  gap: 6,
                  padding: 10,
                  borderTop: '1px solid var(--dsh-color-border, #2e2e2e)',
                  flex: '0 0 auto',
                },
                children: [
                  h('textarea', {
                    key: 'input',
                    value: draft,
                    onChange: (event) => setDraft(event.target.value),
                    onKeyDown,
                    placeholder: canSend ? 'Next turn for this agent… (Ctrl+Enter to send)' : 'This task accepts no further turns',
                    disabled: !canSend || busy,
                    rows: 2,
                    style: {
                      flex: '1 1 auto',
                      resize: 'vertical',
                      padding: '7px 9px',
                      borderRadius: 6,
                      border: '1px solid var(--dsh-color-border-strong, #3d3d3d)',
                      background: 'var(--dsh-color-surface-sunken, #1b1b1b)',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: 12.5,
                    },
                  }),
                  h('button', {
                    key: 'send',
                    onClick: send,
                    disabled: !canSend || busy || draft.trim() === '',
                    style: {
                      padding: '0 14px',
                      borderRadius: 6,
                      border: '1px solid var(--dsh-color-border-strong, #3d3d3d)',
                      background: 'var(--dsh-color-surface-raised, #232323)',
                      color: 'inherit',
                      cursor: 'pointer',
                      font: 'inherit',
                      fontSize: 12,
                    },
                  }, busy ? '…' : 'Send'),
                ],
              }),
            ],
          }),
        ],
      })
    }

    /**
     * Client plugin declaration.
     *
     * `sidebar.panellist` is the sidebar's icon list and `main` is the layout's
     * keyed panel slot; a panel needs both, under the same id. `layout` supplies
     * `selectPanel(id)` so clicking the sidebar row can switch the main panel.
     */
    const inject = ['slots', 'layout']

    /** Stable panel id; the sidebar row and the main panel both use it. */
    const PANEL_ID = 'cli-dispatch'

    function apply(ctx) {
      if (ctx.slots === undefined) return

      // The sidebar entry: an icon plus a label, opening this package's panel.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          label: 'Dispatch',
        }, function DispatchIcon(props) {
          const size = props?.size ?? 16
          return h('svg', {
            width: size,
            height: size,
            viewBox: '0 0 16 16',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
            children: [
              h('path', { key: 'a', d: 'M2.5 4.5 5.5 8l-3 3.5' }),
              h('path', { key: 'b', d: 'M8 11.5h5.5' }),
            ],
          })
        }),
      )

      // The panel body itself, in the layout's root-scoped keyed slot.
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.Panel = Panel
    return module.exports
  },
})
