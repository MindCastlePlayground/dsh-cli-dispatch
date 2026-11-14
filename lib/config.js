// Configuration normalization for the CLI dispatch plugin.
//
// One *target* describes how to start an agent CLI and how to speak to it:
// `acp` (Agent Client Protocol over stdio) is the machine-readable transport
// this plugin drives, `exec` is the one-shot command-line transport used for
// plain `--format json` runs. The defaults cover the opencode CLI that this
// repository validates against, so an empty config still gives a working
// `opencode` target when the binary is on PATH.

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000

/** Built-in target used when the config names none. */
function defaultTarget() {
  return {
    id: 'opencode',
    label: 'opencode',
    command: 'opencode',
    args: ['acp'],
    cwd: null,
    env: {},
    timeoutMs: DEFAULT_TIMEOUT_MS,
    model: null,
    agent: null,
    permission: 'allow',
  }
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

function normalizePermission(value) {
  return value === 'deny' || value === 'ask' ? value : 'allow'
}

function normalizeTarget(raw, index) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`targets[${index}] must be an object`)
  }
  const id = stringOr(raw.id, `target-${index + 1}`)
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new TypeError(`targets[${index}].id "${id}" must contain only letters, digits, dot, dash, or underscore`)
  }
  const args = Array.isArray(raw.args)
    ? raw.args.filter((entry) => typeof entry === 'string')
    : undefined
  const env = raw.env !== null && typeof raw.env === 'object'
    ? Object.fromEntries(Object.entries(raw.env).filter(([, v]) => typeof v === 'string'))
    : {}
  return {
    id,
    label: stringOr(raw.label, id),
    command: stringOr(raw.command, 'opencode'),
    args: args ?? ['acp'],
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : null,
    env,
    timeoutMs: Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0
      ? Math.min(raw.timeoutMs, 6 * 60 * 60_000)
      : DEFAULT_TIMEOUT_MS,
    model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : null,
    agent: typeof raw.agent === 'string' && raw.agent !== '' ? raw.agent : null,
    permission: normalizePermission(raw.permission),
  }
}

/**
 * Normalize raw plugin config into `{ targets, defaultTarget, transcript, ... }`.
 * An unknown `defaultTarget` is ignored rather than fatal so a profile patch
 * cannot brick activation over a typo.
 */
export function normalizeConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const rawTargets = Array.isArray(input.targets) ? input.targets : []
  const targets = rawTargets.length === 0
    ? [defaultTarget()]
    : rawTargets.map(normalizeTarget)

  const seen = new Set()
  for (const target of targets) {
    if (seen.has(target.id)) throw new TypeError(`duplicate target id "${target.id}"`)
    seen.add(target.id)
  }

  const requested = stringOr(input.defaultTarget, targets[0].id)
  const defaultTargetId = seen.has(requested) ? requested : targets[0].id

  return {
    targets,
    defaultTarget: defaultTargetId,
    /** Register the `cli_dispatch` model-facing tool. */
    tool: input.tool !== false,
    /** Register the `/dispatch` slash command. */
    command: input.command !== false,
    transcript: {
      maxChars: Number.isFinite(input.maxChars) && input.maxChars > 0
        ? Math.min(input.maxChars, 4_000_000)
        : DEFAULT_MAX_TRANSCRIPT_CHARS,
      /** Include the agent's reasoning chunks in the conversation transcript. */
      includeReasoning: input.includeReasoning === true,
      /** Include tool-call rows in the conversation transcript. */
      includeToolCalls: input.includeToolCalls !== false,
    },
    /** Stop a task's agent process when the dispatch call is cancelled. */
    killOnCancel: input.killOnCancel !== false,
  }
}

/** Find one target by id, or the configured default when `id` is absent. */
export function resolveTarget(config, id) {
  const wanted = stringOr(id, config.defaultTarget)
  const target = config.targets.find((entry) => entry.id === wanted)
  if (target === undefined) {
    const known = config.targets.map((entry) => entry.id).join(', ')
    throw new Error(`unknown CLI target "${wanted}"; configured targets: ${known}`)
  }
  return target
}
