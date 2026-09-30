param(
  [string]$Repo = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

function Require-Path([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "$Label 不存在：$Path" }
  Write-Host "PASS  $Label"
}

Require-Path (Join-Path $Repo 'package.json') 'package.json'
Require-Path (Join-Path $Repo 'lib\index.js') '插件入口'

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(18|19|20|21|22|23|24|25)\.') {
  throw "Node 版本必须 >=18，当前为 $nodeVersion"
}
Write-Host "PASS  Node $nodeVersion"

Push-Location $Repo
try {
  npm test
  if (Test-Path -LiteralPath (Join-Path $Repo 'package-lock.json')) {
    npm audit --omit=dev --audit-level=high
  } else {
    Write-Host 'ENVIRONMENT_FAILED  仓库无 package-lock.json，npm audit 按发布策略无法执行'
  }
  npm pack --dry-run --json | Out-File -Encoding utf8 (Join-Path $env:TEMP 'lingxu-ctf-pack.json')
  Write-Host 'PASS  npm pack --dry-run'
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '下一步桌面验收：'
Write-Host '1. 在 DSH 设置 -> 插件中安装仓库目录，重启 DSH。'
Write-Host '2. 新建两个会话，分别连接两个测试赛事；交错打开 CTF 视图、报告和状态。'
Write-Host '3. 访问 http://127.0.0.1:<DSH端口>/lingxu-ctf/diag，未登录请求应为 401。'
Write-Host '4. 关闭并重新启用插件，确认工具、路由和轮询没有重复。'
