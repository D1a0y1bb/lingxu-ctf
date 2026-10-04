# 1.0.12：并行赛事会话绑定与真实合同验收

本版本修复并行 DSH 会话在省略 `connection` 参数时可能读取活动赛事的问题，并清理仓库中的真实平台地址。它是当前工作树的发布版本；DSH 桌面交错和 Windows 桌面仍按环境单独验收。

## 功能变化

- 工具没有显式连接或赛事筛选时，自动使用当前 session 最近解析的连接 key。
- 显式 `connection`、`platform`、`baseUrl` 或 `eventId` 仍优先，不改变主动切换赛事的行为。
- live 检查脚本和文档不再内置真实平台地址，实际地址通过 `LINGXU_BASE_URL` 传入。

## 验证结果

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | `passed` | 646 个测试：644 passed、2 skipped |
| `node --check lib/*.js tests/*.mjs` | `passed` | 全部 JavaScript 文件语法通过 |
| `git diff --check` | `passed` | 无空白错误 |
| `npm pack --dry-run` | `passed` | 29 个发布文件，包版本为 `1.0.12` |
| 真实凌虚赛事 10 | `passed` | 合同采样、smoke 和 e2e 通过；AWD/CFS 为 `absent` |
| 真实凌虚赛事 11 | `passed` | 合同采样、smoke 和 e2e 通过；附件元数据和环境地址均可读取 |
| 插件级双赛事交错 | `passed` | session 10/11 的隐式工具解析和 `/state` 路由返回各自赛事 |
| DSH 宿主 `/diag` | `partial` | 本地 401/403 用例通过，DSH 桌面端本轮未启动 |
| Windows 安装与桌面 | `environment_failed` | 当前没有 Windows 验证主机 |
| `npm audit` | `environment_failed` / `passed` | 仓库无 lockfile 返回 `ENOLOCK`；隔离临时清单的高危级别为 0 |

真实平台检查只读取赛事、题目、理论题、排行榜、附件元数据和环境地址。没有提交 flag、交卷、启动环境、延时环境或释放环境。
