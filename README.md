# dsh-lingxu-ctf

> 把[凌虚竞赛平台](https://shuxinbei.clsadp.com)（Lingxu event CTF）接进 DeepSeek Harness：
> 给一个平台地址 + `sessionid`，就能自动枚举赛题 / 理论题 / 排行榜，拉起并发解题 agent 团队，
> 自动提交 flag，并自动生成、提交 writeup。

- 宿主版本基线：DSH Desktop `0.2.0-rc.1`（Cordis `4.0.4`）
- 纯 ESM、零 npm 依赖（只用 Node 内置 `fetch` / `fs`），无构建步骤
- 目标 profile：`desktop`

---

## 1. 它能做什么

| 能力 | 说明 |
|---|---|
| 平台接入 | `ctf_connect` 保存平台地址 + `sessionid`，校验连通性，多赛事可切换 |
| 赛事总览 | `ctf_status`：名称 / 时间 / 我的分数与排名 / 已解 / 待解 / 理论题状态 |
| 赛题枚举 | `ctf_challenges` 按分类 / 状态 / 分值过滤；`ctf_challenge` 拉题面（HTML→Markdown）、下载附件、给出连接信息 |
| 环境题 | `ctf_start_env` 自动走平台的 `begin → run → addr` 三步拿到 `nc host port`；`ctf_release_env` 释放 |
| 自动交 flag | `ctf_submit_flag`：同题同 flag 去重 + 审计日志 + 每题错误次数统计（可选上限） |
| 排行榜 | `ctf_leaderboard`：个人 / 战队 / AWD / CFS |
| 理论题 | `ctf_theory`：列试卷 / 开始 / 拉题 / 逐题作答 / 交卷 |
| 并发解题 | `ctf_solve_start` 拉起 Agent Teams 解题团队（默认 4 并发），建共享任务板；`ctf_solve_status` 看进度；`ctf_solve_stop` 中断并释放环境 |
| WP | `ctf_writeup` 生成 Markdown WP（题面 + 元信息 + 解题思路 + 关键步骤 + flag + 复现脚本），可提交回平台 |
| Web 面板 | 题目看板 / 进度 / 排行榜 / 提交审计，路由 `/lingxu-ctf/state` |
| 预设 | 内置「CTF 解题模式」，一键进入解题纪律模式 |

---

## 2. 安装

插件以 **bundle** 形式安装：`plugin_manager` 会把它写进 `desktop` profile 的 `package.json`
依赖与 `dsh.profile.bundles`，`cordis.patch.yml` 自动并入工具行与「CTF 解题模式」预设行。

### 方式 A：本地目录（开发态推荐）

直接对 DSH 会话说（把路径换成你的实际路径）：

```
用 plugin_manager 安装这个 bundle：file:/Users/d1a0y1bb/Desktop/lingxu-ctf
```

对应调用是 `plugin_manager` 的 `install_bundle`，`target` 支持 npm 包名 / `file:` 路径 / tarball / URL：

| 场景 | target 写法 |
|---|---|
| 本地目录 | `file:/Users/d1a0y1bb/Desktop/lingxu-ctf` |
| 打包分发 | `npm pack` 得到 `dsh-lingxu-ctf-0.1.0.tgz`，target 填该 tgz 的绝对路径 |
| 已发布包 | `dsh-lingxu-ctf` |

### 方式 B：tarball

```bash
cd /Users/d1a0y1bb/Desktop/lingxu-ctf
npm pack            # 产出 dsh-lingxu-ctf-0.1.0.tgz
```

然后把 tgz 路径交给 `plugin_manager install_bundle`。

### ⚠️ 装完必须重启 DSH

profile 的 **bundle 列表在启动时读取**，安装后不会热生效：

1. 关闭 DSH Desktop，重新打开（或按 DSH 的提示重启）；
2. 重启后新开会话，`ctf_*` 工具才会出现，「CTF 解题模式」才会出现在模式选择里。

> 提示：`~/.dsh/profiles/desktop/cordis.patch.yml` 是**实时重载**的，迭代调试期可以直接往里加行做临时验证；
> 但正式安装仍以 `plugin_manager` 为准。

### 验证安装

重启后新开一个会话，问 agent：

```
列出你当前可用的 ctf_* 工具
```

应能看到 13 个工具；若还配置过平台，`/lingxu-ctf/state` 会返回面板 JSON。

---

## 3. 快速开始

### 3.1 从浏览器拿 `sessionid`

平台的登录接口带验证码（`/api/captcha/verify/`），**插件不做自动登录**，因此只支持 Cookie 认证：

1. 浏览器登录凌虚平台，进入目标赛事页面；
2. 按 `F12` 打开开发者工具 → **Application（应用）** → 左侧 **Cookies** → 选中平台域名；
3. 找到 `sessionid`，复制它的值；如果有 `csrftoken`，**一起带上**（写操作会用它做 `X-CSRFToken`）；
4. 拼成一行 Cookie：

```
sessionid=你的值; csrftoken=你的值
```

> - 只复制**平台根地址**（如 `https://shuxinbei.clsadp.com:8000`），**不要**填前端 hash 路由（`#/...`）。
> - 赛事 ID（`eventId`）是 URL 里 `/event/<id>/` 的那个数字。
> - Cookie 只写入本机 DSH 存储（`~/.dsh/storages/lingxu-ctf/state.json`），不会进插件目录、不会进 git；日志里只显示前 6 位。

### 3.2 在会话里说什么

第一句（先接上，不要急着解题）：

```
帮我接入凌虚 CTF：
- 平台地址：https://shuxinbei.clsadp.com:8000
- 赛事 ID：4
- Cookie：sessionid=粘贴你的值; csrftoken=粘贴你的值

先用 ctf_connect 配置并校验，再用 ctf_status 汇报全局情况，
然后用 ctf_challenges 列出未解题并按分值排序。先别开始解题。
```

确认数据无误后，第二句（全自动解题）：

```
开始解题：用 ctf_solve_start 并发 4 个 agent，只做 Web 和 Misc、分值 ≥ 100 的题；
每题解出后自动交 flag 并生成 WP。期间用 ctf_solve_status 汇报进度。
```

### 3.3 agent 会依次做什么

1. `ctf_connect` — 保存连接、校验 Cookie、提示 `punish` 等风险；
2. `ctf_status` / `ctf_challenges` — 摸清题目分布与自身排名；
3. `ctf_solve_start` — 过滤未解题 → 按分值降序 → 建共享任务板 → 按 `concurrency` 拉起 `solver-*` teammate；
4. 每个 teammate：`ctf_challenge` 拉题面 →（环境题）`ctf_start_env` → 本地解题 → `ctf_submit_flag` → `ctf_writeup` 生成 WP（用 `body` 传自己总结的思路正文）→ 完成共享任务；
5. `ctf_solve_status` 对照「任务板 / 平台状态」汇报进度；`ctf_solve_stop` 可随时中断并释放环境。

---

## 4. 工具清单（13 个）

| 工具名 | 作用 | 典型参数 |
|---|---|---|
| `ctf_connect` | 配置平台地址 + sessionid，校验连通性并持久化 | `platform`(`lingxu`\|`ctfd`)、`baseUrl`、`eventId`、`cookie`、`token`（CTFd）、`label` |
| `ctf_status` | 赛事总览：名称/时间/我的分数排名/已解/待解/理论题状态 | `connection`（可选，默认当前激活连接） |
| `ctf_challenges` | 题目列表，支持按分类/状态/分值过滤 | `category`、`solved`、`minScore`、`limit`、`connection` |
| `ctf_challenge` | 单题详情（题面 Markdown + 附件下载 + 连接信息） | `id`（题目 ID）、`download`、`connection` |
| `ctf_start_env` | 环境题 `begin→run→addr`，返回连接信息 | `id`、`connection` |
| `ctf_release_env` | 释放环境 | `id`、`connection` |
| `ctf_submit_flag` | 提交 flag（去重 + 审计 + 错误计数） | `id`、`flag`、`connection` |
| `ctf_leaderboard` | 个人/战队/AWD/CFS 排行榜 | `kind`(`user`\|`team`\|`awd`\|`cfs`)、`size`、`connection` |
| `ctf_theory` | 理论题：列出试卷 / 开始 / 拉题 / 作答 / 交卷 | `action`(`list`\|`begin`\|`questions`\|`answer`\|`time`\|`finish`)、`testId`、`questionId`、`option`、`limit`、`connection` |
| `ctf_solve_start` | 拉起并发解题 agent 团队（默认 4），建共享任务板 | `category`、`minScore`、`limit`、`onlyUnsolved`、`concurrency`、`connection` |
| `ctf_solve_status` | 团队进度：任务板 + 平台状态对照 | `connection`（可选） |
| `ctf_solve_stop` | 中断所有解题 agent、释放环境 | `reason`、`connection` |
| `ctf_writeup` | 生成 / 提交 WP | `id`（题目 ID，省略 = 按已解题目批量生成；旧别名 `challengeId` 仍可用）、`body`（解题思路正文，建议由解题 agent 填写）、`submit`（默认 false，只生成本地文件）、`title`、`connection` |

> 需要指定赛事时，绝大多数工具都接受可选的 `connection`（连接 key，形如 `lingxu:host:4`）；
> 不传就用当前激活连接。

---

## 5. 「CTF 解题模式」预设

bundle 自带一个 agent 预设 `ctf`（名称「CTF 解题模式」，`order: 5`），它：

- 注入解题 persona：先 `ctf_connect` 摸全局、优先做高分且已解人数多的题；
- 环境题必须走 `ctf_start_env`，解完用 `ctf_release_env` 释放；
- 拿到 flag 立刻提交，不攒着；不确定的 flag 不反复提交（防扣分）；
- 需要并发时用 `ctf_solve_start`，而不是手工 spawn；
- 每题解出后调用 `ctf_writeup` 生成 WP；
- 附带标准工具链：bash / fs / jobs / skill / todo / web / ask-user / present / 压缩。

**怎么用**：重启 DSH 后新建会话，在模式（预设）选择里选「CTF 解题模式」，然后直接说
「接入凌虚平台：地址 xxx，eventId xxx，Cookie xxx」。若要改 persona 文案或子插件清单，
编辑仓库根目录的 `cordis.patch.yml` 里 `preset-ctf` 行后重装/重启。

---

## 6. 配置项

配置写在 `cordis.patch.yml` 的 `lingxu-ctf` 行 `config:` 下（安装后也可改 profile 的 `cordis.patch.yml`，实时重载）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `concurrency` | `4` | 并发解题 agent 数，取值 1–8（硬上限 8） |
| `maxWrongAttempts` | `0` | 每题 flag 最大错误提交次数；`0` = 不限制。`punish: true` 的赛事建议设为 `3` 左右 |
| `dedupeFlags` | `true` | 提交前做「同题同 flag」去重，重复的正确 flag 不再请求平台 |
| `workDir` | `''` | 附件、题目元数据、WP 的落盘根目录；留空 = 会话 cwd 下的 `lingxu-ctf-work/` |
| `timeoutMs` | `30000` | 单次平台请求超时（毫秒） |
| `enableWebPanel` | `true` | 是否注册 Web 控制面板路由 `/lingxu-ctf/state` 与客户端 bundle |

目录约定（`workDir` 下）：

```
lingxu-ctf-work/
├── challenges/<slug>-<id>/     # 题面元数据 metadata.json、附件 distfiles/
├── scripts/                    # 复现脚本（生成 WP 时自动内联）
└── writeups/<slug>-<id>.md     # 生成的 WP
```

> `<slug>` 由题名清洗而来：**保留中文与 `!()` 等可读符号**，只把路径危险字符
> `<>:"/\|?*` 与控制字符替换成 `-`，空白折叠为 `-`，最多 60 字符（不切断 emoji），
> 题名为空时回退 `challenge-<id>`。编排层、工具层与 WP 用的是**同一条规则**，
> 所以目录名和 WP 文件名总是对得上。

---

## 7. Web 控制面板

`enableWebPanel: true`（默认）时，宿主插件注册两个 same-origin 路由：

| 路由 | 内容 |
|---|---|
| `GET /lingxu-ctf/state` | 面板 JSON 快照（赛事、统计、题目看板、排行榜、提交审计、理论题） |
| `GET /lingxu-ctf/client.js` | 自托管客户端 bundle（由 index 注入，无需 npm 解析） |

面板能看到：

- **赛事头部**：赛事名 / 平台 / 剩余时间 / 我的分数与排名；
- **统计条**：题目总数、已解、进行中、待解、总分；
- **题目看板**：按分类分组的卡片，显示分值、状态（待解/进行中/已解）、负责人（teammate 名）、已提交次数，支持过滤与搜索；
- **排行榜**：个人榜前 20，标出自己；
- **提交审计**：最近 20 条 flag 提交（时间 / 题目 / 状态，flag 已脱敏）；
- **理论题**：试卷状态、题量、剩余时间。

面板每 5 秒轮询一次（页面不可见时暂停）。未配置平台时会提示先调用 `ctf_connect`。

---

## 8. 多赛事（lingxu / ctfd）

| 适配器 | 认证 | 环境题 | 理论题 | 平台侧 WP |
|---|---|---|---|---|
| `lingxu`（凌虚，已实测） | `sessionid` Cookie（写操作带 `csrftoken`） | ✅ `begin→run→addr` | ✅ 全自动答题 + 交卷 | ✅ 列表 / 提交 |
| `ctfd`（CTFd API v1，未实测） | `token` 或 Cookie | ❌ 平台无统一环境接口 | ❌ 不支持 | ❌ 仅本地导出 |

**切换方式**：每次 `ctf_connect` 都会把该连接设为激活连接，连接 key 形如
`<platform>:<host>:<eventId>`；之后不带 `connection` 的工具都走激活连接。

```
# 凌虚
ctf_connect { platform: "lingxu", baseUrl: "https://shuxinbei.clsadp.com:8000", eventId: 4, cookie: "sessionid=..." }

# CTFd（用 API Token，避免 CSRF 麻烦）
ctf_connect { platform: "ctfd", baseUrl: "https://ctf.example.com", token: "ctfd_xxx" }
```

要同时保留多场比赛，就多次 `ctf_connect`（每次都会保存），再用 `connection` 参数显式指定；
`ctf_status` 会显示当前生效的连接。

---

## 9. 注意事项

- **登录带验证码 → 只支持 Cookie**。平台登录走 `/api/captcha/verify/`，插件不做自动登录；
  Cookie 过期后 `ctf_connect` / 工具会提示重新获取。请只在本机粘贴自己的 Cookie。
- **`punish: true` 时错误提交会扣分**。`ctf_status` / `ctf_connect` 会给出警告；
  护栏默认只记录不阻断（符合「全自动」设计），可用 `maxWrongAttempts` 主动收紧。
- **环境题记得释放**。`ctf_start_env` 会占用平台环境配额，解完或放弃请 `ctf_release_env`
  （重复释放是幂等的：平台返回「该环境正在释放」/「没有运行的环境」都视为成功）。
- **只访问你配置的平台地址**。所有出站请求只指向 `baseUrl`，不做任何第三方外发；
  附件也只会从平台返回的地址下载。
- **Cookie 安全**：凭据只落在本机 `~/.dsh/storages/lingxu-ctf/state.json`，日志中脱敏（只留前 6 位）；
  不要把带 Cookie 的截图或状态文件分享出去。
- **理论题交卷不可逆**：`ctf_theory` 的 `finish` 是危险操作，调用前确认所有题目已作答。
- **不要在未确认 flag 的情况下反复提交**，尤其是开启了错误扣分的赛事。

---

## 10. 开发

```bash
# 全部单测（自动发现 tests/**/*.test.mjs）
node --test

# 只跑 WP 模块
node --test tests/writeup.test.mjs

# 语法检查
node --check lib/writeup.js
```

> Node 24 起测试运行器不再接受目录参数，`node --test tests/` 会报 `MODULE_NOT_FOUND`；
> 用上面的 `node --test`（自动发现）或显式 glob：`node --test "tests/*.test.mjs"`。

> 本机若 `node` 不在 PATH，可用 DSH 自带的 Node：
> ```bash
> "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" --test
> ```

文档：

- [`docs/DESIGN.md`](docs/DESIGN.md) — 设计文档（用户决策、平台 API、模块划分、工具清单、编排设计、验收标准）；
- [`docs/DSH-API-NOTES.md`](docs/DSH-API-NOTES.md) — DSH 插件 API 契约（`defineTool`、Agent Teams、预设、Web 路由、存储、打包安装），写代码前以它为准。

模块划分：`lib/lingxu.js`（平台客户端）→ `lib/platforms.js`（适配器）→ `lib/store.js`（持久化）
→ `lib/tools.js` / `lib/orchestrate.js` / `lib/writeup.js`（业务）→ `lib/index.js`（装配）。
依赖方向单向，反向依赖禁止。

---

## 11. 已知限制

- **本机没有 Docker / pwntools**：插件按「本机 workspace + 按需装工具链」设计（不用容器）。
  pwn / rev 类题目需要自己准备环境，例如 `pip install pwntools`、`brew install gdb`、
  `apt install gdb-multiarch`，或按题目要求装对应版本的解释器 / JDK。
- **理论题交卷不可逆**：平台没有撤回接口，`finish` 之后无法重来。
- **`answer_mode == 2`（check 模式）不支持自动判题**：插件保留该标记并照常展示题面，需要人工确认。
- **CTFd 适配器未实测**：按官方 API v1 实现，环境题 / 理论题 / 平台侧 WP 均不支持。
- **平台可能只返回内网地址**：连接信息优先公网地址；只有内网时原样返回并给出提示。
- **并发上限**：插件 `concurrency` 上限 8，同时受 DSH `agentTeams.maxMembers`（默认 16）约束。
- **Web 面板是自托管 bundle**：第三方 profile 插件无法依赖 DSH 的 client-modules 解析，
  面板通过 `/lingxu-ctf/client.js` + index 注入加载；升级 DSH 后如面板失效，先重启再看宿主注入锚点是否变化。
