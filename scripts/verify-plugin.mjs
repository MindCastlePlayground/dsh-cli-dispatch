// Load the plugin the way the host does, then call its tools.
//
// `npm test` proves the library; this proves the *plugin*: it imports
// `index.js`, gives it a minimal host context, and drives the registered tools
// against the real opencode binary. A regression in `apply()`, in the tool
// registration, or in the argument plumbing fails here.
//
// Usage: node scripts/verify-plugin.mjs [--command <path>] [--report <file>]

import path from 'node:path'
import process from 'node:process'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { apply, name, inject } from '../index.js'

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const workDir = path.join(packageDir, 'tmp', 'verify-plugin')

function parseArgs(argv) {
  const out = { command: 'opencode', report: path.join(packageDir, 'verify-plugin-report.json') }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--command') out.command = argv[++index]
    else if (argv[index] === '--report') out.report = argv[++index]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const checks = []
function check(assertion, detail) {
  checks.push({ name: assertion, ok: Boolean(detail), detail })
  console.log(`  [${detail ? 'PASS' : 'FAIL'}] ${assertion}`)
  return Boolean(detail)
}

/** A host context with just the services this plugin asks for. */
function makeContext() {
  const tools = new Map()
  const commands = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register: ({ name: toolName, description, parameters, output, execute }) => {
        tools.set(toolName, { description, parameters, output, execute })
        return () => tools.delete(toolName)
      },
    },
    commands: {
      register: ({ name: commandName, description, input, handler }) => {
        commands.set(commandName, { description, input, handler })
        return () => commands.delete(commandName)
      },
    },
    get: (service) => {
      if (service === 'commands') return ctx.commands
      if (service === 'logger') return null
      return undefined
    },
    effect: (create) => {
      const dispose = create()
      disposers.push(dispose)
      return () => {}
    },
  }
  return { ctx, tools, commands, disposers }
}

const { ctx, tools, commands, disposers } = makeContext()
await mkdir(workDir, { recursive: true })
apply(ctx, {
  targets: [{
    id: 'opencode',
    label: 'opencode (ACP)',
    command: args.command,
    args: ['acp'],
    cwd: workDir,
    timeoutMs: 240_000,
  }],
})

check('the plugin declares its host name', name === 'cli-dispatch', name)
check('the plugin declares its service dependency', inject.includes('tools'), inject.join(','))
check('apply() registered the three tools', tools.size === 3, [...tools.keys()].join(', '))
check('apply() registered the /dispatch command', commands.has('dispatch'), [...commands.keys()].join(', '))

const report = { ok: false, checks, tool: null, steps: [] }

try {
  console.log('1. call cli_dispatch the way the model would')
  const dispatched = await tools.get('cli_dispatch').execute({
    prompt: 'Reply with exactly this token and nothing else: PLUGIN-PATH-OK',
    waitMs: 120_000,
  }, { signal: undefined })
  check('cli_dispatch returned a task id', typeof dispatched?.task?.id === 'string', dispatched?.task?.id)
  check('cli_dispatch returned the agent reply', /\w/.test(dispatched?.reply ?? ''), (dispatched?.reply ?? '').slice(0, 80))
  check('the reply carries the requested token', /PLUGIN-PATH-OK/i.test(dispatched?.reply ?? ''))
  check('the tool result carries a conversation transcript', /Agent:/.test(dispatched?.transcript ?? ''))
  report.tool = dispatched?.task ?? null
  report.steps.push({ step: 'cli_dispatch', reply: dispatched?.reply ?? null })

  // The renderer is what makes this "conversational" in the DSH transcript.
  const rendered = tools.get('cli_dispatch').output.render({}, dispatched)
  check('the renderer emits text rows', Array.isArray(rendered) && rendered.length > 0 &&
    rendered.every((part) => part.type === 'text'), `${rendered?.length ?? 0} part(s)`)

  console.log('2. continue the same task through cli_message')
  const continued = await tools.get('cli_message').execute({
    id: dispatched.task.id,
    message: 'Which token did I ask for one message ago? Quote it exactly.',
    waitMs: 120_000,
  }, { signal: undefined })
  check('cli_message stayed on the same task', continued?.task?.id === dispatched.task.id)
  check('cli_message reused the same agent session',
    continued?.task?.sessionId === dispatched.task.sessionId,
    `${continued?.task?.sessionId}`)
  check('the agent answered from session memory', /PLUGIN-PATH-OK/i.test(continued?.reply ?? ''),
    (continued?.reply ?? '').slice(0, 80))
  report.steps.push({ step: 'cli_message', reply: continued?.reply ?? null })

  console.log('3. read and stop through cli_tasks')
  const listed = await tools.get('cli_tasks').execute({ action: 'list' }, { signal: undefined })
  check('cli_tasks lists the task', (listed?.tasks ?? []).some((entry) => entry.id === dispatched.task.id))

  const read = await tools.get('cli_tasks').execute({ id: dispatched.task.id, action: 'read' }, { signal: undefined })
  check('cli_tasks read returns the conversation',
    (read?.transcript ?? '').split('Agent:').length - 1 >= 2)

  const stopped = await tools.get('cli_tasks').execute({ id: dispatched.task.id, action: 'stop' }, { signal: undefined })
  check('cli_tasks stop reports the stopped task id', stopped?.stopped === dispatched.task.id, stopped?.stopped ?? 'none')
  check('the stopped task is cancelled',
    (stopped?.tasks ?? []).find((entry) => entry.id === dispatched.task.id)?.status === 'cancelled',
    (stopped?.tasks ?? []).find((entry) => entry.id === dispatched.task.id)?.status ?? 'missing')
  report.steps.push({ step: 'cli_tasks', status: (stopped?.tasks ?? [])[0]?.status ?? null })
} catch (error) {
  check('the plugin path ran without throwing', false)
  report.error = error.stack ?? error.message
  console.error(error)
}

// Tear down through the same effect the host would dispose.
for (const dispose of [...disposers].reverse()) {
  try { await (typeof dispose === 'function' ? dispose() : undefined) } catch {}
}
report.ok = checks.every((entry) => entry.ok)
await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log('')
console.log(`result: ${report.ok ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`)
console.log(`report: ${args.report}`)
process.exit(report.ok ? 0 : 1)
