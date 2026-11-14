// Model-facing tools for CLI task dispatch.
//
// Three entry points cover the whole life:
// - `cli_dispatch` starts a task and asks it the first question.
// - `cli_message` continues the conversation, which is what makes this
//   "conversational" instead of one-shot: the agent CLI keeps its own session
//   state and the transcript stays in order across turns.
// - `cli_tasks` reads a task, lists tasks, or stops one.

const taskSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'target', 'status', 'turns'],
  properties: {
    id: { type: 'string' },
    target: { type: 'string' },
    label: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    cwd: { type: 'string' },
    turns: { type: 'number' },
    entries: { type: 'number' },
    sessionId: { type: 'string' },
    model: { type: 'string' },
    stopReason: { type: 'string' },
    error: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
}

const dispatchResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['task', 'reply'],
  properties: {
    task: taskSummarySchema,
    reply: { type: 'string' },
    transcript: { type: 'string' },
  },
}

const renderJSON = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

/** Render a dispatch result as a readable conversation rather than as JSON. */
const renderConversation = (_args, value) => {
  const head = `task ${value.task.id} · ${value.task.label} · ${value.task.status}` +
    (value.task.stopReason === null ? '' : ` · ${value.task.stopReason}`)
  const body = value.transcript === undefined || value.transcript === ''
    ? value.reply
    : value.transcript
  return [{ type: 'text', text: `${head}\n\n${body}` }]
}

function summaryOf(snapshot) {
  return {
    id: snapshot.id,
    target: snapshot.target,
    label: snapshot.label,
    title: snapshot.title,
    status: snapshot.status,
    cwd: snapshot.cwd,
    turns: snapshot.turns,
    entries: snapshot.entries,
    ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
    ...(snapshot.model === undefined ? {} : { model: snapshot.model }),
    ...(snapshot.stopReason === undefined ? {} : { stopReason: snapshot.stopReason }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  }
}

/** The last assistant entry of a task, for the `reply` field. */
function lastReply(task) {
  for (let index = task.entries.length - 1; index >= 0; index -= 1) {
    const row = task.entries[index]
    if (row.kind === 'assistant') return row.text
  }
  const failure = [...task.entries].reverse().find((row) => row.kind === 'error')
  return failure?.text ?? ''
}

export function registerDispatchTools(ctx, registry, config, resolveTarget) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'cli_dispatch',
    description:
      'Delegate a task to an external agent CLI (by default the opencode agent) and hold a real conversation with it. ' +
      'Starts one long-lived agent session, sends the prompt, and returns the agent reply plus the conversation transcript. ' +
      'Call cli_message with the returned task id to continue the same conversation. ' +
      'Use this for work you want a separate coding agent to perform in its own workspace.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'The instruction for the external agent CLI.' },
        target: { type: 'string', description: 'Configured CLI target id. Defaults to the plugin default target.' },
        cwd: { type: 'string', description: 'Working directory for the agent CLI. Defaults to the configured target cwd, then the session cwd.' },
        model: { type: 'string', description: 'Model id for the agent CLI, when the target supports session model selection.' },
        title: { type: 'string', description: 'Short label for the task, shown in the panel.' },
        waitMs: { type: 'number', description: 'How long to wait for the reply before returning a running task id, 1000-600000. Defaults to 120000.' },
      },
    },
    output: { schema: dispatchResultSchema, render: renderConversation },
    async execute(args, exec) {
      const target = resolveTarget(config, args.target)
      const cwd = args.cwd ?? target.cwd ?? exec?.agent?.session?.cwd ?? process.cwd()
      const task = await registry.create({
        target,
        cwd,
        title: args.title ?? args.prompt.slice(0, 60),
        prompt: args.prompt,
        model: args.model ?? null,
      })
      const settled = await waitForTurn(task, args.prompt, {
        signal: exec?.signal,
        waitMs: clampWait(args.waitMs),
        includeReasoning: config.transcript.includeReasoning,
        includeToolCalls: config.transcript.includeToolCalls,
      })
      return {
        task: summaryOf(task.snapshot()),
        reply: lastReply(task),
        transcript: feedback(task, config, settled),
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'cli_message',
    description:
      'Continue an existing external-agent conversation started by cli_dispatch. Sends one more user turn to the same agent session and returns its reply. ' +
      'The agent keeps its own context, so follow-up questions do not need the earlier transcript repeated.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'The next user turn for the agent CLI.' },
        id: { type: 'string', description: 'Dispatch task id. Defaults to the most recent task.' },
        waitMs: { type: 'number', description: 'How long to wait for the reply before returning a running task id, 1000-600000. Defaults to 120000.' },
      },
    },
    output: { schema: dispatchResultSchema, render: renderConversation },
    async execute(args, exec) {
      const task = registry.resolve(args.id)
      const settled = await waitForTurn(task, args.message, {
        signal: exec?.signal,
        waitMs: clampWait(args.waitMs),
        includeReasoning: config.transcript.includeReasoning,
        includeToolCalls: config.transcript.includeToolCalls,
      })
      return {
        task: summaryOf(task.snapshot()),
        reply: lastReply(task),
        transcript: feedback(task, config, settled),
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'cli_tasks',
    description:
      'Inspect or control external-agent CLI tasks. Returns the task list by default; pass id to read one task transcript, or action stop to cancel a task and close its agent process.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Dispatch task id. Omit to list every task.' },
        action: { type: 'string', enum: ['list', 'read', 'stop'], description: 'Defaults to list when id is absent, read when it is present.' },
        maxChars: { type: 'number', description: 'Maximum transcript characters to return on read, 500-200000.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['tasks'],
        properties: {
          tasks: { type: 'array', items: taskSummarySchema },
          transcript: { type: 'string' },
          stopped: { type: 'string' },
        },
      },
      render: renderJSON,
    },
    async execute(args) {
      const action = args.action ?? (args.id === undefined ? 'list' : 'read')
      if (action === 'stop') {
        const task = registry.resolve(args.id)
        await registry.cancel(task.id, true)
        return { tasks: registry.list(), stopped: task.id }
      }
      if (action === 'read') {
        const task = registry.resolve(args.id)
        const maxChars = Math.max(500, Math.min(200_000, args.maxChars ?? config.transcript.maxChars))
        return { tasks: [summaryOf(task.snapshot())], transcript: task.transcriptText(maxChars) }
      }
      return { tasks: registry.list().map(summaryOf) }
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  }
}

function clampWait(value) {
  if (!Number.isFinite(value)) return 120_000
  return Math.max(1_000, Math.min(600_000, value))
}

/**
 * Send one turn and wait up to `waitMs` for it to settle. A turn that is still
 * running when the budget expires is reported as running: the caller keeps the
 * task id and can read it later, so no work is lost to a timeout.
 */
async function waitForTurn(task, text, options) {
  const turn = task.prompt(text, { signal: options.signal })
  // The turn promise rejects on failure; the settled flag below reports it, so
  // attach a no-op handler to keep Node from flagging an unhandled rejection.
  turn.catch(() => {})
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), options.waitMs)
  })
  const outcome = await Promise.race([turn.then(() => 'settled', () => 'failed'), timeout])
  if (timer !== null) clearTimeout(timer)
  return outcome
}

/** Build the model-facing transcript for one turn. */
function feedback(task, config, outcome) {
  const text = transcript(task.entries, config)
  if (outcome === 'timeout') {
    return `${text}\n\n[The agent is still working. Task ${task.id} is running; call cli_tasks with id ${task.id} to read it later.]`
  }
  if (task.status === 'failed') {
    return `${text}\n\n[The turn failed: ${task.error ?? 'unknown error'}]`
  }
  return text
}

/** Format conversation entries, keeping the tail within the character budget. */
export function transcript(entries, config) {
  const lines = []
  for (const row of entries) {
    if (row.kind === 'reasoning' && config.transcript.includeReasoning !== true) continue
    if (row.kind === 'tool' && config.transcript.includeToolCalls === false) continue
    const label = LABEL[row.kind] ?? row.kind
    lines.push(`${label}: ${row.text.replace(/\s+$/u, '')}`)
  }
  let text = lines.join('\n')
  const limit = config.transcript.maxChars
  if (text.length > limit) {
    text = `…[${text.length - limit} characters trimmed from the start]\n${text.slice(text.length - limit)}`
  }
  return text
}

const LABEL = {
  user: 'User',
  assistant: 'Agent',
  reasoning: 'Agent (thinking)',
  tool: 'Tool',
  system: 'System',
  error: 'Error',
}
