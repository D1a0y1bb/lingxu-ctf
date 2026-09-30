# Windows 验收

当前仓库没有可操作的 Windows 主机，所以 Windows 结果仍是 `environment_failed`，不能用 PowerShell 静态检查冒充桌面验收。

在 Windows 上执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\verify-windows.ps1 -Repo (Get-Location).Path
```

脚本只检查 Node、源码、回归测试、打包清单和 lockfile 状态，不会把 Cookie 写入日志，也不会自动改 profile。真实桌面验收还要在 DSH GUI 完成本地安装、重启、两个赛事会话交错操作、插件卸载/重新启用和 `/diag` 未认证边界检查，并保存截图与 HTTP 状态码。
