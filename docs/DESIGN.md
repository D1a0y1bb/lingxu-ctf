# 设计说明

## 目标

插件把凌虚平台的 HTTP 接口、DSH 工具注册和本地竞赛记录接在一起。核心约束是：平台请求集中在适配器，工具只编排调用，界面只读路由返回的数据。

## 模块

| 文件 | 责任 |
| --- | --- |
| `lib/index.js` | 插件入口、依赖注入、工具/路由/命令注册、配置和面板快照 |
| `lib/lingxu.js` | 凌虚 HTTP 客户端、响应归一化、限流和错误分类 |
| `lib/platforms.js` | 平台适配器接口和连接选择 |
| `lib/store.js` | 本地连接、题目工作记录、提交审计、团队消息和 writeup 索引 |
| `lib/tools.js` | 17 个基础工具规格 |
| `lib/stage-tools.js` | AWD/CFS 赛段工具规格 |
| `lib/orchestrate.js` | Agent Teams 任务分配、复用和停止 |
| `lib/writeup.js` | writeup 文件生成与记录 |
| `lib/team-events.js` | DSH team-message 事件解析 |
| `lib/client.js` | 浏览器端 classic script、视图模型和面板控制器 |
| `lib/toolkit.js` | 工具定义和文本输出包装 |

依赖方向保持单向：`index → tools/orchestrate/writeup/platforms/store`，平台客户端不依赖 UI；`client.js` 不依赖 Node 模块。

## 装配流程

1. DSH 调用默认导出的 `Config`、`inject` 和 `apply`。
2. `apply` 归一化配置并建立 store、连接解析器和平台适配器。
3. 注册 17 个基础工具、系统提示词、Web 路由和命令。
4. 通过可选注入等待 `settings`、`sessions`、`sessionProjections`、`agentTeams` 等服务。
5. 连接成功或状态探测拿到赛段信息后，同步 AWD/CFS 工具。
6. DSH 销毁插件时注销工具、路由和赛段工具。

`tools` 是唯一硬依赖。可选服务缺失时，基础工具仍应可用；对应执行路径返回可读的降级说明。

## 连接选择

连接解析顺序由调用方决定：显式参数优先，其次是设置页声明的平台，最后是本地 store 的活动连接。Cookie 只从同一平台的本地连接回退，不跨 `baseUrl` 复用。

`ctf_connect` 成功后只同步设置页的 `baseUrl`、`eventId` 和 `label`。Cookie 保留在本地 store 的 secret 字段。

## 工具层

基础工具列表在 `lib/tools.js` 的 `TOOL_NAMES` 中维护：

```text
ctf_connect          ctf_session        ctf_status
ctf_challenges       ctf_challenge      ctf_start_env
ctf_delay_env        ctf_release_env    ctf_submit_flag
ctf_leaderboard      ctf_theory         ctf_notice
ctf_solve_start      ctf_solve_status   ctf_solve_stop
ctf_writeup          ctf_team_log
```

AWD 和 CFS 使用独立的工具名，而不是一个带 action 的总工具。只有赛事摘要明确包含赛段时才注册，避免无关工具占用模型上下文。

工具执行遵循同一规则：参数先归一化，连接由 `resolveAdapter` 提供，平台错误转成简短文本；需要阻止宿主继续执行的前置条件才抛出 hard failure。提交、启动环境、释放环境和裁判消息等有副作用的操作在描述和返回中标明。

## 平台适配器

`LingxuClient` 负责 HTTP、Cookie、超时和 JSON 响应；`createAdapter` 把平台字段转换成插件使用的结构：

- challenge：`id`、名称、分类、分值、题型、附件、环境状态；
- environment：地址、运行 ID、剩余秒数、释放时间、平台限制；
- leaderboard：名次、用户名、分数；
- theory：试卷状态、题型、题数、剩余时间；
- event：赛事名称、时间、赛段类型和公告。

适配器不推断平台没有返回的数字；无法解析时返回 `null` 或空集合，由工具层给出下一步。

## 本地数据

store 记录：

- 平台连接和活动连接 key；
- 题目工作目录、环境运行信息和 agent 归属；
- flag 提交、状态、错误次数和时间；
- writeup 文件路径；
- `ctf_team_log` 与观察到的 team-message。

写入按连接 key 隔离。提交审计保留 flag 文本以便复核，但不会保存 Cookie。重复 `messageId` 和重复 flag 是否拦截由 store/config 控制。

## Agent Teams

`ctf_solve_start` 创建或复用 agent，并把题目写入任务板；`ctf_solve_status` 汇总成员、任务、环境和本地消息；`ctf_solve_stop` 停止任务并释放可清理的环境。

会话内调用通过 `exec.agent` 捕获 caller。HTTP 路由没有 exec，因此 `/team` 使用最近一次捕获的会话身份。`agentTeams` 服务未挂载时，编排工具返回缺少服务的说明，不伪造任务状态。

### Team message 观察

DSH 投递消息会产生 `user/message` 事件，来源为 `data.source.kind === 'team-message'`。当前版本读取 `data.content`，并兼容旧版 `data.message.content`：

```text
session/event
  → teamDeliveryOf
  → store.appendTeamMessage
  → GET /lingxu-ctf/team
```

观察钩子不参与投递；解析或落盘失败不会影响原消息。消息 ID 用于去重。

## Web 面板

服务端路由：

```text
/lingxu-ctf/state   /lingxu-ctf/client.js  /lingxu-ctf/config
/lingxu-ctf/diag    /lingxu-ctf/beacon      /lingxu-ctf/team
/lingxu-ctf/reports /lingxu-ctf/theory      /lingxu-ctf/usage
```

`/state` 使用 TTL、single-flight、刷新下限和滚动预算。默认 TTL 4 秒，后台平台刷新至少间隔 20 秒，60 秒窗口最多 4 次刷新；写操作可以请求受控的即时刷新。返回中带 `cachedAt`、`fromCache` 和 `stale`，客户端据此显示数据新鲜度。

`/usage` 只按当前 DSH 会话 ID 读取日志或投影。浏览器不能传入任意日志根目录。日志支持多帧 zstd 和普通 JSONL，按 DSH `tokenUsage` 语义折叠。

客户端是 classic script，通过 DSH 的 module loader 注册配置卡片和 `CTF` 视图。视图需要 `@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-conversation`；缺少会话服务时退回始终显示，以免入口消失。

## 配置契约

`Config` 有 14 个 volatile 字段：平台连接（`baseUrl`、`eventId`、`cookie`、`label`）、并发和提交限制、环境策略、工作目录、请求超时以及两个面板开关。`cookie` 标记为 secret。读取配置前必须解包 volatile 引用，见 `plainConfigValue`。

## 验证入口

```bash
npm test
bash scripts/verify.sh
```

真实平台检查由 `tests/smoke-live.mjs` 和 `tests/e2e-live.mjs` 提供，需要显式 Cookie。没有凭据时只能证明本地装配和纯函数行为，不能据此宣称平台链路通过。

## 已知边界

- 凌虚平台字段和 DSH 可选服务会随版本变化；适配器和注入声明需要随升级复验。
- 当前测试覆盖本地 mock 服务和日志样例，尚未替代 Windows、DSH 桌面端和带真实账号的验收。
- `lib/client.js` 仍是单个 classic bundle，拆分需要同时保持 DSH loader 的注册顺序和样式作用域，属于后续结构性工作，不在发布时改变运行契约。
