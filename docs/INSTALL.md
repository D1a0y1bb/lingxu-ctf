# dsh-lingxu-ctf 安装与排错

面向**装插件的人**：从零到「会话里能看到 16 个 `ctf_*` 工具」的每一步都能照抄。
命令里出现的 `<...>` 需要替换成你自己的值；其余都可以原样粘贴。

- 当前版本：**`1.0.3`**（GitHub tag **`v1.0.3`**，对应 commit `3702de70a771fd0d430916dea03d5e09bfd7ef0d`）
- 分发渠道：**只有 GitHub**。⚠️ **npm 上没有发布**（`https://registry.npmjs.org/dsh-lingxu-ctf` 实测 404），
  不要执行 `npm i dsh-lingxu-ctf`，也不要在 profile 里写 `"dsh-lingxu-ctf": "^1.0.3"`。
- 安装单位：DSH 的 **bundle**（写进 profile 的 `package.json` 依赖 + `dsh.profile.bundles`，
  bundle 行由仓库自带的 `cordis.patch.yml` 提供）。

---

## 0. 支持矩阵（先对一眼）

| 维度 | 支持情况 |
|---|---|
| DSH Desktop | `0.2.0-rc.1`（开发基线）/ `0.2.0-rc.2`（本机实测）；`0.1.7-rc.1` 上游报告可用、本仓库未复现 —— 见 [§7 版本兼容](#7-版本兼容) |
| macOS / Linux | ✅ 完整支持（安装脚本 `scripts/install.sh` 也是 bash，可直接用） |
| Windows | ⚠️ **插件本身跨平台可用**，但仓库里的 `scripts/*.sh` 是 bash 脚本、Windows 默认跑不了；用 [§3 方式 B](#3-方式-b钉-commit-的-tarballpnpm-友好) 或 [§6 手动安装](#6-手动安装等价于-installsh) 的 PowerShell 版本 |
| 需要什么 | DSH Desktop 本身；只有「方式 C 打包」需要本机装 `npm`；方式 B **不需要 git、不需要 SSH key** |

---

## 1. 30 秒版（大多数人的路径）

```bash
# ① 拉代码（GitHub 是公开仓库，不需要登录）
git clone https://github.com/D1a0y1bb/lingxu-ctf.git
cd lingxu-ctf
git checkout v1.0.3          # 钉在发布版本；想跟最新 master 就跳过这行
pwd                          # 记下这个绝对路径，下一步要用
```

然后在 DSH 的会话里对 agent 说（把上一步的绝对路径填进 `file:`）：

```
用 plugin_manager 安装这个 bundle：file:/绝对路径/lingxu-ctf
```

最后**完全退出并重开 DSH Desktop**（bundle 列表只在启动时读一次），新开一个会话说
「列出你当前可用的 ctf_* 工具」，应能看到 **16 个基础工具**。

> 只想少打几个字？用 [方式 B](#3-方式-b钉-commit-的-tarballpnpm-友好)：一行 URL 直接装，不 clone。

---

## 2. 方式 A：GitHub clone（推荐，能随时 `git pull`）

1. **clone 到本机任意目录**（仓库是公开的，无需凭据）：

   ```bash
   git clone https://github.com/D1a0y1bb/lingxu-ctf.git
   cd lingxu-ctf
   ```

2. **（可选）钉在发布版本**：`git checkout v1.0.3`。
   不钉也可以，就是跟着 `master` 走；比赛期间建议钉版本，避免升级中途行为变化。

3. **交给 DSH 安装**（在会话里说，`file:` 后面写**绝对路径**）：

   ```
   用 plugin_manager 安装这个 bundle：file:/绝对路径/lingxu-ctf
   ```

   `plugin_manager` 会把它写进 profile 的 `dependencies` 与 `dsh.profile.bundles`；
   仓库的 `cordis.patch.yml` 同时并入宿主插件行与「CTF 解题模式」预设行。

4. **重启 DSH**（见 [§8 验证安装](#8-验证安装)）。

---

## 3. 方式 B：钉 commit 的 tarball（pnpm 友好）

不 clone、不碰 git、不需要 SSH key，直接把 GitHub 的 codeload 压缩包交给 DSH：

```
用 plugin_manager 安装这个 bundle：https://codeload.github.com/D1a0y1bb/lingxu-ctf/tar.gz/3702de70a771fd0d430916dea03d5e09bfd7ef0d
```

`v1.0.3` 的等价写法（用 tag，不必记 SHA）：

```
用 plugin_manager 安装这个 bundle：https://codeload.github.com/D1a0y1bb/lingxu-ctf/tar.gz/refs/tags/v1.0.3
```

也可以直接写进 profile（**`~/.dsh/profiles/desktop/package.json`**，Windows 是
`%USERPROFILE%\.dsh\profiles\desktop\package.json`）：

```json
{
  "dependencies": {
    "dsh-lingxu-ctf": "https://codeload.github.com/D1a0y1bb/lingxu-ctf/tar.gz/3702de70a771fd0d430916dea03d5e09bfd7ef0d"
  }
}
```

改完记得在同一个文件里把 `"dsh-lingxu-ctf"` 加进 `dsh.profile.bundles` 数组，然后重启 DSH。

**为什么推荐这个方式**：它是纯 HTTPS tarball 依赖，绕开了下面这个坑 👇

### 3.1 pnpm 用户注意：`github:` 依赖会「退化成 SSH」

**现象**：profile 里写了 `github:D1a0y1bb/lingxu-ctf` 之后，`pnpm update` / `pnpm install` 会失败：

```
[ERROR] Command failed with exit code 128:
  git ls-remote "git+ssh://git@github.com/D1a0y1bb/lingxu-ctf.git" HEAD "HEAD^{}"
Host key verification failed.
```

**原因**：pnpm 解析 `github:` 这类简写时，会用 **SSH 形式**（`git+ssh://git@github.com/...`）去探测 ref。
只要你本机没有 GitHub 的 SSH key（或 `~/.ssh/known_hosts` 里没有 github.com 的主机密钥），
`git ls-remote` 就直接 `Host key verification failed`。
报错里**完全不会出现「这是 HTTPS 依赖被转成了 SSH」**，所以很容易以为是网络问题。

**三个绕法（任选其一）**：

| 绕法 | 怎么做 | 需要什么 |
|---|---|---|
| ✅ 推荐：改用 codeload tarball（钉 commit 或 tag） | 把依赖写成 `https://codeload.github.com/D1a0y1bb/lingxu-ctf/tar.gz/<commit-sha 或 refs/tags/v1.0.3>`（见上方示例） | 只要能访问 github/codeload |
| 改用 `git+https://` 显式写法 | profile 依赖写 `git+https://github.com/D1a0y1bb/lingxu-ctf.git#v1.0.3` | 本机有 `git`，但**不需要** SSH key |
| 配置 SSH 或改写 git URL | 配好 GitHub SSH key；或让 git 自动把 ssh 换成 https：<br>`git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"` | 有 git，愿意改全局配置 |

> ⚠️ **钉版本别拿「你本地 HEAD 的 SHA」**：如果那个 commit 还没推到 GitHub，codeload 会返回 **404**。
> 钉之前先确认远端真的有这个 ref：
>
> ```bash
> git ls-remote https://github.com/D1a0y1bb/lingxu-ctf.git
> ```
>
> 输出里能看到 `refs/tags/v1.0.3` 与对应的 commit SHA（本仓库发布时是
> `3702de70a771fd0d430916dea03d5e09bfd7ef0d`），拿它去拼 tarball 地址才一定 200。

---

## 4. 方式 C：本地目录 / 离线 tarball

**开发态**：clone 之后直接把目录交给 DSH（和方式 A 第 3 步一样，`file:` 指向目录）——
改代码后重启 DSH 即可生效（Node 的 ESM 缓存按 URL 生效，**必须重启**）。

**离线 / 内网分发**：在有 `npm` 的机器上打包，把 `.tgz` 拷过去：

```bash
cd lingxu-ctf
npm pack            # 产出 dsh-lingxu-ctf-1.0.3.tgz
```

然后把 **tgz 的路径**交给 DSH：

```
用 plugin_manager 安装这个 bundle：/绝对路径/dsh-lingxu-ctf-1.0.3.tgz
```

> `npm pack` 打出来的包里有：`lib/`（含 `stage-tools.js`）、`cordis.patch.yml`、`README.md`、
> `docs/`、`LICENSE`、`package.json`。
> ⚠️ **`scripts/` 不在包里**（它只在 git 仓库里），所以「离线 tarball」装法用不到 `scripts/install.sh`。

---

## 5. 卸载

```
用 plugin_manager 移除这个 bundle：dsh-lingxu-ctf
```

然后重启 DSH。配置（平台地址 / Cookie）留在 `~/.dsh/storages/lingxu-ctf/`，需要彻底清掉就手动删这个目录。

---

## 6. 手动安装（等价于 install.sh）

仓库里的 `scripts/install.sh` 做两件事：**① 有 `dsh` CLI 就跑 `dsh plugin --profile desktop add <目录>`；
② 没有 CLI 就把手工步骤打印出来**（这一步它以 `exit 1` 结束，只是提示「接下来手动做」，不是真失败）。
它是 **bash 脚本**（Windows 默认没有 bash），下面给出两个平台的等价操作。

### 6.1 macOS / Linux

```bash
# 有 dsh CLI 时
dsh plugin --profile desktop add /绝对路径/lingxu-ctf

# 没有 CLI 时（install.sh 打印的手工步骤）
mkdir -p ~/.dsh/profiles/desktop/node_modules
ln -sfn '/绝对路径/lingxu-ctf' ~/.dsh/profiles/desktop/node_modules/dsh-lingxu-ctf
# 再编辑 ~/.dsh/profiles/desktop/package.json：
#   "dependencies": { "dsh-lingxu-ctf": "link:/绝对路径/lingxu-ctf" }
#   "dsh": { "profile": { "bundles": [ ... 原有条目, "dsh-lingxu-ctf" ] } }
# 然后重启 DSH
```

### 6.2 Windows（PowerShell）

```powershell
# 用 junction 代替符号链接：普通用户即可创建，不需要管理员 / 开发者模式
$Src        = "C:\Users\<你>\lingxu-ctf"          # clone 出来的目录
$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force "$ProfileDir\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$ProfileDir\node_modules\dsh-lingxu-ctf" -Target $Src
```

然后编辑 `$ProfileDir\package.json`（`notepad "$ProfileDir\package.json"`），补两处：

```json
{
  "dependencies": { "dsh-lingxu-ctf": "link:C:\\Users\\<你>\\lingxu-ctf" },
  "dsh": { "profile": { "bundles": [ "...原有条目...", "dsh-lingxu-ctf" ] } }
}
```

最后**完全退出并重开 DSH Desktop**。

> 优先用 `plugin_manager`（[方式 A](#2-方式-agithub-clone推荐能随时-git-pull) / [方式 B](#3-方式-b钉-commit-的-tarballpnpm-友好)）：
> 它走的是 DSH 自己的安装路径，不用手改 profile 文件，也不受 Windows 符号链接权限的影响。

---

## 7. 版本兼容

| DSH Desktop | 状态 | 说明 |
|---|---|---|
| `0.2.0-rc.1` | ✅ 开发基线 | 插件最初按它开发并验证（`dsh.client` 装配、`cordis.patch.yml` 两条 Loader 行） |
| `0.2.0-rc.2` | ✅ 本机实测 | 当前开发机（DSH 安装目录下 `runtime/primary-runtime/runtime.json` 的 `desktopVersion`） |
| `0.1.7-rc.1` | ⚠️ 上游报告可用、**本仓库未复现** | 见下方「0.1.7 上的已知差异」 |
| 更早版本 | ❌ 未验证 | 早期版本没有 `@deepseek-ai/dsh-client-modules` 这类客户端装配机制，配置卡片 / 顶部 CTF tab 可能不出现 |

### 0.1.7 上的已知差异

- **客户端半（顶部 CTF 视图 tab + 设置页配置卡片）依赖三个包名**：
  `@deepseek-ai/dsh-client-modules`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-conversation`
  （写在 `package.json` 的 `dsh.client.inject`）。我们在 `0.2.0-rc.2` 的安装包里确认过这些包存在；
  **`0.1.7-rc.1` 的包里有没有同名包，本仓库没有对应环境可核实**（不确认就不下结论）。
- 如果宿主解析不到这些包，`dsh-client-modules` 对解析不到的包名是**静默跳过**（不警告、不报错）。
  表现出来的两种症状：
  1. **工具能用、但看不到 CTF tab / 配置卡片**；
  2. **tab 在所有会话里都出现**——会话门控拿不到 `ctx.sessions` 时会降级为「始终显示」，这是设计内的降级。
- **纯 CTF 能力（工具 / 预设）不受影响**：工具走宿主侧注册，预设走 `cordis.patch.yml`。

### 怎么确认自己这台是什么状态

1. 重启后新开会话说「列出你当前可用的 ctf_* 工具」——能看到 16 个就说明**宿主侧**装好了；
2. 在 DSH Web GUI 的地址后面加 `/lingxu-ctf/diag` 打开（同源路由，例如 GUI 在 `http://127.0.0.1:19387`
   就访问 `http://127.0.0.1:19387/lingxu-ctf/diag`）：看路由是否注册、bundle 版本、
   以及 `stage` 打点（`view-slot-registered` / `view-slot-preset-absent` 等）；
3. 顶部没有 CTF tab 时，先在「CTF 解题模式」预设的新会话里看一眼——门控只在 CTF 会话显示。

---

## 8. 验证安装

1. **完全退出并重开 DSH Desktop**（bundle 列表启动时读取，装完不重启不生效）；
2. 新开一个会话，说：

   ```
   列出你当前可用的 ctf_* 工具
   ```

   应看到 **16 个基础 `ctf_*` 工具**；设置页里会多出 `dsh-lingxu-ctf` 的配置卡片；
3. 连上含 AWD / CFS 的赛事后再跑一次 `ctf_status`，工具列表会长出对应的 `ctf_awd_*`（9 个）/ `ctf_cfs_*`（7 个）。

---

## 9. 排错对照表

| 报错 / 现象 | 真实原因 | 怎么办 |
|---|---|---|
| `Host key verification failed` + `git ls-remote "git+ssh://git@github.com/..."` | pnpm 把 `github:` 依赖按 SSH 形式探测 ref，而本机没有 GitHub SSH key | 换 [§3 方式 B](#3-方式-b钉-commit-的-tarballpnpm-友好)（codeload tarball）或 `git+https://` 写法 |
| `404 Not Found - GET https://registry.npmjs.org/dsh-lingxu-ctf` | **这个包没发布到 npm** | 别用 npm 装，改用 GitHub（方式 A / B） |
| `bash: scripts/install.sh: No such file or directory` / Windows「'bash' 不是内部或外部命令」 | `scripts/*.sh` 是 bash 脚本，Windows 默认没有 bash | 用 [§6.2 PowerShell 步骤](#62-windowspowershell)，或装 WSL / Git Bash 后照 §6.1 跑 |
| `npm run verify` 在 Windows 上报错 | `package.json` 里 `verify` 调的是 `bash scripts/verify.sh` | 直接跑 `node --test`（等价于它的核心检查）；`verify.sh` 是开发自检，不是安装步骤 |
| 装完重启了，但会话里没有 `ctf_*` 工具 | 多半是**没有真正重启**，或 profile 的 `dsh.profile.bundles` 里没写进去 | 关闭 DSH Desktop 再打开；检查 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 是否含 `dsh-lingxu-ctf` |
| 工具在，但顶部没有 CTF tab | ① 当前会话不是「CTF 解题模式」预设（门控）；② 宿主是旧版本、客户端依赖没解析到 | 用 CTF 预设新开会话；仍不行看 `GET /lingxu-ctf/diag` |
| `plugin_manager` 报找不到包 / 装不上 | target 写法不对 | `file:` 用**绝对路径**；tarball 用 **`.tgz` 路径**；URL 用上面给的 codeload 地址 |
| 升级后又变回旧行为 | DSH 的 Node ESM 缓存按 URL 永久生效 | 升级后必须**重启** DSH，而不是只刷新页面 |

---

## 10. 给维护者报错时请带上

尤其是 Windows 上「GUI / 浏览器 web 安装报错」（**目前尚未定位到确切原因**），请附：

1. **完整报错文本**（截图不如文本，含堆栈更好）；
2. DSH Desktop 版本：看「关于」页；也可以直接读安装目录里
   `runtime/primary-runtime/runtime.json` 的 `desktopVersion`（Windows 在 `%LOCALAPPDATA%` 下的安装目录）；
3. 安装方式：GUI 插件页 / 浏览器 web 页面 / 手改 profile / `plugin_manager` 工具；
4. Windows 版本号，以及是否用 WSL；
5. `%USERPROFILE%\.dsh\profiles\desktop\package.json` 的内容（含本机路径与其他插件信息，贴之前过一眼）；
6. `%USERPROFILE%\.dsh\profiles\desktop\cordis.yml` 里与 `dsh-lingxu-ctf` 相关的行（⚠️ 配置里可能有 Cookie，**先脱敏**）。

> 仓库里 `scripts/install.sh` 的**注释**里残留了一处开发机的绝对路径（打印手工步骤时会显示出来），
> 不影响执行，也不用照抄 —— 请把它换成你自己的路径。
