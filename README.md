# dsh-lingxu-ctf

DeepSeek Harness（DSH）的凌虚竞赛平台插件。它把赛事连接、题目查询、环境管理、提交记录和并行解题接到同一套工具里，附件与 writeup 保存到当前工作区。

当前版本：`1.0.7`

## 能做什么

- 连接凌虚平台，读取赛事、题目、排行榜、公告和理论题状态。
- 查看题面并下载附件；按题型启动、延长和释放环境。
- 提交 flag，在本地记录结果并对重复 flag 做拦截。
- 通过 DSH Agent Teams 分配题目、查看进度、停止任务和记录队内线索。
- 生成 writeup，保存题目材料、提交审计和运行记录。
- 在 DSH 顶部 `CTF` 视图查看题目、环境、agent、协同消息、提交和报告。

插件只支持凌虚适配器。AWD、CFS 工具会在探测到对应赛段后才注册。

## 安装

仓库不依赖 npm 发布包，直接从 GitHub 或本地目录安装。

```bash
git clone https://github.com/D1a0y1bb/lingxu-ctf.git
cd lingxu-ctf
bash scripts/install.sh
```

也可以在 DSH 的插件管理器里选择这个目录，或把本地目录作为 bundle 安装。安装完成后重启 DSH；插件清单在启动时读取。

没有 `dsh` 命令时，`scripts/install.sh` 会打印插件管理器和手工 link 的路径。Windows 使用 DSH 图形界面或 PowerShell 的 junction，不要照搬 Unix 的 `ln -s`。

安装后可运行：

```bash
npm test
bash scripts/verify.sh
```

`verify.sh` 没有平台 Cookie 时仍会完成静态检查，但会明确显示真实平台检查未运行。需要强制要求 live 检查时设置 `VERIFY_REQUIRE_LIVE=1`。

下一轮研发的缺陷、设计顺序和放行门槛见 [`docs/NEXT-REVIEW.md`](docs/NEXT-REVIEW.md)。

## 第一次连接

在 DSH 设置页填写以下三项：

1. 平台地址，例如 `https://ctf.example.com:8000`；
2. 赛事 ID（平台 URL 中 `/event/<id>/` 的数字）；
3. 浏览器 Cookie 中的 `sessionid=...`。

然后新建或切换到 CTF 会话，先调用：

```text
ctf_connect
ctf_session
ctf_status
```

也可以直接在会话里调用 `ctf_connect`。Cookie 只用于本地连接，不写入设置页的普通字段，也不会在工具结果和面板中回显完整值。

## 工具

基础工具始终注册，共 17 个：

| 工具 | 用途 |
| --- | --- |
| `ctf_connect` | 新建或切换平台连接 |
| `ctf_session` | 检查 Cookie 是否有效 |
| `ctf_status` | 读取赛事概况、赛段和通知 |
| `ctf_challenges` | 列出题目并按状态过滤 |
| `ctf_challenge` | 读取题面、题型和附件 |
| `ctf_start_env` | 启动环境并返回地址 |
| `ctf_delay_env` | 延长仍在运行的环境 |
| `ctf_release_env` | 释放环境配额 |
| `ctf_submit_flag` | 提交 flag 并记录结果 |
| `ctf_leaderboard` | 查询排行榜 |
| `ctf_theory` | 查询理论题、开始/答题/交卷 |
| `ctf_notice` | 读取公告 |
| `ctf_solve_start` | 启动并行解题任务 |
| `ctf_solve_status` | 查看 agent、任务和环境状态 |
| `ctf_solve_stop` | 停止并行解题任务 |
| `ctf_writeup` | 生成或读取 writeup |
| `ctf_team_log` | 记录队内线索和进展 |

含 AWD 赛段时增加 9 个 `ctf_awd_*` 工具，含 CFS 赛段时增加 7 个 `ctf_cfs_*` 工具。没有探测到赛段信息时不会显示这些工具；连接成功或运行 `ctf_status`/`ctf_session` 后会再次同步。

## 题型和环境

凌虚题型按平台返回值处理：`1` 环境型、`2` 外链型、`3` 附件型。环境剩余时间以平台返回值为准，不在插件里写死比赛时长。

环境相关操作有三个约束：

- 启动前先用 `ctf_challenge` 确认题型；附件题不需要启动环境。
- 剩余时间不足时可用 `ctf_delay_env`，平台不允许任意时刻延长。
- 完成题目或停止 agent 后调用 `ctf_release_env`，否则会继续占用赛事配额。

AWD 的提交、自己的 flag、重置靶机和裁判消息，CFS 的逐关提交和动态信息，都通过对应赛段工具完成。赛段工具的副作用会在返回中明确说明。

## 配置

设置页有 14 项：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | 空 | 凌虚平台根地址 |
| `eventId` | `0` | 赛事 ID |
| `cookie` | 空 | 浏览器 Cookie，secret 字段 |
| `label` | 空 | 连接备注 |
| `concurrency` | `4` | 并发解题 agent，范围 1–8 |
| `maxWrongAttempts` | `0` | 单题错误提交上限，0 表示不限制 |
| `envLimit` | `2` | 本地对环境配额的参考值，0 表示等待平台反馈 |
| `envAutoDelay` | `true` | 环境临近到期时自动尝试延时 |
| `reuseAgents` | `true` | 复用闲置 agent |
| `dedupeFlags` | `true` | 本地拦截重复 flag |
| `workDir` | 空 | 附件和 writeup 目录，空值使用工作区下的 `lingxu-ctf-work/` |
| `timeoutMs` | `30000` | 平台请求超时（毫秒） |
| `enableWebPanel` | `true` | 启用 CTF Web 视图和路由 |
| `enableFloatingPanel` | `false` | 是否显示右下角浮动面板 |

多个赛事同时使用时，建议用 `ctf_connect` 保存各自的连接；切换赛事不会复用不同平台的 Cookie。

## Web 路由和界面

插件注册以下路由：

| 路由 | 作用 |
| --- | --- |
| `/lingxu-ctf/state` | 面板快照 |
| `/lingxu-ctf/client.js` | 浏览器端 bundle |
| `/lingxu-ctf/config` | 读取和更新非 secret 配置 |
| `/lingxu-ctf/diag` | 查看面板缓存和请求计数 |
| `/lingxu-ctf/beacon` | 接收客户端状态信号 |
| `/lingxu-ctf/team` | agent、任务和队内消息 |
| `/lingxu-ctf/reports` | 本地 writeup 列表 |
| `/lingxu-ctf/theory` | 按需读取理论题概要 |
| `/lingxu-ctf/usage` | 读取当前会话 token 用量 |

顶部 `CTF` 视图是主入口，按需显示看板、环境、理论题、agent、协同、提交和报告。浮动面板默认关闭；两个界面共享服务端缓存，避免轮询重复请求平台。

`/lingxu-ctf/usage` 只接受 DSH 会话 ID。日志路径由服务端的 DSH 会话目录决定，浏览器不能通过查询参数指定任意文件系统根目录。

## 工作目录

默认目录是当前 DSH 工作区下的 `lingxu-ctf-work/`，也可以在设置页指定 `workDir`。典型内容包括：

```text
lingxu-ctf-work/
├── challenges/<题目-slug>-<id>/
│   └── distfiles/
├── writeups/
└── store.json
```

题目、连接、提交记录和队内消息使用本地 store 保存。Cookie 不写入题面、报告或普通面板快照。

## 开发和验证

```bash
npm test                         # 全部单元测试
node --test tests/client.test.mjs
node --check lib/index.js
bash scripts/verify.sh
```

有测试账号时再运行真实平台检查：

```bash
LINGXU_COOKIE_FILE=/path/to/cookie \
LINGXU_BASE_URL=https://ctf.example.com:8000 \
LINGXU_EVENT_ID=4 \
npm run smoke

LINGXU_COOKIE_FILE=/path/to/cookie \
LINGXU_BASE_URL=https://ctf.example.com:8000 \
LINGXU_EVENT_ID=4 \
npm run e2e
```

这两个脚本只读为主，不会主动交 flag 或交卷；没有凭据时退出码为 0 并标记为跳过。发布记录应把“单元测试通过”和“真实平台检查通过”分开写。

## 当前边界

- 需要有效的凌虚 Cookie；插件不负责登录、续期或验证码。
- DSH 的 Agent Teams、settings、sessions 等服务是可选依赖。缺少它们时，基础工具仍可加载，对应功能会给出降级结果。
- 顶部视图依赖 DSH 客户端的 `modules`、`locale` 和 `ui-conversation` 注入。DSH 升级后若模块名变化，需要重新验证视图门控。
- AWD/CFS、理论题和环境接口的字段以平台实际返回为准；平台侧变更时应先跑 live 检查，再更新适配器。

## 许可证

MIT
