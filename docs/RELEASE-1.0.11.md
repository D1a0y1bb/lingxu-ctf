# 1.0.11：跨进程状态、同机限流与宿主认证边界

本版本把上一轮审查里剩下的本地可验证项收口，版本号已更新到 `1.0.11`。它是当前工作树的候选发布版本；真实赛事和 Windows 桌面回执仍按用户安排留到下一轮，不在本说明中冒充通过。

## 已完成

- 两个独立 Node 进程并发写同一状态目录，40 条连接、提交、题目工作和团队消息全部保留；锁、临时文件、JSON 完整性和 `0700/0600` 权限均通过。
- 两个独立 Node 进程共用同一个 host 租约文件，10 个真实 HTTP 请求全局并发为 1；配置的 60ms 间隔在跨进程调度抖动下仍保持至少 35ms 的实测下界。
- `/lingxu-ctf/*` 路由在宿主提供 `connection` 服务时复用 `connection.admit()`；旧宿主没有该服务时拒绝非 loopback 请求。当前运行中的旧 DSH 进程未重启，真实桌面回执仍待下一轮。
- `scripts/sample-live-contract.mjs` 只读采样赛事、题目、理论题、排行榜及存在的 AWD/CFS 合同；最多抽取 12 道题详情寻找附件型和环境型题，附件只取元数据，环境只读地址，不执行启动、延时、释放或 flag 操作。

## 验证结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | `passed` | 645/645 |
| `bash scripts/verify.sh` | `passed` | 语法、回归、slug 契约和打包清单通过；live 因没有 Cookie 跳过 |
| `npm pack --dry-run` | `passed` | 29 个发布文件，包含新增合同、发布记录和 Windows 文档 |
| `npm audit` | `environment_failed` / `passed` | 仓库无 lockfile，直接审计返回 `ENOLOCK`；隔离临时 lockfile 使用 npm 官方 registry，高危及以上为 0 |
| DSH `/diag` 宿主认证 | `partial` | 本地 401/403 用例通过；当前进程未重载，实测旧路由仍返回 200，未打断正在运行的会话 |
| 真实凌虚 AWD/CFS/附件/环境 | `not_reproduced` | 当前保存 Cookie 返回 HTTP 403 `session-expired`，本轮不重新索取凭据 |
| 两个赛事 DSH 交错会话 | `not_reproduced` | 等待用户提供可测试赛事和有效账号 |
| Windows 安装与桌面 | `environment_failed` | 当前没有 Windows 主机，等用户反馈后再验收 |

## 下一步放行条件

拿到有效账号和两个可测试赛事后，按 [`LIVE-CONTRACT-SAMPLING.md`](./LIVE-CONTRACT-SAMPLING.md) 生成脱敏合同样本，并在同一台电脑的两个 DSH 进程中交错验证两个赛事。Windows 主机可用后再执行 [`WINDOWS-ACCEPTANCE.md`](./WINDOWS-ACCEPTANCE.md) 的安装、重启和桌面检查。
