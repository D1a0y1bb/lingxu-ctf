# dsh-lingxu-ctf

> 把**凌虚竞赛平台**（Lingxu event CTF）接进 DeepSeek Harness：**配置一次，之后在会话里说一句「开始」**，
> 就能自动摸清赛题与排名、拉起并发解题 agent 团队、自动提交 flag、自动生成 writeup。

| 项目 | 说明 |
|---|---|
| 适用版本 | DSH Desktop `0.2.0-rc.1`（Cordis `4.0.4`），目标 profile `desktop` |
| 平台支持 | **只支持凌虚赛事平台**（`sessionid` Cookie 认证） |
| 依赖 | 零第三方依赖：只用 Node 内置能力 + DSH 官方 `@deepseek-ai/schemastery`（配置表单 schema），无构建步骤 |
| 安装 | 用 `plugin_manager` 装 bundle：本地目录 `file:<你的插件目录>` / tarball / npm 包名 |
| 提供 | 14 个 `ctf_*` 工具 · 「CTF 解题模式」agent 预设 · Web 界面（顶部「CTF」视图 tab + 设置页配置卡片；右下角浮动面板可选，默认关闭） |

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [怎么用（5 步跑起来）](#怎么用5-步跑起来)
- [工具清单（14 个）](#工具清单14-个)
- [「CTF 解题模式」预设](#ctf-解题模式预设)
- [配置项（11 项）](#配置项11-项)
- [Web 界面](#web-界面)
- [多场赛事](#多场赛事)
- [注意事项](#注意事项)
- [开发](#开发)
- [已知限制](#已知限制)

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 赛事总览 | 赛事名 / 起止时间 / 剩余时间 / 我的分数与排名 / 已解 / 待解 / 理论题状态 |
| 赛题枚举 | 按分类 / 状态 / 分值过滤；单题题面（HTML→Markdown）+ 附件自动下载到工作区 |
| 环境题 | 自动走平台 `begin → run → addr` 三步，返回可直连的 `nc host port`；用完可释放 |
| 自动交 flag | 同题同 flag 本地去重 + 提交审计日志 + 每题错误次数统计（可设上限，防错误扣分） |
| 并发解题 | 拉起 agent 团队（默认 4 个，1–8），建共享任务板自动去重，每个 agent 独立解一道题 |
| 排行榜 | 个人 / 战队 / AWD / CFS |
| 理论题 | 列试卷 → 开始考试 → 拉题 → 逐题作答（`option` 支持 string 或 array）→ 交卷（交卷**不可逆**） |
| writeup | 自动生成 Markdown WP（题面 + 元信息 + 解题思路 + 关键步骤 + flag + 复现脚本），可提交回平台 |
| Web 界面 | 顶部「CTF」视图 tab（题目看板 / Agent 活动 / 协同通信 / 提交审计 / 报告，5 秒轮询）+ 设置页配置卡片；右下角浮动面板可选、**默认关闭** |
| 预设 | 内置「CTF 解题模式」，选它就能直接说「开始」，不用每次交代流程 |

---

## 安装

插件以 **bundle** 形式安装：`plugin_manager` 会把它写进 `desktop` profile 的 `package.json` 依赖与
`dsh.profile.bundles`，仓库里的 `cordis.patch.yml` 会同时并入宿主插件行与「CTF 解题模式」预设行。

对 DSH 说一句话就能装（把 `<...>` 换成你的实际情况）：

```
用 plugin_manager 安装这个 bundle：<target>
```

`<target>` 支持三种写法：

| 场景 | `<target>` 怎么写 | 说明 |
|---|---|---|
| 本地目录（开发态） | `file:<你的插件目录>` | 例如插件在 `~/dsh-lingxu-ctf`，就填 `file:~/dsh-lingxu-ctf`（建议用绝对路径） |
| 分发包（tarball） | 指向 `dsh-lingxu-ctf-0.1.0.tgz` 的路径 | 在插件目录执行 `npm pack` 生成 tgz，再把 tgz 路径交给 `install_bundle` |
| npm 包名 | `dsh-lingxu-ctf` | 该包已发布到 npm（或你配置的 registry）时可用 |

打包成 tarball 分发：

```bash
cd <你的插件目录>
npm pack            # 产出 dsh-lingxu-ctf-0.1.0.tgz
```

### ⚠️ 装完必须重启 DSH

profile 的 **bundle 列表在启动时读取**，安装后不会热生效：

1. 关闭 DSH Desktop，重新打开；
2. 重启后新开一个会话，`ctf_*` 工具才会出现，「CTF 解题模式」才会出现在模式选择里。

### 验证安装

重启后新开一个会话，对 agent 说：

```
列出你当前可用的 ctf_* 工具
```

应能看到 14 个 `ctf_*` 工具；设置页里也会多出 `dsh-lingxu-ctf` 的配置卡片
（见 [怎么用](#怎么用5-步跑起来) 第 2 步）。

---

## 怎么用（5 步跑起来）

一句话总览：**装好插件 → 配置一次 → 之后每场比赛只要「新建工作区 → 选预设 → 说开始」**。

### 第 1 步：装插件并重启 DSH

按上面的[安装](#安装)章节装好并重启。装完不用再做别的，工具和预设都会自动就位。

### 第 2 步：在设置里填 4 项

打开 **设置 → 内置插件 → 插件列表 → `dsh-lingxu-ctf`**，展开配置卡片，填这 4 项：

| 字段 | 填什么 |
|---|---|
| `平台地址` | 平台根地址，例如 `https://shuxinbei.clsadp.com:8000`（**不要**带前端 `#/...` 路由） |
| `赛事 ID` | 浏览器地址栏 `/event/<id>/` 里的那个数字 |
| `Cookie（sessionid）` | 浏览器复制的完整 Cookie，**必须含 `sessionid=`**（怎么拿见下方） |
| `并发解题 Agent 数` | 同时解几道题，默认 4，可填 1–8 |

其余字段（错误提交上限 / flag 去重 / 工作目录 / 请求超时 / Web 面板与浮动面板开关）都有合理默认值，先不用管，
需要时看[配置项](#配置项11-项)。

> `Cookie` 是 **secret 字段**：只写不读，保存后设置页只显示「已设置」，留空表示「不修改」。
> 凭据只落在本机 `~/.dsh/storages/lingxu-ctf/`，不会进插件目录、不会进 git。

#### 附：怎么拿 `sessionid`

平台的登录接口带验证码，**插件不做自动登录**，所以只能用 Cookie：

1. 浏览器登录凌虚平台，打开目标赛事页面；
2. 按 `F12` → **Application（应用）** → 左侧 **Cookies** → 选中平台域名；
3. 复制 `sessionid` 的值；如果有 `csrftoken`，**一起带上**（写操作会用它做 `X-CSRFToken`）；
4. 拼成一行，粘进设置页的 `Cookie` 字段：

```
sessionid=你的值; csrftoken=你的值
```

### 第 3 步：新建一个工作区

在 DSH 里新建一个工作区（选一个空文件夹）。**为什么要新建**：题面元数据、附件、解题脚本、
生成的 writeup 全部落在这个工作区下的 `lingxu-ctf-work/` 里，**一场比赛一个目录**，好找也好清理。

### 第 4 步：新建会话时选「CTF 解题模式」

在新建会话（工作区）时，把 agent 模式/预设选成 **「CTF 解题模式」**。
这个预设已经写好了完整工作流和解题纪律，选它就够了。

### 第 5 步：说「开始」

在工作区里新建会话（已选预设），直接说：

```
开始
```

**就这一句。** 预设已经让 agent 知道该干什么：

- 它会先用 `ctf_status` 确认连接、看清赛事名 / 剩余时间 / 题目分布 / 我的排名；
- 再用 `ctf_solve_start` 拉起并发解题团队（按设置里的并发数），自动建共享任务板并分派题目；
- **不需要再报一遍平台地址和 Cookie** —— 第 2 步已经配置好了，agent 直接用。

想缩小范围就直接把条件说出来，例如：

```
开始，只做 Web 和 Misc、分值 ≥ 100 的题，并发 6
```

### 说这些话就能用

| 你说 | 发生什么 |
|---|---|
| `开始` | `ctf_status` 摸底 → `ctf_solve_start` 按并发拉 agent 团队、建共享任务板 |
| `看下进度` | `ctf_solve_status`：任务板 + 平台侧题目/排名对照 |
| `只做 Web 分类` / `只做 300 分以上的` | 带 `category` / `minScore` 的编排 |
| `停` | `ctf_solve_stop`：中断 agent 并释放环境 |
| `给这题写个 writeup` | `ctf_writeup` 生成 Markdown 落盘，可选提交平台 |
| `做理论题` | `ctf_theory`：列试卷 → 开始 → 逐题作答 → 交卷（**交卷不可逆**；多选可写 `option=BCD`） |
| `看看排行榜` | `ctf_leaderboard` |
| `这题环境先放掉` | `ctf_release_env` 释放靶机，避免占满环境配额 |
| `这题题面给我看看` | `ctf_challenge` 拉题面（Markdown）+ 下载附件 + 给出连接信息 |

### 它自己会做什么

选好预设说「开始」之后，每个解题 agent 会自动跑完这一串，**你不用盯着**：

1. `ctf_challenge` —— 拉题面（HTML 已转 Markdown）、下载附件到工作区；
2. 环境题自动 `ctf_start_env`（平台需要 `begin → run → addr` 三步），拿到 `nc host port` 连接信息；
3. 在工作区里动手解题（写脚本、跑 exp、必要时联网查资料），保留复现脚本；
4. 拿到 flag 立刻 `ctf_submit_flag` 提交（本地去重 + 审计；错误次数超限会拒提交，防扣分）；
5. `ctf_writeup` 生成 Markdown WP 落到 `lingxu-ctf-work/writeups/`；
6. 解完释放环境、把共享任务标记完成，并向 lead 汇报。

你随时可以用 `看下进度` 查看团队状态，用 `停` 收工。

---

## 工具清单（14 个）

这些工具由插件注册，agent 会自动调用；你也可以在会话里直接点名要求。

| 工具名 | 作用 | 参数 |
|---|---|---|
| `ctf_connect` | 保存平台连接（多赛事切换时用；设置页填过可省） | `baseUrl`、`eventId`、`cookie`、`label` |
| `ctf_session` | **探活**：检查 sessionid 是否还有效（开赛前 / 提交报 403 后先跑这个） | `connection` |
| `ctf_status` | 赛事总览：名称 / 时间 / 我的分数排名 / 已解 / 待解 / 理论题状态 | `connection` |
| `ctf_challenges` | 题目列表，按分类 / 状态 / 分值过滤 | `category`、`solved`、`minScore`、`limit`、`connection` |
| `ctf_challenge` | 单题详情：题面 Markdown + 附件下载 + 连接信息 | `id`、`download`、`connection` |
| `ctf_start_env` | 环境题开题并起环境（`begin→run→addr`），返回连接信息 | `id`、`connection` |
| `ctf_release_env` | 释放环境（幂等，重复释放也算成功） | `id`、`connection` |
| `ctf_submit_flag` | 提交 flag：本地去重 + 审计 + 错误次数护栏 | `id`、`flag`、`connection` |
| `ctf_leaderboard` | 排行榜：个人 / 战队 / AWD / CFS | `kind`、`size`、`connection` |
| `ctf_theory` | 理论题一站式：list / begin / questions / answer / time / finish | `action`、`testId`、`questionId`、`option`（string 或 array）、`limit`、`connection` |
| `ctf_solve_start` | 拉起并发解题 agent 团队并建共享任务板 | `category`、`minScore`、`limit`、`onlyUnsolved`、`concurrency`、`connection` |
| `ctf_solve_status` | 团队进度：任务板 + 平台状态对照 | `connection` |
| `ctf_solve_stop` | 中断所有解题 agent，并（默认）释放它们拉起的环境 | `reason`、`releaseEnvs`、`connection` |
| `ctf_writeup` | 生成 / 提交 WP（`id` 省略 = 按已解题目批量生成；`submit` 默认 false） | `id`、`body`、`submit`、`title`、`connection` |

说明：

- `kind` 取值 `user` / `team` / `awd` / `cfs`；`action` 取值 `list` / `begin` / `questions` / `answer` / `time` / `finish`；
  `id` 可以是数字或字符串。
- **必填参数**：`ctf_connect.baseUrl`、`ctf_submit_flag.flag`、`ctf_theory.action`（schema 层面的必填）；
  其余参数省略时走默认值，或由工具返回一句「缺少 xx」的使用提示（例如 `ctf_challenge` 少了 `id`）。
- `ctf_theory` 的 `option` **支持 string 或 array**（`action=answer` 时必填）：
  单选 / 判断传 `"B"` 或 `["B"]`；多选传 `"BCD"` 或 `["B","C","D"]`（插件按平台规则排序）；
  填空题按空位顺序传数组，如 `["答案1","答案2"]`（**不排序**）。
- 所有工具都接受可选的 `connection`（连接 key，形如 `lingxu:<host>:<赛事ID>`）；
  不传就用设置页配置的连接。
- 一般**不需要手写这些调用**——预设里的工作流会自己用。工具描述里写了每个工具的用法与副作用。

---

## 「CTF 解题模式」预设

bundle 自带一个 agent 预设 `ctf`（名称「CTF 解题模式」，`order: 5`），它做了三件事：

1. **注入解题 persona**：优先做高分且已解人数多的题；拿到 flag 立刻提交，不攒着；
   不确定的 flag 不反复提交（防扣分）；需要并发时用 `ctf_solve_start`，不手工一个个 spawn。
2. **写死默认工作流**：用户说「开始」就直接 `ctf_status` → `ctf_solve_start`，
   **不反问配置、不索要凭据**（配置在设置页里）。
3. **附带标准工具链**：bash / fs / jobs / skill / todo / web / ask-user / present / 上下文压缩。

**怎么用**：新建会话时选「CTF 解题模式」，然后说「开始」即可（见[怎么用](#怎么用5-步跑起来)）。
若想改 persona 文案或子插件清单，编辑 `cordis.patch.yml` 里的 `preset-ctf` 行后重装/重启。

---

## 配置项（11 项）

**推荐在设置页改**：**设置 → 内置插件 → 插件列表 → `dsh-lingxu-ctf`**（表单由插件自带的配置卡片渲染）。
也可以直接改 profile 里 `cordis.patch.yml` 的 `lingxu-ctf` 行 `config:`（profile 层实时重载）。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `''` | 平台根地址，如 `https://shuxinbei.clsadp.com:8000`（不要带 `#/` 路由） |
| `eventId` | `0` | 赛事 ID，URL 里 `/event/<id>/` 的数字 |
| `cookie` | `''` | 完整 Cookie，必须含 `sessionid=`；**secret 字段，只写不读** |
| `label` | `''` | 连接备注名，多场比赛时便于识别 |
| `concurrency` | `4` | 并发解题 agent 数，1–8（硬上限 8） |
| `maxWrongAttempts` | `0` | 每题 flag 最大错误提交次数；`0` = 不限制，`punish: true` 的赛事建议设 3 左右 |
| `dedupeFlags` | `true` | 提交前做「同题同 flag」去重，已成功提交过的 flag 不再请求平台 |
| `workDir` | `''` | 附件 / 元数据 / WP 的落盘根目录；留空 = 当前工作区下的 `lingxu-ctf-work/` |
| `timeoutMs` | `30000` | 单次平台请求超时（毫秒） |
| `enableWebPanel` | `true` | 是否注册宿主侧的 `/lingxu-ctf/*` 路由（Web 界面的数据来源）；关掉后工具与预设照常，但界面读不到数据 |
| `enableFloatingPanel` | `false` | 显示右下角浮动面板。**默认关闭**：日常主要看顶部「CTF」视图，想要老式悬浮看板再打开 |

> 这两个开关**不是同一层**：`enableWebPanel` 管宿主路由（关掉后界面拿不到数据），
> `enableFloatingPanel` 管右下角面板挂不挂（且它的开关信息本身就来自 `/lingxu-ctf/config` 路由，
> 所以 `enableWebPanel: false` 时浮动面板一定不会出现）。
> 浮动面板开关是**页面加载时读一次**配置决定的：改完这两项（以及其它开关类配置）请**刷新一次页面**再看，
> 不刷新就一直维持加载时的行为。

> 只要 `baseUrl` + `eventId` + `cookie` 齐了，工具就会**直接用配置连平台**，不需要先跑 `ctf_connect`。
> 显式调用 `ctf_connect` 会额外把连接存进本地状态，适合**多场比赛切换**。

目录约定（`workDir` 下）：

```
lingxu-ctf-work/
├── challenges/<slug>-<id>/     # 题面元数据 metadata.json、附件 distfiles/
├── scripts/                    # 复现脚本（生成 WP 时自动内联）
└── writeups/<slug>-<id>.md     # 生成的 WP
```

> `<slug>` 由题名清洗而来：保留中文与 `!()` 等可读符号，只把路径危险字符
> `<>:"/|?*` 与控制字符替换成 `-`，最多 60 字符，题名退化成空时回退 `challenge`
> （如 `challenge-12.md`）。

---

## Web 界面

插件在 DSH 的 Web 界面注册**三个互不牵连的出口**：顶部「CTF」视图 tab、设置页配置卡片、右下角浮动面板。
它们都靠宿主侧的 `/lingxu-ctf/*` 路由供数据，而这些路由由配置项 `enableWebPanel`（默认 `true`）控制：

- `enableWebPanel: true` → 路由就绪，三个出口都能正常工作；
- `enableWebPanel: false` → 路由全部不注册，**tab 与配置卡片仍可能出现在界面上**（客户端半由 DSH 的
  `dsh.client` 机制独立装配，不读这个开关），但读不到数据，只会显示空态 / 加载失败。

### ① 顶部「CTF」视图 tab（主入口）

会话顶部的视图条会多一个 **CTF** tab（`对话 | 轨迹 | CTF`），点进去是 5 个子视图：

| 子视图 | 看什么 |
|---|---|
| **题目看板** | 按分类分组；每张卡片显示分值、状态（待解 / 进行中 / 已解）、负责人、提交次数、任务完成数，支持分类 / 状态 / 搜索筛选。**平台侧还显示未解、但共享任务已 `in_progress` 的题会升级成「进行中 · solver-xxx」**；只存在于任务板、平台列表里还没同步的题会标「仅任务」 |
| **Agent 活动** | 每个 teammate 的状态点（运行中 / 空闲 / 启动中 / 失败）、当前题目、已完成题数、最后活动时间，可展开看它负责的全部题目 |
| **协同通信** | 团队的 spawn / 汇报 / 状态 / 停止消息时间线（`[时间] from → to 内容`，按 kind 着色） |
| **提交审计** | 最近 30 条 flag 提交（时间 / 题目 / 状态 / 脱敏 flag） |
| **报告** | 本地 `lingxu-ctf-work/writeups/` 的 WP 列表：题名 / 分类 / 路径 / 大小 / 修改时间 / 是否已提交平台，点开可展开正文（正文由 `/reports` 下发；当前该路由只回列表元信息，所以展开处显示「（无正文）」） |

数据 5 秒轮询一次（页面不可见时暂停），来源是三条同源路由：

- `GET /lingxu-ctf/state` —— 赛事 + 题目看板 + 排行榜 + 提交审计 + 理论题；
- `GET /lingxu-ctf/team` —— 团队成员 / 共享任务板 / 协同消息 / 计数；
- `GET /lingxu-ctf/reports` —— 本地 WP 列表（纯本地读盘，不请求平台）。

> **为什么我在某个会话里看不到 CTF tab？** 这个 tab 默认**只在 CTF 预设会话里显示**：
> 当前会话（或其祖先会话）的 preset 是 `ctf` / `ctf-*` 时才注册，切到别的会话会自动注销。
> 想让它出现，就用「CTF 解题模式」新建会话（见[怎么用](#怎么用5-步跑起来)）。
> 两种容错降级会**始终显示** tab：拿不到 `ctx.sessions` 服务，或拿到的会话快照里没有任何
> preset 信息（无法判定）。所以「CTF 会话里有、别的会话里没有」是预期行为，不是坏了。

### ② 设置页配置卡片

就是你填平台地址 / Cookie 的地方（**设置 → 内置插件 → 插件列表 → `dsh-lingxu-ctf`**）：
注册进 DSH Plugins 页的 bundle 配置槽（key = 包名 `dsh-lingxu-ctf`），`cookie` 渲染为只写输入框，永不回显。
读写走 `GET` / `POST /lingxu-ctf/config`。

### ③ 右下角浮动面板（可选，默认关闭）

只有 `enableFloatingPanel: true` 才挂载 —— 默认 `false`，因为顶部 CTF 视图已经是主入口。
它是同一份数据的紧凑版：赛事头部（赛事名 / 剩余时间 / 分数排名）、统计条（总数 / 已解 / 进行中 / 待解 / 总分）、
题目看板、个人榜前 20、提交审计（最近 20 条）、理论题状态。

### 路由清单（排查时用）

| 路由 | 方法 | 作用 |
|---|---|---|
| `/lingxu-ctf/state` | GET | 面板快照：赛事 / 题目 / 排行榜 / 提交审计 / 理论题 |
| `/lingxu-ctf/team` | GET | 团队全景：`members` / `tasks` / `messages` / `counts`（`?limit=` 控制消息条数，默认 50、上限 200） |
| `/lingxu-ctf/reports` | GET | 本地 writeup 列表：`{ok, generatedAt, writeups[]}`，每条含题目 / 路径 / 大小 / 修改时间 / 是否已提交（**不含正文**）；文件不在就跳过 |
| `/lingxu-ctf/config` | GET / POST | 配置卡片的读写接口（secret 字段只回「是否已设置」） |
| `/lingxu-ctf/diag` | GET | 宿主侧客户端加载诊断：路由注册、bundle 版本、浏览器打点（beacon） |
| `/lingxu-ctf/beacon` | GET | 浏览器半的回传探针（1x1 图片式 GET，`?stage=&detail=`），`/diag` 里可见 |
| `/lingxu-ctf/client.js` | GET | 自托管的客户端 bundle（浏览器实际执行的那份脚本） |

> ⚠️ `/lingxu-ctf/team` 需要会话语境：HTTP 路由没有 `exec.agent`，插件只能把**会话内最近一次 `ctf_*` 调用**
> 的 agent 记下来用。所以刚装完、还没跑过任何 `ctf_*` 工具时，它返回 `ok:false` + 提示
> 「先在会话里跑一次 ctf_status」，前端渲染空态 —— 这是预期行为，不是报错。

客户端半通过 DSH 官方 `dsh.client` 机制加载（`package.json` 的 `dsh.client` + `exports["./client"]`），
由 DSH 的 client-modules 宿主半自动组装并服务，**不要**改成手工注入 boot graph。

---

## 多场赛事

**本插件只适配凌虚赛事平台**。同时打多场比赛时：

- 设置页的 `baseUrl` / `eventId` / `cookie` 永远指向**当前主用**的那场；
- 想保留多场，就分别对 agent 说「用 `ctf_connect` 存一下这场比赛：地址 …、赛事 ID …、Cookie …」，
  每次 `ctf_connect` 都会把连接存进本地状态并设为激活连接；
- 连接 key 形如 `lingxu:<host>:<赛事ID>`，之后用 `connection` 参数显式指定要用哪一场，
  不传则用激活连接（或设置页配置）。

```
ctf_connect { baseUrl: "https://shuxinbei.clsadp.com:8000", eventId: 4, cookie: "sessionid=..." }
```

---

## 注意事项

- **登录带验证码 → 只支持 Cookie**。平台登录走 `/api/captcha/verify/`（要滑动验证码，参数是
  `{username, password, captcha_ticket}`），插件不做自动登录、也不会替你续期；
  Cookie 失效后工具会给出统一提示（见下一小节）。请只在本机粘贴自己的 Cookie。
- **`csrftoken` 建议一起带上**。实测平台不强制（不带也是 200），但写操作会用它做 `X-CSRFToken`；
  从浏览器**全量复制** Cookie 最省事。`ctf_connect` 发现少了它只会提醒，不会拒绝。
- **`punish: true` 时错误提交会扣分**。`ctf_status` 会给出警告；护栏默认只记录不阻断
  （符合「全自动」设计），可用 `maxWrongAttempts` 主动收紧。
- **环境题记得释放**。`ctf_start_env` 会占用平台环境配额；解完或放弃时说一句「这题环境放掉」
  （`ctf_release_env`，重复释放是幂等的）。`ctf_solve_stop` 默认也会释放。
- **只访问你配置的平台地址**。所有出站请求只指向 `baseUrl`，不做任何第三方外发；
  附件也只会从平台返回的地址下载。
- **Cookie 安全**：secret 字段只写不读、日志脱敏（只留前 6 位）、状态文件在本机
  `~/.dsh/storages/lingxu-ctf/`；不要把带 Cookie 的截图或状态文件分享出去。
- **不要在未确认 flag 的情况下反复提交**，尤其是开启了错误扣分的赛事。

### Cookie 失效（sessionid 过期）：只能手动换，无法自动续期

平台对失效登录态返回 **`403` + `{"detail":"未登录"}`**（不是 `401`），插件会把它识别成专门的
「session 失效」，所有工具统一提示：

```
❌ 凌虚 sessionid 已失效，请重新登录平台后复制新的 Cookie，
   再用 ctf_connect { baseUrl, eventId, cookie } 更新（其余配置会保留）。
```

⚠️ **无法自动续期**：平台登录接口需要滑动验证码，而且鉴权请求不会回 `Set-Cookie` ——
Cookie 的寿命在**登录那一刻**就固定了。失效后只能：浏览器重新登录 → 复制新 Cookie →
在设置页粘贴（或调一次 `ctf_connect`）覆盖。其余配置项（赛事 ID / 并发数 / 工作目录等）保持不变。

### 「平台未为该题配置环境」（`env-not-configured`）

有些题 `task_type=1`（环境题），但平台侧其实没给它配环境。此时 `ctf_start_env` / `ctf_release_env`
会拿到 **`400` + `{"error":"该题目没有选择对应的环境，请联系管理员。"}`**。插件把这类响应识别为
**平台数据问题、不算失败**：

| 工具 | 返回 |
|---|---|
| `ctf_start_env` | `⚠️ 该题在平台上没有配置环境（平台返回：…）`，并提示直接分析附件 |
| `ctf_release_env` | `ℹ️ 题目 #N：平台未为该题配置环境，无需释放（不算失败）` |

怎么判断：先用 `ctf_challenge` 看题面上「需要环境」的标记，再看是否命中上面两条文案。
如果这道题**本该有环境**却没有，只能找平台（出题人 / 管理员）确认，插件侧绕不过去。

### 理论题：状态语义与正确用法

**试卷状态**按平台前端的同款优先级判定（`ctf_theory action=list` 与 `ctf_status` 都这么显示）：

```
已交卷（is_parse）> 进行中（is_begin）> 已结束·未交卷（is_end）> 已开始未交卷（有 start_time）> 未开始
```

⚠️ 坑：**交卷后平台会把 `is_begin` 变回 `false`**，只看 `is_begin` 会把已交卷的试卷误判成「未开始」；
插件以 `is_parse` 为准。列表里的「交卷次数」列是 `parse_count`（**交卷次数，不是已答题数**）。

`action=answer` 的 `option` **现在是 string 或 array**：

| 题型 | 怎么传 | 提交结果 |
|---|---|---|
| 单选 / 判断 | `option="B"` 或 `option=["B"]` | `["B"]` |
| 多选 | `option="BCD"` 或 `option=["B","C","D"]` | 按键位排序后提交 |
| 填空 | `option=["答案1","答案2"]` | 按空位顺序提交，**不排序** |

平台前端对非填空题会做 `answer.sort()`，插件按同样规则归一；请求体是 JSON `{"option":[...]}`。

⚠️ **交卷不可逆**：`action=finish` 没有撤回接口，交卷前确认所有题都已作答。
而且试卷一旦交卷，平台**不再开放题目列表** —— `action=questions` / `order` 会返回
`400「题目不是开启状态」`。这是平台行为，不是插件故障。

---

## 开发

```bash
# 全部单测（自动发现 tests/**/*.test.mjs）
node --test

# 只跑某个模块
node --test tests/writeup.test.mjs

# 语法检查
node --check lib/writeup.js
```

> Node 24 起测试运行器不再接受目录参数：`node --test tests/` 会报 `MODULE_NOT_FOUND`，
> 用 `node --test`（自动发现）或 `node --test "tests/*.test.mjs"`。
> 若 `node` 不在 PATH，可用 DSH 自带的 Node：
> `"<DSH 安装目录>/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" --test`

文档：

- [`docs/DESIGN.md`](docs/DESIGN.md) — 设计文档（用户决策、平台 API、模块划分、编排设计、验收标准）；
- [`docs/DSH-API-NOTES.md`](docs/DSH-API-NOTES.md) — DSH 插件 API 契约（工具注册、Agent Teams、预设、Web 路由、存储、打包安装）。

模块划分（依赖方向单向，反向依赖禁止）：

```
lib/lingxu.js      平台客户端（纯 fetch，零依赖）
lib/platforms.js   平台适配器注册表（只注册 lingxu）
lib/store.js       连接配置 + 提交审计 + 解题进度持久化
lib/toolkit.js     零依赖的 defineTool 兼容实现（参数 DSL → JSON Schema + 校验）
lib/tools.js       14 个模型可见工具
lib/orchestrate.js Agent Teams 并发编排
lib/writeup.js     WP 生成与提交
lib/client.js      Web 界面（浏览器半：顶部「CTF」视图 tab + 配置卡片 + 浮动面板）
lib/index.js       装配（配置归一化 + 依赖注入 + 注册）
```

---

## 已知限制

- **只支持凌虚赛事平台**，没有其他平台的适配器（历史遗留的非 `lingxu` 连接记录会直接报错，不静默降级）。
- **没有 Docker / pwntools**：插件按「本机工作区 + 按需装工具链」设计，不用容器。
  pwn / rev 类题目需要自己准备环境（`pip install pwntools`、`brew install gdb`、
  `apt install gdb-multiarch`，或按题目要求装解释器 / JDK）。
- **Cookie 无法自动续期**：平台登录要滑动验证码，且鉴权不回 `Set-Cookie`，过期只能手动重新复制（见
  [Cookie 失效](#cookie-失效sessionid-过期只能手动换无法自动续期)）。
- **理论题交卷不可逆，且交卷后平台不再开放题目列表**：`finish` 之后无法重来，
  `questions` / `order` 会返回 `400「题目不是开启状态」`。
- **`answer_mode == 2`（check 模式）不支持自动判题**：插件保留该标记并照常展示题面，需要人工确认。
- **`task_type=1` 但平台没配环境的题**：`ctf_start_env` / `ctf_release_env` 会被识别成
  「平台未为该题配置环境」，不算失败但也起不了环境，只能找平台确认。
- **平台可能只返回内网地址**：连接信息优先公网地址；只有内网时原样返回并给出提示。
- **并发上限**：`concurrency` 上限 8，同时受 DSH `agentTeams.maxMembers`（默认 16）约束。
- **客户端半依赖 DSH 的 `dsh.client` 机制**：升级 DSH 后如顶部「CTF」视图 tab / 配置卡片 / 浮动面板失效，
  先重启；仍不正常时打开 `GET /lingxu-ctf/diag` 看路由是否注册、bundle 版本与浏览器打点
  （`stage` 里能看到 `view-slot-registered` / `view-slot-preset-absent` 之类的降级原因）。
- **顶部 CTF tab 只在 CTF 预设会话里出现**（拿不到会话服务或快照无 preset 信息时降级为始终出现）——
  换个普通会话看不到 tab 属于设计行为。
