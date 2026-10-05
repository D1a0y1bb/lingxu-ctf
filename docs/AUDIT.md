# 交付审计

审计基线为已发布 `1.1.1`，Node 要求 `>=18`。本文只记录当前代码和可复现检查；没有真实平台或宿主回执的项目保留为 `unverified`。

## 结果

| 范围 | 状态 | 证据 |
| --- | --- | --- |
| JavaScript 语法 | `passed` | `node --check lib/*.js tests/*.mjs` |
| 单元与契约回归 | `passed` | `npm test`，包含独立进程与共享限流用例 |
| 多会话身份隔离 | `passed`（本地） | 并行 session registry、显式未知 session、客户端 session 路由用例 |
| token 用量折叠 | `passed`（本地） | 多帧 zstd、JSONL、交错 step、retry 和宿主投影用例 |
| 请求与附件边界 | `passed`（本地） | 同源跳转、响应大小、写请求重试、附件限额、正文超时和半文件清理用例 |
| 状态存储 | `passed`（本地） | 权限、损坏恢复、两个 store 并发合并；两个独立 Node 进程共写 40 连接/提交/进度/消息，临时文件与锁均清理 |
| 调度预览 | `passed`（本地） | `ctf_solve_start(dryRun=true)` 返回环境配额、并发槽、任务复用和派发队列，不创建任务、不拉起 agent、不写题型缓存 |
| 题目详情与提交脱敏 | `passed`（本地） | `/lingxu-ctf/challenge` 按需返回题面和工作状态；面板、详情和导出 manifest 均只返回脱敏 flag |
| 脱敏 fixture 回放 | `passed`（本地） | 合成赛事 fixture 覆盖赛事、题目、详情、排行、理论题和 session 失效响应 |
| 结果包导出 | `passed`（本地） | `ctf_export_bundle` 复制附件、writeup 和脚本，排除 store、Cookie、日志和符号链接 |
| 同机多 DSH 限流 | `passed`（本地） | 两个独立 Node 进程共用 host 租约，10 个真实 HTTP 请求全局并发 1、配置 60ms 且实测间隔下界 ≥35ms |
| DSH 宿主认证与 `/diag` | `environment_failed`（代码通过） | 插件路由复用 `connection.admit()`；本地替身未认证返回 401、非 loopback 返回 403；本机没有 DSH 桌面应用，无法取得真实 `/diag` 回执 |
| 平台能力合同 | `passed`（本地） | `present/absent/unknown` 与执行前复核用例 |
| 真实凌虚赛事 10/11 | `passed` | 两场只读合同采样、smoke 和 e2e 均通过；赛事 10 采样 20 个接口，赛事 11 采样 12 个接口；两场 AWD/CFS 均为 absent |
| DSH 桌面端会话恢复、生命周期与面板 | `environment_failed` | 插件级真实平台 session/tool/`/state` 交错隔离已通过；本机没有 DSH 桌面应用，无法完成不同赛事、热重载和桌面路由回执 |
| Windows 安装 | `environment_failed` | 当前没有 Windows 验证主机，无法完成安装、重启和真实桌面验收 |
| `npm audit` | `environment_failed`（仓库合同）/ `passed`（隔离清单） | 仓库按 host-managed 策略没有 lockfile，直接执行返回 ENOLOCK；把 `package.json` 复制到临时目录生成临时 lockfile 后，npm 官方 registry 高危级别为 0 |

## 关键链路

### 会话和赛事归属

工具执行时保存 `{ sessionId, caller, connKey, eventId }`。浏览器在同一轮 `/state`、`/team`、`/reports` 和 `/usage` 请求中携带同一个 session ID，服务端按该 ID 读取上下文。存在多个已知会话时，缺少或无法识别的 ID 不再退回最近会话。

会话上下文有容量和过期上限；明确的会话结束事件、插件卸载和热重载会回收记录。团队事件订阅保存 disposer，重新装配服务前先解除旧订阅。

### 用量

日志读取支持多帧 zstd 和普通 JSONL。用量按 `(turn, step, retry)` 保存独立槽位，同一槽的新快照替换旧值；不同 step 交错到达时不会互相覆盖。HTTP 路由只接受明确的 session，工具层为旧宿主保留带 `inferred` 标记的兼容路径。

### 平台请求和附件

平台根地址只接受 HTTP/HTTPS。绝对请求地址和跳转必须与根地址同源，跳转次数最多 5 次。普通响应体默认上限为 32 MiB，附件默认上限为 64 MiB。附件先写唯一临时文件，完成后原子改名，失败或超限会清理半文件。

GET 等安全请求可按既有策略重试；POST、PUT、PATCH、DELETE 默认不因限流自动重放，只有调用方提供幂等键或明确启用时才重试。

### 本地状态和 HTTP 输出

状态目录权限为 `0700`，文件为 `0600`。状态写入有进程间锁、唯一临时文件、原子替换和合并逻辑，文件上限为 16 MiB；异常 schema 会归一化，原型字段不会进入内存状态。

配置写接口拒绝跨站浏览器来源，只接受声明过的字段和类型。插件 Web 路由会复用 DSH `connection.admit()` 的 Host/Origin/浏览器会话检查；旧宿主没有该服务时，至少拒绝非 loopback socket。`/reports`、`/usage` 和 `/diag` 的普通响应不返回本机绝对路径。

### 平台能力和不可信内容

平台适配器暴露版本化能力合同，AWD/CFS 状态统一为 `present`、`absent` 或 `unknown`。保留旧工具名时，执行前会按当前连接重新确认，避免把上一场赛事的能力带到新会话。

平台题面、理论题、附件元数据和目标响应都按不可信数据处理。prompt 和工具输出明确划出内容边界，题面中的指令不能扩大文件读取、凭据访问或消息发送范围。

## 还需要外部环境补的检查

1. 用有效账号完成赛事摘要、分页、排行榜、理论题、AWD/CFS、附件和环境接口的 live 检查；可使用 `scripts/sample-live-contract.mjs` 生成脱敏样本。当前账号已确认失效，不能伪造成功 fixture。
2. 在 DSH 桌面端用两个不同赛事交错运行会话，复验切换会话、服务重连、热重载和卸载后的订阅与定时器；本版本已完成同赛事双 session 的冷恢复和生命周期回执。
3. 在 Windows 完成安装、路径、文件权限退化和界面检查。
4. 如果部署是跨机器多实例，仍需由共享网关/限流服务协调；当前实现只覆盖同一台机器共享 `DSH_HOME` 的 DSH 进程。

历史提交和旧 tag 保持不变。本轮采用前向提交和新版本标签，不通过 force-push 改写公共历史。
