# DSH CLI Dispatch

把一个 CLI agent（默认 `opencode acp`）变成 DSH 里的**可分发任务**，并提供**对话式**的查看与追问界面。

> 仓库：[MindCastlePlayground/dsh-cli-dispatch](https://github.com/MindCastlePlayground/dsh-cli-dispatch)

DSH 自带的 subagent 只能跑 DSH 自己的模型。真实开发中经常需要把活儿交给外部 CLI agent：它有自己的工具链、自己的 provider 额度、自己的登录态、自己的沙箱。这个插件把这类 CLI 收进 DSH：

- **任务分发**：模型调用 `cli_dispatch` 起一个任务，插件拉起 CLI 子进程、建一个会话，把 prompt 发过去；
- **对话式**：一个任务 = 一个长驻 agent 会话。后续用 `cli_message` 追问，走同一会话，**上下文不重放**；
- **CLI 调用**：`/dispatch` 命令让用户自己起任务、读任务、停任务，不必经过模型；
- **可视化**：Web 侧栏多一个 Dispatch 面板，实时看对话、直接输入下一轮、随时 Stop。

```
packages/dsh-cli-dispatch/
  index.js                  # Host 插件入口（注册工具、命令、面板路由）
  cordis.patch.yml          # bundle 插入行
  lib/config.js             # 配置归一化：targets / 默认 target / transcript 策略
  lib/acp.js                # ACP over stdio 客户端（NDJSON 分帧 + 会话）
  lib/tasks.js              # 任务与会话注册表（一个 task = 一个 agent 进程 + 一个 session）
  lib/tools.js              # cli_dispatch / cli_message / cli_tasks 三个工具
  lib/command.js            # /dispatch 命令解析与执行
  lib/panel.js              # /cli-dispatch/* HTTP 路由（面板 + 工具共用同一注册表）
  client/index.js           # Web 面板（sidebar.panellist + main 槽位）
  scripts/verify.mjs        # 对真实 opencode 的端到端验证
  test/                     # node:test：ACP 假 agent + 面板 HTTP 集成测试
```

## 为什么是 ACP，不是 `opencode run`

本机实测：`opencode run`（含 `--format json`、`--standalone`、`--print-logs`）会挂住——stdout 无输出、进程不退出，日志只停在 `cli starting`。`opencode acp` 正常。

所以插件用 **ACP（Agent Client Protocol）over stdio** 作为默认传输：

- 一个 task 拉起一个 `opencode acp` 子进程，握手一次，建一个 session；
- 一次 prompt 是一轮 JSON-RPC 请求，回复以 `session/update` 流式推回；
- 多轮 prompt 复用同一 session —— 这是“对话式”的物理基础，也是它比“每次重开 CLI 再拼历史”更省 token 的原因；
- 需要工具授权时，agent 发 `session/request_permission`，插件按 `permission` 配置自动应答或转人工。

这个协议不是 opencode 私有：任何讲 ACP 的 agent 都能当 target，只改 `command`/`args` 即可。

## 安装

包是标准 DSH 本地 bundle。在 profile 的 `package.json` 里加入：

```jsonc
{
  "dependencies": {
    "@local/dsh-cli-dispatch": "link:H:/path/to/packages/dsh-cli-dispatch"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "@local/dsh-cli-dispatch"]
    }
  }
}
```

包内 `cordis.patch.yml` 会插入一条 `cli-dispatch` 行；不写 `config` 也能跑，默认就是本机 `opencode acp`。

> 与仓库其它本地包一致：**不 import `@deepseek-ai/*`**。Windows 下 profile 本地包经 junction 解析 DSH 包时 Node ESM loader 无法 stat，因此插件只用 Node 内置模块与 `ctx` 服务。

## 配置

```yaml
- insert:
    - id: cli-dispatch
      name: '@local/dsh-cli-dispatch'
      config:
        defaultTarget: opencode
        tool: cli_dispatch        # 工具名前缀，按需改
        command: dispatch         # /dispatch
        targets:
          - id: opencode
            label: opencode (ACP)
            command: opencode
            args: [acp]
            cwd: H:/work
            permission: allow     # allow | deny | ask
            timeoutMs: 900000
            model: deepseek/deepseek-v4-pro
        transcript:
          maxChars: 200000
          includeReasoning: false
          includeToolCalls: true
        killOnCancel: true
```

- `targets[].permission`：`allow` 自动同意工具授权；`deny` 自动拒绝；`ask` 转给 `cli_tasks` 的调用方处理。
- `transcript.includeReasoning` 默认 **false**：思考过程对模型价值低、token 高。面板仍然全量显示。
- `transcript.maxChars` 从**尾部**截断，并在开头标注 `…[N characters trimmed from the start]`，避免长会话把上下文撑爆。

## 模型侧工具

| 工具 | 作用 |
| --- | --- |
| `cli_dispatch(prompt, target?, cwd?, model?, title?, waitMs?)` | 起任务并等第一轮，返回 `{task, reply, transcript}` |
| `cli_message(message, id?, waitMs?)` | 对已有任务追问，走同一会话 |
| `cli_tasks(id?, action?, maxChars?)` | `list` 列任务 / `read` 读对话 / `stop` 停止 |

`waitMs`（1s–10min，默认 2min）是**等待上限，不是超时**：到点任务不会被杀，工具返回 `status: running` 的任务 id 并提示用 `cli_tasks(id)` 续读。长任务因此不会丢。

对话式渲染：`cli_dispatch` / `cli_message` 的输出用 `renderConversation` 渲染成对话行（`You:` / `Agent:` / `thinking:` / `tool:`），而不是一坨 JSON。

## CLI 调用

```
/dispatch 把 README 重写一遍              # 起任务
/dispatch --target local 修一下测试       # 指定 target
/dispatch --list                          # 列任务
/dispatch --read dispatch-1a2b3c4d        # 读对话
/dispatch --task dispatch-1a2b3c4d 继续   # 向该任务追问
/dispatch --stop dispatch-1a2b3c4d        # 停止
```

## Web 面板

侧栏出现 **Dispatch** 入口，主面板是两个视图：

- 左：任务列表（状态点、轮次、`N you · M agent`）；
- 右：当前任务的实时对话 + 输入框 + Stop。

面板走 `/cli-dispatch/*` 路由，和模型工具**读写同一份注册表**——模型起的任务，人能在面板里接着聊；人在面板里发的消息，模型下次 `cli_tasks` 也能读到。面板用长轮询（`since=<seq>`）拿增量，不重放历史。

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/cli-dispatch/config` | targets 与默认 target |
| GET | `/cli-dispatch/tasks` | 任务快照列表 |
| GET | `/cli-dispatch/tasks/<id>` | 任务 + 全量对话（面板首屏用） |
| GET | `/cli-dispatch/tasks/<id>/events?since=<seq>` | 长轮询增量 |
| POST | `/cli-dispatch/tasks/<id>/message` | `{message}`，追加一轮（202） |
| POST | `/cli-dispatch/tasks/<id>/stop` | 取消当前轮并关闭 |

## 验证

### 单元 / 集成

```bash
cd packages/dsh-cli-dispatch
npm test
```

25 个用例，全部 `node --test`：

- 配置归一化（默认 target、重复 id、未知 default 回退、`resolveTarget`）；
- `/dispatch` 命令解析；
- ACP 传输（对 `test/fixtures/fake-acp.mjs` 这个可脚本化假 agent，覆盖握手、流式、多轮、工具行、权限应答、关闭后拒绝、缺失命令不挂起）；
- transcript 顺序、过滤、截断；
- 面板 HTTP 路由（真实 `node:http` 服务、增量轮询、`message`/`stop`、空 transcript、404/400）；
- 面板 bundle 契约（在 `node:vm` 里按宿主的 `window.__ModuleLoader__.load` 格式真跑一遍：注册 id、只 require 共享基线模块、导出 `apply`/`inject`、注册 `sidebar.panellist` 与 `main` 槽、factory 内不碰 DOM）。

最后一条是补上的：面板是手写 bundle，`node --check` 只能说语法没坏，跑不起就只能在浏览器里发现。把它放进 `vm` + 假 `window`/`require` 里执行，才能证明它真的能被宿主加载。

### 对真实 opencode 的端到端验证

```bash
node scripts/verify.mjs --command "D:/Code/soft/OpenCode/npm/node_modules/@opencode/cli/bin/opencode.exe"
```

它驱动的是**插件自己的注册表**（和模型工具同一条代码路径），不是 mock。最近一次结果：

```
PASS  handshake completed              status=running
PASS  agent reported its identity      OpenCode 2.2.7
PASS  a real ACP session id was minted ses_e2eb493a1ffengk3KqQMpEVHcq
PASS  turn one settled                 stopReason=end_turn
PASS  turn one returned text           3059ms
PASS  turn one contains the requested token   DISPATCH-TURN-ONE
PASS  turn two settled                 stopReason=end_turn
PASS  the agent remembered the earlier turn without being told again
PASS  both turns share one agent session      turns=2 session=ses_e2eb493a1ffengk3KqQMpEVHcq
PASS  the transcript has both user turns
PASS  the transcript has both agent replies
PASS  settled replies are no longer marked as streaming
PASS  usage was reported by the agent  {"inputTokens":31,"outputTokens":9,"totalTokens":14120,"cachedReadTokens":14080}
PASS  the agent process was closed cleanly
```

关键的两条：**第二轮没有重放第一轮**，agent 靠会话记忆答出了 `DISPATCH-TURN-ONE`；两轮 `sessionId` 相同，证明“一个任务 = 一个会话”。完整报告写入 `verify-report.json`。

### 插件装载路径的验证

上面那个脚本直接调 `lib/` 的注册表；它证明不了 `apply()`、工具注册、参数传递没坏。所以还有一个：

```bash
node scripts/verify-plugin.mjs --command "D:/Code/soft/OpenCode/npm/node_modules/@opencode/cli/bin/opencode.exe"
```

它 `import { apply } from '../index.js'`，给一个只含 `tools`/`commands`/`get`/`effect` 的宿主上下文，然后**像模型那样调用注册出来的工具**：

```
PASS  apply() registered the three tools       cli_dispatch, cli_message, cli_tasks
PASS  apply() registered the /dispatch command dispatch
PASS  cli_dispatch returned the agent reply
PASS  the tool result carries a conversation transcript
PASS  the renderer emits text rows             1 part(s)
PASS  cli_message reused the same agent session
PASS  the agent answered from session memory
PASS  cli_tasks stop reports the stopped task id
PASS  the stopped task is cancelled
```

`result: PASS (16/16 checks)`，报告写入 `verify-plugin-report.json`。

这个脚本当场抓到一个真 bug：目标 `cwd` 不存在时，`spawn` 会以 `ENOENT` 报**命令**不存在，看起来像 agent 二进制丢了。现在 `open()` 先 `stat` 工作目录，报错直接指向 `cwd`。

### 在真实 DSH 里加载

包已装进 `~/.dsh/profiles/desktop`（`link:` 依赖 + `dsh.profile.bundles`），宿主实测返回：

```
GET /cli-dispatch/config -> 200 {"targets":[{"id":"opencode",...}],"defaultTarget":"opencode"}
GET /cli-dispatch/tasks  -> 200 {"tasks":[]}
```

即插件在运行中的 DSH 里已经激活，路由和注册表都起来了；侧栏入口与面板由 `/plugins` bundle 供给，走宿主的 `dsh-client-modules`。

## 设计取舍

- **一个 task 一个进程**：隔离彻底，权限、工作目录、环境变量互不干扰；代价是任务多了进程也多。已结算任务保留 32 个后 LRU 回收。
- **长轮询而非 WebSocket**：DSH 的 `ctx.webServer` 是普通 HTTP；长轮询在这个约束下最省事，也不会和宿主的路由抢升级。
- **`waitMs` 不杀任务**：模型侧的一次工具调用不该决定外部 agent 的生死。
- **reasoning 默认不进 transcript**：面板要看，模型不必看。
- **空 transcript 的首屏走详情路由**：`since=0` 在轮询端点里表示“等我第一条”，避免首屏把请求挂住。

## English

A DSH plugin that dispatches work to an external CLI agent (default `opencode acp`) and shows it as a conversation.

Dispatch is model-facing: `cli_dispatch` starts a task, `cli_message` continues it, `cli_tasks` lists, reads, or stops. Users get the same thing through `/dispatch` and a **Dispatch** sidebar panel. Both paths share one registry, so a task started by the model can be continued by a human and vice versa.

Transport is ACP over stdio, not `opencode run` — the latter hangs on this machine (no stdout, no exit), while `opencode acp` works. One task owns one agent process and one session, so follow-up prompts reuse the session's context instead of replaying the transcript.

`waitMs` bounds how long the tool waits, not how long the task lives: an unfinished task stays alive and is read later with `cli_tasks(id)`.

Verify with `npm test` (25 cases: real HTTP tests for the panel routes, a `vm`-executed contract test for the panel bundle, and the ACP transport against a scriptable fake agent). Then run `node scripts/verify.mjs` and `node scripts/verify-plugin.mjs`, which drive the real opencode binary — the first through the registry, the second through the plugin's own `apply()` and registered tools — and write `verify-report.json` / `verify-plugin-report.json`.
