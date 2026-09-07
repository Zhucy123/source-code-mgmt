# source-code-mgmt — DSH 源代码管理插件

> [English](README.en.md) | 中文

> 版本：**v1.21.0**　|　更新日志见文末「[版本历史](#版本历史)」

> **界面语言跟随 DSH 设置实时切换**：面板与 host 端消息自动使用 DSH 的语言（设置 → 通用 → 语言），中文 ↔ 英文即时生效，无需重启。

> DSH Web GUI 源代码管理插件：把「环境检查 → SSH 配置 → 代码上传推送 → 克隆仓库 → 发布 npm 包」整合进「代码管理」面板，支持 GitHub / Gitee 双平台，一键管理代码仓库。

> 入口位置自适应：**已安装 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时**，「代码管理」作为它侧边栏的一个新 Tab 页面出现（全新侧边栏 Tab）；**未安装时**，「代码管理」按钮位于 DSH **右上角、常驻可见**——有会话时放在「Session 日志」旁边的右对齐列表里，无会话空态时改为一个固定在**右上角**的浮动按钮，点击后打开一个 **dsh-better-sidebar 外观的右侧集成面板**（推挤主内容区）。两种形态都复用同一套面板 UI。

## 功能

集成入口（二选一，自动检测，无需手动切换）：

- **已安装 dsh-better-sidebar**：「代码管理」注册为它侧边栏的一个**新 Tab 页面**，点击侧边栏 Tab 直接打开面板；
- **未安装 dsh-better-sidebar**：「代码管理」按钮常驻在 DSH **右上角**——有活跃（非空白）会话时通过 `conversation.session.header.utilities` 槽位放在「Session 日志」旁（同款胶囊、间距一致）；空白（新对话）/无会话空态时通过常驻的 `shell.overlay` 槽注册一个固定在右上角的浮动按钮（仅空白或没有会话时显示，活跃会话时交给 header 内的按钮，避免重复）。点击都打开一个 **dsh-better-sidebar 外观的右侧集成面板**（内容放同一面板），并把主内容区往左推挤。

> 检测只是激活时一次内存读取（`ctx.get('betterSidebar')`），零 I/O、零网络，不影响 DSH 启动速度；两种形态间自动切换。未安装 better-sidebar 时入口常驻右上角（有会话=Session 日志旁，空态=固定右上角浮动按钮），空态/新对话也可见。

面板分五步（①②③ 为核心三步，④⑤ 为新扩展板块，默认折叠按需展开）：

### ① 环境检查
- 显示**操作系统**（美化名：`Windows` / `macOS` / `Linux`，对应底层 Node 平台标识 `win32` / `darwin` / `linux`）
- 自动检测 **Git**、**GitHub CLI** 是否安装及版本（如 `git version 2.55.0`、`gh version 2.97.0`）
- 检测 **SSH** 客户端是否可用（解析到可用 `ssh` 即显示「已找到」）
- **缺工具时给安装指引 + 一键安装（按平台自适应、尽量免 sudo）**：某工具未找到时，该行显示「❌ 未安装」+「**复制安装命令**」+「**安装**」按钮：
  - **GitHub CLI（Linux / macOS）**：**免 sudo 用户级安装**——从官方 GitHub Release 下载对应平台/架构的二进制包，解压后装到 `~/.local/bin/gh`（目录不存在会自动创建，全程不需要管理员权限）；失败时自动回退系统包管理器。
  - **Git（Linux）**：apt / dnf / pacman（自动带 `sudo -n`；**先探测 sudo 是否免密**，需要密码时不再盲目执行，而是给出「请在终端手动执行」的指引 + 完整命令）。**Git（macOS）**：brew，无 brew 时走 **Xcode 命令行工具**（`xcode-select --install`，系统自带安装，含 git/ssh）。
  - **SSH（Windows）**：内置可选功能（需管理员）；**SSH（Linux）**：apt / dnf / pacman 的 openssh-client（同上 sudo 探测）；**macOS** 系统自带。
  - **复制安装命令**与「安装」按钮**走同一套平台自适应逻辑**（不再固定显示 Windows 的 winget 命令）。
- **安装过程实时进度弹窗**：点「安装」后弹出进度窗口，逐步显示「查询最新版本 → 下载 → 解压 → 安装 → 清理」及实时输出；完成后显示成功/失败原因。
- **需要重启时提示并一键重启**：检测到安装后当前 host 进程无法立即识别（如 gh 装到了不在 PATH 的 `~/.local/bin`）时，弹窗提示并显示「**重启 DSH**」按钮——点击后 host 通过 detached 辅助进程按原启动命令自动拉起新进程（机制同 dsh-update），页面短暂断开后刷新即可；若 host 已能识别（如设置了 `DSH_SCM_GH` 或 `~/.local/bin` 在 PATH），则不打扰直接完成。
- 安装完成后自动重新检测。

### ② SSH 密钥与连接
- **平台选择**：下拉选择代码托管平台 **GitHub（默认）** / **Gitee**，决定下面的 SSH 配置写入与连接测试目标
- **自动探测 ed25519 密钥**：扫描 `~/.ssh/*.pub` 中已存在的 ed25519 公钥——**优先用 `id_ed25519`**；否则用找到的第一个（支持任意命名的密钥，如 `github_ed25519`）；都没有则默认名 `id_ed25519`。状态行显示**实际检测到的密钥文件名**，SSH config 的 `IdentityFile` 也用它
- 一键**生成 ed25519 密钥**（无密码；本地已有 ed25519 密钥时复用，不会重复生成）
- 一键**写入 SSH config**（GitHub：`github.com → ssh.github.com:443`；Gitee：`gitee.com` 443 端口；均为 443 端口满足国内网络绕过 22 端口封锁）
- **测试连接** `ssh -T git@github.com`（GitHub）或 `ssh -T git@gitee.com`（Gitee）
- 显示公钥内容，方便复制上传到对应平台
- 检测 `gh` 是否已登录及账号

> **海外用户需要 443 吗？——不需要。** 「写 SSH config」是**可选的**（仅在你点按钮时才会写入 `~/.ssh/config`）。GitHub 官方标准端点就是 `git@github.com` 走 **22 端口**，海外正常网络开箱即用，直接跳过该按钮：生成密钥 → 把公钥贴到 GitHub → 测试连接 → 推送，全程 22 端口。443 配置（`Host github.com → HostName ssh.github.com, Port 443`）是 GitHub **官方支持的**端口 22 封锁兜底方案，典型场景是国内网络、部分公司/校园网；写了也无害（仅当 443 也被封锁时才反而不通，极少数网络）。Gitee 是国内平台，海外用户基本只会用到 GitHub。

### ③ 代码管理
- **跟随 ② 平台**：本区所有「检测/新建/可见性」逻辑随 ② 的平台选择切换（GitHub 走 `gh` CLI，Gitee 走 Gitee OpenAPI）
- **Gitee 令牌**（仅 Gitee 模式显示）：输入 Gitee 私人访问令牌（需 `projects` 权限）→ 保存在本机 `~/.dsh/storages/source-code-mgmt-gitee.json`（0600，**不写入插件目录**、不回传到浏览器/日志）；可一键清除；令牌无效会自动清掉
- **选择工作区**：下拉选择 DSH 已登记的工作区文件夹，选中即加载
- **选择目录 →**：下拉右侧按钮，可手动输入/粘贴目录绝对路径或点击「浏览…」弹出原生文件夹选择器；确认后**持久化加入自定义目录列表**（插件独立存储于 `~/.dsh/storages/source-code-mgmt-dirs.json`，**不写入插件目录**，开源不泄漏个人路径），下次打开无需重新选择；手动添加的目录会以**自定义目录徽标**显示，末端带 **✕** 可一键删除该下拉记录（只删记录，不删实际文件夹）
- 显示仓库状态：平台来源、分支、远程地址、待提交改动数、领先/落后远程、>100MB 文件
- **查看详情**：有改动时「改动」行旁出现「查看」按钮 → 点击弹出窗口列出改动/新增/删除/重命名的**文件或文件夹名称**；所有**可文本预览**的文件（含新增/untracked 新文件）都可**点击文件行展开查看内容**——**并排视图**（左旧右新，删除行红底、新增行绿底），**纯新增文件没有旧版本，只显示「新版本」一列**；**二进制文件不显示「查看」**（内容无法按文本预览）；本地与远程存在差异时「同步」行旁出现「查看」按钮 → 点击弹出窗口显示**本地领先/落后的具体提交列表**；无改动或已一致时不显示按钮
- **本地 Git 工作流**（不改动远程同步逻辑）：
  - 「改动」弹窗里每个文件行有**暂存 / 取消暂存**按钮（按 `git status` 的 XY 状态区分 staged/unstaged），并显示「已暂存 / 未暂存」标记
  - ③ 面板仓库名上方有**提交信息输入框 + 「提交」按钮**（仅 git 仓库且有改动时显示）——可写自定义提交信息，**不再用固定 message**；留空则自动生成
  - 「分支」行旁有**「切换」**按钮 → 弹窗列出分支，点选即 `checkout`
  - 「分支」行旁有**「历史」**按钮 → 弹窗列出提交（hash+subject+author+date），每条可**查看**（并排 diff）、**revert**、**cherry-pick**（后两者带确认框，因为会改写历史）
- **远程按平台 + 当前账号匹配**：③ 的「远程 / 同步」只认「属于当前平台的远程」**且 owner 等于当前登录账号**（GitHub 平台 = `gh` 账号如 `Zhucy123` 名下，Gitee 平台 = Gitee 令牌账号如 `Zhucy2100` 名下）。这样：
  - 切到 Gitee 时不读 GitHub 的 origin，只读 gitee.com 的远程；
  - github.com 上**属于别人/其他组织**的仓库（如 `deepseek-ai/deepseek-harness`）不会被当作「用户自己的远程」显示，ahead/behind 也不对它计算；
  - 本地没有属于当前账号的远程时，「远程」显示「（无）」、不计算同步，只走「同名仓库检测 + 新建仓库并推送」形态。
- **创建 Git**：当所选目录**不是 git 仓库**但远程已存在同名仓库时显示该按钮，仅执行 `git init`（+设默认身份），**不拉取不推送**，由用户自行决定下一步是拉取还是推送
- **新建仓库并推送**：默认以**文件夹名**为仓库名（只读不可改），可选**私有/公开**；同名仓库已存在时**按钮禁用**并在下方提示「同名仓库已经创建」。若目录还是**全新的（尚无任何提交）**，会先自动 `git add` + 生成一个初始提交再创建，避免推送时报 "no commits found"
  - GitHub：`gh repo create --private|--public --source=. --push`
  - Gitee：用令牌调 Gitee OpenAPI `POST /user/repos` 建仓，再设置 SSH 远程 `git@gitee.com:<owner>/<name>.git` 并 `git push`（走 ② 已配的 SSH 密钥）
- **>100MB 文件处理**：自动识别超过 100MB 单文件限制的文件——文件在一级子目录内则**忽略整个一级目录**（该文件夹为一整体），根目录独立文件则**忽略单个文件**；已存在于 `.gitignore` 的不重复添加，并显示「未上传原因」

### ④ 克隆仓库（Clone）
- 跟随 ② 平台：把已登录账号（GitHub 走 `gh`，Gitee 走 OpenAPI）名下**所有远程仓库**列出来，并自动标记本地是否已有同名 git 仓库（默认按「默认工作区 + 已登记工作区 + 自定义目录」判定）
- **克隆到目录**：可选目标父目录（默认 = DSH 默认工作区），不选即克隆到默认位置；克隆走 SSH URL（`git@github.com:…` / `git@gitee.com:…`），成功后自动加入自定义目录列表，③ 里可直接选中
- 列表里「本地已有」的仓库不可重复克隆，其余每个仓库一个「克隆」按钮

### ⑤ 发布 npm 包（npm publish）
- 五步向导（在目标目录执行）：**① 确认源** `npm config get registry` → **② 查看认证配置** `npm config list`（自动脱敏 token/auth/password）→ **③ 验证身份** `npm whoami` → **④ 预览打包** `npm pack --dry-run`（先看会发布哪些文件，不真正打包发布）→ **⑤ 发布** `npm publish`
- **登录与发布固定走官方源 `https://registry.npmjs.org`**：即使你的全局 npm 配置是镜像源（如 `registry.npmmirror.com`——镜像只同步、不接受发布），`whoami` / `npm login` / `npm publish` 也统一带 `--registry=https://registry.npmjs.org`；状态区在检测到镜像配置时会黄色提示「发布将使用官方源」。
- **「打开终端执行 npm login」安全弹终端**：先探测系统真实存在的终端程序（`konsole` / `gnome-terminal` / `xterm` 系等），再 spawn（并挂 error 监听兜底）——修复了旧版 `spawn` 不存在二进制时异步 ENOENT 未捕获、**直接把 dsh host 进程打崩**的问题；KDE 下用 `konsole --separate` 开独立窗口，不与宿主所在终端实例纠缠。找不到终端时明确返回手动命令指引，不再假装成功。
- 发布前必须勾选「我已核对以上内容，确认发布到 npm registry」才可点「发布」，防止误操作

### 数据加载时机（打开时联网、显示刷新中）
DSH 打开时**不联网同步仓库**，只预取静态的环境/SSH/工作区列表。**打开插件、切换工作区、刷新状态、以及推送/拉取/暂存/提交等操作后**，都会联网获取对应工作区的最新仓库状态，并显示「⟳ 刷新中…」提示——避免打开/重开/切换时显示可能过期的旧数据（如旧的「无改动」）。关闭面板再打开也会重新同步，不会停留在旧状态。

## 安装

> 本插件以 **Profile Bundle** 形态分发：`package.json` 声明了 `dsh.bundle`（携带 `cordis.patch.yml` 配置层），所以 `dsh plugin --profile web add` **一条命令装完即自动激活**——无需手动编辑任何配置文件。

### 方式一：从 npm 官方包安装（推荐）

**最省事的方式**——只需一条命令，且不用先进 profile 目录，推荐给普通使用者。

**在任意目录执行：**
```bash
# 用 DSH 自带的插件命令（自动定位/初始化 web profile）
dsh plugin --profile web add source-code-mgmt
```

> 该命令在 web profile 目录里执行 `pnpm add`，成功后对账插件层：检测到本插件声明 `dsh.bundle`，会自动把它追加进 `dsh.profile.bundles`（见 `~/.dsh/profiles/web/package.json`）并注册进 Cordis loader 树，**一步装完即用**。

装完**完全重启 dsh web**（不是刷新页面，而是要停掉旧进程后重新启动），然后浏览器 **F5 刷新**，「代码管理」入口即出现（已装 dsh-better-sidebar 时为侧边栏 Tab，未装时为右上角 Session log 旁的「代码管理」按钮 + 右侧集成面板）。

### 方式二：从本地目录安装（开发/测试）

**Windows (PowerShell):**
```powershell
# 用 DSH 插件命令安装本地源码（link: 协议，符号链接，改源码即生效）
dsh plugin --profile web add link:C:/path/to/source-code-mgmt
dsh web
```

**Linux / macOS:**
```bash
dsh plugin --profile web add link:/home/yourname/path/to/source-code-mgmt
dsh web
```

### 方式三：从 GitHub 安装（分发场景）

**Windows / Linux / macOS 通用:**
```bash
dsh plugin --profile web add git+https://github.com/Zhucy123/source-code-mgmt.git
dsh web
```

> git 安装会把源码**实际拷贝**到 node_modules，改动源码需重新 `dsh plugin --profile web add ...` 拉取（不像 `link:` 是符号链接、改源码即生效）。

### 验证安装是否成功

安装并重启后，可以核对以下几点：

1. **依赖已写入**：`~/.dsh/profiles/web/package.json` 的 `dependencies` 里应有 `source-code-mgmt`。
2. **已加入配置层**：`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 列表里应有 `source-code-mgmt`（`dsh plugin add` 自动写入，无需手动编辑）。
3. **符号链接已建立（`link:` 方式）**：`~/.dsh/profiles/web/node_modules/source-code-mgmt` 指向源码目录（Windows 显示为 Junction）。
4. **重启后入口可见**：已装 dsh-better-sidebar 时侧边栏出现「代码管理」Tab；未装时右上角 Session log 旁出现「代码管理」按钮，点击展开右侧集成面板。

### 常见排障

| 现象 | 原因 / 处理 |
|------|------------|
| 已 `dsh plugin add` 并重启，但按钮不出现 | 最常见：装完没有**完全重启**（不是刷新）。停掉旧 `dsh web` 进程再启动（旧进程还占着 3080 端口时，新实例起不来）。 |
| 安装时提示「declares no dsh.bundle」 | 装到的版本缺少 bundle 声明（旧版或打包遗漏 `cordis.patch.yml`）。确认版本 ≥ 1.9.0 后重新安装/更新。 |
| 出现「Failed to load plugins」 | 插件 host 端 `index.js` 启动报错（多为依赖解析问题）。查看启动日志，确认 `node_modules` 依赖已装齐。 |

## 使用步骤

1. 重启 dsh web 并刷新浏览器
2. 点击「**代码管理**」入口（已装 dsh-better-sidebar 时点侧边栏 Tab，未装时点右上角 Session log 旁的「代码管理」按钮展开右侧集成面板）
3. 面板打开（联网获取当前工作区最新状态，显示「⟳ 刷新中…」，拉取完成即显示内容）
4. ①确认 Git / GitHub CLI 已安装 → ②生成密钥并测试连接 → ③选择工作区后推送或新建仓库

## 后端 API 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/source-code-mgmt/env` | GET | 环境检查（git/gh 版本） |
| `/api/source-code-mgmt/install-tool` | POST | 一键安装缺失工具（body `tool`: `git`/`gh`/`ssh`；gh 可另传 `source`: `official` 或 `gh-proxy.com`/`ghfast.top`/`ghproxy.net` 等镜像 id，按平台自适应：gh 在 Linux/macOS 免 sudo 装到 `~/.local/bin`；git/ssh 走系统包管理器 / brew / Xcode CLT / winget；响应为 **NDJSON 事件流**：`step`/`out`/`result`，供进度弹窗实时展示） |
| `/api/source-code-mgmt/install-command` | POST | 按工具与下载源返回可复制的安装命令（body `tool` + 可选 `source`；与「安装」同源逻辑） |
| `/api/source-code-mgmt/check-update` | POST | 检查 gh / git 是否有可用更新（body `tool`；返回 `{current, latest, hasUpdate}`） |
| `/api/source-code-mgmt/ssh` | GET | SSH 密钥 / config / gh 登录状态 |
| `/api/source-code-mgmt/gh/login` | POST | 打开终端运行 `gh auth login`（交互式登录需用户在弹出终端完成；找不到终端时返回手动命令指引） |
| `/api/source-code-mgmt/gen-key` | POST | 生成 ed25519 密钥 |
| `/api/source-code-mgmt/write-config` | POST | 写入 SSH config（body `provider`: `github` 默认 / `gitee`） |
| `/api/source-code-mgmt/ssh-test` | POST | 测试 SSH 连接（body `provider`: `github` 默认 / `gitee`） |
| `/api/source-code-mgmt/default-dir` | GET | 当前工作区目录 |
| `/api/source-code-mgmt/workspaces` | GET | 列出所有工作区目录 + 自定义目录集合（DSH 工作区 + 插件自定义目录） |
| `/api/source-code-mgmt/pick-dir` | POST | 宿主端弹出原生文件夹选择对话框，返回选中的路径 |
| `/api/source-code-mgmt/add-workspace` | POST | 校验目录存在并持久化加入插件自定义目录列表，返回合并后的工作区列表 |
| `/api/source-code-mgmt/remove-workspace` | POST | 仅删除自定义目录的下拉记录（不删实际文件夹），返回更新后的列表 |
| `/api/source-code-mgmt/align` | POST | 强制对齐：`git fetch` + `git reset --hard origin/<branch>`，本地完全重置为远程状态 |
| `/api/source-code-mgmt/init-git` | POST | 仅 `git init` + 设置默认身份，不拉取不推送（由用户决定下一步） |
| `/api/source-code-mgmt/repo-exists` | POST | 检测同名仓库是否存在（body `provider`: `github`/`gitee`） |
| `/api/source-code-mgmt/repo?dir=` | GET | 获取仓库状态（query `provider`: `github`/`gitee`） |
| `/api/source-code-mgmt/repo-diff?dir=&path=` | GET | 按需返回单个改动文件的 unified diff 文本 |
| `/api/source-code-mgmt/stage` | POST | 暂存改动（body `dir`、`path`；`path` 空=全部） |
| `/api/source-code-mgmt/unstage` | POST | 取消暂存（body `dir`、`path`；`path` 空=全部） |
| `/api/source-code-mgmt/commit` | POST | 用自定义信息提交（body `dir`、`message`、`paths?`；沿用 pushFlow 的无身份兜底逻辑） |
| `/api/source-code-mgmt/branches` | POST | 列出分支（当前分支在前） |
| `/api/source-code-mgmt/checkout` | POST | 切换分支（body `dir`、`branch`） |
| `/api/source-code-mgmt/log` | POST | 最近提交历史（body `dir`、`count?`，返回 hash/subject/author/date） |
| `/api/source-code-mgmt/revert` | POST | revert 某提交（body `dir`、`hash`） |
| `/api/source-code-mgmt/cherrypick` | POST | cherry-pick 某提交（body `dir`、`hash`） |
| `/api/source-code-mgmt/commit-diff` | POST | 返回某提交的完整 patch（body `dir`、`hash`） |
| `/api/source-code-mgmt/push` | POST | 提交并推送（git 操作，平台无关） |
| `/api/source-code-mgmt/pull` | POST | 从远程拉取更新（`git pull --ff-only`，已最新/成功/冲突反馈） |
| `/api/source-code-mgmt/merge-push` | POST | 拉取并推送（`git pull --rebase` + `git push`，本地有更改且远程有更新时合并推送） |
| `/api/source-code-mgmt/force-push` | POST | 强制推送（`git push --force`，覆盖远程为本地状态） |
| `/api/source-code-mgmt/force-pull` | POST | 强制拉取（`git pull --force`，拉入远程更新） |
| `/api/source-code-mgmt/create` | POST | 新建仓库并推送（body `provider`；GitHub 走 `gh repo create`，Gitee 走 OpenAPI + SSH push） |
| `/api/source-code-mgmt/set-visibility` | POST | 修改仓库可见性（body `provider`；GitHub 走 `gh repo edit`，Gitee 走 `PATCH /repos/{owner}/{repo}`） |
| `/api/source-code-mgmt/gitee-token` | GET/POST | GET：令牌是否已配置 + 账号；POST：保存（`{token}`）或清除（`{clear:true}`）Gitee 令牌 |

## 安全

所有路由均为 **loopback-only**（`sec-fetch-site` + Origin 校验），仅本机浏览器可访问，LAN/手机来源一律 403——与控制面板同一策略。

## 跨平台

- **Windows / Linux / macOS 通用**
- 用 `process.platform` 检测平台
- `~/.ssh` 通过 `homedir()` 定位（Windows: `C:\Users\用户名\ .ssh`，Linux/macOS: `/home/用户名/.ssh` 或 `/Users/用户名/.ssh`）
- Linux/macOS 下 SSH config 自动设 0600 权限
- **git / gh / ssh / ssh-keygen 二进制自动探测**：启动时依次按 ①环境变量覆盖 → ②PATH 查找（Windows 加 `.exe`）→（仅 Windows）③Git 自带目录（`usr\bin` / `bin`）回退，最后兜底用裸命令名。因此只要装了 Git，即使 `ssh` 不在 PATH 里也能正常工作，换设备无需额外配置。
- 如需手动指定二进制路径，可用环境变量覆盖：`DSH_SCM_GIT` / `DSH_SCM_GH` / `DSH_SCM_SSH` / `DSH_SCM_SSH_KEYGEN`
- **SSH 传输修复**：Git for Windows 自带的 MSYS `ssh.exe`（`usr\bin\ssh.exe`）在被 detached/agent 进程调用时可能报 `couldn't create signal pipe, Win32 error 5`，导致 `git push`/`git pull` 失败。插件执行 git 远程命令时会自动注入 `GIT_SSH` 指向解析到的可用 `ssh`（通常为系统 OpenSSH `C:\Windows\System32\OpenSSH\ssh.exe`），避免该问题。
- **中文文件名兼容**：git 默认 `core.quotepath` 会把含非 ASCII 字节的路径输出成八进制转义的引号串（显示为乱码）。插件对所有 git 调用统一注入 `-c core.quotepath=false`（直接输出原始 UTF-8 路径），并对仍带引号转义的路径做 `parseGitPath()` 反转义兜底——改动列表 / diff 里的中文文件名显示正常
- **缺工具一键安装跨平台（v1.15.0 起按平台自适应、尽量免 sudo）**：GitHub CLI 在 Linux/macOS 直接**免 sudo 用户级安装**（官方二进制 → `~/.local/bin/gh`，失败回退系统包管理器）；git/ssh 在 Linux 走 apt-get / dnf / pacman（**先探测 sudo 免密**，需要密码时给出手动命令指引而非静默失败），macOS 走 brew / Xcode 命令行工具，Windows 走 winget / 内置功能（回退 choco/scoop）。安装过程有**实时进度弹窗**，需要重启时提供**一键重启 dsh**。SSH 密钥探测、本地 Git 工作流、并排 diff 等在三个平台行为一致；「浏览目录」的原生选择器仅 Windows 可用，macOS/Linux 上请在输入框直接填路径（可手动输入粘贴）。

## 开发

```bash
git clone https://github.com/Zhucy123/source-code-mgmt.git
cd source-code-mgmt
# 在本地 DSH 测试（安装到 web profile，自动激活）
dsh plugin --profile web add link:$(pwd)
```

- 改动 `lib/client.js`（浏览器端）→ 刷新页面即生效
- 改动 `lib/index.js`（host/Node 端）→ 刷新页面即可让面板重新检测（`toolInstalled` 按当前 PATH / `~/.local/bin` 实测）；如 host 端 API 仍为旧版，重启 dsh web 进程一次

## 版本历史

### v1.21.0（当前）
**彻底移除 Gitee CLI + Gitee 私人令牌配置移到 ②**：

- **背景**：Gitee CLI 不是刚需——插件核心的 Gitee 功能（建仓 / push / clone / ②③）靠**私人令牌（OpenAPI）** 与 **SSH 公钥**驱动，与 CLI 二进制无关；且 Windows 上安装经常失败（无 npm.exe 的 ENOENT / npm.cmd 的 EINVAL 坑）报「未找到可用的包管理器」误导。
- **host 端**：删除 `GITEE` 常量、`env.gitee` 检测、`installHints.gitee`、`checkSsh` 的 `giteeLoggedIn/giteeAccount`、`giteeUserLevelScript`、`checkGiteeUpdate`、`giteeLoginTerminal`、`/gitee/login` 与 `/gitee/import-token` 路由、`installCommandSystem`/`installCommand`/`installToolFlow`/`toolInstalled`/`/check-update` 里的 gitee 分支；`installCommandSystem` 对未知工具（含 gitee）直接返回 null，避免误落到 gh 的包名。
- **client 端**：① 环境检查固定检测 gh（不再按平台切 gitee CLI 行）；② **Gitee 私人令牌改在 ② 直接输入/保存/清除**（`/gitee-token` 存储，保存/清除后即时通知 ③④ 刷新）；③ 只读显示令牌配置状态（未配置时提示去 ②），移除「从 Gitee CLI 导入」按钮。
- **保留不变**：Gitee 平台本身、私人令牌存储（`~/.dsh/storages`，0600）、建仓/push/clone、SSH 443 配置全部保留。
- 变更范围：`lib/index.js`（重启 dsh web 生效）、`lib/client.js`（刷新即生效）。版本号 1.20.0 → 1.21.0。

### v1.20.0（历史）
① 环境检查新增 **Git 检查更新（仅 Windows）**（复用 gh/gitee 的「检查更新」交互）：

- **已安装的 Git 行显示「检查更新」按钮（仅 Windows 显示）**：host 对比本地 `git --version` 与 Git 官方最新稳定版本，有更新则 `window.confirm` 确认后一键升级（进度弹窗实时展示）。
- **Git 官方版本来源不能用 GitHub Releases（`git/git` 没有 release，/releases/latest 是 404）**，改用其 **tags API** 并**过滤预发布/RC**（`v2.56.0-rc0` 之类会被剔除，避免诱导更新到 RC）。
- **更新 = 系统包管理器「升级」命令**：Windows `winget upgrade Git.Git`；需要 root 时沿用 `canSudo()` 探测（Windows 走 winget 自处理提权）。
- **Linux/macOS 不显示 Git 检查更新**：这两个平台的 git 是发行版 / brew / Xcode CLT 管理的，版本与官方不同步（Linux 常停留在发行版固定版本），拿官方最新版对比会**永远误报**，且随系统更新走无需单独检查——host 端也加了防御，非 Windows 的 git 更新直接提示「Git 随系统更新」。
- SSH **不加**更新（系统组件、无独立可升级版本，且没必要）。
- 新增 `POST /check-update` 的 `tool=git` 分支（返回 `{ok, current, latest, hasUpdate}`）。
- 变更范围：`lib/index.js`（刷新/重启一次生效）、`lib/client.js`（刷新即生效）。版本号 1.19.0 → 1.20.0。

### v1.19.0（历史）
GitHub CLI 下载源选择扩展到 **Windows**（此前仅 Linux/macOS）：

- **Windows 也支持镜像下载源下拉**：之前下载源选择只在 Linux/macOS 显示，Windows 走 winget 直连 GitHub Releases 导致「下载很慢 / 不走进度」。现在 ① 环境检查在 Windows 的 gh 缺失时同样显示「下载源」下拉（默认第一个镜像 `gh-proxy.com`）。
- **Windows 镜像安装 = 下载官方 msi + msiexec 静默安装**：选定镜像后，host 按「镜像前缀 + 官方 msi URL」下载 `gh_<版本>_windows_<arch>.msi`（实测约 5-6MB/s），再用 `msiexec /qn` 全静默安装——与 winget 效果一致（gh 注册进 Program Files 与 PATH），但避开了直连 GitHub 的慢速段。「一键安装」分步进度 /「复制安装命令」/「检查更新」均跟随所选镜像。msiexec 用 PowerShell `-EncodedCommand`（UTF-16LE base64）经 `Start-Process -Verb RunAs -Wait` 触发 UAC 提权安装（DSH 进程通常非提权）。
- **修复 Windows 下载报 `curl: (3) URL rejected: Port number...`**：最初用 `cmd /c` 拼字符串执行 curl，Node spawn 在 Windows 会重排引号，把镜像 URL 的第二个 `https://` 误判成「host:端口」导致 curl 拒绝。已改为**参数数组直接调用 `curl.exe`**（`runLive(bin, args)`），逐个传值，彻底绕开 shell 引号重排。
- **列举镜像**：`gh-proxy.com`（快，推荐）→ `ghfast.top` / `ghproxy.net`（可用，较慢）→ 官网（慢）；与 Linux/macOS 共用同一份 `GH_MIRRORS`，仅下载资产从 `.tar.gz` 换成 `.msi`。
- **「下载源」下拉在 gh 已安装时也显示（三平台统一）**：此前只在 gh 缺失时渲染，导致**已安装点「检查更新」时无法选镜像**（更新走隐藏的 `ghSource`，若默认落官网则很慢）——Linux/macOS/Windows 都存在。现改为 gh 行**常驻「下载源」下拉**：未安装时影响一键安装，已安装时影响「检查更新」触发的覆盖安装；并修复默认镜像的竞态（改为独立 `useEffect` 监听 env，保证「已安装点更新」也不会竞态落到官网）。
- **回退策略**：选「官网（慢）」或镜像版本解析失败时，Windows 回落系统包管理器（winget / choco / scoop），原有行为不变。
- 变更范围：`lib/index.js`（刷新/重启一次生效）、`lib/client.js`（刷新即生效）。版本号 1.18.0 → 1.19.0。

### v1.18.0（历史）
① 环境检查新增 **CLI 检查更新**（GitHub CLI / Gitee CLI）：

- **已安装时显示「检查更新」按钮**：host 对比本地版本与官方最新 release（gh 查 GitHub Releases API；gitee 查 Gitee OpenAPI 公开端点，无需令牌）。
- **有更新 → 询问 → 按安装逻辑更新**：`window.confirm` 展示「发现新版本：x → y，是否立即更新？」；确认后**复用一键安装流程**（`/install-tool` 带 `force`，跳过「已安装」短路）——gh 走用户级安装脚本 + 所选下载源（镜像），gitee 走官方安装脚本，进度弹窗实时展示，装完自动重新检测。
- 无更新提示「已是最新版本（x）」；错误（读不到版本/连不上官方）有明确提示。
- **点击「检查更新」后按钮变为「正在检查更新…」并禁用**，检查完成自动恢复。
- **修复更新不生效**：`/install-tool` 路由最初未透传 `force`（更新确认后命中「已安装」短路，显示"已安装 执行成功"但版本不变），已修复——`force` 完整透传到安装流程，更新真正覆盖安装到最新版。
- 新增 `POST /check-update` 路由（body `tool`: `gh`/`gitee` → `{ok, current, latest, hasUpdate}`）。
- 变更范围：`lib/index.js`、`lib/client.js`。版本号 1.17.0 → 1.18.0。

### v1.17.0（历史）
Gitee 平台改用官方 **Gitee CLI** 检测与登录（对齐 GitHub 的 gh 体验）：

- **① 环境检查按平台自适应**：切到 Gitee 后，工具行检测 **Gitee CLI（`gitee`，官方 oschina/gitee-cli）** 而不是 GitHub CLI（gh）；切回 GitHub 恢复检测 gh。Gitee CLI **未安装时可一键安装**（Linux/macOS 走官方安装脚本免 sudo 装到 `~/.local/bin/gitee`，gitee.com 国内直连无需镜像；Windows 走 `npm install -g @gitee/gitee-cli`），安装后点「重新检查」即可。
- **② Gitee 登录行用 CLI 状态**：Gitee CLI 已装时显示 `gitee auth status` 结果——未登录提供「**登录 Gitee**」按钮（host 打开终端运行 `gitee auth login`，粘贴私人令牌即可）+「复制登录命令」+「重新检查」；CLI 未装时提示「请在 ① 环境检查安装 Gitee CLI」，并显示令牌兜底状态（Gitee API 仍需要私人令牌，可在 ③ 配置）。
- **③「从 Gitee CLI 导入」令牌**：Gitee CLI 已登录时，③ 令牌配置块出现「从 Gitee CLI 导入」按钮——把 CLI 保存的令牌（`gitee auth token`）一键导入插件存储（`~/.dsh/storages`），免去手动复制粘贴；「新建仓库并推送」等 OpenAPI 功能随即可用。
- 私人令牌仍是 Gitee API 认证方式（创建仓库等必需）；SSH 公钥只管 push/pull 已有仓库。
- 变更范围：`lib/index.js`、`lib/client.js`。版本号 1.16.0 → 1.17.0。

### v1.16.0（历史）
GitHub CLI 下载提速 + gh 登录按钮 + 移除一键重启：

- **GitHub CLI 下载源可选（官网 / 镜像）**：官网直连在国内网络经常「下载很慢 / 基本不走进度」。现 gh 未安装时，①环境检查会显示「下载源」下拉（默认第一个镜像）：`gh-proxy.com`（实测约 2-3.5MB/s、稳定）→ `ghfast.top` / `ghproxy.net`（可用但偏慢）→ `官网（慢）`。下载 URL 由 host 按所选源构造（镜像 = 前缀 + 官方 Releases URL），「一键安装」与「复制安装命令」都跟随所选下载源。镜像列表由 `/env` 的 `ghMirrors` 下发，后续增删镜像无需改浏览器端。
- **安装完成提示改为「刷新网页即可生效」**：删除「需要重启 DSH 生效」提示与「重启 DSH」按钮；成功提示统一为「安装完成…，刷新网页即可生效」。host 端删除整套一键重启机制（`/restart` 路由、`restartLaunch` / `scheduleRestart` / `restartNeededFor` 等）。
- **缺少环境时也显示「重新检查」按钮**：之前只有全部就绪才显示；现在有缺失时提示行旁同样提供「重新检查」，手动安装 / 刷新后无需重启即可重新检测。
- **gh 未登录时可一键登录**：② SSH 密钥与连接的「GH 登录」行在未登录时显示「登录 GitHub」按钮（host 打开终端运行 `gh auth login`，KDE konsole 独立窗口、找不到终端给出手动命令指引）+「复制登录命令」+「重新检查」；登录完成后点「重新检查」即可看到账号。
- 变更范围：`lib/client.js`（刷新即生效）、`lib/index.js`（刷新/重启一次生效）。版本号 1.15.1 → 1.16.0。

### v1.15.1（历史）
⑤ 发布 npm 包功能修复（v1.15.0 的补丁）：

- **修复「打开终端执行 npm login」打崩 host**：旧实现 `spawn` 不存在的终端二进制（如 SteamOS 上没有 `x-terminal-emulator`）时，异步 ENOENT 错误无监听器被抛成未捕获异常，**直接把 dsh host 进程打崩**（表现：运行 `pnpm dsh web` 的终端跟着结束）。现改为先 `findTerminal()` 探测 PATH 中真实存在的终端（konsole / gnome-terminal / xterm 系等），并对每个 child 挂 `error` 监听器兜底——绝不再崩宿主。
- **KDE konsole 用 `--separate` 开独立窗口**：不与宿主所在的 konsole 实例纠缠；找不到任何终端时明确返回「请手动运行：<命令>」指引，不再假装打开成功。
- **npm 登录/发布固定走官方源**：`npm login` / `npm whoami` / `npm publish` 统一带 `--registry=https://registry.npmjs.org`（镜像源只同步、不接受发布）；`npmStatus` 新增 `publishRegistry` / `mirrorConfigured`，面板在检测到镜像配置（如 npmmirror）时黄色提示「发布将使用官方源」；「复制登录命令」也同步为官方源版本。
- 变更范围：`lib/index.js`（需重启 dsh web）、`lib/client.js`（刷新即生效）。版本号 1.15.0 → 1.15.1。

### v1.15.0（历史）
一键安装全面升级：**平台自适应 + 尽量免 sudo + 实时进度 + 一键重启**。

- **修复「复制安装命令」在 Linux/macOS 上错误显示 winget**：客户端写死的 Windows 提示改为取 host `/env` 返回的 `installHints`（与「安装」按钮同一套平台自适应逻辑）；非 Windows 且无可用方式时留空，不再误导。
- **GitHub CLI（Linux/macOS）改免 sudo 用户级安装**：`installCommand()` 对 gh 优先返回官方二进制下载脚本（查最新版本 → 按平台/架构下载 `gh_<ver>_linux_amd64` / `macOS_arm64` 等 → 解压 → 装到 `~/.local/bin/gh`），一键安装失败自动回退系统包管理器。`resolveBin` 新增 `~/.local/bin` 探测——**插件加载时即使 PATH 里没有该目录也能找到用户级 gh**（不再依赖改 PATH / 设环境变量）。
- **sudo 免密探测（Linux）**：`canSudo()` 用 `sudo -n true` 探测；需要密码时**不再盲目执行**（`-n` 必然失败），返回「请在终端手动执行：<命令>」指引 + 原因，配合复制按钮即可完成。
- **macOS 兜底**：git/ssh 无 brew 时走 **Xcode 命令行工具**（`xcode-select --install`，系统自带安装、含 git/ssh），弹窗以「⏳ 已触发，按系统提示完成后点重新检查」呈现。
- **安装后实测复查**：`toolInstalled()` 改为按当前 PATH/落点直接探测（git/ssh 走 `--version`、gh 走 `~/.local/bin` 优先），**不再依赖模块加载时缓存的历史解析结果**——装完立即识别，修掉「装好了还报失败」的隐患。
- **安装进度弹窗**：`/install-tool` 改为 **NDJSON 事件流**（`step`/`out`/`result`，`runLive()` spawn 流式转发），浏览器端 `jpostStream()` 逐行消费；弹窗逐步显示「▶ 查询最新版本 → 下载 → 解压 → 安装 → 清理」与实时输出尾部。
- **需要重启时提示 + 一键重启**：`restartNeededFor()` 智能判定（`DSH_SCM_GH` 显式指定或 `~/.local/bin` 在 PATH 时无需重启）；需要时弹窗显示「**重启 DSH**」按钮——新增 `POST /restart` 路由（机制同 dsh-update：detached helper 等端口释放后按原启动命令拉起新进程，POSIX detached spawn / Windows PowerShell 隐藏窗口；严格 loopback + origin 同源校验；systemd supervisor 托管或 `DSH_SCM_RESTART=0` 时禁用），点击后页面短暂断开、新进程自动起来。
- 变更范围：`lib/index.js`（需重启 dsh web）、`lib/client.js`（刷新即生效）。版本号 1.14.0 → 1.15.0。

### v1.14.0（历史）
按你的要求**移除了 ⑤「提交 PR」功能**：

- **前端**：`lib/client.js` 删除整个 `PrSection`（含 ⑤ 区块的渲染与面板导语中的「⑤提交 PR」文案），一并清理了对应的 i18n 键（`EN_DICT`）。
- **host**：`lib/index.js` 删除整套 PR 实现——`/pr/targets`、`/pr/rule`、`/pr/analyze`、`/pr/generate`、`/pr/execute` 五个路由，`prAnalyzeFlow` / `prGenerateFlow` / `prExecuteFlow`，PR 目标仓库本地存储（`source-code-mgmt-pr-targets.json`）、PR 规则缓存读写（`rules/` 下的 `readPrRule`/`writePrRule` 等）、`parseRepoUrl`、`fillPrTemplate`、安全校验（`safeEntryPath` / `safeRegenerateCommand`）、`PRESET_PR_RULES` 与启动时的规则预置写入。
- 保留 `llmComplete()` 这一通用 LLM 调用助手（与 PR 无关，属可复用能力，本轮暂未用到可直接忽略）。
- 版本号 1.13.0 → 1.14.0；`package.json` 描述同步去掉「AI-assisted Pull Requests」。克隆板块的「按地址克隆」「本地已有判定」与 ⑥ npm（默认空目录）等仍保持 v1.13.0 行为不变。
- 变更范围：`lib/client.js`（刷新即生效）、`lib/index.js`（需重启 dsh web）。

> 说明：`rules/` 目录下旧预置文件 `rules/awesome-dsh-plugin__awesome-dsh-plugin.json` 已不再被任何代码引用，可自行删除或保留（不影响功能）。

### v1.13.0（历史）
按第二轮反馈继续精化（④⑤⑥ 三处交互收敛）：

- **④「本地已有」判定扩大到已登记的目录**：此前克隆列表只在「当前选中的克隆目录」下判定本地是否已有，用户若把克隆目录切到别处（如工作区 `workspace`），明明已存在的仓库仍标「可克隆」。现在新增 `localRepoExistsAnywhere()`：除了当前选中目录，还会遍历 ③ 代码管理登记过的**所有工作区 / 自定义目录**（`~/.dsh/storages/workspace.json` + `source-code-mgmt-dirs.json`）逐一判定——任一被登记的位置已有同名仓库即标「本地已有」；克隆成功后目标目录本就会记入自定义目录，因此「某位置已有该仓库」的知识会自动沉淀下来，下次列表直接命中。
- **④ 新增「按仓库地址克隆到任意位置」**：克隆板块底部新增一行——粘贴任意 git 仓库地址（HTTPS 或 SSH，GitHub / Gitee / 自建均可）+ 选择目标目录，自动从 URL 末段推导仓库名（去掉 `.git`）并 `POST /clone/run` 克隆到所选位置；复用「选择目录…」按钮（可输入绝对路径或弹系统文件夹选择器，确认后记住到自定义目录）。目标目录默认沿用顶部下拉，未选择时给出提示。
- **⑥ 发布 npm：目标目录默认留空**：此前默认回填默认工作区，用户不选就可能发布到非预期目录。现在目标目录**默认留空**，界面提示「当前留空，不会自动使用默认目录」；未选目录时「重新检查 / 登录 / 执行」按钮全部禁用并拦截，用户必须手动选择（同 ③/④ 的「选择目录…」按钮）。
- **⑤ 收敛为「提交 awesome-dsh-plugin 插件收录 PR」**：按你要求先只保留「awesome-dsh-plugin 插件收录 PR」这最常用的一条路——隐藏「目标仓库地址」输入框、隐藏「记录到本地 / 已记录」行与标签、隐藏「分析 PR 规则 / 重新分析（忽略缓存）」按钮与手填规则面板、隐藏通用 PR 流程兜底框；目标仓库锁定为 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`，挂载时只读加载一次其**预置收录规则**（不消耗 AI）并展示加载状态。保留下部：插件信息（名称/分类/描述 en/zh）→「生成 PR 内容（AI）」（命中预置模板可免 AI 填充、仍可编辑）→ 可编辑的标题/描述/条目文件内容 + 工作目录 →「执行 PR」（逐步日志 + PR 链接）。host 端 `/pr/analyze`、`/pr/targets` 等路由与预置规则文件保持不变，仅前端做了收敛。

### v1.12.0（历史）
本次更新（新增④克隆 / ⑤提交 PR / ⑥发布 npm 三大板块）：

- **④ 克隆仓库**：列出已登录账号（GitHub `gh repo list` / Gitee OpenAPI `user/repos`）名下所有远程仓库并标记本地是否已有；**默认目标目录 = 用户主目录（home）**，不选即克隆到 home；每一行目录都有与 ③ 代码管理一致的「选择目录…」按钮（输入绝对路径或系统文件夹选择器，确认后记住到自定义目录）；克隆走 SSH URL，成功后自动加入自定义目录列表。host 新增 `GET /clone/default-dir`、`GET /clone/home`、`GET /clone/repos`、`POST /clone/run`；本地已存在判定同时覆盖「目录名 == 仓库名且含 .git」的场景
- **⑤ 提交 PR**：目标仓库网址记录到 `~/.dsh/storages/source-code-mgmt-pr-targets.json`（**不写入插件目录**）；**输入网址即自动读取该仓库的本地规则**（`GET /pr/rule`，只读缓存、不消耗 AI）：命中预置/缓存规则就显示对应专属 PR 功能，未命中则显示通用流程并提示「分析 PR 规则」；**预置 `rules/awesome-dsh-plugin__awesome-dsh-plugin.json`**——输入 `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin` 直接给出它的收录规则（fork → clone → 在 `data/plugins/<owner>__<repo>.yml` 写条目 → `npm ci && node scripts/generate-readme.mjs` 重生成 README → commit → push → PR，规则写在插件目录）；「分析 PR 规则」抓取目标仓库 README/CONTRIBUTING/PR 模板/package.json 交给 **DSH 默认模型**思考该仓库应如何 PR，输出结构化步骤规则并**缓存到插件目录 `rules/<owner>__<repo>.json`**（下次直接执行、不再消耗 AI；「重新分析（忽略缓存）」可强制重想）；「生成 PR 内容」按规则模板产出标题/描述/条目文件内容（带预置模板时可免 AI 直接填充、仍可编辑），**生成后可改、绝不直接提交**；「执行 PR」按 `fork→clone→加 upstream→fetch→建分支→写条目→重生成 README→commit→push→gh pr create（Gitee 走 OpenAPI）` 逐步执行并显示日志与 PR 链接。host 新增 `GET /pr/targets`、`POST /pr/targets`、`POST /pr/rule`、`POST /pr/analyze`、`POST /pr/generate`、`POST /pr/execute`
- **⑥ 发布 npm 包**：五步向导（`npm config get registry` → `npm config list`（脱敏 token/auth/password）→ `npm whoami` → `npm pack --dry-run` → `npm publish`），发布前需勾选确认；**可切换包目录**（同样带「选择目录…」按钮）；**未登录/未配置时明确提示**：显示当前 registry / whoami，未登录给出「打开终端执行 npm login」（host 弹系统终端、进入目标目录执行，`POST /npm/login`）与「复制登录命令」，登完回面板点「重新检查」；`GET /npm/status` 会报告目录是否存在、是否含 `package.json` 并给出对应警告。host 新增 `GET /npm/status`、`POST /npm/step`、`POST /npm/login`
- **host 端 AI 能力**：新增 `llmComplete()`——通过 `ctx.get('llm')` 调 DSH 的 LLM 运行时，默认模型取 `ctx.get('settings').get('agent-default-model')`（兜底解析 `~/.dsh/settings.yaml`），消息格式适配 `GenerateOptions`（text-delta 组装）
- **维护性**：新增 i18n 键通过 `Object.assign` 并入 `EN_DICT` / `HOST_EN`，不改动原超长字典行；新增 `inputStyle()` 共享输入框样式；`node --check` 双端通过
- **对抗式审查修复（同版本内）**：
  - **修复 Windows npm 路径含空格导致 ⑥ 不可用**：npm 解析路径（如 `C:\Program Files\nodejs\npm.cmd`）含空格时，shell 模式会把命令截断成 `'C:\Program' 不是内部命令`。`run()` 现对含空格的可执行文件路径加引号包裹（只包裹路径本身，参数仍按数组安全传递），npm registry / whoami / version 实测通过；
  - **修复「重新分析（忽略缓存）」失效**：`/pr/analyze` 路由此前未把 `force` 传给分析流程，导致该按钮永远走缓存。现已透传 `body.force`；
  - **修复点号仓库名解析**：`parseRepoUrl` 此前把 `owner/my.repo` 截断成 `my`（正则排除点号），现允许点号、仅剥离尾部 `.git`；
  - **安全加固 PR 规则执行**：规则来自 AI/缓存、默认受信任，新增 `safeEntryPath()` 拦截条目文件路径穿越（`..` / 绝对路径），`safeRegenerateCommand()` 只放行白名单构建命令并拒绝 shell 元字符——防止恶意仓库文档诱导 AI 产出危险规则后自动执行；
  - **修复「确保 fork」日志假成功**：GitHub `gh repo fork` 失败时此前仍显示 ✅，现仅在真实成功或「already exists」时显示成功；
  - **Gitee 仓库列表分页**：`user/repos` 默认每页 20，此前只列前 20 个；现按每页 100 分页拉全（上限 10 页 ≈ 1000 个，与 GitHub 对齐）；
  - 扩展 `tools/smoke-test.mjs` 至 31 项（覆盖点号仓库名、路径穿越、命令白名单等边界），全绿；`node --check` 双端通过
- **按反馈完善（同版本内）**：
  - **④ 默认克隆目录改为用户主目录**：此前默认是 DSH 工作区，且「工作区目录本身就是仓库」时被误标为可克隆；现默认改为 `os.homedir()`（Windows 为 `C:\Users\<用户名>`，Linux/macOS 为用户主目录），本地已存在判定补上「基目录名 == 仓库名 且含 `.git`」；
  - **④⑥ 目录选择按钮与 ③ 一致**：克隆目标与 npm 包目录都提供「选择目录…」按钮，行为与 ③ 代码管理相同（可输入绝对路径或弹出系统文件夹选择器，确认后记住到自定义目录），不再局限于工作区内；
  - **⑤ 按仓库显示对应 PR 功能**：输入目标仓库网址后自动 `GET /pr/rule` 读缓存规则（不消耗 AI）——有规则显示专属流程、无规则显示通用流程并提示分析；预置 awesome-dsh-plugin 收录规则（写入插件目录 `rules/`），输入官方仓库网址即命中；
  - **⑥ 未登录/未配置时引导登录**：`npm whoami` 未登录时面板给出明确警告，可一键弹出系统终端执行 `npm login`（`POST /npm/login`，Windows 用 `cmd /k`、其他平台回退常见终端模拟器）或复制登录命令，完成后「重新检查」即可继续发布流程；
  - **⑤ 分析 PR 规则可手动输入规则来源**：点击「分析 PR 规则」展开输入面板——可手动填写该仓库的 PR 规则文本，或提供规则文件（本地路径 / URL，如某仓库 README），留空则由 AI 自动抓取仓库文档（README/CONTRIBUTING/PR 模板）分析；提供内容时走**精简提示词**（只忠实整理用户输入、不抓文档、不编造，节省 token），结果同样结构化缓存到插件目录 `rules/`；仓库已有本地规则时点击「分析 PR 规则」会先询问「是否重新分析」（选否则不做任何事）。

### v1.11.0（历史）
本次更新（改动文件查看体验 + 中文文件名兼容性）：

- **新增/untracked 文件现在可以查看内容**：改动列表里「新增」文件行也显示「▸ 查看」，点击展开显示完整文件内容（按「全部新增」的 diff 渲染，超大文件只显示前 2000 行并附截断提示，上限 1MB 不会整读进内存）；空的新文件显示「（空文件）」。
- **新增文件不再显示「旧版本」列**：并排 diff 在没有任何删除行（纯新增，如新增/untracked 文件）时只显示「新版本」一列，不再出现空白的「旧版本」表头与左列；有增有删的修改仍保留双列对比。
- **二进制文件不显示「查看」**：每个改动文件按内容嗅探（NUL 字节启发式，与 git 一致）判断是否可文本预览——二进制文件（图片、exe 等）不显示「查看」按钮（悬停提示「二进制文件，无法查看文本内容」）；已删除/暂存后无副本的文件用 `git diff --numstat`（二进制条目 `-\t-`）判断。
- **中文文件名兼容性修复**：git 默认 `core.quotepath` 会把中文路径输出成八进制转义的引号串（如 `"\346\270\270…md"`），导致改动列表与 diff 头部的中文文件名显示成乱码。现在所有 git 调用统一注入 `-c core.quotepath=false`（直接输出 UTF-8 路径），并新增 `parseGitPath()` 反转义兜底——改动列表、`ls-files -z`、`diff --name-only`、`git diff`/`git show` 头部路径等解析点全覆盖。
- 新增 `tools/verify-cn-paths.test.mjs` 回归测试（中文路径解析、文本/二进制可查看性、新增文件 diff 生成、已删除文件判断）。

### v1.10.1（历史）
本次更新（修复 better-sidebar 集成与「未安装 better-sidebar」时入口的若干问题）：

- **修复：装了 dsh-better-sidebar 后，右上角「代码管理」按钮仍残留**。根因：未装 better-sidebar 时的降级入口此前只给 ReactDOM 降级路径赋了 `entryUnmount`，slots 路径漏了——导致切到「侧边栏 Tab」形态时 header 入口没被拆掉。现已把 `slots.inject` 返回的 disposer 记进 `entryUnmount`，切到 Tab 时正确拆除（顺带修正同类清理逻辑）。
- **修复：未安装 better-sidebar 时，入口只在对话内显示，新对话/无会话空态不显示**。根因：旧入口挂 `conversation.session.header.utilities`（`scope: 'session'`），而空态时整个会话 header 被 `hideChrome` 隐藏，按钮出不来。现在改为**右上角常驻**——有活跃会话时放在「Session 日志」旁（会话 header 的右对齐列表），新对话/无会话空态时改为 `shell.overlay` 常驻槽里 `position: fixed` 钉在右上角的按钮（仅空白/无会话时显示，避免与 header 按钮重复）。
- **修复：刷新瞬间「代码管理」按钮与「Session 日志」重叠**。根因：`captureSessions()` 延迟 1.2s 才捕获到 session 列表，捕获前误判为「无会话」而提前点亮常驻按钮。现在未捕获到 session 列表前不渲染常驻按钮，杜绝刷新闪叠。
- **判定信号修正**：常驻按钮的显隐改用「当前会话是否空白」判断（`sessions.list.getSnapshot().byId[current].blank`）——活跃（非空白）会话才隐藏常驻按钮（交给 header 内的按钮），空白/无会话则显示，替代原来不准确的「`current === undefined`」判断。
- **健壮性**：better-sidebar 服务的探测由「一次性 1.5s 重试」改为**有界多档重试**（快节奏起步再放慢，覆盖约 44s，拿到即停、卸载即清），兜底 better-sidebar 客户端冷启动较慢导致漏切 Tab 的竞态。

> 以上均为客户端（`lib/client.js`）改动，刷新页面即生效；host 端 `/api` 路由与推送/忽略逻辑未改动。

### v1.10.0（历史）
本次更新：

- **界面中英文实时切换（跟随 DSH 语言设置）**：面板全部文案（①②③ 三步、按钮、弹窗、状态/结果消息、确认框、Tab 标题）与 host 端错误/结果消息改为双语词典驱动——语言 = DSH 设置 → 通用 → 语言，切换**即时生效**（面板经 `ctx.locale` 订阅实时重渲染，Tab 标题随动），无需刷新/重启；host 端按请求的 `?lang=` 经 AsyncLocalStorage 按请求返回对应语言，并发不串扰。中文界面与 v1.9.0 完全一致，英文界面为完整翻译（含 >100MB 忽略原因、Gitee 令牌提示、git 命令失败回退等全部消息）。新增 `tools/` 下的 i18n 提取/应用/测试脚本便于后续维护

### v1.9.0（历史）
本次更新：

- **改为 Profile Bundle 分发，安装即激活**：`package.json` 的 `dsh.bundle` 从裸字符串 `"./lib/index.js"` 改为对象形态 `{ "patch": "./cordis.patch.yml" }`，并新增 `cordis.patch.yml`（insert `source-code-mgmt` 行）。现在 `dsh plugin --profile web add source-code-mgmt` 一步装完即被自动加入 `dsh.profile.bundles` 并注册进 Cordis loader 树，**不再需要手动编辑 `cordis.patch.yml` 激活**；README 中「安装 ≠ 激活」说明与 PowerShell 激活脚本已删除。功能行为零变化（仍是同一份 `lib/index.js` host 端 + `lib/client.js` 浏览器端）

### v1.8.0（历史）
本次更新：

- **新增「推送暂存」按钮**（③面板「同步」行）：当**本地领先有提交**或**有已暂存的改动**时，「同步」行「本地领先 N 提交」后面出现「**推送暂存**」按钮——点击后**只把已暂存的内容**用**你填写的提交信息**（没填则自动生成 `chore: update <文件夹名>`）提交，然后**推送到远程**；不会像「推送更改」那样自动暂存所有未暂存的改动。推送成功后自动刷新状态并显示「⟳ 刷新中…」，界面显示本次提交的信息与 hash。host 端新增 `POST /push-staged` 路由（`pushStagedFlow`，沿用本插件 `run()`/GIT_SSH）

### v1.7.0（历史）
本次更新：

- **数据加载时机重做：打开时联网、显示「刷新中」**：此前打开 DSH 会预取所有工作区的仓库状态并缓存，导致打开/重开/切换面板时命中旧缓存，显示可能过期的数据（如旧的「无改动」）。现在改为——**打开 DSH 时不联网同步仓库**（只预取静态的 env/SSH/工作区列表）；**打开插件、切换工作区、自定义目录点击、刷新状态、以及推送/拉取/暂存/取消暂存/提交/对齐/初始化等操作后**，一律**联网获取对应工作区的最新状态**，并显示「⟳ 刷新中…」提示（刷新期间按钮变「刷新中…」、状态区显示同步中）。关闭面板再打开也会重新同步，不再停留在旧状态。删除了预取所有工作区的 `syncAllRepos` 与「命中缓存秒显」分支

### v1.6.0（历史）
本次更新：

- **未安装 dsh-better-sidebar 时的入口改为「右上角 Session log 旁 + 右侧集成面板」**：原「右上角浮动按钮 + 右侧抽屉」改为——「代码管理」按钮经 DSH 的 `conversation.session.header.utilities` 槽位注册，**出现在右上角 Session log 旁边的右对齐列表**里（与 Session log 同款胶囊样式、间距 8px 不挤在一起）；点击后在**右侧展开一个 dsh-better-sidebar 外观的集成面板**（复用原话术：环境检查 / SSH / 代码管理三步），并把主内容区 `#root` **往左推挤**（margin-right + width calc）。slots 服务不可用时降级为右上角浮动按钮 + 右侧面板。改动仅限 `lib/client.js`（浏览器端），刷新页面即生效，host 端 `/api` 路由未动
- **已安装 dsh-better-sidebar 的形态不变**：仍注册为它侧边栏的「代码管理」Tab；安装/未安装两形态依旧自动检测切换

### v1.5.0（历史）
本次更新：

- **① 环境检查缺工具一键安装**：某个工具（git / gh / ssh）未检测到时，该行显示「❌ 未安装」+「复制安装命令」+「**安装**」按钮——「安装」由 host 自动选包管理器执行（Windows winget / 内置功能、macOS brew、Linux apt/dnf/pacman），安装后自动重新检测；host 新增 `POST /install-tool` 路由（best-effort，回传执行命令与输出）
- **修复切换平台后 ③ 未刷新**：仓库状态缓存按目录 + 平台区分，② 切换 GitHub / Gitee 后 ③ 会重新拉取对应平台的检测内容，不再残留上一个平台的「远程/同步/同名校验」结果；拉取期间显示「⟳ 切换平台，正在重新检测…」提示，避免旧内容停留几秒让用户误以为没变化
- **macOS / Linux 适配修复**：Linux 缺工具一键安装自动带 `sudo -n`（已是 root 则省略，避免权限失败挂起）；`decodeSessionDir` 按平台区分 Windows 盘符路径与 POSIX 绝对路径，macOS / Linux 下也能正确从 session 目录还原工作区

### v1.4.0（历史）
本次更新：

- **SSH 密钥自动探测**：扫描 `~/.ssh/*.pub` 中的 ed25519 公钥——优先用 `id_ed25519`，否则用找到的第一个（支持任意命名密钥）；都没有才用默认名 `id_ed25519` 新建。② 状态行显示实际检测到的密钥名，SSH config 的 `IdentityFile` 也用它，有自定义命名密钥也能正确识别、配置并推送

### v1.3.0（历史）
本次更新（补齐本地 Git 工作流，未改动远程同步逻辑）：

- **② SSH 默认折叠 + 标题行切平台**：② SSH 部分默认折叠，标题行内嵌「平台」下拉（折叠时也能切），切换后自动展开该部分以继续配置，③ 跟随平台

- **选择性暂存 + 自定义提交信息**：「改动」弹窗每个文件行新增**暂存 / 取消暂存**按钮（按 `git status --porcelain` 的 XY 状态区分 staged/unstaged），并显示「已暂存 / 未暂存」；③ 面板仓库名上方新增**提交信息输入框 + 「提交」按钮**，提交不再用固定 `chore: update workspace via DSH...`（留空则自动生成基于文件夹名的信息）；沿用 `pushFlow` 的无身份兜底逻辑
- **分支切换 + 提交历史 + revert / cherry-pick**：「分支」行旁新增「切换」（弹窗列出分支，点选 `checkout`）与「历史」（弹窗列出提交，每条可「查看」「revert」「cherry-pick」——后两者带确认框）
- **真·并排 diff**：把 unified diff 解析成（旧行/新行）配对，左右两栏渲染（删除行红底、新增行绿底）；改动文件展开与历史点某提交（`/commit-diff`）都用并排视图；保留纯文本 `renderDiff` 作降级（二进制/无法解析时）
- **「查看改动」秒出**：加载仓库状态时后台并发预取所有改动文件的 diff（并发≤3、纯本地 git 读取）并缓存，点开文件行立即显示，不再等「加载中…」
- **提交历史右键菜单**：「历史」弹窗每条提交可点**「⋯」或右键**打开菜单——查看提交差异、复制短哈希、复制完整哈希、复制提交信息、还原此提交（revert）、拾取此提交（cherry-pick，后两者带确认框）
- **本地 Git 功能按 better-sidebar 自适应隐藏**：已安装并激活 **dsh-better-sidebar** 时，③ 面板**隐藏本插件自带的本地 Git 工作流**（暂存/取消暂存、自定义提交、分支「切换」、提交「历史」+ revert/cherry-pick、并排 diff），因为这些能力 better-sidebar 的 Git 面板已覆盖，避免重复；此情况下「查看改动」弹窗**只列改动文件**，并**提示具体改动内容请到 dsh-better-sidebar 的「源代码管理 / Git 面板」查看**；**未安装**时则展示完整本地 Git 功能
- host 端新增 `/stage` `/unstage` `/commit` `/branches` `/checkout` `/log` `/revert` `/cherrypick` `/commit-diff` 路由（全部走 `isLoopbackRequest` 校验 + `run()`/`GIT_SSH`）

### v1.2.0（历史）
本次更新：

- **入口自适应（不再占用左栏底部按钮）**：「代码管理」的入口改为自动检测——**已安装 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 时**，通过其 `ctx.betterSidebar.registerTab` 把「代码管理」注册为该侧边栏的一个**新 Tab 页面**；**未安装时**，在 DSH 页面**右上角显示一个浮动按钮**，点击展开**右侧栏抽屉**（形态类似 dsh-better-sidebar 的右栏），内容为同一面板
- **检测零开销**：激活时仅一次内存读取（`ctx.get('betterSidebar')`），零 I/O、零网络，毫秒级，不影响 DSH 启动；并对激活顺序做了兜底延迟重试，保证最终落在正确的形态
- **移除原左栏底部按钮**：不再通过 `sidebar.footer.action` 插槽注册触发按钮；`ScmPanel` 支持 `variant`（`tab` / `drawer`）以分别适配侧边栏 Tab 与右侧抽屉布局，面板 UI 与 host 端 `/api` 路由完全复用、未改动
- **可见性默认值更聪明**：「私有 / 公开」下拉默认选**当前仓库的实际可见性**（已存在且可读时）；当所选工作区**没有远程**（即将新建的仓库）时，默认选**公开**，而不是固定「私有」
- **每个部分可折叠**：①环境检查 / ②SSH / ③代码管理 标题行**右上角各加一个折叠按钮**，点击收起只显示标题、再点展开；①环境检查在**所有工具都就绪**（git/gh/ssh 均已安装）时**默认折叠**并显示「✅ 均存在」提示

### v1.1.2（历史）
本次更新：

- **改动详情可展开查看内容 diff**：「改动」查看弹窗里，对已跟踪的改动（修改/删除/新增）点击文件行即可展开查看该文件的 diff——删除行红色带 `-`、新增行绿色带 `+`、上下文灰色；untracked 新文件无 diff 只列名称（后端对每个改动文件追加 `git diff`/`git diff --cached` 内容）

### v1.1.1（历史）
本次更新：

- **远程按平台切换**：切到 Gitee 时「远程 / 同步」不再读取 GitHub 的 origin，而是只匹配 gitee.com 的远程（GitHub 平台仍读 github.com 远程）——解决「切到 Gitee 却仍显示 `git@github.com:...`」的问题；本地没有对应平台远程时显示「（无）」且不计算同步
- **远程必须属于当前账号**：此前只按 `github.com`/`gitee.com` 域名匹配远程，导致 `deepseek-ai/deepseek-harness` 这类**别人的远程**被当成用户自己的远程显示、还能点「推送更改」。现在校验远程 owner 必须等于当前登录账号（GitHub=`gh` 账号、Gitee=令牌账号），不属于自己的远程一律不算，界面回到「同名仓库检测 + 新建仓库」形态；同时无远程时「同步」行显示「（无）」，不再误显示「与远程一致」
- **「拉取更新」改用强制对齐的实现并直接执行**：「本地干净 + 远程有更新」状态的「拉取更新」按钮不再走 `git pull --ff-only`，而是复用「强制对齐」的 `git fetch` + `git reset --hard origin/<branch>` 逻辑——本地干净没有可丢失的改动，reset 等同快速前进到远程最新，且**不弹确认框直接执行**，结果更可靠（可绕过 rebase/merge 常见失败场景）
- **操作按钮只保留当前状态对应的唯一动作**：只有本地有改动（远程一致）→ 只显示「推送更改」；只有远程有更新（本地干净）→ 只显示「拉取更新」；「强制对齐」仅在「本地和远程都有更新」状态出现（该状态的唯一操作按钮），不再在推送/拉取/已同步状态里当作兜底显示
- **「本地有改动 + 远程有更新」状态只保留「强制对齐」**：此前该状态显示「拉取更新并推送更改 / 强制推送 / 强制拉取」三按钮，但这些操作容易因未提交改动、分支保护等失败且行为难预测（表现为点了没反应、不显示结果），现改为只显示提示 + 「强制对齐」按钮（`git fetch` + `git reset --hard`，本地完全重置为远程），与用户实际想要的「一键对齐」一致
- **修复「点了按钮没有任何反馈」**：操作回调先 `setErr` 再刷新仓库状态，随后 `loadRepo` 把错误提示无条件清空，导致失败时结果被立即抹掉、界面像什么都没发生；现在错误/结果会保留显示（切换目录 / 切换平台 / 手动刷新状态仍会清空旧提示），对齐失败等也能看到真实原因

### v1.1.0（历史）
本次更新：

- **② SSH 新增平台选择**：在「② SSH 密钥与连接」顶部增加下拉选择代码托管平台 **GitHub（默认）** / **Gitee**
  - 「配置 SSH(config)」按所选平台写入相应 443 端口配置（GitHub：`github.com → ssh.github.com:443`；Gitee：`gitee.com` 443）
  - 「测试连接」按所选平台执行 `ssh -T git@github.com` / `ssh -T git@gitee.com`
  - 「SSH 配置」状态行按所选平台分别显示 github / gitee 的配置情况，公钥上传提示文案也随平台切换
- **③ 代码管理完整适配 Gitee**：③ 全部跟随 ② 的平台选择
  - Gitee 模式走 **Gitee OpenAPI**（REST API + 私人令牌，`curl` 调用），令牌在 ③ 输入并保存到本机 `~/.dsh/storages/source-code-mgmt-gitee.json`（0600），可清除
  - 同名仓库检测：Gitee `GET /repos/{owner}/{name}`；可见性读取/修改：Gitee `GET/PATCH /repos/{owner}/{name}`
  - 新建仓库并推送：Gitee `POST /user/repos` 建仓 + SSH 远程 `git@gitee.com:<owner>/<name>.git` 推送
  - 仓库状态行显示当前平台来源；推送/拉取/强制对齐等 git 操作平台无关照常可用

### v1.0.1（历史）
本次更新：

- **「改动」详情查看**：「改动 N 个文件」旁新增「查看」按钮，点击弹出窗口列出改动的文件/新增的文件/文件夹名称（含状态标签：新增/修改/删除/重命名），只显示名称不显示具体内容；无改动时不显示该按钮
- **「同步」详情查看**：「同步」行在本地与远程存在差异时新增「查看」按钮，点击弹出窗口显示本地领先/落后的具体提交列表；与远程一致时无差异可看，不显示按钮
- **修复**：点「查看」不再导致插件崩溃（补全弹窗挂载容器）
- **修复**：推送/拉取/新建仓库等操作后，操作结果（如「已推送 已提交 …」）能正常显示并保留，不再被刷新逻辑立即清空
- **修复**：切换工作区 / 选择新目录 / 手动刷新状态时，会清空上一个工作区的操作结果，避免残留
- **优化**：操作后的自动刷新不再闪断信息栏（目录/分支/改动/同步等字段保持显示，仅后台更新数据）
- 操作系统显示统一为美化名 `Windows` / `macOS` / `Linux`（对应底层 `win32` / `darwin` / `linux`）

### v1.0.0（历史）
**首发版本**，包含以下功能与修复：

- 跨平台二进制自动探测：`git` / `gh` / `ssh` / `ssh-keygen` 按 ①环境变量覆盖 → ②PATH 查找 → ③（仅 Windows）Git 自带目录回退 自动定位，换设备无需额外配置，即使 `ssh` 不在 PATH 也能工作
- 环境检查：显示操作系统、Git、GitHub CLI、SSH 是否可用
- SSH：密钥生成 / 写入 github.com 443 配置 / 测试连接 / 公钥展示 / gh 登录检测
- 代码管理：工作区选择、动态操作按钮（推送 / 拉取更新 / 合并推送 / 强制推送 / 强制拉取 / 新建仓库并推送）
- 修改已有仓库可见性（私有 ↔ 公开）
- 新建仓库并推送：对无提交的全新目录自动生成初始提交，避免 `gh` 报 "no commits found"
- >100MB 文件自动忽略（整目录或单文件）并显示未上传原因
- 所有 API 均为 loopback-only，仅本机浏览器可访问

## License

MIT
