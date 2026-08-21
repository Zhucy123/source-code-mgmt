# source-code-mgmt — DSH 源代码管理插件

> 版本：**v1.1.1**　|　更新日志见文末「[版本历史](#版本历史)」

> DSH Web GUI 侧边栏插件：把「环境检查 → SSH 配置 → 代码上传推送」整合进左栏底部的「代码管理」按钮，支持 GitHub / Gitee 双平台，一键管理代码仓库。

## 功能

集成在 **左侧边栏底部**（会话栏底部，通过 `sidebar.footer.action` 插槽），点击「代码管理」按钮打开面板，分三步：

### ① 环境检查
- 显示**操作系统**（美化名：`Windows` / `macOS` / `Linux`，对应底层 Node 平台标识 `win32` / `darwin` / `linux`）
- 自动检测 **Git**、**GitHub CLI** 是否安装及版本（如 `git version 2.55.0`、`gh version 2.97.0`）
- 检测 **SSH** 客户端是否可用（解析到可用 `ssh` 即显示「已找到」）
- 未安装时提示先安装 Git for Windows / GitHub CLI

### ② SSH 密钥与连接
- **平台选择**：下拉选择代码托管平台 **GitHub（默认）** / **Gitee**，决定下面的 SSH 配置写入与连接测试目标
- 检测本机 `~/.ssh/id_ed25519` 密钥是否存在
- 一键**生成 ed25519 密钥**（无密码）
- 一键**写入 SSH config**（GitHub：`github.com → ssh.github.com:443`；Gitee：`gitee.com` 443 端口；均为 443 端口满足国内网络绕过 22 端口封锁）
- **测试连接** `ssh -T git@github.com`（GitHub）或 `ssh -T git@gitee.com`（Gitee）
- 显示公钥内容，方便复制上传到对应平台
- 检测 `gh` 是否已登录及账号

### ③ 代码管理
- **跟随 ② 平台**：本区所有「检测/新建/可见性」逻辑随 ② 的平台选择切换（GitHub 走 `gh` CLI，Gitee 走 Gitee OpenAPI）
- **Gitee 令牌**（仅 Gitee 模式显示）：输入 Gitee 私人访问令牌（需 `projects` 权限）→ 保存在本机 `~/.dsh/storages/source-code-mgmt-gitee.json`（0600，**不写入插件目录**、不回传到浏览器/日志）；可一键清除；令牌无效会自动清掉
- **选择工作区**：下拉选择 DSH 已登记的工作区文件夹，选中即加载
- **选择目录 →**：下拉右侧按钮，可手动输入/粘贴目录绝对路径或点击「浏览…」弹出原生文件夹选择器；确认后**持久化加入自定义目录列表**（插件独立存储于 `~/.dsh/storages/source-code-mgmt-dirs.json`，**不写入插件目录**，开源不泄漏个人路径），下次打开无需重新选择；手动添加的目录会以**自定义目录徽标**显示，末端带 **✕** 可一键删除该下拉记录（只删记录，不删实际文件夹）
- 显示仓库状态：平台来源、分支、远程地址、待提交改动数、领先/落后远程、>100MB 文件
- **查看详情**：有改动时「改动」行旁出现「查看」按钮 → 点击弹出窗口列出改动/新增/删除/重命名的**文件或文件夹名称**（只列名称不显示内容）；本地与远程存在差异时「同步」行旁出现「查看」按钮 → 点击弹出窗口显示**本地领先/落后的具体提交列表**；无改动或已一致时不显示按钮
- **动态操作按钮**（git 操作平台无关，GitHub/Gitee 均可）：根据本地与远程的相对状态**只显示当前状态对应的唯一动作**——
  - 只有本地有更改 → 只显示「推送更改」（`git add` + `commit` + `push`）
  - 只有远程有更新 → 只显示「拉取更新」（实现复用「强制对齐」逻辑：`git fetch` + `git reset --hard origin/<branch>`；因为本地干净无改动，reset 不会丢任何内容，等同快速前进到远程最新，直接执行不弹确认）
  - 本地和远程都有更新 → 只显示提示 +「**强制对齐**」：「拉取更新并推送更改 / 强制推送 / 强制拉取」在此场景下容易因未提交改动、分支保护等原因失败且行为难预测，已不在界面展示；直接把本地**完全重置为远程状态**（`git fetch` + `git reset --hard origin/<branch>`，丢弃本地差异）
  - 完全同步 → 显示「✓ 已是最新」
  - 「**强制对齐**」（`git fetch` + `git reset --hard origin/<branch>`，把本地完全重置为远程状态）**只在「本地和远程都有更新」状态出现**，作为该状态的唯一操作按钮，用于解决「本地与远程文件相同却仍显示同步差异」的情况
- **创建 Git**：当所选目录**不是 git 仓库**但远程已存在同名仓库时显示该按钮，仅执行 `git init`（+设默认身份），**不拉取不推送**，由用户自行决定下一步是拉取还是推送
- **新建仓库并推送**：默认以**文件夹名**为仓库名（只读不可改），可选**私有/公开**；同名仓库已存在时**按钮禁用**并在下方提示「同名仓库已经创建」。若目录还是**全新的（尚无任何提交）**，会先自动 `git add` + 生成一个初始提交再创建，避免推送时报 "no commits found"
  - GitHub：`gh repo create --private|--public --source=. --push`
  - Gitee：用令牌调 Gitee OpenAPI `POST /user/repos` 建仓，再设置 SSH 远程 `git@gitee.com:<owner>/<name>.git` 并 `git push`（走 ② 已配的 SSH 密钥）
- **>100MB 文件处理**：自动识别超过 100MB 单文件限制的文件——文件在一级子目录内则**忽略整个一级目录**（该文件夹为一整体），根目录独立文件则**忽略单个文件**；已存在于 `.gitignore` 的不重复添加，并显示「未上传原因」

### 预加载优化
DSH 打开时自动预取环境/SSH/工作区/仓库状态，点开面板**直接秒显**，无需重新加载。

## 安装

### 关键前提：安装 ≠ 激活

`pnpm add`（无论是 `link:`、`git+` 还是 npm）只会把插件写进 profile 的 `package.json` 依赖和 `node_modules`，**并不会自动把插件注册进 Cordis loader 树**。要让左栏底部出现「代码管理」按钮，**还必须激活它**（见下方「激活配置（安装后必做）」）+ **完全重启 dsh web**。这也是 dsh-update 等本地插件共用的激活方式。

### 方式一：从 npm 官方包安装（推荐）

**最省事的方式**——只需一条命令，且不用先进 profile 目录，推荐给普通使用者。

**在任意目录执行：**
```bash
# 用 DSH 自带的插件命令（自动定位/初始化 web profile）
dsh plugin --profile web add source-code-mgmt
```

或者等价地手动操作：

```bash
cd ~/.dsh/profiles/web
pnpm add source-code-mgmt
dsh web
```

> 说明：`dsh plugin --profile web add <包名>` 本质是「在 web profile 目录里执行 `pnpm add <包名>`」并顺带对账插件层，比手动 `cd` 更省心。但它**同样不会自动把插件激活**（不会替你写 `cordis.patch.yml` 的 insert 条目），所以装完后仍需下面「激活配置」里的步骤 + 完全重启。

### 激活配置（安装后必做）

插件**不会**因为 `pnpm add` 就自动出现在侧边栏。请在 `~/.dsh/profiles/web/cordis.patch.yml` 中添加 insert 条目（若文件已有其他插件的 insert，照格式并列添加即可）：

```yaml
- insert:
    - id: source-code-mgmt
      name: 'source-code-mgmt'
```

保存后**完全重启 dsh web**（不是刷新页面，而是要停掉旧进程后重新启动），然后浏览器 **F5 刷新**，左栏底部即出现「代码管理」按钮。

> 用命令直接追加（幂等，已存在则跳过）——PowerShell：
> ```powershell
> $patch = "$HOME\.dsh\profiles\web\cordis.patch.yml"
> $addLines = "`n# Activate the source-code-mgmt plugin (installed as a profile dependency).`n- insert:`n    - id: source-code-mgmt`n      name: 'source-code-mgmt'`n"
> $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
> if (Test-Path $patch) {
>     $content = [System.IO.File]::ReadAllText($patch)
>     if ($content -notmatch 'source-code-mgmt') {
>         [System.IO.File]::AppendAllText($patch, $addLines, $utf8NoBom)
>         Write-Host "OK: 已追加 source-code-mgmt 激活条目" -ForegroundColor Green
>     } else {
>         Write-Host "SKIP: cordis.patch.yml 已包含 source-code-mgmt" -ForegroundColor Yellow
>     }
> } else {
>     Write-Host "ERROR: 未找到 $patch" -ForegroundColor Red
> }
> ```

### 方式二：从本地目录安装（开发/测试）

**Windows (PowerShell):**

```powershell
# 1. 进入你的 DSH profile 目录
cd ~/.dsh/profiles/web

# 2. 用 link 协议添加插件（指向本地源码绝对路径），会建立符号链接
pnpm add link:C:/path/to/source-code-mgmt

# 3. 激活插件：同上（见上方「激活配置」；追加 insert 条目后完全重启）
dsh web
```

**Linux / macOS:**

```bash
# 1. 进入你的 DSH profile 目录
cd ~/.dsh/profiles/web

# 2. 链接到插件源码目录（符号链接）
pnpm add link:/home/yourname/path/to/source-code-mgmt

# 3. 激活插件：同上（见上方「激活配置」；追加 insert 条目后完全重启）
dsh web
```

### 方式三：从 GitHub 安装（分发场景）

**Windows / Linux / macOS 通用:**

```bash
# 1. 进入你的 DSH profile 目录
cd ~/.dsh/profiles/web

# 2. 从 GitHub 安装插件（实际下载源码到 node_modules）
pnpm add git+https://github.com/Zhucy123/source-code-mgmt.git

# 3. 激活插件：同上（见上方「激活配置」；追加 insert 条目后完全重启）
dsh web
```

> 方式三装完同样**不会自动激活**（激活方式同方式一）；且它是**实际拷贝**到 node_modules，改动源码需重新 `pnpm add` 拉取（不像 `link:` 是符号链接、改源码即生效）。

### 验证安装是否成功

安装 + 激活 + 重启后，可以核对以下几点：

1. **依赖已写入**：`~/.dsh/profiles/web/package.json` 的 `dependencies` 里应有 `source-code-mgmt`。
2. **符号链接已建立（`link:` 方式）**：`~/.dsh/profiles/web/node_modules/source-code-mgmt` 指向源码目录（Windows 显示为 Junction）。
3. **激活条目已添加**：`~/.dsh/profiles/web/cordis.patch.yml` 里有 `source-code-mgmt` 的 insert 条目。
4. **重启后按钮可见**：左栏底部出现「代码管理」按钮。

### 常见排障

| 现象 | 原因 / 处理 |
|------|------------|
| 已 `pnpm add` 并重启，但按钮不出现 | 最常见：没在 `cordis.patch.yml` 里激活。补上 insert 条目后**完全重启**（不是刷新）。 |
| 改了 `cordis.patch.yml` 但仍不出现 | 服务未真正重启——旧进程还占着 3080 端口。停掉旧 `dsh web` 进程再启动。 |
| 出现「Failed to load plugins」 | 插件 host 端 `index.js` 启动报错（多为依赖解析问题）。查看启动日志，确认 `node_modules` 依赖已装齐。 |

## 使用步骤

1. 重启 dsh web 并刷新浏览器
2. 点击左栏底部「**代码管理**」按钮
3. 面板打开（秒显预加载数据）
4. ①确认 Git / GitHub CLI 已安装 → ②生成密钥并测试连接 → ③选择工作区后推送或新建仓库

## 后端 API 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/source-code-mgmt/env` | GET | 环境检查（git/gh 版本） |
| `/api/source-code-mgmt/ssh` | GET | SSH 密钥 / config / gh 登录状态 |
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
- `~/.ssh` 通过 `homedir()` 定位（Windows: `C:\Users\用户名\ .ssh`，Linux: `/home/用户名/.ssh`）
- Linux/macOS 下 SSH config 自动设 0600 权限
- **git / gh / ssh / ssh-keygen 二进制自动探测**：启动时依次按 ①环境变量覆盖 → ②PATH 查找（Windows 加 `.exe`）→（仅 Windows）③Git 自带目录（`usr\bin` / `bin`）回退，最后兜底用裸命令名。因此只要装了 Git，即使 `ssh` 不在 PATH 里也能正常工作，换设备无需额外配置。
- 如需手动指定二进制路径，可用环境变量覆盖：`DSH_SCM_GIT` / `DSH_SCM_GH` / `DSH_SCM_SSH` / `DSH_SCM_SSH_KEYGEN`
- **SSH 传输修复**：Git for Windows 自带的 MSYS `ssh.exe`（`usr\bin\ssh.exe`）在被 detached/agent 进程调用时可能报 `couldn't create signal pipe, Win32 error 5`，导致 `git push`/`git pull` 失败。插件执行 git 远程命令时会自动注入 `GIT_SSH` 指向解析到的可用 `ssh`（通常为系统 OpenSSH `C:\Windows\System32\OpenSSH\ssh.exe`），避免该问题。

## 开发

```bash
git clone https://github.com/Zhucy123/source-code-mgmt.git
cd source-code-mgmt
# 在本地 DSH 测试
cd ~/.dsh/profiles/web
pnpm add link:$(pwd)
```

- 改动 `lib/client.js`（浏览器端）→ 刷新页面即生效
- 改动 `lib/index.js`（host/Node 端）→ 需重启 dsh web

## 版本历史

### v1.1.1（当前）
本次更新：

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
