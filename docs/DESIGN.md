# dsh-lingxu-ctf — 设计文档

DSH 插件：把凌虚竞赛平台（Lingxu event CTF）接入 DSH，实现「给一个平台地址 + sessionid，
自动枚举赛题 / 排行榜 / 理论题，拉起并发解题 agent 团队，自动交 flag，自动写 WP」。

- 宿主版本基线：DSH Desktop `0.2.0-rc.1`（`@deepseek-ai/dsh-*` 全部 `0.2.0-rc.1`，Cordis `4.0.4`）
- 目标 profile：`desktop`
- 参考实现：`~/Desktop/HuntingBlade`（凌虚 API 逆向来源）、`howmp/dsh-pentest`（bundle 打包范式）

---

## 1. 用户已确认的决策

| 决策点 | 选择 |
|---|---|
| 认证 | **只用 `sessionid` Cookie**（平台登录带验证码 `/api/captcha/verify/`，不做自动登录） |
| 理论题 | **全自动答题 + 自动交卷** |
| 交付范围 | 核心工具集 + **CTF 解题模式预设** + **WP 自动生成/提交** + **Web 控制面板** + **多赛事管理** |
| Flag 提交 | **全自动**（agent 判定为 flag 即提交） |
| 并发 | 默认 **4** 个解题 agent，可配置 |
| 解题环境 | 本机 workspace，按需安装工具链（**不用 Docker**） |

> 非阻塞护栏（不违反"全自动"选择）：flag 去重、提交审计日志、每题错误次数统计并在面板展示。
> `punish: true` 时错误提交会扣分，护栏只记录不阻断，可用配置 `maxWrongAttempts` 主动收紧。

---

## 2. 凌虚平台 API（已实测打通，event 4）

Base = 平台根地址，例如 `https://shuxinbei.clsadp.com:8000`（**不要**填前端 hash 路由）。
认证：`Cookie: sessionid=...`；写操作若 Cookie 里有 `csrftoken` 则附带 `X-CSRFToken` 头。

| 用途 | 方法 + 路径 | 关键返回 |
|---|---|---|
| 赛事详情 | `GET /event/{eid}/` | `name/start_time/end_time/status/label` |
| 赛事状态 | `GET /event/{eid}/info/` | `user{token,username,number}`、`test_type{1:理论题,2:实操题}`、`punish`、`end_seconds` |
| 题目列表 | `GET /event/{eid}/ctf/` | 分页 `{count,next,results[]}`；`results[]` = `{id,name,classify,score,ctf_id,is_parse,parse_count,is_begin,msg}` |
| 题目详情 | `GET /event/{eid}/ctf/{cid}/info/` | `{name,desc(HTML),attachment,task_type,answer_mode,score,parse_count,link_path}` |
| 开题 | `POST /event/{eid}/ctf/{cid}/begin/` | `{status}`，`1/2` 视为成功 |
| 起环境 | `POST /event/{eid}/ctf/{cid}/run/` | `{status}`，`error` 或 `status==3` 为失败 |
| 取地址 | `GET /event/{eid}/ctf/{cid}/addr/` | `{domain_addr, ext_id}`；优先公网 `domain_addr` |
| 释放环境 | `POST /event/{eid}/ctf/{cid}/release/` | `status==2` 成功；`3` + "该环境正在释放"/"没有运行的环境" 视为幂等成功 |
| 交 flag | `POST /event/{eid}/ctf/{cid}/flag/`，body `flag=<flag>` | `status==1` 正确 / `==2` 错误；文本含"已提交了正确的Flag"= 重复正确 |
| 理论题列表 | `GET /event/{eid}/test/` | `[{id,name,type[],score,count,time_seconds,is_begin,is_end,answer_rule}]` |
| 开始理论题 | `POST /event/{eid}/test/{tid}/begin/` | `status==1` 成功 |
| 题目列表 | `GET /event/{eid}/test/{tid}/list/` | 分页题目（含选项） |
| 题序 | `GET /event/{eid}/test/{tid}/order/` | 题目顺序 |
| 剩余时间 | `GET /event/{eid}/test/{tid}/time/` | `{name,seconds}` |
| 答题 | `POST /event/{eid}/test/{tid}/answer/{qid}/`，body `option=<x>` | 逐题提交 |
| 交卷 | `POST /event/{eid}/test/{tid}/finish/`，body `status=1` | 不可逆 |
| 排行榜（个人） | `GET /event/{eid}/user/rank/?size=&type=` | `{count,results[{id,username,score,test_score,ctf_score,awd_score,parse_count,is_self}]}` |
| 排行榜（战队） | `GET /event/{eid}/team/rank/` | 同上结构 |
| 排行榜（AWD/CFS） | `GET /event/{eid}/awd/rank/`、`/cfs/rank/` | 同上结构 |
| WP 列表/提交 | `GET /event/{eid}/write_up/` / `POST /event/{eid}/write_up/` | 分页；POST 提交 writeup |
| 通知 | `GET /event/{eid}/notice/` | 分页 |
| 提交日志 | `GET /event/{eid}/log/?type=1&test_type=2` | 分页 `{test_name,username,sub_time,type,test_type}` |
| 个人中心 | `GET /event/{eid}/personal/`、`/platform/personal/` | — |
| 环境变量题判断 | `detail.task_type == 1` | 需要 `begin→run→addr` 流程 |

**注意事项**
- 题目列表分页：`next` 为相对路径，需要拼 base。
- `answer_mode == 2` 是 check 模式，HuntingBlade 标记为不支持；本插件保留该标记但照常展示。
- `desc` 是 HTML，需转 Markdown 后给 agent。
- `attachment` 是相对路径，需 `urljoin(base, attachment)` 下载。
- 连接信息格式：`domain_addr` 可能是 `host:port`，统一规范化为 `nc host port`；若是 URL 则原样保留。
- 平台可能只返回内网地址（`192.168.x.x`），此时优先公网；只有内网时原样返回并提示。

---

## 3. 插件形态

一个 bundle，四条 Loader 行（由 `cordis.patch.yml` 以 `insert` 注入）：

```yaml
- insert:
    - id: lingxu-ctf            # 宿主插件：工具 + 编排 + 存储
      name: 'dsh-lingxu-ctf'
      config: { ... }
    - id: lingxu-ctf-client     # Web 控制面板（客户端半）
      name: 'dsh-lingxu-ctf/client'
    - id: preset-ctf            # 「CTF 解题模式」预设
      name: '@deepseek-ai/dsh-agent-preset'
      config: { id: ctf, order: 5, name: 'CTF 解题模式', plugins: [...] }
```

> 0.2.0-rc.1 的预设**不再扫描 YAML 目录**，改为 `@deepseek-ai/dsh-agent-preset` 行声明
> （见 `dsh-agent-preset-registry` README）。dsh-pentest 的 `preset/pentest/` 目录方案是 0.1.x 的旧做法，
> 本插件不用。

---

## 4. 模块划分与写入范围

| 文件 | 职责 | 负责人 |
|---|---|---|
| `package.json` / `cordis.patch.yml` | bundle 声明、Loader 行、预设 | Lead |
| `lib/lingxu.js` | 凌虚平台客户端（纯 `fetch`，零依赖） | Lead |
| `lib/platforms.js` | 平台适配器注册表（lingxu / ctfd） | Lead |
| `lib/store.js` | 赛事状态持久化 + 审计日志 | Lead |
| `lib/tools.js` | 全部 `defineTool` 工具定义 | Teammate A |
| `lib/orchestrate.js` | Agent Teams 并发编排 | Teammate B |
| `lib/client.js` | Web 控制面板（客户端半） | Teammate C |
| `lib/writeup.js` | WP 生成与提交 | Teammate D |
| `lib/preset.js` | 预设 persona 文案常量 | Teammate D |
| `lib/index.js` | 宿主插件入口，装配上述模块 | Lead |
| `tests/*.test.mjs` | 单元测试（mock ctx + mock fetch） | 各自 |

**依赖方向**：`tools/orchestrate/writeup` → `lingxu/platforms/store`。反向依赖禁止。
`index.js` 只做装配，不含业务逻辑。

---

## 5. 工具清单（模型可见）

| 工具名 | 作用 |
|---|---|
| `ctf_connect` | 配置平台地址 + sessionid，校验连通性并持久化 |
| `ctf_status` | 赛事总览：名称/时间/我的分数排名/已解/待解/理论题状态 |
| `ctf_challenges` | 题目列表，支持按分类/状态/分值过滤 |
| `ctf_challenge` | 单题详情（题面 Markdown + 附件下载 + 连接信息） |
| `ctf_start_env` | 环境题 `begin→run→addr`，返回连接信息 |
| `ctf_release_env` | 释放环境 |
| `ctf_submit_flag` | 提交 flag（去重 + 审计 + 错误计数） |
| `ctf_leaderboard` | 个人/战队/AWD/CFS 排行榜 |
| `ctf_theory` | 理论题：列出试卷 / 开始 / 拉题 / 作答 / 交卷 |
| `ctf_solve_start` | 拉起并发解题 agent 团队（默认 4），建共享任务板 |
| `ctf_solve_status` | 团队进度：任务板 + 平台状态对照 |
| `ctf_solve_stop` | 中断所有解题 agent、释放环境 |
| `ctf_writeup` | 生成 / 提交 WP |

---

## 6. 编排设计（`ctf_solve_start`）

1. 同步平台题目列表 → 过滤未解题（可按分类/最低分值/数量上限过滤）
2. 每题 `ctx.agentTeams.createTask({ subject, description, writeScopes })` 建共享任务
3. 按 `concurrency`（默认 4）分批 `ctx.agentTeams.spawnTeammate(lead, {...})`，命名 `solver-<slug>`
4. teammate prompt 自带：平台地址、凭据引用、题目 id、任务 id、工作流（`ctf_challenge` → `ctf_start_env`
   → 解题 → `ctf_submit_flag` → `ctf_writeup` → 完成任务）
5. teammate 之间可用 `send_message` 互相交流；共享任务板天然去重（claim 语义）
6. 返回编排摘要；后续用 `ctf_solve_status` 查询进度

**并发上限**：`ctx.agentTeams` 的 `maxMembers` 默认 16，`ctx.subagents` 的 `maxActiveSubagents` 默认 8。
本插件 `concurrency` 默认 4、上限 8。

---

## 7. 安全与凭据

- Cookie 只写入 DSH 自己的存储（`storageDomain` / `~/.dsh`），不写入插件目录、不进 git。
- 平台 URL 与 Cookie 通过 `ctf_connect` 传入，落到 `store`，日志中脱敏（只留前 8 位）。
- 所有出站请求只指向用户配置的平台 base，不做任何第三方外发。

---

## 8. 验收标准

1. `node --test tests/*.test.mjs` 全绿
2. 用真实 event 4 + 真实 cookie 跑通：`ctf_status` / `ctf_challenges` / `ctf_leaderboard` 返回正确数据
3. 插件装入 `desktop` profile 后重启，工具在会话中可见，预设「CTF 解题模式」出现在模式选择
4. `ctf_solve_start` 能真实拉起 N 个 teammate 并建出任务板
5. Web 面板能显示题目看板 / 进度 / 排行榜

---

## 9. 实现状态（截至交付）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 单元测试 | ✅ | `node --test tests/*.test.mjs` → **201 用例全绿**（含跨模块集成用例） |
| 真实平台冒烟 | ✅ | `tests/smoke-live.mjs` 对 event 4 全通过（78 题 / 15 分类 / 排行榜 / 理论题） |
| 端到端联调 | ✅ | `tests/e2e-live.mjs` 22/22：真实插件装配 + 真实平台，含 flag 去重护栏与面板快照 |
| 真实 Cordis 装配 | ✅ | 用解包出的同一份 Cordis 跑 `ctx.plugin()`：注册 13 工具，可选 service 全缺失仍装配成功 |
| 装入 profile | ✅ | `dsh-lingxu-ctf` 已在 `desktop` profile 的 `dsh.profile.bundles` + `node_modules`（link:） |
| 重启后生效 | ⏳ | Node ESM 缓存按 URL 永久生效，**必须重启 DSH** 才会 import 新代码 |
| 浏览器视觉验收 | ⏳ | 需人工刷新确认（面板逻辑已有 33 条测试覆盖） |
| 真实拉起 teammate | ⏳ | 需重启后在会话里实际调用 `ctf_solve_start` 验证 |

### 交付过程中修掉的真实缺陷（均由跨模块复核发现，非单测能覆盖）

1. **Cordis Proxy 守卫**：`ctx.agent` 抛 `cannot get property "agent" without inject` ⇒ 插件整体
   `fiberPhase: failed`。改为统一的 `service(ctx, name)` 兜底访问器，并加严格 Proxy 回归测试。
2. **`ctf_solve_*` 未透传 `exec.agent`** ⇒ 三个编排工具在生产环境全不可用（单测因 mock 掉了
   orchestrator 而全绿）。补 `__agent`/`__signal`。
3. **环境记录形状不一致**：`ctf_start_env` 只写嵌套 `env`，而 `orchestrate.stop` 与 `writeup`
   读顶层字段 ⇒ 停止时永不释放环境、WP 时间线永远「未记录开始时间」。改为双写。
4. **slug 实现四份分歧**：`Baby Heap!` 在编排层是 `baby-heap!-12`，而 `ctf_challenge` 下到
   `baby-heap-12` ⇒ solver 被指到没有附件的目录。统一为「只剔路径危险字符」流派。
5. **`SCOPE_ID_RE` 非贪婪反解**：`challenges/baby-heap-12` 被解成 `heap-12` ⇒ status 对照错乱、
   stop 漏释放。改贪婪前缀 + 尾部不含 `-`。
6. **WP 提交截断**：提交/预览复用了复现脚本的 8KB 截断读取器，>8KB 的 WP 会被截断提交。
   改为不截断读取。
7. **`store.resolveConnection` 部分匹配**：只传 `eventId`（不带 `baseUrl`）时无法构造 key ⇒
   永远解析不到连接。改为按已提供字段做部分匹配。

### 已知限制

- 凌虚登录带验证码，只支持 `sessionid` Cookie，不做账号密码自动登录。
- `punish: true` 的赛事错误提交会扣分；护栏（去重 / 错误计数 / 审计）默认只记录不阻断
  （按用户「全自动」决策），可用 `maxWrongAttempts` 收紧。
- 本机无 Docker / pwntools / gdb / r2，pwn/rev 需按需自装工具链。
- CTFd 适配器按官方 API v1 实现但**未对真实站点实测**。
- 理论题 `finish` 不可逆，按用户决策不加二次确认。

