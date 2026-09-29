# DSH 接口记录

这份文档只记录插件依赖的 DSH 行为，便于升级后复验。目标接口来自当前开发环境的 DSH `0.2.0-rc.1` 记录；如果宿主版本不同，应以实际服务和类型定义为准。

## 插件入口

默认导出必须包含：

```js
export default { Config, inject, apply }
```

`Config` 的字段使用 `volatile()` 才会出现在设置页。secret 字段使用 `role('secret')`。volatile 值读出后可能是带 `.get()` 的引用，业务代码先经过 `plainConfigValue`。

本插件只把 `tools` 放在 `inject` 数组中。`settings`、`sessions`、`sessionProjections`、`agentTeams` 和 `systemPrompt` 由 `ctx.inject` 按需取得；把可选服务写成硬依赖会让没有对应 bundle 的 DSH profile 整体加载失败。

## 工具注册

工具注册接口使用：

```js
ctx.tools.register(defineTool({
  name,
  description,
  parameters,
  output,
  execute,
}))
```

`register` 返回 disposer。插件销毁和 AWD/CFS 赛段切换时必须调用 disposer，避免旧工具留在上下文中。

基础工具 17 个；赛段工具由 `lib/stage-tools.js` 按赛事摘要动态注册。读取不到摘要时保持原列表，不因一次失败注销全部赛段工具。

## 可选服务

### `settings`

插件读取设置表单和 revision，并只更新 `baseUrl`、`eventId`、`label`。Cookie 不回写，因为设置服务返回 secret 时可能是脱敏值。

### `sessions`

客户端侧常见形状是 `sessions.list.getSnapshot()`，返回含 `byId` 的对象。宿主侧也可能提供 `sessions.list()` 数组或 `sessions.get(id)`。插件对这些形状做兼容，只取当前会话的 ID 和预设。

### `sessionProjections`

宿主投影用于读取会话的 `tokenUsage`。插件只接受非负有限数，并把 `uncachedInputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens` 归一化后计算总量。

### `agentTeams`

编排器使用成员、任务和停止接口。工具执行时按 session ID 保存 caller、连接 key 和赛事 ID，HTTP `/team` 路由只读取请求所对应的会话；并行会话不会共用“最近 caller”。服务缺失时，编排工具返回说明，不生成假的成员或任务。

## 会话事件

当前 team-message 投递事件：

```js
{
  type: 'user/message',
  data: {
    source: { kind: 'team-message', messageId, senderId, senderName },
    content: [{ type: 'text', text }],
  },
}
```

旧版事件把 blocks 放在 `data.message.content`，解析器仍兼容。普通用户消息、assistant 消息和没有 team 来源的事件会被忽略。

## Web 服务

Web 服务使用 `register({ path, method, handler })`。插件路由如下：

```text
/lingxu-ctf/state
/lingxu-ctf/client.js
/lingxu-ctf/config
/lingxu-ctf/diag
/lingxu-ctf/beacon
/lingxu-ctf/team
/lingxu-ctf/reports
/lingxu-ctf/theory
/lingxu-ctf/usage
```

响应统一使用 JSON，错误时保留 HTTP 200 的业务状态对象或明确的 4xx；客户端不能把非 JSON 直接当成功数据。`/state`、`/team`、`/reports` 和 `/usage` 接受 `session` 查询参数。存在多个已知会话时，没有显式 session 的请求不会猜测最近会话。

`POST /config` 校验浏览器的 `Origin` 和 Fetch Metadata，拒绝跨站写入；无浏览器头的宿主内部调用保持兼容。普通 `/reports`、`/usage` 和 `/diag` 响应会移除或遮盖本机绝对路径。

旧的 `tapIndex`/boot graph 注入不是当前客户端装配路径。浏览器 bundle 通过 package manifest 的 `dsh.client.inject` 声明：

```json
[
  "@deepseek-ai/dsh-client-modules",
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-conversation"
]
```

三项都来自当前客户端 graph；缺少 `ui-conversation` 时，视图无法按会话预设门控。

## 客户端约束

`lib/client.js` 是 classic script，不能出现顶层 `import` 或 `export`。通过 DSH module loader 注册 factory，并在没有 loader 的测试环境中提供本地兜底。配置卡片和顶部视图共用主题 token，样式必须限定在 `.lx-*` 范围内。

## 升级检查

升级 DSH 后至少执行：

```bash
npm test
bash scripts/verify.sh
```

并确认：

1. `dsh.client.inject` 中的三个模块仍能被宿主解析；
2. `sessions` 快照仍能得到当前会话 ID；
3. `session/event` 的 team-message 内容位置没有变化；
4. `settings.update` 的 revision 规则未改变；
5. 带有效 Cookie 的 smoke/e2e 检查通过。
6. 两个会话交错请求四条 session 路由时，返回的 caller、连接、报告和用量互不串线。
