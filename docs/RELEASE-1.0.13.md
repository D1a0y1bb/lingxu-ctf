# 1.0.13：发布说明整理与 DSH profile 同步

本版本整理发布文档，修正限流说明和打包文件数，并同步本地 DSH profile 到当前版本。

## 变化

- README 明确同机 DSH 进程使用共享 host 租约，跨机器限流交给网关或外部服务。
- 审计文档和后续设计改为已发布版本基线。
- 修正 `1.0.12` 发布记录，将实际打包文件数更正为 30。
- Windows 不纳入本轮发布范围。

## 检查

- `npm test`：646 个测试，644 passed，2 skipped。
- `node --check lib/*.js tests/*.mjs`：通过。
- `git diff --check`：通过。
- `npm pack --dry-run --json`：版本 `1.0.13`，31 个发布文件。
