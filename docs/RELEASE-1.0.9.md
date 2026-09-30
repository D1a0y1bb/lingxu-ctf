# 1.0.9：DSH 会话恢复与客户端生命周期

发布日期：2026-09-30

这个版本收尾了 1.0.8 留下的宿主重启问题：DSH 重建插件 registry 后，浏览器仍会带着原 session ID 请求面板，服务端现在会通过宿主只读 `sessionQuery` 确认该 session 仍存在，再恢复最小会话上下文。恢复只保存 session ID，不猜 caller、连接或凭据。

## 主要变化

- `/state`、`/team`、`/usage`、`/reports` 和 `/theory` 在收到已存在但不在内存 registry 的 session ID 时执行冷会话恢复。
- CTF 视图、配置卡片和浮动面板共享宿主 `ctx`，浮动配置轮询跟随插件生命周期注销。
- 已由 DSH `ModuleLoader` 接管时跳过 classic script 的备用 bootstrap，避免重复挂载面板和重复轮询。
- live e2e 从真实未解题列表读取题目 ID，适配不同赛事的题目编号。

## 验证结果

- `passed`：`npm test`，639/639。
- `passed`：全部 `lib/*.js`、`tests/*.mjs` 语法检查，`git diff --check`，slug 跨模块契约和 npm 包清单检查。
- `passed`：真实凌虚 smoke/e2e（赛事 7）；登录、赛事摘要、题目分页、题面、排行榜、理论题、提交记录和去重护栏均有回执。
- `passed`：macOS DSH 实例重启后冷 session 恢复；主 CTF 视图与浮动面板均显示真实赛事数据；插件关闭时路由注销，重新启用后恢复。
- `partial`：本轮两个 live DSH session 使用同一赛事配置；不同赛事交错切换尚未做宿主级回执。
- `unverified`：Windows 安装、路径权限和界面显示。

Windows 验证不作为本次发布阻塞项。旧提交和 `v1.0.8` 标签未改写，本版本只新增前向提交和 `v1.0.9` 标签。
