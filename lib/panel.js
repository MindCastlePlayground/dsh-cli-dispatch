// HTTP surface for the CLI-dispatch panel.
//
// The panel is a browser plugin (`./client`) that reads this API. Everything
// here is a plain named route on `ctx.webServer`, so the plugin still works
// when no Web host is composed — the routes simply never register.
//
// Endpoints, all JSON:
//   GET  /cli-dispatch/tasks             → { tasks }
//   GET  /cli-dispatch/tasks/<id>        → { task, entries }
//   GET  /cli-dispatch/tasks/<id>/events → { task, entries } (long-poll, since=<seq>)
//   POST /cli-dispatch/tasks/<id>/message → { task } (body: { message })
//   POST /cli-dispatch/tasks/<id>/stop    → { task }
//   GET  /cli-dispatch/config            → { targets, defaultTarget }

const ROUTE_PREFIX = '/cli-dispatch'
const POLL_TIMEOUT_MS = 25_000

/** Statuses a task never leaves; only these end the panel's poll loop. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** Sequence of the newest entry, or 0 for an empty transcript. */
function lastSeq(task) {
  const rows = task.entries
  return rows.length === 0 ? 0 : rows[rows.length - 1].seq
}

/** Entries newer than `since`, trimmed to the panel's row budget. */
function entriesSince(task, since) {
  const rows = since === 0 ? task.entries : task.entries.filter((row) => row.seq > since)
  return rows.map((row) => ({
    seq: row.seq,
    kind: row.kind,
    text: row.text,
    at: new Date(row.at).toISOString(),
    ...(row.streaming === true ? { streaming: true } : {}),
    ...(row.phase === undefined ? {} : { phase: row.phase }),
    ...(row.toolCallId === undefined ? {} : { toolCallId: row.toolCallId }),
  }))
}

function sendJSON(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req, limit = 1_000_000) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * Register the panel's routes when a Web server is composed.
 * Returns a disposer; a missing `ctx.webServer` yields a no-op disposer.
 */
export function registerPanelRoutes(ctx, registry, config) {
  const webServer = ctx.get?.('webServer') ?? ctx.webServer
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    return () => {}
  }

  const disposers = []

  const register = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  register(`${ROUTE_PREFIX}/config`, async (req, res) => {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method not allowed' })
    sendJSON(res, 200, {
      targets: config.targets.map((target) => ({ id: target.id, label: target.label, command: target.command })),
      defaultTarget: config.defaultTarget,
    })
  })

  register(`${ROUTE_PREFIX}/tasks`, async (req, res) => {
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method not allowed' })
    sendJSON(res, 200, { tasks: registry.list() })
  })

  // `/cli-dispatch/tasks/<id>` and its sub-resources share one prefix route so
  // the id can carry any character the registry mints.
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/tasks/`,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://x')
      const rest = url.pathname.slice(`${ROUTE_PREFIX}/tasks/`.length)
      const [rawId, ...tail] = rest.split('/')
      const id = decodeURIComponent(rawId ?? '')
      const action = tail.join('/')

      let task
      try {
        task = registry.require(id)
      } catch (error) {
        return sendJSON(res, 404, { error: error.message })
      }

      if (action === '' && req.method === 'GET') {
        return sendJSON(res, 200, { task: task.snapshot(), entries: entriesSince(task, 0) })
      }

      if (action === 'events' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0')
        const start = Number.isFinite(since) && since > 0 ? since : 0
        // New rows are ready now: answer without holding the request. A caller
        // with no cursor yet (`since=0`) uses the detail route for its initial
        // load, so this route always means "hold until something new arrives".
        if (lastSeq(task) > start) {
          return sendJSON(res, 200, { task: task.snapshot(), entries: entriesSince(task, start) })
        }
        // A finished task stays readable; it only stops the poll loop.
        if (TERMINAL.has(task.status)) {
          return sendJSON(res, 200, { task: task.snapshot(), entries: [], settled: true })
        }
        let unsubscribe = () => {}
        let timer = null
        let finished = false
        const finish = (status, value) => {
          if (finished) return
          finished = true
          if (timer !== null) clearTimeout(timer)
          unsubscribe()
          sendJSON(res, status, value)
        }
        unsubscribe = task.subscribe(() => {
          if (lastSeq(task) > start || TERMINAL.has(task.status)) {
            finish(200, {
              task: task.snapshot(),
              entries: entriesSince(task, start),
              ...(TERMINAL.has(task.status) ? { settled: true } : {}),
            })
          }
        })
        timer = setTimeout(() => {
          // An idle hold is not the end of the conversation: the agent settles
          // between turns while the task stays open.
          finish(200, { task: task.snapshot(), entries: entriesSince(task, start), idle: true })
        }, POLL_TIMEOUT_MS)
        res.on?.('close', () => { if (!finished) { finished = true; unsubscribe(); clearTimeout(timer) } })
        return undefined
      }

      if (action === 'message' && req.method === 'POST') {
        let body
        try {
          body = await readBody(req)
        } catch (error) {
          return sendJSON(res, 400, { error: error.message })
        }
        const message = typeof body.message === 'string' ? body.message : ''
        if (message.trim() === '') return sendJSON(res, 400, { error: 'message is required' })
        task.prompt(message).catch(() => {})
        return sendJSON(res, 202, { task: task.snapshot() })
      }

      if (action === 'stop' && req.method === 'POST') {
        await registry.cancel(task.id, true)
        return sendJSON(res, 200, { task: task.snapshot() })
      }

      return sendJSON(res, 404, { error: `unknown dispatch resource "${action || '(root)'}"` })
    },
  }))

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose() } catch {}
    }
  }
}
