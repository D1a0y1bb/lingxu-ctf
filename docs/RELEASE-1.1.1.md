# 1.1.1：补充导出模块发布检查

本补丁版本补充发布验证脚本对 `lib/export.js` 的检查，避免新增结果导出模块漏出验证清单。

## 检查

- `npm test`：652 项，650 passed，2 skipped，0 failed。
- `node --check lib/*.js tests/*.mjs`：通过。
- `git diff --check`：通过。
- `bash scripts/verify.sh`：静态检查通过；真实平台检查未运行。
- `npm audit`：隔离目录使用官方 registry 检查，0 vulnerabilities。
