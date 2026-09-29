# 交付审计

本文记录当前工作树和可复现检查的结果。它不是平台运营报告；真实平台没有凭据时，相关项记为 `unverified`，不把静态测试当成 live 证据。

审计基线：`v1.0.6` 工作树，Node `>=18`，目标 DSH 版本按仓库当前注入声明验证。旧版本的提交和 tag 保留不动。

## 结论

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| JavaScript 语法 | `passed` | `node --check lib/*.js tests/*.mjs` |
| 单元测试 | `passed` | `npm test`，612 个测试通过 |
| 工具注册与动态赛段工具 | `passed` | `tests/index.test.mjs`、`tests/tools.test.mjs`、`tests/platforms.test.mjs` |
| 客户端 classic script 装配 | `passed` | `tests/client.test.mjs` |
| 会话 token 用量 | `passed`（本地样例） | zstd 多帧、明文 JSONL、宿主投影对账用例 |
| 团队消息观察钩子 | `passed`（本地样例） | 真实 `data.content` 结构、旧嵌套结构、去重用例 |
| 真实凌虚平台冒烟 | `unverified` | 本轮没有有效 `LINGXU_COOKIE` |
| DSH 桌面端安装后 UI | `unverified` | 未启动用户桌面实例做视觉验收 |

## 已核对的链路

### 插件装配

`lib/index.js` 只把 `tools` 作为硬依赖。`settings`、`sessions`、`sessionProjections`、`agentTeams` 和 `systemPrompt` 通过可选注入获取；缺少其中任一项不会阻止基础工具注册。

基础工具为 17 个。AWD（9 个）和 CFS（7 个）根据赛事摘要动态注册/注销，无法取得赛段信息时保持现状，不因一次网络失败清空工具。

### 连接和凭据

连接来源按显式参数、设置页、本地 store 处理。Cookie 只在平台客户端请求时使用；设置同步只写 `baseUrl`、`eventId` 和 `label`，不把 secret 回写到普通配置。

### 数据和路由

`/state` 使用服务端缓存和 single-flight；写操作会使缓存失效，但仍受刷新上限约束。`/team` 读取成员、任务和本地消息；`/reports` 只访问工作目录；`/usage` 只按 DSH 会话 ID 读取会话日志或宿主投影。

### 团队消息

当前 DSH 投递事件是：

```js
{
  type: 'user/message',
  data: {
    source: { kind: 'team-message', messageId, senderName },
    content: [{ type: 'text', text: '...' }]
  }
}
```

解析器同时接受旧版 `data.message.content`，只观察事件、不参与投递，写盘失败不会阻塞原消息。`messageId` 用于去重。

### 会话用量

日志读取支持多帧 zstd 和普通 JSONL。折叠规则按 DSH 的 `tokenUsage` 投影处理：同一 step 的更新替换旧值，重试按最新尝试计数，压缩开销单列。宿主侧优先读取 `sessions`/`sessionProjections` 服务；服务不可用时保留日志侧结果。

## 对用户问题的落实

| 问题 | 当前处理 | 状态 |
| --- | --- | --- |
| 审计事件混在普通消息里 | 按事件类型和来源拆分，普通 `user/message` 不进团队通信 | `passed` |
| 多帧日志和增量读取 | 逐帧解压，明文文件每次从头解析并用缓存去重 | `passed` |
| 平台轮询过密 | TTL、single-flight、刷新下限和滚动上限 | `passed`（单测） |
| 环境配额和过期 | 工具返回平台限制，面板区分本地持有与平台 blocked | `passed`（单测） |
| 空报告、空团队、无环境 | 各路由返回明确空态，不用假数据填充 | `passed`（单测） |
| 多赛事切换 | 连接 key 隔离；跨平台不复用 Cookie | `passed`（单测） |
| Windows 安装 | 文档给出 GUI/junction 路径 | `partial`（未在 Windows 主机复验） |
| agent 活动和协同 | 读取任务板、session event 和本地 team log | `partial`（live 服务未接入） |
| 理论题 | 按需查询，交卷后不把状态显示成未开始 | `passed`（单测） |

## 发布前复核

运行：

```bash
npm test
bash scripts/verify.sh
```

带平台凭据时再运行 `tests/smoke-live.mjs` 和 `tests/e2e-live.mjs`。`verify.sh` 会把 live 检查显示为 `passed`、`failed` 或“未运行”，不会把跳过包装成通过。

## 未验证项

1. 当前机器没有可用的凌虚登录 Cookie，因此无法确认真实赛事字段、排行榜和理论题接口的当前返回。
2. 未在 Windows、DSH 桌面端和生产 profile 中做本轮视觉/安装验收。
3. 历史 tag 的提交说明仍保留原样；本轮采用前向版本整理，没有重写公共 Git 历史。
