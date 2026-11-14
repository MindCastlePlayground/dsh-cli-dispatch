// ACP (Agent Client Protocol) client over a child process's stdio.
//
// The dispatcher talks to an agent CLI through one long-lived process per task:
// `initialize` → `session/new` → one or more `session/prompt` turns, with the
// agent streaming `session/update` notifications in between. Everything here is
// Node built-ins so the package stays importable from a profile `link:` install
// on Windows, where the ESM loader cannot stat `@deepseek-ai/*` through a
// junction.

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/**
 * One ACP agent process. Emits:
 * - `update` ({sessionId, update}) for every `session/update` notification
 * - `permission` ({request, respond}) for `session/request_permission`
 * - `stderr` (string)
 * - `exit` ({code, signal})
 * - `protocol-error` (Error) for lines that are not JSON-RPC
 */
export class AcpConnection extends EventEmitter {
  #child = null
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #closed = false
  #stderrTail = []

  constructor(options) {
    super()
    this.command = options.command
    this.args = options.args ?? []
    this.cwd = options.cwd
    this.env = options.env
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.agentInfo = null
    this.capabilities = null
  }

  get running() {
    return this.#child !== null && this.#closed === false
  }

  /** Spawn the agent process. Resolves once the process is running, not once it answers. */
  start() {
    if (this.#child !== null) return
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#consume(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      this.#stderrTail.push(text)
      if (this.#stderrTail.length > 40) this.#stderrTail.shift()
      this.emit('stderr', text)
    })

    child.on('error', (error) => {
      this.#failAll(error)
      this.emit('protocol-error', error)
    })

    child.on('exit', (code, signal) => {
      this.#closed = true
      const error = new Error(
        `the agent process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})` +
          (this.#stderrTail.length === 0 ? '' : `: ${this.stderr()}`),
      )
      this.#failAll(error)
      this.emit('exit', { code, signal })
    })
  }

  /** Recent stderr text, for error details. */
  stderr() {
    return this.#stderrTail.join('').trim()
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param {string} method
   * @param {unknown} params
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   */
  request(method, params, options = {}) {
    if (this.#closed) return Promise.reject(new Error('the agent process is not running'))
    const id = this.#nextId++
    const payload = { jsonrpc: '2.0', id, method }
    if (params !== undefined) payload.params = params

    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.#pending.delete(id)
          reject(new Error(`the agent did not answer ${method} within ${timeoutMs}ms`))
        }, timeoutMs)
        : null
      const onAbort = () => {
        this.#settle(id, new Error(`${method} was cancelled`))
      }
      const entry = {
        resolve: (value) => {
          if (timer !== null) clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          if (timer !== null) clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      this.#pending.set(id, entry)
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          this.#settle(id, new Error(`${method} was cancelled`))
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      this.#write(payload)
    })
  }

  /** Send one JSON-RPC notification (no response expected). */
  notify(method, params) {
    if (this.#closed) return
    const payload = { jsonrpc: '2.0', method }
    if (params !== undefined) payload.params = params
    this.#write(payload)
  }

  /** Answer a `session/request_permission` request. */
  respondPermission(id, optionId) {
    this.#write({
      jsonrpc: '2.0',
      id,
      result: { outcome: { outcome: 'selected', optionId } },
    })
  }

  /** Reject a `session/request_permission` request. */
  rejectPermission(id) {
    this.#write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
  }

  /** Ask the agent to stop the current turn. */
  cancel(sessionId) {
    this.notify('session/cancel', { sessionId })
  }

  /** Terminate the agent process. */
  async close() {
    const child = this.#child
    this.#closed = true
    this.#failAll(new Error('the agent process was closed'))
    if (child === null || child.exitCode !== null) return
    try { child.stdin.end() } catch {}
    const exited = new Promise((resolve) => child.once('exit', resolve))
    try { child.kill('SIGTERM') } catch {}
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, 2_000)
    await exited
    clearTimeout(timer)
  }

  #settle(id, error) {
    const entry = this.#pending.get(id)
    if (entry === undefined) return
    this.#pending.delete(id)
    entry.reject(error)
  }

  #failAll(error) {
    const entries = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of entries) entry.reject(error)
  }

  #write(payload) {
    const child = this.#child
    if (child === null || child.stdin.destroyed) return
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch (error) {
      this.emit('protocol-error', error)
    }
  }

  #consume(chunk) {
    this.#buffer += chunk
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line === '') continue
      this.#handleLine(line)
    }
  }

  #handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.emit('protocol-error', new Error(`unparsable agent output: ${line.slice(0, 200)}`))
      return
    }

    if (message.method === 'session/update') {
      this.emit('update', message.params ?? {})
      return
    }
    if (message.method === 'session/request_permission') {
      this.emit('permission', {
        request: message.params ?? {},
        respond: (optionId) => this.respondPermission(message.id, optionId),
        reject: () => this.rejectPermission(message.id),
      })
      return
    }
    if (message.method !== undefined) {
      // Unknown server-to-client request: answer with an error so the agent is never blocked.
      if (message.id !== undefined) {
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `unsupported client method: ${message.method}` },
        })
      }
      return
    }

    const entry = this.#pending.get(message.id)
    if (entry === undefined) return
    this.#pending.delete(message.id)
    if (message.error !== undefined) {
      entry.reject(new Error(message.error.message ?? 'the agent reported an error'))
    } else {
      entry.resolve(message.result)
    }
  }
}

/**
 * ACP session wrapper: handshake, new session, and prompt turns.
 * `update` events are forwarded verbatim from the protocol.
 */
export class AcpSession {
  constructor(connection) {
    this.connection = connection
    this.sessionId = null
    this.agentInfo = null
    this.availableCommands = []
    this.configOptions = []
  }

  async initialize() {
    const result = await this.connection.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })
    this.agentInfo = result?.agentInfo ?? null
    this.connection.agentInfo = this.agentInfo
    this.connection.capabilities = result?.agentCapabilities ?? null
    return result
  }

  async newSession(cwd) {
    const result = await this.connection.request('session/new', { cwd, mcpServers: [] })
    this.sessionId = result?.sessionId ?? null
    this.configOptions = result?.configOptions ?? []
    return result
  }

  /**
   * Run one prompt turn and resolve when the agent settles it.
   * @param {string} text
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [options]
   */
  async prompt(text, options = {}) {
    if (this.sessionId === null) throw new Error('no ACP session is open')
    return this.connection.request(
      'session/prompt',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
      { signal: options.signal, timeoutMs: options.timeoutMs ?? 0 },
    )
  }

  cancel() {
    if (this.sessionId !== null) this.connection.cancel(this.sessionId)
  }
}
