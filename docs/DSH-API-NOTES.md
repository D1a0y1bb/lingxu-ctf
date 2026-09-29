# DSH 插件 API 契约笔记（0.2.0-rc.1）

> 供本插件所有模块复用。**不要凭记忆写 API**，以本文件为准；本文件由实际源码/README 核对得出。
> 源码位置：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的 `/dsh/node_modules/@deepseek-ai/`，
> 已解包到 `/tmp/dsh-src/`（如丢失可重新解包）。

## 1. 插件模块形态

Cordis 插件是一个 ESM 模块，导出 `apply(ctx, config)`，可选 `name` / `Config` / `inject`。

```js
export const name = 'dsh-lingxu-ctf'
export const inject = ['tools', 'agentTeams', 'storageDomain']  // 声明依赖的 service
export function apply(ctx, config) {
  ctx.tools.register(defineTool({ /* ... */ }))
}
```

- `ctx.effect(fn)` / `ctx.on(...)` 注册清理逻辑；`ctx.tools.register()` 返回 disposer，交给 `ctx.effect` 管理。
- 官方范式（`dsh-experimental-tool-agent-team/lib/index.js`）：
  ```js
  register(scoped.tools.register(defineTool({ ... })))
  ```
  其中 `register` 收集 disposer 并在卸载时统一释放。

## 2. 工具注册：`defineTool`

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'ctf_status',
  description: '...',
  parameters: {
    platform: { type: 'string', required: true, description: '...' },
    limit: { type: 'number' },
    mode: { type: 'string', enum: ['a', 'b'] },
  },
  output: {
    schema: { type: 'string' },              // 或 object/array 等
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    // args 已按 parameters 校验并推断类型
    // exec.agent  —— 调用该工具的 Agent（可空）
    // exec.signal —— AbortSignal
    return '...'
  },
}))
```

要点：
- 参数 DSL 支持 `string` / `number` / `integer` / `boolean` / `null` / `array` / `object` / `json` / `oneOf`。
- `execute` 的返回值必须匹配 `output.schema`。
- 抛异常 = 普通工具失败（不会终止整个 turn）。
- **拿调用者**：`exec.agent`。真实范例：
  ```js
  async execute(args, exec) {
    const agent = callingAgent(exec.agent, 'spawn_teammate')
    return ctx.agentTeams.spawnTeammate(agent, { ... })
  }
  ```

## 3. Agent Teams（并发 agent 的正解）

Service：`ctx.agentTeams`。需要 `@deepseek-ai/dsh-experimental-agent-team` 与
`@deepseek-ai/dsh-experimental-tool-agent-team` 已挂载（desktop profile 的
`@deepseek-ai/dsh-experimental-agent-team-profile` bundle 已包含）。

> ⚠️ **服务层字段名与工具层不同**。工具层（模型看到的 `spawn_teammate` / `send_message` /
> `update_task`）的参数名是 snake_case，而 `ctx.agentTeams.*` **服务方法**用的是另一套字段名。
> 插件直接调服务，必须按下面这份（已对 `dsh-experimental-agent-team/lib/index.js` 逐字段核对）。

```js
// 建 teammate（只有 Lead 能建）
// 必填：name / description / prompt / context / provider / signal
await ctx.agentTeams.spawnTeammate(callerAgent, {
  name: 'solver-web-01',            // 唯一 lower-kebab-case，永久占用（含失败的）
  description: '...',
  prompt: [{ type: 'text', text: '...' }],   // ContentBlock[]
  context: 'fresh',                 // 'fresh' | 'fork'
  provider: 'spawn',                // 必填！'spawn' | 'fork'（漏了会被拒）
  signal: abortSignal,              // 必填！内部 AbortSignal.any([...]) 对 undefined 会 TypeError
})

// 发消息（running → 最近 step 边界送达；inactive → 唤醒/冷恢复）
// 注意字段是 content: ContentBlock[]，不是 message
await ctx.agentTeams.sendMessage(callerAgent, {
  target: 'solver-web-01',
  content: [{ type: 'text', text: '...' }],
  signal: abortSignal,
})

// 共享任务板
const task = await ctx.agentTeams.createTask(callerAgent, {
  subject: '...', description: '...', writeScopes: ['challenges/web-01'],
})
ctx.agentTeams.getTask(callerAgent, id)
ctx.agentTeams.listTasks(callerAgent)
// 注意字段是 taskId，不是 id（传 id 会报 task "undefined" not found）
await ctx.agentTeams.updateTask(callerAgent, { taskId: id, expectedRevision, action: 'claim' })

// 名单 / 等待 / 中断
ctx.agentTeams.listMembers(callerAgent)   // [{ name, role, status }]
await ctx.agentTeams.waitForChange(callerAgent, timeoutMs, signal)
ctx.agentTeams.interrupt(callerAgent, 'solver-web-01')
```

- 成员状态：`running` / `inactive` / `provisioning` / `failed`。**`inactive` 只表示当前没有 turn 在执行**，
  不代表任务成功或失败。
- `listMembers()` **第一行固定是 `{ name: 'lead', role: 'lead' }`**；算成员数/上限时要排除它。
- `listTasks()` 里负责人字段是 **`ownerName`**（不是 `owner`）。
- 任务更新是 CAS：`expectedRevision` 过期会被拒绝。
- `callerAgent` 只能来自工具执行上下文 `exec.agent`；插件里没有别的途径拿到调用者身份。
  工具层必须把它塞进 args（本插件用 `args.__agent`）。
- 上限（可在 bundle 配置）：`maxMembers` 默认 16、`maxTasks` 256、`maxPendingMessagesPerMember` 64、
  `maxMessageBytes` 65536。
- 任务 `action`：`claim` / `release` / `edit` / `set_dependencies` / `complete` / `reopen` / `reassign` / `delete`。

## 4. 子 agent（一次性委派，本插件用于单题深挖，可选）

```js
// ctx.subagents.start(providerName, request) —— provider 名如 'spawn' / 'fork'
// ctx.subagents.startContinuable(spec)
// ctx.subagents.sendMessage(sender, targetId, contentBlocks, options)
```
`maxActiveSubagents` 默认 8。本插件主线用 Agent Teams，`subagents` 仅在需要单题隔离上下文时使用。

## 5. 系统提示词注入

```js
ctx.systemPrompt.section({ name: 'ctf:protocol', order: 500, text: '...' })
ctx.systemPrompt.variable('ctf_event', ({ agent }) => '...')   // 文本里用 {{ctf_event}} 引用
ctx.systemPrompt.context({ ... })                              // runtime context
```
`order` 用有限值即可；`interpolate: false` 可保留 `{{...}}` 字面量。

## 6. 预设（「CTF 解题模式」）

0.2.0-rc.1 中预设是**插件行**，不是 YAML 目录：

```yaml
- id: preset-ctf
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: ctf                 # 必填，会话保存的预设标识
    order: 5
    name: 'CTF 解题模式'
    description: '...'
    plugins:                # 必填，子插件行列表
      - id: persona
        name: '@deepseek-ai/dsh-persona'
        config:
          prefix: '...'
          suffix: '...'
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'
      # ... 其余照抄 dsh-web-app/presets/standard.patch.yml
```
参考：`/tmp/dsh-src/dsh-web-app/presets/standard.patch.yml`（完整可抄的标准预设）。

## 7. Web 服务与客户端 UI

- 宿主侧注册 HTTP 路由：`ctx.webServer.register({ kind: 'exact', path, handler })`。
  **`kind` 只认 `'exact'`**（`dsh-host-webserver` 源码里只有这一种分支）。
- 注入客户端脚本：`ctx.webServer.tapIndex(html => ...)`。另有 `webserver/index-inject` 事件可用。

### ⚠️ 不要用 `__DSH_BOOT__` graph 行注入（0.2.0-rc.1 上是 no-op）

很多第三方插件（含 `dsh-opencode-go-usage`）抄的 `injectGraphRow` 写法在 **0.2.0-rc.1 上完全无效**，
已实测核对：

1. `@deepseek-ai/dsh-client-modules` 的 `parseBootManifest` 要求 `window.__DSH_BOOT__` 是
   **对象** `{ rev, entries, batches }`（内部 `Array.isArray(graph.entries)` +
   `Array.isArray(graph.batches)` 双校验，缺失时报 `__DSH_BOOT__ is missing or not an object`），
   且每个 entry 必须归属某个 initial-load batch。
   而 `dsh-opencode-go-usage` 写的是**数组**，其 `injectGraphRow` 里 `if (!Array.isArray(graph)) return html`
   直接原样返回 ⇒ 什么都没注入。
2. graph row 是按 **classic script** 加载（`document.createElement('script')`，无 `type="module"`），
   加载后必须自行调用 `window.__ModuleLoader__.load({ id, factory })`，
   否则报 `loaded without registering "<id>" via __ModuleLoader__.load`。
   ⇒ 带顶层 `export` 的 ESM 作为 graph row 是**语法错误**。
3. 官方 index 注入行（`renderRow`）只有 `global / script / script-src / script-preload / style / html`，
   全是 classic script；唯一能产出 `<script type="module">` 的是 `kind:'html'` + placement。

**本插件采用的做法**：`ctx.webServer.tapIndex(html => injectClientScript(html, url))`，
直接注入 `<script type="module" src="/lingxu-ctf/client.js?rev=<contentHash>"></script>`。
版本无关、不污染 boot manifest、内容哈希天然解决缓存。见 `lib/index.js` 的 `injectClientScript`。

### 主题 token 与挂载点

- 真实 CSS 变量前缀是 **`--dsw-alias-*`**，不是 `--dsh-color-*`（后者在安装包里零命中）。
  常用：`--dsw-alias-label-primary|secondary|tertiary|caption`、`--dsw-alias-border-l1..l4`、
  `--dsw-alias-bg-base|bg-layer-1..3`、`--dsw-alias-interactive-bg-hover`、
  `--dsw-alias-state-success|state-error|state-warn|brand-primary`、
  `--dsw-alias-label-primary-foreground`、`--dsw-alias-button-primary-fill`。
- 可用的 DOM 锚点：`data-dsh-automatic-focus`、`data-dsh-boot`。
  `[data-dsh-sidebar-right]` 在安装包里不存在 —— **不要依赖它**，找不到容器就自建浮动面板。

- 客户端半入口形如：
  ```js
  export const name = 'dsh-lingxu-ctf'
  export function apply(ctx) { /* 自挂载 DOM 面板 */ }
  ```
  本插件不用 `dsh.client` + client-modules 解析（第三方 profile 包装不进 DSH 自身解析路径），
  改为自托管 bundle（见上）。

## 8. 存储

```js
const domain = await ctx.storageDomain.open(spec)   // DomainSpec
```
`dsh-base` 里 `storage-domain` 行默认 `backend: json`，可按域路由到 sqlite：
```yaml
- id: storage-domain
  config:
    backend: json
    routes: { ctf: sqlite }
```
本插件优先用**文件 JSON 持久化**（`~/.dsh/storages/lingxu-ctf/`）以避免额外后端依赖；
如挂 sqlite 后端再切换。

## 9. 打包与安装

- `package.json` 需含：
  ```json
  {
    "name": "dsh-lingxu-ctf",
    "type": "module",
    "main": "./lib/index.js",
    "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
    "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } },
    "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1", "@deepseek-ai/dsh-tools": "0.2.0-rc.1" }
  }
  ```
- 安装：`plugin_manager` 工具（`install_bundle`，target = npm 包名 / `file:` 路径 / tarball / URL）。
  安装会写 profile 的 `package.json` dependencies + `dsh.profile.bundles`，**bundle 列表在启动时读取，需要重启 DSH**。
- profile 路径：`~/.dsh/profiles/desktop/`；其中 `cordis.patch.yml` 是**实时重载**的（`patchReload: live`），
  适合迭代期临时加行调试。
- 第三方插件已装的先例：`dsh-whale-widget-plus`（github:）、`dsh-opencode-go-usage`（npm）。

## 10. 版本兼容红线

- 宿主 `0.2.0-rc.1`；`agentPresets.register(definition)` 在本版本**存在**。
- `@deepseek-ai/dsh-persona` 的 `prefix` / `suffix` 是当前字段（旧版是 `text`）。
- 不要依赖 `@deepseek-ai/dsh-client-runtime` 等已不存在的包。
