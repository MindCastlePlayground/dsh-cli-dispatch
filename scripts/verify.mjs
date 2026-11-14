// End-to-end verification against the real opencode CLI.
//
// This is the proof the plugin works: no fake agent, no mocked transport. It
// drives `DispatchRegistry` — the exact code the model-facing tools use —
// against `opencode acp`, keeps a conversation over two turns in one agent
// session, and writes a JSON report so the result is reproducible.
//
// Usage:
//   node scripts/verify.mjs [--command <path>] [--report <file>] [--model <id>]

import path from 'node:path'
import process from 'node:process'
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from '../lib/config.js'
import { DispatchRegistry } from '../lib/tasks.js'

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function parseArgs(argv) {
  const out = { command: 'opencode', report: path.join(packageDir, 'verify-report.json'), model: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--command') out.command = argv[++index]
    else if (arg === '--report') out.report = argv[++index]
    else if (arg === '--model') out.model = argv[++index]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const workDir = path.join(packageDir, 'tmp', 'verify')

const config = normalizeConfig({
  targets: [{
    id: 'opencode',
    label: 'opencode (ACP)',
    command: args.command,
    args: ['acp'],
    cwd: workDir,
    timeoutMs: 240_000,
    model: args.model,
  }],
})

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  return ok
}

const startedAt = new Date().toISOString()
const report = { startedAt, command: args.command, checks, turns: [], ok: false }

await mkdir(workDir, { recursive: true })
const registry = new DispatchRegistry({ config })

try {
  console.log('1. open a task against the real opencode ACP server')
  const task = await registry.create({
    target: config.targets[0],
    cwd: workDir,
    title: 'verification run',
  })
  check('handshake completed', task.status === 'running', `status=${task.status}`)
  check('agent reported its identity', task.agentInfo !== null,
    task.agentInfo === null ? undefined : `${task.agentInfo.name} ${task.agentInfo.version}`)
  check('a real ACP session id was minted', typeof task.sessionId === 'string' && task.sessionId.startsWith('ses_'),
    task.sessionId ?? 'none')

  console.log('2. turn one: ask a question with a verifiable answer')
  const firstStarted = Date.now()
  const first = await task.prompt('Reply with exactly this token and nothing else: DISPATCH-TURN-ONE')
  const firstMs = Date.now() - firstStarted
  const firstReply = lastAssistant(task)
  check('turn one settled', first?.stopReason !== undefined, `stopReason=${first?.stopReason}`)
  check('turn one returned text', firstReply.length > 0, `${firstMs}ms`)
  check('turn one contains the requested token', /DISPATCH-TURN-ONE/i.test(firstReply), firstReply.slice(0, 120))

  console.log('3. turn two: prove the conversation is continuous (no transcript replay)')
  const second = await task.prompt('Which token did I ask you to reply with one message ago? Quote it exactly.')
  const secondReply = lastAssistant(task)
  check('turn two settled', second?.stopReason !== undefined, `stopReason=${second?.stopReason}`)
  check('the agent remembered the earlier turn without being told again', /DISPATCH-TURN-ONE/i.test(secondReply),
    secondReply.slice(0, 160))
  check('both turns share one agent session', task.turns === 2 && typeof task.sessionId === 'string',
    `turns=${task.turns} session=${task.sessionId}`)

  console.log('4. read the conversation the way the model and the panel do')
  const text = task.transcriptText(config.transcript.maxChars)
  check('the transcript has both user turns', (text.match(/^User:/gm) ?? []).length === 2)
  check('the transcript has both agent replies', (text.match(/^Agent:/gm) ?? []).length === 2)
  check('settled replies are no longer marked as streaming', !/\(streaming\)/.test(text),
    text.includes('(streaming)') ? 'a reply stayed open' : undefined)
  check('usage was reported by the agent', task.usage !== null,
    task.usage === null ? undefined : JSON.stringify(task.usage))

  report.turns = [
    { turn: 1, prompt: 'Reply with exactly this token and nothing else: DISPATCH-TURN-ONE', reply: firstReply, elapsedMs: firstMs, stopReason: first?.stopReason ?? null, usage: task.usage },
    { turn: 2, prompt: 'Which token did I ask you to reply with one message ago? Quote it exactly.', reply: secondReply, stopReason: second?.stopReason ?? null },
  ]
  report.transcript = text
  report.task = task.snapshot()
  report.sessionId = task.sessionId
  report.agent = task.agentInfo

  await task.close()
  task.finish('completed')
  check('the agent process was closed cleanly', true)
} catch (error) {
  check('verification ran without throwing', false, error.stack ?? error.message)
  report.error = error.stack ?? error.message
} finally {
  await registry.dispose()
}

report.ok = checks.every((entry) => entry.ok)
report.finishedAt = new Date().toISOString()
await writeFile(args.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log('')
console.log(`report: ${args.report}`)
console.log(`result: ${report.ok ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`)
process.exit(report.ok ? 0 : 1)

function lastAssistant(task) {
  for (let index = task.entries.length - 1; index >= 0; index -= 1) {
    if (task.entries[index].kind === 'assistant') return task.entries[index].text
  }
  return ''
}
