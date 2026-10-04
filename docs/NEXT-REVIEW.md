# 研发审查与后续设计

基线为已发布 `1.0.13`。本地回归覆盖独立进程、宿主认证和并行赛事绑定；真实凌虚赛事 10、11 已有只读回执，但这仍没有替代 DSH 桌面验收。

## 本轮复核

| 原审查项 | 当前处理 | 状态 |
| --- | --- | --- |
| B1 单槽位会话身份 | session registry 按 ID 保存 caller、赛事和连接，路由拒绝跨会话猜测 | `passed`（本地） |
| B2 团队事件订阅生命周期 | 保存 disposer，服务重装前清理，插件卸载时释放 | `passed`（本地） |
| B3 用量只保留最后 step | 改为 `(turn, step, retry)` 多槽位折叠 | `passed`（本地） |
| B4 普通面板回退最近日志 | HTTP 用量要求明确 session；旧宿主兼容只留在工具层 | `passed`（本地） |
| B5 附件没有预算 | 64 MiB 限额、流式临时文件、原子落盘和失败清理 | `passed`（本地） |
| B6 配置写边界 | 字段白名单、类型校验、同源与 Fetch Metadata 检查 | `passed`（本地） |
| B7 路由暴露绝对路径 | 报告移除 `absPath`，用量和诊断错误遮盖本机路径 | `passed`（本地） |
| B8 旧赛段工具沿用 | 能力三态合同，状态未知时执行前复核当前连接 | `passed`（本地） |
| B9 多进程覆盖 store | 文件锁、唯一临时文件、原子替换和合并写入 | `passed`：两个独立 Node 进程压力用例通过 |
| B10 限流器仅进程级 | 同机共享 `DSH_HOME` 的 host 租约，跨机器明确交给网关 | `passed`（同机）；跨机器 `partial` |
| B11 客户端慢响应覆盖 | AbortController、请求代次和同轮 session 参数 | `passed`（本地） |
| B12 平台能力无版本 | 新增版本化合同、稳定错误投影和测试 fixture | `passed`（本地） |
| B13 重启后的冷 session | 路由用 `sessionQuery` 确认宿主 session 后恢复最小上下文 | `passed`（本地 + macOS DSH） |
| B14 classic bootstrap 重复挂载 | ModuleLoader 接管时跳过备用 bootstrap，配置轮询跟随 `ctx` 销毁 | `passed`（本地 + macOS DSH） |
| B15 宿主认证与诊断边界 | 插件路由复用 `connection.admit()`，旧宿主拒绝非 loopback | `environment_failed`：代码用例通过；本机没有 DSH 桌面应用，无法取得真实 `/diag` 回执 |

## 下一步优先级

### P1：跨赛事双会话验收（剩余项）

插件级真实平台双赛事交错已经通过。剩余工作依赖可启动的 DSH 桌面应用：同时打开两个**不同赛事**，交错执行状态查询、团队消息、报告生成和 token 用量刷新，随后热重载插件并确认没有重复消息、重复轮询或遗留工具。

完成标准不是页面“看起来正常”，而是保存两组请求与响应、session ID、连接 key、事件数量和卸载后的订阅状态。

### P1：真实平台合同采样

赛事 10、11 的真实采样已经覆盖赛事摘要、题目分页、排行榜、理论题、附件元数据和环境地址；后续仍应保存脱敏 fixture，并补齐会话过期、权限不足和 AWD/CFS 存在时的形状。fixture 不包含 Cookie、flag、用户名和内部地址。

能力合同应继续由平台响应推导，不根据工具是否注册反推平台能力。平台字段变化时先更新 fixture 和适配器，再改界面。

### P2：多实例限流

同一台机器上的多个 DSH 进程现在通过 `DSH_HOME/storages/lingxu-ctf/rate-limit.json` 共享 host 租约；不同机器没有共享文件系统，必须在平台网关或外部限流服务统一配额。不要把本机租约描述成跨机器分布式锁。

### P2：模块拆分

`lib/index.js` 和 `lib/client.js` 仍承担过多职责。等真实双会话回执稳定后再做纯结构拆分：

- `session-context`：身份注册、生命周期和请求解析；
- `http-routes`：路由、公开响应投影和同源检查；
- `usage-reader`：日志读取、折叠和宿主投影对账；
- `client-data` 与 `client-view`：请求状态和渲染分开。

拆分时保持 package export、classic script 入口、路由和工具名不变。每一步只移动一个责任域，并用当前 646 个测试（644 passed、2 skipped）确认行为未变。

### P2：宿主认证边界

配置写入继续保留同源与 Fetch Metadata 检查；插件 Web 路由已复用 DSH `connection.admit()` 的登录态与 Host/Origin 机制。若 Web 服务以后允许远程访问，仍不得改成插件自造 token；没有宿主认证服务的旧版本只能留在 loopback。

## 发布门槛

| 门槛 | 必须看到的证据 |
| --- | --- |
| 本地回归 | `npm test`、`node --check`、`git diff --check` |
| 包内容 | `npm pack --dry-run --json`，没有 Cookie、state、日志、工作目录和本机路径 |
| DSH 宿主 | 双会话、热重载、卸载、客户端视图和可选服务降级 |
| 真实平台 | 有效 Cookie 下 smoke/e2e；副作用操作只在隔离题目执行 |
| Windows | 安装、路径、重启和界面显示 |
| 发布记录 | 分开写 `passed`、`failed`、`partial`、`unverified` 和 `environment_failed` |

## 公共文本规则

注释只解释不明显的约束和失败边界。README、commit 和 release note 只写用户能验证的变化，不写“全部完成”“零问题”这类回执无法证明的话。旧公共历史不在普通发布中重写；确需整理时，单独建立迁移分支并确认 force-push 影响。
