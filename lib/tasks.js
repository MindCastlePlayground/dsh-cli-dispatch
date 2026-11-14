// Dispatch task registry: one task is one ACP session over one agent CLI
// process, plus the conversation transcript that both the model and the Web
// panel read.
//
// Conversation is the point: a task keeps every turn in order, and every
// assistant, reasoning, tool, and system entry is appended as it streams in, so
// a reader that joins late still sees one coherent dialogue instead of a log.

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { AcpConnection, AcpSession } from './acp.js'

const MAX_SETTLED_TASKS = 32
const PROGRESS_THROTTLE_MS = 120

let taskCounter = 0

function nextTaskId(kind) {
  taskCounter += 1
  return `${kind}-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** One conversation entry. `seq` is per-task and strictly increasing. */
function entry(kind, text, extra = {}) {
  return { seq: 0, kind, text, at: Date.now(), ...extra }
}

export class DispatchTask {
  constructor(options) {
    this.id = nextTaskId('dispatch')
    this.target = options.target
    this.targetId = options.target.id
    this.targetLabel = options.target.label
    this.cwd = options.cwd
    this.title = options.title
    this.status = 'starting'
    this.createdAt = Date.now()
    this.updatedAt = this.createdAt
    this.entries = []
    this.turns = 0
    this.usage = null
    this.stopReason = null
    this.error = null
    this.model = options.model ?? null
    this.agentInfo = null
    this.sessionId = null
    this.pendingPermission = null
    this.availableCommands = []
    this.currentMode = null
    this.unknownUpdates = []
    this.#emitter = new EventEmitter()
    this.#emitter.setMaxListeners(64)
  }

  #seq = 0
  #connection = null
  #acp = null
  #emitter
  #progressAt = 0
  #openAssistant = null
  #cancelRequested = false
  #currentMessageId = null
  #currentToolCallId = null
  #closed = false

  /** Subscribe to `change` (snapshot) and `settle` (terminal status). */
  subscribe(listener) {
    this.#emitter.on('change', listener)
    return () => this.#emitter.off('change', listener)
  }

  onSettle(listener) {
    this.#emitter.once('settle', listener)
    return () => this.#emitter.off('settle', listener)
  }

  /** Append one conversation entry and publish a change. */
  push(kind, text, extra) {
    if (this.#closed) return null
    const row = entry(kind, text, extra)
    row.seq = ++this.#seq
    this.entries.push(row)
    this.updatedAt = row.at
    this.#publish()
    return row
  }

  /** Append streamed assistant text, coalescing into the open assistant entry. */
  appendAssistant(text) {
    if (text === '') return
    const open = this.#openAssistant
    if (open !== null) {
      open.text += text
      open.at = Date.now()
      this.updatedAt = open.at
      this.#publish(true)
      return
    }
    const row = this.push('assistant', text, { streaming: true })
    if (row === null) return
    this.#openAssistant = row
  }

  /**
   * Mark the open assistant entry complete so the next chunk starts a new one.
   * This tracks the open row by reference rather than by position, because an
   * agent may interleave other notifications (usage, tool calls) between the
   * last text chunk and the end of the turn.
   */
  closeAssistantEntry() {
    const open = this.#openAssistant
    this.#openAssistant = null
    if (open === null) return
    delete open.streaming
    open.at = Date.now()
    this.updatedAt = open.at
    this.#publish(true)
  }

  #publish(force) {
    const now = Date.now()
    if (force !== true && now - this.#progressAt < PROGRESS_THROTTLE_MS) return
    this.#progressAt = now
    this.#emitter.emit('change', this.snapshot())
  }

  /** Compact view for the model-facing tool result. */
  snapshot() {
    const counts = { assistant: 0, reasoning: 0, tool: 0, system: 0, error: 0, user: 0 }
    for (const row of this.entries) {
      if (counts[row.kind] !== undefined) counts[row.kind] += 1
    }
    return {
      id: this.id,
      target: this.targetId,
      label: this.targetLabel,
      title: this.title,
      status: this.status,
      cwd: this.cwd,
      turns: this.turns,
      entries: this.entries.length,
      counts,
      ...(this.availableCommands.length === 0 ? {} : { availableCommands: this.availableCommands }),
      ...(this.sessionId === null ? {} : { sessionId: this.sessionId }),
      ...(this.model === null ? {} : { model: this.model }),
      ...(this.usage === null ? {} : { usage: this.usage }),
      ...(this.stopReason === null ? {} : { stopReason: this.stopReason }),
      ...(this.error === null ? {} : { error: this.error }),
      ...(this.pendingPermission === null ? {} : { pendingPermission: this.pendingPermission }),
      createdAt: new Date(this.createdAt).toISOString(),
      updatedAt: new Date(this.updatedAt).toISOString(),
    }
  }

  /** Conversation text, bounded by `maxChars` from the tail. */
  transcriptText(maxChars) {
    const lines = []
    for (const row of this.entries) {
      const label = ROW_LABEL[row.kind] ?? row.kind
      lines.push(`${label}${row.streaming === true ? ' (streaming)' : ''}: ${row.text}`)
    }
    let text = lines.join('\n')
    if (maxChars !== undefined && text.length > maxChars) {
      text = `…[${text.length - maxChars} characters trimmed]\n${text.slice(text.length - maxChars)}`
    }
    return text
  }

  /**
   * Start the agent process and open one ACP session.
   * @param {{signal?: AbortSignal, onProgress?: Function}} [options]
   */
  async open(options = {}) {
    const target = this.target
    // A missing working directory makes `spawn` fail with ENOENT naming the
    // *command*, which reads as "the agent binary is gone". Check it first so
    // the error points at the real problem.
    try {
      const info = await stat(this.cwd)
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch (error) {
      const failure = new Error(
        `the working directory "${this.cwd}" is unusable (${error.code ?? error.message}); ` +
        'set `cwd` on the target or pass one to the dispatch call',
      )
      this.status = 'failed'
      this.error = failure.message
      this.push('error', failure.message)
      this.#settle()
      throw failure
    }
    const connection = new AcpConnection({
      command: target.command,
      args: target.args,
      cwd: this.cwd,
      env: Object.keys(target.env ?? {}).length === 0 ? undefined : { ...process.env, ...target.env },
      requestTimeoutMs: 120_000,
    })
    this.#connection = connection
    connection.on('stderr', (text) => {
      if (this.#closed) return
      this.push('system', text.trimEnd(), { stream: 'stderr' })
    })
    connection.on('protocol-error', (error) => {
      if (this.#closed) return
      this.push('error', error.message)
    })
    connection.on('update', (params) => this.#onUpdate(params))
    connection.on('permission', ({ request, respond }) => {
      this.pendingPermission = {
        title: request?.toolCall?.title ?? request?.toolCall?.kind ?? 'permission requested',
        options: (request?.options ?? []).map((option) => option.optionId),
      }
      const mode = this.target.permission ?? 'allow'
      this.push('system', `permission requested: ${this.pendingPermission.title} (mode=${mode})`)
      const options = request?.options ?? []
      const pick = options.find((option) => option.kind === 'allow_once') ??
        options.find((option) => option.kind === 'allow_always') ??
        options[0]
      if (mode === 'allow' && pick !== undefined) {
        respond(pick.optionId)
        this.push('system', `permission granted: ${pick.optionId}`)
      } else if (mode === 'deny') {
        respond(options.find((option) => option.kind === 'reject_once')?.optionId ?? pick?.optionId)
        this.push('system', 'permission denied by policy')
      } else {
        this.push('system', 'permission left pending; answer it from the panel')
      }
      this.pendingPermission = null
    })

    connection.start()
    const acp = new AcpSession(connection)
    this.#acp = acp
    try {
      await acp.initialize()
      this.agentInfo = acp.agentInfo
      await acp.newSession(this.cwd)
      this.sessionId = acp.sessionId
      const wantedModel = this.model
      if (wantedModel !== null && acp.configOptions.some((option) => option.id === 'model')) {
        try {
          await connection.request('session/set_model', { sessionId: this.sessionId, modelId: wantedModel })
        } catch (error) {
          this.push('system', `model selection ignored: ${error.message}`)
        }
      }
    } catch (error) {
      this.status = 'failed'
      this.error = error.message
      this.push('error', `failed to open the agent session: ${error.message}`)
      await this.close()
      this.#settle()
      throw error
    }
    this.status = 'running'
    return this
  }

  #onUpdate(params) {
    if (this.#closed) return
    const update = params?.update ?? {}
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const text = update.content?.text ?? update.content?.content ?? ''
      if (typeof text === 'string' && text !== '') this.appendAssistant(text)
      this.#currentMessageId = update.messageId ?? this.#currentMessageId
      return
    }
    if (kind === 'agent_thought_chunk') {
      const text = update.content?.text ?? ''
      if (typeof text === 'string' && text !== '') this.push('reasoning', text, { streaming: true })
      return
    }
    if (kind === 'tool_call') {
      this.closeAssistantEntry()
      this.#currentToolCallId = update.toolCallId ?? null
      const title = update.title ?? update.kind ?? 'tool'
      const detail = update.rawInput === undefined ? '' : ` ${truncate(JSON.stringify(update.rawInput), 400)}`
      this.push('tool', `${title}${detail}`, { toolCallId: this.#currentToolCallId, phase: update.status ?? 'started' })
      return
    }
    if (kind === 'tool_call_update') {
      const status = update.status ?? 'update'
      const title = update.title ?? ''
      const detail = update.rawOutput === undefined ? '' : ` ${truncate(JSON.stringify(update.rawOutput), 400)}`
      if (title === '' && detail === '' && status === 'in_progress') return
      this.push('tool', `${title !== '' ? title : this.#currentToolCallId ?? 'tool'} → ${status}${detail}`, {
        toolCallId: update.toolCallId ?? this.#currentToolCallId,
        phase: status,
      })
      return
    }
    if (kind === 'available_commands_update') {
      // Session metadata, not conversation: the panel shows it as a hint, and
      // the model-facing transcript stays free of setup chatter.
      this.availableCommands = (update.availableCommands ?? []).map((command) => ({
        name: command.name,
        description: command.description ?? '',
      }))
      this.#publish(true)
      return
    }
    if (kind === 'current_mode_update') {
      this.currentMode = update.currentModeId ?? update.modeId ?? null
      this.#publish(true)
      return
    }
    if (kind === 'usage_update') {
      // Token accounting is panel telemetry; it is not a conversational turn.
      this.usage = update.usage ?? update
      this.#publish(true)
      return
    }
    if (kind === 'user_message_chunk') return
    // Anything the protocol adds later is shown to the panel as raw metadata
    // rather than guessed into the conversation.
    this.unknownUpdates.push({
      kind: kind ?? 'unknown',
      at: Date.now(),
      payload: truncate(JSON.stringify(update), 2_000),
    })
    if (this.unknownUpdates.length > 50) this.unknownUpdates.shift()
    this.#publish(true)
  }

  /** Run one prompt turn. Resolves with the agent's stop reason. */
  async prompt(text, options = {}) {
    if (this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled') {
      throw new Error(`the task is ${this.status} and accepts no further prompts`)
    }
    if (this.#acp === null) throw new Error('the task has no open agent session')
    this.closeAssistantEntry()
    this.push('user', text)
    this.turns += 1
    this.status = 'running'
    this.#cancelRequested = false
    this.#publish(true)
    try {
      const result = await this.#acp.prompt(text, {
        signal: options.signal,
        timeoutMs: this.target.timeoutMs,
      })
      this.stopReason = result?.stopReason ?? null
      this.usage = result?.usage ?? null
      this.closeAssistantEntry()
      this.status = 'idle'
      this.#publish(true)
      return result
    } catch (error) {
      // A stop the user or the panel asked for is a cancellation, not a fault:
      // the agent answers one of these either as an aborted request or as a
      // cancelled-turn error, and both must read the same to the caller.
      if (options.signal?.aborted === true || this.#cancelRequested) {
        this.status = 'cancelled'
        this.push('system', 'turn cancelled')
      } else {
        this.status = 'failed'
        this.error = error.message
        this.push('error', error.message)
      }
      this.closeAssistantEntry()
      this.#publish(true)
      throw error
    }
  }

  /** Stop the current turn without closing the session. */
  cancelTurn() {
    this.#cancelRequested = true
    this.#acp?.cancel()
  }

  /** Terminate the agent process and settle the task. */
  async close() {
    if (this.#connection !== null) await this.#connection.close()
    this.#connection = null
    this.#acp = null
    this.#closed = true
  }

  /** Mark terminal and notify waiters. */
  finish(status) {
    if (this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled') return
    this.status = status
    this.updatedAt = Date.now()
    this.#publish(true)
    this.#settle()
  }

  #settle() {
    this.#emitter.emit('settle', this.snapshot())
  }
}

const ROW_LABEL = {
  user: 'User',
  assistant: 'Agent',
  reasoning: 'Agent (thinking)',
  tool: 'Tool',
  system: 'System',
  error: 'Error',
}

function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * Owns every dispatch task in this process. Tasks are addressable by id and
 * every mutation is observable, which is what the tool, the command, the CLI,
 * and the Web panel all read.
 */
export class DispatchRegistry {
  constructor(options = {}) {
    this.config = options.config
    this.logger = options.logger ?? null
    this.tasks = new Map()
    this.#emitter = new EventEmitter()
    this.#emitter.setMaxListeners(128)
  }

  #emitter

  /** Subscribe to task creation and settlement. */
  subscribe(listener) {
    this.#emitter.on('event', listener)
    return () => this.#emitter.off('event', listener)
  }

  list() {
    return [...this.tasks.values()].map((task) => task.snapshot())
  }

  get(id) {
    return this.tasks.get(id) ?? null
  }

  require(id) {
    const task = this.tasks.get(id)
    if (task === undefined) {
      const known = [...this.tasks.keys()].join(', ')
      throw new Error(`unknown dispatch task "${id}"; known tasks: ${known || '(none)'}`)
    }
    return task
  }

  /** Resolve a task id, or the most recent task when the id is absent. */
  resolve(id) {
    if (id !== undefined && id !== null && id !== '') return this.require(id)
    const all = [...this.tasks.values()]
    if (all.length === 0) throw new Error('no dispatch task exists yet; start one first')
    return all[all.length - 1]
  }

  /**
   * Create and open a task. The returned task has an open ACP session and
   * accepts prompts.
   * @param {{target: object, cwd: string, title: string, model?: string|null, signal?: AbortSignal}} options
   */
  async create(options) {
    const target = options.target
    const task = new DispatchTask({
      target,
      cwd: options.cwd,
      title: options.title ?? options.prompt?.slice(0, 60) ?? 'dispatch',
      model: options.model ?? target.model ?? null,
    })
    this.tasks.set(task.id, task)
    this.#emitter.emit('event', { kind: 'created', task: task.snapshot() })
    task.onSettle((snapshot) => {
      this.#emitter.emit('event', { kind: 'settled', task: snapshot })
      this.#evict()
    })
    await task.open()
    return task
  }

  /** Drop the oldest settled tasks so long sessions stay bounded. */
  #evict() {
    const settled = [...this.tasks.values()].filter(
      (task) => task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled',
    )
    while (settled.length > MAX_SETTLED_TASKS) {
      const oldest = settled.shift()
      this.tasks.delete(oldest.id)
      this.#emitter.emit('event', { kind: 'evicted', task: oldest.snapshot() })
    }
  }

  /** Cancel one task's turn, or close it when `close` is set. */
  async cancel(id, close = false) {
    const task = this.require(id)
    task.cancelTurn()
    if (close) {
      await task.close()
      task.finish('cancelled')
    }
  }

  async dispose() {
    await Promise.all([...this.tasks.values()].map(async (task) => {
      await task.close()
      task.finish('cancelled')
    }))
    this.tasks.clear()
    this.#emitter.removeAllListeners()
  }
}
