// Tests for the panel's HTTP surface.
//
// The panel is the conversation view: the model writes turns through the tools,
// the browser reads them through these routes. The routes are exercised against
// a real `node:http` server and the plugin's own registry, so a change in the
// wire shape fails here rather than in the browser.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../lib/config.js'
import { DispatchRegistry } from '../lib/tasks.js'
import { registerPanelRoutes } from '../lib/panel.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeCli = path.join(here, 'fixtures', 'fake-acp.mjs')

function fakeTarget(mode = 'echo') {
  return {
    id: 'fake',
    label: 'fake agent',
    command: process.execPath,
    args: [fakeCli],
    cwd: here,
    env: { FAKE_ACP_MODE: mode },
    timeoutMs: 30_000,
    model: null,
    agent: null,
    permission: 'allow',
  }
}

/**
 * Serve the panel routes on a real server.
 *
 * `routes` mirrors the host's `webServer.register` contract closely enough to
 * prove path handling: exact paths win, prefixes catch the rest.
 */
async function withPanel(run) {
  const config = normalizeConfig({})
  const registry = new DispatchRegistry({ config })
  const exact = new Map()
  const prefixes = []
  const fakeWebServer = {
    register: ({ kind, path: routePath, handler }) => {
      if (kind === 'prefix') {
        prefixes.push({ path: routePath, handler })
        return () => {
          const index = prefixes.findIndex((entry) => entry.handler === handler)
          if (index >= 0) prefixes.splice(index, 1)
        }
      }
      exact.set(routePath, handler)
      return () => exact.delete(routePath)
    },
  }

  const ctx = { get: (name) => (name === 'webServer' ? fakeWebServer : undefined) }
  const disposeRoutes = registerPanelRoutes(ctx, registry, config)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const direct = exact.get(url.pathname)
    if (direct !== undefined) return direct(req, res)
    for (const entry of prefixes) {
      if (url.pathname.startsWith(entry.path)) return entry.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no route' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  const call = async (routePath, init) => {
    const response = await fetch(`${base}${routePath}`, init)
    const text = await response.text()
    return { status: response.status, body: text === '' ? null : JSON.parse(text) }
  }

  try {
    await run({ registry, base, call, config })
  } finally {
    disposeRoutes()
    await registry.dispose()
    // `fetch` keeps connections alive, and `server.close()` waits for them;
    // close the idle sockets explicitly so the test process can exit.
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('the panel lists no tasks before any dispatch', async () => {
  await withPanel(async ({ call }) => {
    const listed = await call('/cli-dispatch/tasks')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.tasks, [])
  })
})

test('the panel reports the configured targets', async () => {
  await withPanel(async ({ call }) => {
    const answered = await call('/cli-dispatch/config')
    assert.equal(answered.status, 200)
    assert.equal(answered.body.defaultTarget, 'opencode')
    assert.equal(answered.body.targets[0].id, 'opencode')
  })
})

test('the panel returns a task, its entries, and then only new entries', async () => {
  await withPanel(async ({ registry, call }) => {
    const task = await registry.create({ target: fakeTarget(), cwd: here, title: 'panel task' })
    await task.prompt('panel hello')

    const listed = await call('/cli-dispatch/tasks')
    assert.equal(listed.body.tasks.length, 1)
    assert.equal(listed.body.tasks[0].id, task.id)

    const detail = await call(`/cli-dispatch/tasks/${tag(task.id)}`)
    assert.equal(detail.status, 200)
    assert.ok(detail.body.entries.length > 0)
    assert.equal(detail.body.entries[0].kind, 'user')

    // A poll at the newest row holds until another turn produces rows, and the
    // answer then carries only rows past that cursor — never a replay.
    const newest = detail.body.entries[detail.body.entries.length - 1].seq
    const held = call(`/cli-dispatch/tasks/${tag(task.id)}/events?since=${newest}`)
    await sleep(60)
    await task.prompt('panel again')
    const fresh = await held
    assert.equal(fresh.status, 200)
    assert.ok(fresh.body.entries.length > 0)
    assert.ok(fresh.body.entries.every((row) => row.seq > newest))
  })
})

test('the panel accepts a message, delivers it as another turn, and stops the task', async () => {
  await withPanel(async ({ registry, call }) => {
    const task = await registry.create({ target: fakeTarget(), cwd: here, title: 'panel turn' })
    await task.prompt('first')

    const posted = await call(`/cli-dispatch/tasks/${tag(task.id)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'sent from the panel' }),
    })
    assert.equal(posted.status, 202)

    // The turn runs detached; wait for the transcript to show it.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const detail = await call(`/cli-dispatch/tasks/${tag(task.id)}`)
      const userRows = detail.body.entries.filter((row) => row.kind === 'user')
      if (userRows.length === 2) {
        assert.equal(userRows[1].text, 'sent from the panel')
        break
      }
      await sleep(25)
    }
    const final = await call(`/cli-dispatch/tasks/${tag(task.id)}`)
    assert.equal(final.body.entries.filter((row) => row.kind === 'user').length, 2)

    const stopped = await call(`/cli-dispatch/tasks/${tag(task.id)}/stop`, { method: 'POST' })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.body.task.status, 'cancelled')
  })
})

test('the panel rejects an empty message and an unknown task', async () => {
  await withPanel(async ({ registry, call }) => {
    const task = await registry.create({ target: fakeTarget(), cwd: here, title: 'panel errors' })
    const empty = await call(`/cli-dispatch/tasks/${tag(task.id)}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    })
    assert.equal(empty.status, 400)

    const missing = await call('/cli-dispatch/tasks/dispatch-0000000000000000')
    assert.equal(missing.status, 404)
    assert.match(missing.body.error, /unknown dispatch task/)
  })
})

test('an empty transcript answers the detail route at once and holds later polls', async () => {
  await withPanel(async ({ registry, call }) => {
    const task = await registry.create({ target: fakeTarget(), cwd: here, title: 'quiet' })

    // The panel's initial load: the detail route must answer immediately even
    // with nothing in the transcript (it used to read `entries[-1].seq`).
    const first = await call(`/cli-dispatch/tasks/${tag(task.id)}`)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.entries, [])
    assert.equal(first.body.task.status, 'running')

    // A poll with no cursor waits for the first row instead of spinning.
    const held = call(`/cli-dispatch/tasks/${tag(task.id)}/events?since=0`)
    await sleep(60)
    await task.prompt('wake the poll')
    const answered = await held
    assert.equal(answered.status, 200)
    assert.ok(answered.body.entries.length > 0)
    assert.equal(answered.body.entries[0].kind, 'user')
  })
})

/** Percent-encode a task id the way the browser panel does. */
function tag(id) {
  return encodeURIComponent(id)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
