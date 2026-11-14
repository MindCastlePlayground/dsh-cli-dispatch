// A scriptable ACP agent used by the test suite.
//
// It speaks the same protocol opencode speaks — `initialize`, `session/new`,
// `session/prompt`, `session/update` notifications, and permission requests —
// so the plugin's transport, conversation, and panel logic are exercised
// without spending a model call. The real opencode binary is exercised by
// `scripts/verify.mjs`.

let buffer = ''
let nextId = 1
const pending = new Map()
const sessions = new Map()

const MODE = process.env.FAKE_ACP_MODE ?? 'echo'

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line !== '') handle(JSON.parse(line))
  }
})

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function notify(sessionId, update) {
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
}

function request(method, params) {
  const id = nextId++
  write({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve) => pending.set(id, resolve))
}

async function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id)
    if (resolve !== undefined) {
      pending.delete(message.id)
      resolve(message.result)
    }
    return
  }

  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        agentInfo: { name: 'fake-agent', version: '1.0.0' },
      },
    })
    return
  }

  if (message.method === 'session/new') {
    const sessionId = `ses_fake_${sessions.size + 1}`
    sessions.set(sessionId, { turns: 0, history: [] })
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId,
        configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'fake/model' }],
      },
    })
    notify(sessionId, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'init', description: 'initialize the workspace' }],
    })
    return
  }

  if (message.method === 'session/prompt') {
    const { sessionId, prompt } = message.params
    const session = sessions.get(sessionId)
    if (session === undefined) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown session' } })
      return
    }
    const text = prompt.map((block) => block.text ?? '').join('')
    session.turns += 1
    session.history.push(text)

    if (MODE === 'permission') {
      const answer = await request('session/request_permission', {
        sessionId,
        toolCall: { title: `read ${text}` },
        options: [
          { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' },
        ],
      })
      notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `granted=${JSON.stringify(answer?.outcome ?? null)}` } })
    }

    if (MODE === 'tools') {
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'read_file',
        status: 'pending',
        rawInput: { file_path: 'README.md' },
      })
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: { bytes: 42 },
      })
    }

    // Stream the reply in three chunks, exactly as a real agent does.
    const reply = MODE === 'echo' && session.turns > 1
      ? `turn ${session.turns}: ${text}`
      : `echo: ${text}`
    for (const part of splitChunks(reply)) {
      notify(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: `msg_${session.turns}`,
        content: { type: 'text', text: part },
      })
      await sleep(5)
    }

    write({
      jsonrpc: '2.0',
      id: message.id,
      result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: reply.length } },
    })
    return
  }

  if (message.method === 'session/cancel') {
    return
  }

  if (message.method === 'session/set_model') {
    write({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }

  if (message.id !== undefined) {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
  }
}

function splitChunks(text) {
  const size = Math.max(1, Math.ceil(text.length / 3))
  const parts = []
  for (let index = 0; index < text.length; index += size) {
    parts.push(text.slice(index, index + size))
  }
  return parts.length === 0 ? [text] : parts
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
