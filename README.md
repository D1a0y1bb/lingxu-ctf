# dsh-lingxu-ctf

> 把**凌虚竞赛平台**（Lingxu event CTF）接进 DeepSeek Harness：**配置一次，之后在会话里说一句「开始」**，
> 就能自动摸清赛题与排名、拉起并发解题 agent 团队、自动提交 flag、自动生成 writeup。

| 项目 | 说明 |
|---|---|
| 适用版本 | DSH Desktop `0.2.0-rc.1`（Cordis `4.0.4`），目标 profile `desktop` |
| 平台支持 | **只支持凌虚赛事平台**（`sessionid` Cookie 认证） |
| 依赖 | 零第三方依赖：只用 Node 内置能力 + DSH 官方 `@deepseek-ai/schemastery`（配置表单 schema），无构建步骤 |
| 安装 | 用 `plugin_manager` 装 bundle：本地目录 `file:<你的插件目录>` / tarball / npm 包名 |
| 提供 | **16 个基础 `ctf_*` 工具** + **按赛段动态加载**的 AWD（9 个）/ CFS（7 个）工具 · 「CTF 解题模式」agent 预设 · Web 界面（顶部「CTF」视图 tab + 设置页配置卡片；右下角浮动面板可选，默认关闭） |

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [怎么用（5 步跑起来）](#怎么用5-步跑起来)
- [工具清单（16 个基础工具与赛段工具）](#工具清单16-个基础工具与赛段工具)
- [AWD 与 CFS 赛段](#awd-与-cfs-赛段)
- [「CTF 解题模式」预设](#ctf-解题模式预设)
- [配置项（13 项）](#配置项13-项)
- [Web 界面](#web-界面)
- [多场赛事](#多场赛事)
- [注意事项](#注意事项)
- [开发](#开发)
- [已知限制](#已知限制)

---

## 功能一览

| 能力 | 说明 |
|---|---|
| 赛事总览 | 赛事名 / 起止时间 / 剩余时间 / 我的分数与排名 / 已解 / 待解 / 赛段构成（理论题 / CTF / AWD / CFS）/ 理论题状态 / 未读公告数 |
| 赛题枚举 | 按分类 / 状态 / 分值过滤；单题题面（HTML→Markdown）+ 附件自动下载到工作区；题型分三类（环境型 / 外链型 / 附件型） |
| 环境题 | 自动走平台 `begin → run → addr` 三步，返回可直连的 `nc host port`；**环境有存活时间**（到期自动回收），剩余 <10 分钟会告警、可 `ctf_delay_env` 延时；用完可释放 |
| 环境配额 | 平台限制同时运行的环境数（本赛事实测 2 个）；编排**只对环境型题目限量**，非环境题不限量，并在状态里显示排队与被占用的环境 |
| 自动交 flag | 同题同 flag 本地去重 + 提交审计日志（**flag 明文展示**便于核对）+ 每题错误次数统计（可设上限）；check 模式自动改走 `/check/` |
| 并发解题 | 拉起 agent 团队（默认 4 个，1–8），建共享任务板自动去重，每个 agent 独立解一道题 |
| 排行榜 | 个人 / 战队 / AWD / CFS |
| AWD 赛段 | 含 AWD 时自动加载 9 个 `ctf_awd_*` 工具：赛段状态 / 靶机列表与详情 / 提交 flag / 取自己 flag / 排行榜 / 回合动态 / KVM 重置 / 呼叫裁判 |
| CFS 赛段 | 含 CFS 时自动加载 7 个 `ctf_cfs_*` 工具：赛段状态 / 关卡列表与详情 / 逐关提交 / 排行榜 / 得分总势 / 提交流水 |
| 理论题 | 列试卷 → 开始考试 → 拉题 → 逐题作答（`option` 支持 string 或 array）→ 交卷（交卷**不可逆**） |
| 公告 | `ctf_notice`：未读数 + 公告列表（最新在前） |
| writeup | 自动生成 Markdown WP（题面 + 元信息 + 解题思路 + 关键步骤 + flag + 复现脚本），可提交回平台 |
| Web 界面 | 顶部「CTF」视图 tab（题目看板 / Agent 活动 / 协同通信 / 提交审计 / 报告 / **环境**，5 秒轮询）+ 设置页配置卡片；右下角浮动面板可选、**默认关闭** |
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

应能看到 **16 个基础 `ctf_*` 工具**（还没连平台时就是这 16 个）；设置页里也会多出
`dsh-lingxu-ctf` 的配置卡片（见 [怎么用](#怎么用5-步跑起来) 第 2 步）。

> 连上平台后，如果这场赛事含 AWD / CFS 赛段，工具列表会**再长出** 9 个 `ctf_awd_*` / 7 个 `ctf_cfs_*`
> —— 见 [AWD 与 CFS 赛段](#awd-与-cfs-赛段)。纯 CTF 赛事就只有 16 个，不会白占上下文。

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

其余字段（错误提交上限 / **环境数上限** / **环境自动延时** / flag 去重 / 工作目录 / 请求超时 / Web 面板与浮动面板开关）
都有合理默认值，先不用管，需要时看[配置项](#配置项13-项)。

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
| `这题环境先放掉` | `ctf_release_env` 释放靶机 —— 环境配额通常只有 2 个，不放别人起不来 |
| `环境快到期了，延时` | `ctf_delay_env`：每次 +30 分钟（平台只允许剩余 <30 分钟时延时） |
| `看看公告` | `ctf_notice`：未读数 + 公告列表 |
| `AWD 现在什么情况` | `ctf_awd_status` → `ctf_awd_list`（只有含 AWD 赛段时才有这些工具） |
| `这题题面给我看看` | `ctf_challenge` 拉题面（Markdown）+ 下载附件 + 给出连接信息 |

### 它自己会做什么

选好预设说「开始」之后，每个解题 agent 会自动跑完这一串，**你不用盯着**：

1. `ctf_challenge` —— 拉题面（HTML 已转 Markdown）、下载附件到工作区，识别题型（环境型 / 外链型 / 附件型）；
2. 环境型自动 `ctf_start_env`（平台需要 `begin → run → addr` 三步），拿到 `nc host port` 与**环境剩余时间**；
   起环境后剩余不足 30 分钟会自动延时一次（`envAutoDelay`，默认开），剩余不足 10 分钟会提醒；
3. 在工作区里动手解题（写脚本、跑 exp、必要时联网查资料），保留复现脚本；
4. 拿到 flag 立刻 `ctf_submit_flag` 提交（本地去重 + 审计；错误次数超限会拒提交，防扣分）；
5. `ctf_writeup` 生成 Markdown WP 落到 `lingxu-ctf-work/writeups/`；
6. 解完释放环境、把共享任务标记完成，并向 lead 汇报。

你随时可以用 `看下进度` 查看团队状态（含环境占用 `N/M` 与排队情况），用 `停` 收工。

---

## 工具清单（16 个基础工具与赛段工具）

这些工具由插件注册，agent 会自动调用；你也可以在会话里直接点名要求。

**基础工具（16 个，永远可用）**：

| 工具名 | 作用 | 参数 |
|---|---|---|
| `ctf_connect` | 保存平台连接（多赛事切换时用；设置页填过可省） | `baseUrl`、`eventId`、`cookie`、`label` |
| `ctf_session` | **探活**：检查 sessionid 是否还有效（开赛前 / 提交报 403 后先跑这个） | `connection` |
| `ctf_status` | 赛事总览：名称 / 时间 / 赛段构成 / 我的分数排名 / 已解 / 待解 / 理论题状态 / 未读公告数 | `connection` |
| `ctf_challenges` | 题目列表，按分类 / 状态 / 分值过滤 | `category`、`solved`、`minScore`、`limit`、`connection` |
| `ctf_challenge` | 单题详情：题面 Markdown + 题型 + 附件下载 + 连接信息 | `id`、`download`、`connection` |
| `ctf_start_env` | 环境型题目开题并起环境（`begin→run→addr`），返回连接信息与剩余时间 | `id`、`connection` |
| `ctf_delay_env` | 环境延时：每次 +30 分钟（平台只允许剩余 <30 分钟时延时） | `id`、`connection` |
| `ctf_release_env` | 释放环境（幂等，重复释放也算成功）；**让位给排队的环境题** | `id`、`connection` |
| `ctf_submit_flag` | 提交 flag：本地去重 + 审计 + 错误次数护栏；check 模式自动走 `/check/` | `id`、`flag`、`connection` |
| `ctf_leaderboard` | 排行榜：个人 / 战队 / AWD / CFS | `kind`、`size`、`connection` |
| `ctf_theory` | 理论题一站式：list / begin / questions / answer / time / finish | `action`、`testId`、`questionId`、`option`（string 或 array）、`limit`、`connection` |
| `ctf_notice` | 赛事公告：未读条数 + 列表（最新在前） | `unreadOnly`、`limit`、`connection` |
| `ctf_solve_start` | 拉起并发解题 agent 团队并建共享任务板（环境感知派发） | `category`、`minScore`、`limit`、`onlyUnsolved`、`concurrency`、`connection` |
| `ctf_solve_status` | 团队进度：任务板 + 平台状态对照 + 环境占用 / 排队 | `connection` |
| `ctf_solve_stop` | 中断所有解题 agent，并（默认）释放它们拉起的环境 | `reason`、`releaseEnvs`、`connection` |
| `ctf_writeup` | 生成 / 提交 WP（`id` 省略 = 按已解题目批量生成；`submit` 默认 false） | `id`、`body`、`submit`、`title`、`connection` |

**赛段工具（按赛事类型动态加载，不需要手动开关）**：

| 赛段 | 数量 | 工具 |
|---|---|---|
| AWD（`test_type` 含 3） | 9 | `ctf_awd_status`、`ctf_awd_list`、`ctf_awd_detail`、`ctf_awd_submit`、`ctf_awd_own_flag`、`ctf_awd_rank`、`ctf_awd_dynamic`、`ctf_awd_reset`、`ctf_awd_referee` |
| CFS（`test_type` 含 4） | 7 | `ctf_cfs_status`、`ctf_cfs_list`、`ctf_cfs_detail`、`ctf_cfs_submit`、`ctf_cfs_rank`、`ctf_cfs_chart`、`ctf_cfs_dynamic` |

赛段工具的完整说明见 [AWD 与 CFS 赛段](#awd-与-cfs-赛段)。

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

## AWD 与 CFS 赛段

凌虚的赛事可以是多种赛段的组合（`Competition.test_type`：**1 理论题 / 2 CTF / 3 AWD / 4 CFS**）。
因为 AWD（回合制攻防、KVM 重置、裁判）与 CFS（关卡制、逐关提交）各有一整套操作，
插件**按赛事类型动态注册工具**：

| 赛事类型 | 工具列表 |
|---|---|
| 纯 CTF（只有 `test_type=2`） | **16 个基础工具**，没有 AWD/CFS 工具（零上下文浪费） |
| 含 AWD（`test_type` 含 3） | 16 基础 + **9 个 `ctf_awd_*`** |
| 含 CFS（`test_type` 含 4） | 16 基础 + **7 个 `ctf_cfs_*`** |

**怎么触发加载**（都是自动的，用户不用管）：

1. 插件启动时用当前活动连接探一次；
2. `ctf_connect` 连接成功后；
3. `ctf_status` / `ctf_session` 跑完时（它们本来就要读赛事信息，顺手同步，**零额外请求**）。

> **为什么我的工具列表里没有 AWD 工具？** 因为这场赛事没有 AWD 赛段（或还没连平台 / 还没跑过
> `ctf_status` → 插件还不知道赛段构成）。切到含 AWD 的赛事并跑一次 `ctf_status`，工具就会出现；
> 切走也会自动注销。判定依据是 `Competition.test_type` 的键，不是 `/event/<id>/type/` 接口。

**三个实测出来的坑**（插件已经内置处理，这里写出来是为了排查时不被误导）：

- **`/event/{id}/type/` 返回的 `"3"` 是 CFS，不是 AWD**。平台源码这个视图只在 `test_type` 含键
  `"1"`/`"2"`/`"4"` 时分别追加 `"1"`/`"2"`/**`"3"`** —— 也就是说它把 **CFS（key 4）** 标成了 `"3"`，
  而 **AWD（key 3）根本不会出现在这个接口里**。别拿它判断有没有 AWD。
- **`awdRank()` 在没有 AWD 赛段时平台会真的 HTTP 500**（源码没做赛段校验）。所以「有没有 AWD」
  只能看 `test_type`，不能靠调这个接口探测；`ctf_awd_rank` 会把 500 渲染成友好提示而不是抛错。
- **`cfsChallenges()` 在没有 CFS 赛段时不报错、返回空列表**（`cfs/rank/` 也会照常返回全体参赛者、
  分数全 0），所以「有没有 CFS」只能看 `hasCfs`。

**AWD 工具速览**（完整参数与副作用见工具描述）：

| 工具 | 作用 |
|---|---|
| `ctf_awd_status` | 赛段状态 / 当前回合 / 加固期 / 剩余时间 / 我的排名 / 提交 token（脱敏） |
| `ctf_awd_list` | 靶机列表（`catId` / `caId` / 分类 / 本轮分 / 总分 / 是否宕机 / 是否被攻击），可按 `classify` 过滤 |
| `ctf_awd_detail` | 单台靶机详情：IP / 镜像账号 / 攻击 IP / 重置次数 / 题面 / `envRunId`（**`catId` + `caId` 都必填，顺序是 catId → caId**） |
| `ctf_awd_submit` | 提交打到的 flag（攻击视角；`token` 与 `flag` 走 **query 参数**，省略 `token` 会自动取） |
| `ctf_awd_own_flag` | 取自己靶机的 flag（防守视角）。⚠️ 平台按**请求来源 IP** 匹配，通常要在靶机本机调用 |
| `ctf_awd_rank` | AWD 排行榜（`limit` 默认 30、上限 200） |
| `ctf_awd_dynamic` | 回合动态：谁打了谁、得分、第几回合（`limit` 默认 30、上限 200） |
| `ctf_awd_reset` | 重置 KVM 靶机：`envRunId` 必填（来自 `ctf_awd_detail`）；`type=1` 免费次数（默认）/ `2` **扣分** |
| `ctf_awd_referee` | 呼叫裁判：`content` 必填。⚠️ **真的会给管理员写消息**，非必要别用、别刷屏 |

**CFS 工具速览**：

| 工具 | 作用 |
|---|---|
| `ctf_cfs_status` | 赛段状态 / 剩余时间（CFS 没有「回合」概念） |
| `ctf_cfs_list` | 关卡题目列表（`cctId` / 题名 / 分值 / 通关进度） |
| `ctf_cfs_detail` | 单题详情：分值 / 进度 / 关卡地址列表 / 附件 / 题面（`cctId` 必填） |
| `ctf_cfs_submit` | 提交某一关的 flag（`cctId` + `flag` 都必填；一题多关卡） |
| `ctf_cfs_rank` | 排行榜（`limit` 默认 30、上限 200）。⚠️ 没有 CFS 赛段时它也返回全体参赛者，**不能**当赛段判据 |
| `ctf_cfs_chart` | 得分总势（各名次分数曲线的最新值 + 时间范围） |
| `ctf_cfs_dynamic` | 提交流水：谁在什么时候提交了哪道题的哪一关（`limit` 默认 30、上限 200） |

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

> 预设里写死的工作流与解题纪律以 **CTF 解题流程**为主（摸题 → 开环境 → 解题 → 交 flag → 写 WP → 释放环境）。
> AWD / CFS 赛段工具与环境的存活时间、延时规则等细节，**以各工具的自身描述为准** —— 它们会随赛事类型出现，
> agent 读到工具后按描述执行。

---

## 配置项（13 项）

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
| `envLimit` | `2` | **同时可运行的环境数上限**（平台 `env_limit`，实测本赛事为 2）；编排只按它限制**环境型**题目，非环境题不受影响。填 `0` = 让插件从平台报错里自动学习真实值 |
| `envAutoDelay` | `true` | **环境到期自动延时**：起环境后若剩余已不足 30 分钟，自动调一次延时接口（每次 +30 分钟）。平台只允许剩余 <30 分钟时延时 |
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

会话顶部的视图条会多一个 **CTF** tab（`对话 | 轨迹 | CTF`），点进去是 6 个子视图：

| 子视图 | 看什么 |
|---|---|
| **题目看板** | 按分类分组；每张卡片显示分值、状态（待解 / 进行中 / 已解）、**题型徽章**（环境型 / 外链型 / 附件型）、**环境剩余时间**（<10 分钟橙色告警、过期红色）、负责人、提交次数、任务完成数，支持分类 / 状态 / 搜索筛选。**平台侧还显示未解、但共享任务已 `in_progress` 的题会升级成「进行中 · solver-xxx」**；只存在于任务板、平台列表里还没同步的题会标「仅任务」 |
| **Agent 活动** | 每个 teammate 的状态点（运行中 / 空闲 / 启动中 / 失败）、当前题目、已完成题数、最后活动时间，可展开看它负责的全部题目；**持有环境的 agent 会带一个 🌐 环境标记**（含剩余时间，过期变红） |
| **协同通信** | 团队的 spawn / 汇报 / 状态 / 停止消息时间线（`[时间] from → to 内容`，按 kind 着色） |
| **提交审计** | 最近 30 条 flag 提交（时间 / 题目 / 状态 / 脱敏 flag） |
| **报告** | 本地 `lingxu-ctf-work/writeups/` 的 WP 列表：题名 / 分类 / 路径 / 大小 / 修改时间 / 是否已提交平台，点开可展开正文（正文由 `/reports` 下发；当前该路由只回列表元信息，所以展开处显示「（无正文）」） |
| **环境** | 环境型题目专场：顶部一行 **`环境 1/2`** 配额（满了高亮「配额已满 · 新环境起不来，先释放一个」），下面按紧急度排序（**已过期 → 快到期 → 正常 → 尚未起环境**），每条显示题名 / 题型 / 状态 / 剩余时间 / 负责的 agent |

视图顶部的摘要条也会显示 `环境 N/M` 与 Agents / 任务计数（`环境 N/M · 已满` 表示新的环境题会被排队）。

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
题目看板（含题型徽章与环境剩余时间）、个人榜前 20、提交审计（最近 20 条）、理论题状态。

### 样式与主题

界面样式**只用 DSH 的真实主题 token**（`--dsw-alias-*`），跟随 DSH 的明暗主题自动切换：

- 暗色判定跟随 `body[data-ds-dark-theme]`（**不是** `prefers-color-scheme`），所以「系统浅色 + DSH 暗色」
  这种组合也能正确显示；
- 没有硬编码兜底色（之前的版本把品牌色猜成蓝色，实际 DSH 是近黑 / 黑白）；
- 状态色用 token 的三级色（浅底深字 / 暗色下自动变深底），三处出口（视图 / 配置卡片 / 浮动面板）共用一套样式。

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
- **环境题记得释放**。`ctf_start_env` 会占用平台环境配额（默认只有 2 个）；解完或放弃时说一句
  「这题环境放掉」（`ctf_release_env`，重复释放是幂等的）。`ctf_solve_stop` 默认也会释放，
  解出 flag 后插件还会主动提醒你释放让位。
- **只访问你配置的平台地址**。所有出站请求只指向 `baseUrl`，不做任何第三方外发；
  附件也只会从平台返回的地址下载。
- **Cookie 安全**：secret 字段只写不读、日志脱敏（只留前 6 位）、状态文件在本机
  `~/.dsh/storages/lingxu-ctf/`；不要把带 Cookie 的截图或状态文件分享出去。
- **不要在未确认 flag 的情况下反复提交**——平台对错误提交不扣分，但乱试会浪费时间。
  注意：赛事信息里的 `punish` 是「**是否公示作弊处罚**」（管理员下发的处罚记录），
  与错误提交 flag 无关，不要理解成扣分开关。

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

> 环境相关的错误插件**逐条对应平台源码分类**（共 10 类），不再是一句裸 `400`：
> 未绑定 CTF 原题 / 未配置环境 / 比赛未开启 / 比赛已结束 / 未加入战队 / 未配置 CTF 赛段 /
> 环境数超限（带具体上限数字）/ 环境忙碌（正在启动·释放·延时）/ 环境不存在或已过期 / 容器启动·释放失败。
> 每类都给出可操作的中文说明，`ctf_status` 与 `ctf_solve_status` 也会把环境占用与排队显示出来。

### 环境有存活时间（TTL），到期会被平台回收

环境**不是起了就一直有**：平台给每次启动一个存活时长（源码 `Competition.env_start_min`，模型默认 60 分钟，
**实测本赛事只有约 30 分钟**），到期自动释放容器。

- `ctf_start_env` 会返回**环境剩余时间**（以平台下发为准，不猜、不写死）；
- 剩余 **<10 分钟**会主动提醒：`⚠️ 环境将在 …后释放，长题请用 ctf_delay_env id=<id> 延时`；
- `ctf_delay_env` 每次 **+30 分钟**，但平台**只允许剩余 <30 分钟时延时**（早了会返回
  「剩余半小时后才能延时」，插件识别为 `too-early` 并告知你何时再来）；
- `envAutoDelay`（默认 `true`）：起环境后如果剩余已经不足 30 分钟（本赛事的环境总时长就是 ~30 分钟），
  插件会**自动延时一次**，避免解题中途环境被回收；不想要就把它关掉；
- Web 界面的「题目看板 / 环境」子视图会实时显示每个环境的剩余时间（<10 分钟橙色、过期红色）。

> 环境配额（同时能跑几个）与存活时间是**两件事**：配额由 `envLimit` / 平台 `env_limit` 决定（默认 2），
> 配额满了新的环境题会被**排队**（`ctf_solve_status` 会列出来），此时先 `ctf_release_env` 释放一个再
> `ctf_solve_start` 补派。

### check 模式（`answer_mode=2`）：触发 ≠ 判定

平台有两类题目答题模式：**FLAG 模式**（`answer_mode=1`，提交 flag 比对）和 **check 模式**
（`answer_mode=2`，走 `POST /event/<eid>/ctf/<id>/check/`）。插件**自动识别并路由**：对 check 模式的题调
`ctf_submit_flag` 不会去打 `/flag/`（那样平台只会拒绝），而是改走 `/check/`。

⚠️ 但**平台源码里的 `/check/` 是「简化版」**：它不读请求体、不比对 flag、**不返回判定结果**，
只写一条检测日志后返回 `check已触发`。所以：

- 「已触发」**不等于**已得分 —— 请到平台页面确认该题是否变绿，或用 `ctf_challenges solved=true` 复查；
- 不要反复触发（每次都写日志）；
- 插件会把这类提交记为审计状态 `check`，**不计入错误提交次数、也不影响 flag 去重**。

### 已解出的题目再提交 flag：平台返回 HTTP 400

对已解题目重复提交，平台是 **HTTP 400 + `{"error":"您已提交了正确的Flag。"}`**（不是 200），
插件把它分类成 `already_solved` 并正常渲染为「此前已提交过正确 flag」，**不当失败、不抛错**。
队伍版文案（`您所在的战队已提交了正确的Flag。`）同样识别。

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
lib/lingxu.js      平台客户端（纯 fetch，零依赖），含环境生命周期 / 题型 / AWD / CFS
lib/platforms.js   平台适配器注册表（只注册 lingxu）
lib/store.js       连接配置 + 提交审计 + 解题进度持久化
lib/toolkit.js     零依赖的 defineTool 兼容实现（参数 DSL → JSON Schema + 校验）
lib/tools.js       16 个基础模型可见工具
lib/stage-tools.js 赛段工具（AWD 9 个 / CFS 7 个），按赛事类型动态注册
lib/orchestrate.js Agent Teams 并发编排（环境感知派发）
lib/writeup.js     WP 生成与提交
lib/client.js      Web 界面（浏览器半：顶部「CTF」视图 tab + 配置卡片 + 浮动面板）
lib/index.js       装配（配置归一化 + 依赖注入 + 路由 + 赛段工具注册器）
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
- **`answer_mode == 2`（check 模式）插件会自动改走 `/check/`，但平台该端点不判分**：只触发检测、
  不返回结果，「已触发」不等于已得分，需要人工到平台页面确认。
- **环境有存活时间且到期自动回收**：时长由平台 `env_start_min` 决定（模型默认 60 分钟，实测本赛事约 30 分钟），
  插件以平台返回的剩余时间为准；只能 `ctf_delay_env` 每次 +30 分钟（且只在剩余 <30 分钟时允许），
  不能无限续。同时运行的环境数也有上限（默认 2），环境型题目会被排队。
- **AWD / CFS 的接口有点「野」**（都是平台源码行为，插件已做降级）：
  没有 AWD 赛段时 `awd/rank/` 会 **HTTP 500**；没有 CFS 赛段时 `cfs/` 接口不报错但返回空、
  `cfs/rank/` 还会照常返回全体参赛者（分数全 0）；`/event/<id>/type/` 返回的 `"3"` 是 **CFS 不是 AWD**。
  所以「有没有某个赛段」一律以 `Competition.test_type`（`ctf_status` 的「本赛事含」行）为准。
- **`task_type=1` 但平台没配环境的题**：`ctf_start_env` / `ctf_release_env` 会被识别成
  「平台未为该题配置环境」，不算失败但也起不了环境，只能找平台确认。
- **`ctf_awd_own_flag` 通常只在靶机本机有值**：平台按**请求来源 IP** 匹配靶机，在 agent 自己机器上调
  多半只拿到空字符串 —— 需要时到靶机上 curl 平台的 `/awd/get_flag/`。
- **平台可能只返回内网地址**：连接信息优先公网地址；只有内网时原样返回并给出提示。
- **并发上限**：`concurrency` 上限 8，同时受 DSH `agentTeams.maxMembers`（默认 16）约束。
- **客户端半依赖 DSH 的 `dsh.client` 机制**：升级 DSH 后如顶部「CTF」视图 tab / 配置卡片 / 浮动面板失效，
  先重启；仍不正常时打开 `GET /lingxu-ctf/diag` 看路由是否注册、bundle 版本与浏览器打点
  （`stage` 里能看到 `view-slot-registered` / `view-slot-preset-absent` 之类的降级原因）。
- **顶部 CTF tab 只在 CTF 预设会话里出现**（拿不到会话服务或快照无 preset 信息时降级为始终出现）——
  换个普通会话看不到 tab 属于设计行为。
