// The `/dispatch` slash command: task dispatch from the human side of the
// conversation, not from the model's tool surface.
//
// `/dispatch <prompt>` starts a task, `/dispatch --task <id> <message>` continues
// one, and `/dispatch --list` shows what exists. The command renders into the
// composer's command result, so a person can drive the same registry the model
// drives.

const HELP = [
  'Usage:',
  '  /dispatch <prompt>              start a task on the default CLI target',
  '  /dispatch --target <id> <text>  start on a named target',
  '  /dispatch --task <id> <text>    continue an existing task',
  '  /dispatch --list                list tasks',
  '  /dispatch --read <id>           read one task transcript',
  '  /dispatch --stop <id>           stop a task and close its agent process',
].join('\n')

/** Parse the command's own grammar: flags first, then the free-text tail. */
export function parseCommandInput(rawInput) {
  const text = String(rawInput ?? '')
  const flags = { target: null, task: null }
  let action = 'dispatch'
  let rest = text

  const patterns = [
    ['--list', 'list', false],
    ['--read', 'read', true],
    ['--stop', 'stop', true],
    ['--task', 'task', true],
    ['--target', 'target', true],
  ]

  for (const [flag, key, takesValue] of patterns) {
    const index = rest.indexOf(`${flag} `)
    const atEnd = rest.trimEnd().endsWith(flag)
    if (index < 0 && !atEnd) continue
    if (takesValue) {
      const start = index >= 0 ? index : rest.trimEnd().length - flag.length
      const after = rest.slice(start + flag.length).trimStart()
      const [value, ...tail] = after.split(/\s+/u)
      if (value === undefined || value === '') return { error: `${flag} requires a value` }
      if (key === 'task') flags.task = value
      else if (key === 'target') flags.target = value
      else {
        action = key
        flags.task = value
        rest = `${rest.slice(0, start)} ${tail.join(' ')}`
        continue
      }
      rest = `${rest.slice(0, start)} ${tail.join(' ')}`
    } else {
      action = key
      rest = rest.replace(flag, ' ')
    }
  }

  return { action, target: flags.target, task: flags.task, prompt: rest.trim() }
}

export function registerDispatchCommand(ctx, registry, config, resolveTarget) {
  const dispose = ctx.commands.register({
    name: 'dispatch',
    description: 'Dispatch a task to an external agent CLI and hold a conversation with it',
    input: { hint: '<prompt> | --list | --task <id> <text> | --read <id> | --stop <id>' },
    async handler({ rawInput }) {
      const parsed = parseCommandInput(rawInput)
      if (parsed.error !== undefined) return { kind: 'error', text: parsed.error }

      if (parsed.action === 'list') {
        const tasks = registry.list()
        if (tasks.length === 0) return { kind: 'success', text: 'no dispatch tasks yet' }
        return {
          kind: 'success',
          text: tasks
            .map((task) => `${task.id}  ${task.status.padEnd(9)} ${task.label}  ${task.turns} turn(s)  ${task.title}`)
            .join('\n'),
        }
      }

      if (parsed.action === 'read') {
        const task = registry.resolve(parsed.task)
        return { kind: 'success', text: task.transcriptText(config.transcript.maxChars) }
      }

      if (parsed.action === 'stop') {
        const task = registry.resolve(parsed.task)
        await registry.cancel(task.id, true)
        return { kind: 'success', text: `stopped ${task.id}` }
      }

      if (parsed.prompt === '') return { kind: 'error', text: HELP }

      if (parsed.task !== null) {
        const task = registry.require(parsed.task)
        await task.prompt(parsed.prompt)
        return { kind: 'success', text: replyOf(task) }
      }

      const target = resolveTarget(config, parsed.target)
      const cwd = target.cwd ?? process.cwd()
      const task = await registry.create({
        target,
        cwd,
        title: parsed.prompt.slice(0, 60),
        prompt: parsed.prompt,
      })
      await task.prompt(parsed.prompt)
      return { kind: 'success', text: `task ${task.id} (${target.label})\n\n${replyOf(task)}` }
    },
  })
  return () => { try { dispose() } catch {} }
}

function replyOf(task) {
  for (let index = task.entries.length - 1; index >= 0; index -= 1) {
    const row = task.entries[index]
    if (row.kind === 'assistant') return row.text
  }
  const failure = [...task.entries].reverse().find((row) => row.kind === 'error')
  return failure?.text ?? '(no reply)'
}

export { HELP }
