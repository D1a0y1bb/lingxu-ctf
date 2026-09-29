# 安装与排错

本文对应 `dsh-lingxu-ctf` `1.0.8`。插件是 DSH bundle，不是独立的 Node 服务。

## 支持范围

| 项目 | 当前值 |
| --- | --- |
| Node | `>=18`；优先使用 DSH 自带 runtime |
| 平台 | 凌虚 |
| DSH API | 按当前仓库的 `dsh-client-*` 注入和 Cordis 服务验证 |
| 安装方式 | DSH 插件管理器、本地 link、`dsh plugin` |
| npm | 不要求发布到 npm |

DSH 升级后应重新检查插件注入模块和 settings/sessions 服务名称。插件缺少可选服务时会降级，但客户端会话门控可能退回始终显示。

## 推荐安装

### GitHub 目录

```bash
git clone https://github.com/D1a0y1bb/lingxu-ctf.git
cd lingxu-ctf
bash scripts/install.sh
```

### 已有本地目录

```bash
cd /path/to/lingxu-ctf
bash scripts/install.sh
```

脚本先尝试 `dsh plugin --profile <profile> add <path>`。没有 `dsh` 命令时，它会给出 DSH 插件管理器和手工 link 的具体路径，并以非零退出码结束，避免让用户误以为已经安装。

安装后重启 DSH。profile 的 bundle 清单在启动阶段读取，热加载不会覆盖所有服务。

## 手工安装

在没有 CLI 和插件管理器的机器上，把仓库目录 link 到目标 profile：

macOS/Linux：

```bash
PROFILE=desktop
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
mkdir -p "$DSH_HOME/profiles/$PROFILE/node_modules"
ln -sfn "/绝对路径/lingxu-ctf" \
  "$DSH_HOME/profiles/$PROFILE/node_modules/dsh-lingxu-ctf"
```

然后在 `$DSH_HOME/profiles/$PROFILE/package.json` 中确认：

```json
{
  "dependencies": {
    "dsh-lingxu-ctf": "link:/绝对路径/lingxu-ctf"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-lingxu-ctf"]
    }
  }
}
```

保留原有条目，只补缺少的字段；不要覆盖整个 profile 文件。

Windows 使用 DSH 图形界面的本地路径安装，或在 PowerShell 中创建 junction：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force "$profile\node_modules" | Out-Null
cmd /c mklink /J "$profile\node_modules\dsh-lingxu-ctf" "C:\path\to\lingxu-ctf"
```

本轮没有 Windows 主机，因此 Windows 结果标为待复验。

## 卸载

优先用 DSH 插件管理器移除 bundle。手工安装时删除 profile 中的 bundle 名和对应 link，然后重启 DSH。不要删除仓库工作目录，除非其中的附件、writeup 和 store 已经备份。

## 安装后检查

```bash
cd /path/to/lingxu-ctf
npm test
bash scripts/verify.sh
```

检查 profile 是否登记：

```bash
grep -n "dsh-lingxu-ctf" "$HOME/.dsh/profiles/desktop/package.json"
```

成功加载后，DSH 日志中应出现插件名称和基础工具数量。基础工具应为 17 个；AWD/CFS 只有在连接到含对应赛段的赛事后才出现。

## 连接平台

在插件设置页填 `baseUrl`、`eventId` 和浏览器 Cookie。Cookie 要包含 `sessionid=`，不要把整段 Cookie 粘到 issue、终端回显或截图中。

在会话里按顺序运行：

```text
ctf_connect
ctf_session
ctf_status
```

如果 `ctf_session` 返回失效，重新登录凌虚并复制新的 Cookie，再调用 `ctf_connect`。插件不自动续期。

## 常见问题

### 插件不出现在设置页

确认三个条件：

1. `package.json` 的 profile dependencies 有 `dsh-lingxu-ctf`；
2. `dsh.profile.bundles` 里有同名条目；
3. DSH 已完全退出并重新启动。

### 工具只有基础 17 个

这是正常的初始状态。先确保连接有效，再运行 `ctf_status`。赛事摘要没有返回 AWD/CFS 时，专用工具不会注册。

### CTF 视图总是显示

视图门控依赖 DSH 的 `sessions` 服务和客户端 `ui-conversation` 模块。缺服务时插件会选择始终显示，以免把入口藏掉。检查 DSH 版本是否仍提供 `@deepseek-ai/dsh-client-ui-conversation`，并重新启动。

### 面板数据更新慢

服务端缓存默认 4 秒，后台平台刷新至少间隔 20 秒，并有每分钟上限。交 flag 或切换连接会触发一次受控刷新；`/lingxu-ctf/diag` 可查看命中和限流计数。

### live 检查显示未运行

这是因为没有设置 `LINGXU_COOKIE` 或 `LINGXU_COOKIE_FILE`。静态测试仍然有效，但它不能证明当前平台接口可用。需要 live 证据时，在隔离的 Cookie 文件中运行：

```bash
LINGXU_COOKIE_FILE=/private/path/lingxu.cookie \
LINGXU_BASE_URL=https://ctf.example.com:8000 \
LINGXU_EVENT_ID=4 \
bash scripts/verify.sh
```

### 请求返回 403

先运行 `ctf_session`。常见原因是 Cookie 过期、赛事 ID 不属于该账号，或平台地址带了错误的前端路由。

### 安装后如何反馈问题

请附上 DSH 版本、操作系统、`node --version`、触发工具名、脱敏后的返回首行和 `bash scripts/verify.sh` 的结果。不要提交 Cookie、完整请求头或本地 store。
