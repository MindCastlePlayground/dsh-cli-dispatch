// Entry point of the CLI task-dispatch plugin.
//
// Two halves share one registry:
// - the model-facing tools and the `/dispatch` command, which is how a task is
//   started and continued from a conversation;
// - a small HTTP surface (`/cli-dispatch/*`) that the Web panel polls, so a
//   human watching the conversation sees the same turns the model sees.
//
// The transport is ACP over stdio: one child agent process per task, one
// session per task, one turn per prompt. That is what makes the dialogue
// continuous instead of a series of unrelated one-shot runs.

import { normalizeConfig, resolveTarget } from './lib/config.js'
import { DispatchRegistry } from './lib/tasks.js'
import { registerDispatchTools } from './lib/tools.js'
import { registerDispatchCommand } from './lib/command.js'
import { registerPanelRoutes } from './lib/panel.js'

export const name = 'cli-dispatch'
export const inject = ['tools']

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.get('logger') ?? null
  const registry = new DispatchRegistry({ config, logger })

  ctx.effect(() => {
    const disposers = []
    const commands = ctx.get('commands')

    if (config.tool === true) {
      disposers.push(registerDispatchTools(ctx, registry, config, (id) => resolveTarget(config, id)))
    }
    if (config.command === true && commands !== undefined) {
      disposers.push(registerDispatchCommand({ ...ctx, commands }, registry, config, (id) => resolveTarget(config, id)))
    }
    disposers.push(registerPanelRoutes(ctx, registry, config))

    return async () => {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch {}
      }
      await registry.dispose()
    }
  }, 'cli-dispatch.activate()')
}

export { normalizeConfig, resolveTarget }
