# source-code-mgmt — DSH 源代码管理插件

> DSH Web GUI 侧边栏插件：把「环境检查 → SSH 配置 → 代码上传推送」整合进左栏底部的「代码管理」按钮，一键管理 GitHub 仓库。

## 功能

集成在 **左侧边栏底部**（会话栏底部，通过 `sidebar.footer.action` 插槽），点击「代码管理」按钮打开面板，分三步：

### ① 环境检查
- 显示**操作系统**（平台类型，如 `win32`）
- 自动检测 **Git**、**GitHub CLI** 是否安装及版本（如 `git version 2.55.0`、`gh version 2.97.0`）
- 检测 **SSH** 客户端是否可用（解析到可用 `ssh` 即显示「已找到」）
- 未安装时提示先安装 Git for Windows / GitHub CLI

### ② SSH 密钥与连接
- 检测本机 `~/.ssh/id_ed25519` 密钥是否存在
- 一键**生成 ed25519 密钥**（无密码）
- 一键**写入 SSH config**（`github.com → ssh.github.com:443` 端口，满足国内网络绕过 22 端口封锁）
- **测试连接** `ssh -T git@github.com`
- 显示公钥内容，方便复制上传到 GitHub
- 检测 `gh` 是否已登录及账号

### ③ 代码管理
- **选择工作区**：下拉选择 DSH 已登记的工作区文件夹（如 `deepseek-harness` / `workspace` / `quiz-app`），选中即加载
- **选择目录 →**：下拉右侧按钮，可手动输入/粘贴目录绝对路径或点击「浏览…」弹出原生文件夹选择器；确认后**持久化加入下拉列表**（插件独立存储于 `~/.dsh/storages/source-code-mgmt-dirs.json`），下次打开无需重新选择
- 显示仓库状态：分支、远程地址、待提交改动数、领先/落后远程、>100MB 文件
- **动态操作按钮**：根据本地与远程的相对状态自动显示——
  - 只有本地有更改 → 只显示「推送更改」（`git add` + `commit` + `push`）
  - 只有远程有更新 → 只显示「拉取更新」（`git pull --ff-only`）
  - 本地和远程都有更新 → 显示三按钮：「拉取更新并推送更改」（`git pull --rebase` + `push`）、「强制推送」（`git push --force`，用本地覆盖远程）、「强制拉取」（`git pull --force`，并入远程更新）
  - 完全同步 → 显示「✓ 已是最新」
- **新建仓库并推送**：默认以**文件夹名**为仓库名（只读不可改），可选**私有/公开**，`gh repo create --private|--public --source=. --push`；同名仓库已存在时**按钮禁用**并在下方提示「同名仓库已经创建」
- **>100MB 文件处理**：自动识别超过 GitHub 100MB 单文件限制的文件——文件在一级子目录内则**忽略整个一级目录**（该文件夹为一整体），根目录独立文件则**忽略单个文件**；已存在于 `.gitignore` 的不重复添加，并显示「未上传原因」

### 预加载优化
DSH 打开时自动预取环境/SSH/工作区/仓库状态，点开面板**直接秒显**，无需重新加载。

## 安装

### 方式一：从本地目录安装（开发/测试）

**Windows (PowerShell):**

```powershell
cd ~/.dsh/profiles/web
pnpm add link:C:/path/to/source-code-mgmt
dsh web
```

**Linux / macOS:**

```bash
cd ~/.dsh/profiles/web
pnpm add link:/home/yourname/path/to/source-code-mgmt
dsh web
```

### 方式二：从 GitHub 安装

**Windows / Linux / macOS 通用:**

```bash
cd ~/.dsh/profiles/web
pnpm add git+https://github.com/你的用户名/source-code-mgmt.git
dsh web
```

### 方式三：从 npm 安装（如果已发布）

```bash
cd ~/.dsh/profiles/web
pnpm add source-code-mgmt
dsh web
```

### 激活配置（可选）

如果插件未自动出现在「插件市场 → 已安装」，在 `~/.dsh/profiles/web/cordis.patch.yml` 中添加 insert 条目：

```yaml
- insert:
    - id: source-code-mgmt
      name: 'source-code-mgmt'
```

安装后重启 dsh web，然后浏览器 **F5 刷新**，左栏底部即出现「代码管理」按钮。

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
| `/api/source-code-mgmt/write-config` | POST | 写入 github.com SSH config |
| `/api/source-code-mgmt/ssh-test` | POST | 测试 SSH 连接 |
| `/api/source-code-mgmt/default-dir` | GET | 当前工作区目录 |
| `/api/source-code-mgmt/workspaces` | GET | 列出所有工作区目录（DSH 工作区 + 插件自定义目录） |
| `/api/source-code-mgmt/pick-dir` | POST | 宿主端弹出原生文件夹选择对话框，返回选中的路径 |
| `/api/source-code-mgmt/add-workspace` | POST | 校验目录存在并持久化加入插件自定义目录列表，返回合并后的工作区列表 |
| `/api/source-code-mgmt/repo-exists` | POST | 检测同名仓库是否存在 |
| `/api/source-code-mgmt/repo?dir=` | GET | 获取仓库状态 |
| `/api/source-code-mgmt/push` | POST | 提交并推送 |
| `/api/source-code-mgmt/pull` | POST | 从远程拉取更新（`git pull --ff-only`，已最新/成功/冲突反馈） |
| `/api/source-code-mgmt/merge-push` | POST | 拉取并推送（`git pull --rebase` + `git push`，本地有更改且远程有更新时合并推送） |
| `/api/source-code-mgmt/force-push` | POST | 强制推送（`git push --force`，覆盖远程为本地状态） |
| `/api/source-code-mgmt/force-pull` | POST | 强制拉取（`git pull --force`，拉入远程更新） |
| `/api/source-code-mgmt/create` | POST | 新建私有/公开仓库并推送 |
| `/api/source-code-mgmt/set-visibility` | POST | 修改已有仓库的可见性（`gh repo edit --visibility private|public`） |

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
git clone https://github.com/你的用户名/source-code-mgmt.git
cd source-code-mgmt
# 在本地 DSH 测试
cd ~/.dsh/profiles/web
pnpm add link:$(pwd)
```

- 改动 `lib/client.js`（浏览器端）→ 刷新页面即生效
- 改动 `lib/index.js`（host/Node 端）→ 需重启 dsh web

## License

MIT
