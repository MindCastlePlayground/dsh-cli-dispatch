// Unit and integration tests for the CLI dispatch plugin.
//
// The transport tests drive the plugin's own ACP client against a scripted
// agent, which exercises the real code path — spawn, handshake, streaming,
// permission replies, multi-turn conversation — without a model call. The
// separate `scripts/verify.mjs` run proves the same path against the real
// opencode binary.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig, resolveTarget } from '../lib/config.js'
import { DispatchRegistry } from '../lib/tasks.js'
import { parseCommandInput } from '../lib/command.js'
import { transcript } from '../lib/tools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeCli = path.join(here, 'fixtures', 'fake-acp.mjs')

function fakeTarget(mode = 'echo', extra = {}) {
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
    ...extra,
  }
}

async function withTask(mode, run) {
  const registry = new DispatchRegistry({ config: normalizeConfig({}) })
  const task = await registry.create({ target: fakeTarget(mode), cwd: here, title: 'test task' })
  try {
    await run(task, registry)
  } finally {
    await registry.dispose()
  }
}

test('normalizeConfig supplies a working default opencode target', () => {
  const config = normalizeConfig({})
  assert.equal(config.targets.length, 1)
  assert.equal(config.targets[0].id, 'opencode')
  assert.equal(config.defaultTarget, 'opencode')
  assert.equal(config.targets[0].command, 'opencode')
  assert.deepEqual(config.targets[0].args, ['acp'])
  assert.equal(config.targets[0].permission, 'allow')
  assert.equal(config.transcript.includeReasoning, false)
  assert.equal(config.transcript.includeToolCalls, true)
})

test('normalizeConfig keeps declared targets and rejects duplicate ids', () => {
  const config = normalizeConfig({
    targets: [
      { id: 'a', command: 'opencode', args: ['acp'] },
      { id: 'b', command: 'other', args: ['run'], timeoutMs: 1000, permission: 'deny' },
    ],
    defaultTarget: 'b',
  })
  assert.equal(config.targets.length, 2)
  assert.equal(config.defaultTarget, 'b')
  assert.equal(config.targets[1].permission, 'deny')

  assert.throws(
    () => normalizeConfig({ targets: [{ id: 'a' }, { id: 'a' }] }),
    /duplicate target id/,
  )
})

test('normalizeConfig falls back to the first target for an unknown defaultTarget', () => {
  const config = normalizeConfig({ targets: [{ id: 'only' }], defaultTarget: 'missing' })
  assert.equal(config.defaultTarget, 'only')
})

test('resolveTarget reports unknown ids with the configured list', () => {
  const config = normalizeConfig({ targets: [{ id: 'alpha' }, { id: 'beta' }] })
  assert.equal(resolveTarget(config, 'beta').id, 'beta')
  assert.equal(resolveTarget(config, undefined).id, 'alpha')
  assert.throws(() => resolveTarget(config, 'gamma'), /unknown CLI target "gamma"/)
})

test('parseCommandInput reads flags and keeps the free-text tail', () => {
  assert.deepEqual(parseCommandInput('fix the tests'), {
    action: 'dispatch', target: null, task: null, prompt: 'fix the tests',
  })
  assert.deepEqual(parseCommandInput('--target opencode fix the tests'), {
    action: 'dispatch', target: 'opencode', task: null, prompt: 'fix the tests',
  })
  assert.deepEqual(parseCommandInput('--task dispatch-abc keep going'), {
    action: 'dispatch', target: null, task: 'dispatch-abc', prompt: 'keep going',
  })
  assert.equal(parseCommandInput('--list').action, 'list')
  assert.equal(parseCommandInput('--read dispatch-abc').task, 'dispatch-abc')
  assert.equal(parseCommandInput('--stop dispatch-abc').action, 'stop')
  assert.match(parseCommandInput('--task').error, /requires a value/)
})

test('a task opens a session, streams a reply, and keeps the conversation', async () => {
  await withTask('echo', async (task) => {
    assert.equal(task.status, 'running')
    assert.match(task.sessionId, /^ses_fake_/)

    await task.prompt('hello there')
    assert.equal(task.turns, 1)
    assert.equal(task.status, 'idle')
    assert.equal(task.stopReason, 'end_turn')

    const assistants = task.entries.filter((row) => row.kind === 'assistant')
    assert.equal(assistants.length, 1, 'chunks coalesce into one assistant entry')
    assert.equal(assistants[0].text, 'echo: hello there')
    assert.equal(assistants[0].streaming, undefined, 'the entry is closed when the turn settles')

    const users = task.entries.filter((row) => row.kind === 'user')
    assert.equal(users.length, 1)
    assert.equal(users[0].text, 'hello there')

    await task.prompt('second turn')
    assert.equal(task.turns, 2, 'the same agent session serves later turns')
    const replies = task.entries.filter((row) => row.kind === 'assistant').map((row) => row.text)
    assert.deepEqual(replies, ['echo: hello there', 'turn 2: second turn'])
  })
})

test('the transcript preserves turn order and labels each speaker', async () => {
  await withTask('echo', async (task) => {
    await task.prompt('first')
    await task.prompt('second')
    const text = task.transcriptText()
    const lines = text.split('\n')
    assert.match(lines[0], /^User: first$/)
    assert.match(lines[1], /^Agent: echo: first$/)
    assert.match(lines[2], /^User: second$/)
    assert.match(lines[3], /^Agent: turn 2: second$/)
  })
})

test('transcript() drops reasoning and tool rows when the config asks', () => {
  const entries = [
    { kind: 'user', text: 'q' },
    { kind: 'reasoning', text: 'thinking' },
    { kind: 'assistant', text: 'a' },
    { kind: 'tool', text: 'read_file' },
  ]
  const quiet = transcript(entries, { transcript: { maxChars: 10_000, includeReasoning: false, includeToolCalls: false } })
  assert.equal(quiet, 'User: q\nAgent: a')

  const loud = transcript(entries, { transcript: { maxChars: 10_000, includeReasoning: true, includeToolCalls: true } })
  assert.match(loud, /Agent \(thinking\): thinking/)
  assert.match(loud, /Tool: read_file/)
})

test('transcript() trims from the front and says so', () => {
  const entries = Array.from({ length: 50 }, (_, index) => ({ kind: 'assistant', text: `line ${index}` }))
  const text = transcript(entries, { transcript: { maxChars: 100, includeReasoning: false, includeToolCalls: true } })
  assert.ok(text.length < 220, 'the tail is bounded')
  assert.match(text, /characters trimmed from the start/)
  assert.match(text, /line 49$/)
})

test('tool calls and permission grants land in the conversation', async () => {
  await withTask('tools', async (task) => {
    await task.prompt('read something')
    const tools = task.entries.filter((row) => row.kind === 'tool')
    assert.ok(tools.length >= 2, 'the tool call and its update both appear')
    assert.match(tools[0].text, /read_file/)
    assert.ok(tools.some((row) => /completed/.test(row.text)))
  })
})

test('permission mode allow answers without human input', async () => {
  await withTask('permission', async (task) => {
    await task.prompt('do it')
    const assistant = task.entries.filter((row) => row.kind === 'assistant').pop()
    assert.match(assistant.text, /granted=/)
    assert.match(assistant.text, /allow-once/)
    const system = task.entries.filter((row) => row.kind === 'system').map((row) => row.text).join('\n')
    assert.match(system, /permission requested/)
    assert.match(system, /permission granted/)
  })
})

test('a task rejects prompts after it is closed', async () => {
  await withTask('echo', async (task) => {
    await task.prompt('one')
    await task.close()
    task.finish('cancelled')
    await assert.rejects(() => task.prompt('two'), /cancelled/)
  })
})

test('the registry resolves the most recent task when no id is given', async () => {
  const registry = new DispatchRegistry({ config: normalizeConfig({}) })
  try {
    const first = await registry.create({ target: fakeTarget(), cwd: here, title: 'first' })
    const second = await registry.create({ target: fakeTarget(), cwd: here, title: 'second' })
    assert.equal(registry.resolve().id, second.id)
    assert.equal(registry.resolve(first.id).id, first.id)
    assert.throws(() => registry.require('dispatch-nope'), /unknown dispatch task/)
    assert.equal(registry.list().length, 2)
  } finally {
    await registry.dispose()
  }
})

test('a missing command fails the task instead of hanging it', async () => {
  const registry = new DispatchRegistry({ config: normalizeConfig({}) })
  try {
    await assert.rejects(
      () => registry.create({
        target: { ...fakeTarget(), command: 'definitely-not-a-real-binary-xyz' },
        cwd: here,
        title: 'broken',
      }),
      /ENOENT|exited|not running/,
    )
  } finally {
    await registry.dispose()
  }
})
