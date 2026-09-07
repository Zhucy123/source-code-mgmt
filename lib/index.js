/**
 * source-code-mgmt — host half (Node).
 *
 * Provides /api routes for the browser half that wrap the git / gh / ssh
 * command line for a "源代码管理" (source code management) sidebar tool:
 *
 *   GET  /api/source-code-mgmt/env          — git & gh presence/version
 *   GET  /api/source-code-mgmt/ssh          — ssh key + config + gh auth status
 *   POST /api/source-code-mgmt/gen-key      — generate ed25519 key (no passphrase)
 *   POST /api/source-code-mgmt/write-config — write ~/.ssh/config for github|gitee (443)
 *   POST /api/source-code-mgmt/ssh-test     — ssh -T git@<host> connectivity (github|gitee)
 *   GET  /api/source-code-mgmt/repo?dir=    — status of the selected folder
 *   POST /api/source-code-mgmt/push         — commit+push (auto .gitignore >100MB)
 *   POST /api/source-code-mgmt/create       — gh repo create --private --source=. --push
 *
 * All routes are loopback-only (same-machine browsers only).
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync,
  readdirSync, statSync, openSync, readSync, closeSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'

// ---------- i18n: host messages follow the client’s language (?lang= query param, per request) ----------
const HOST_EN = {"尚未配置 Gitee 私人令牌（请打开 ③ 代码管理输入令牌）":"No Gitee personal token configured (enter one in ③ Code Management)","Gitee API 请求失败（需要 curl）":"Gitee API request failed (curl required)","not a git repository（尚未 git init，可用「新建仓库并推送」初始化为 git 仓库并上传）":"not a git repository (run \"Create repo & push\" to init one and upload)","超过 GitHub 100MB 单文件限制（${}），已被 .gitignore 的 \"${}\" 排除":"Exceeds GitHub's 100MB file limit (${}) — already excluded by .gitignore entry \"${}\"","超过 GitHub 100MB 单文件限制（${}），${} 所在的一级目录「${}」整体忽略（该文件夹为一整体）":"Exceeds GitHub's 100MB file limit (${}) — the whole first-level folder \"${}\" of ${} is ignored (the folder is one unit)","超过 GitHub 100MB 单文件限制（${}），已忽略单个文件「${}」":"Exceeds GitHub's 100MB file limit (${}) — the file \"${}\" was ignored individually","尚未配置远程仓库 origin，请使用「新建仓库」创建远程仓库。":"No origin remote configured — use \"Create repo\" to create a remote repo.","not a git repository（尚未 git init，无法拉取）":"not a git repository (no git init yet — cannot pull)","尚未配置远程仓库 origin，无法拉取。":"No origin remote configured — cannot pull.","拉取存在冲突：本地有未合并改动或与远程冲突，请手动 git pull 处理合并。":"Pull conflicts: you have unmerged local changes or conflicts with the remote — resolve them manually with git pull.","git pull 失败":"git pull failed","not a git repository（尚未 git init）":"not a git repository (run git init first)","拉取并推送失败：合并存在冲突，请手动解决后重试。":"Pull-and-push failed: merge conflicts — resolve them manually and retry.","pull --rebase 失败":"pull --rebase failed","push 失败":"push failed","push --force 失败":"push --force failed","强制拉取存在冲突，请手动处理。":"Force-pull conflicts — handle them manually.","git pull --force 失败":"git pull --force failed","缺少仓库名称":"Repo name required","仓库名称包含非法字符（仅允许字母、数字、点、下划线、横线）":"Repo name contains invalid characters (only letters, digits, dots, underscores, dashes)","git add 失败：${}":"git add failed: ${}","需要先配置 Gitee 私人令牌":"Configure the Gitee personal token first","Gitee 创建仓库失败":"Failed to create the Gitee repo","缺少文件路径":"File path required","无法识别当前分支":"Cannot determine the current branch","尚未配置远程仓库 origin，无法对齐。":"No origin remote configured — cannot align.","git fetch 失败":"git fetch failed","git reset --hard 失败":"git reset --hard failed","git init 失败":"git init failed","git add 失败":"git add failed","git reset 失败":"git reset failed","提交信息不能为空":"Commit message cannot be empty","没有已暂存（staged）的改动可提交":"Nothing staged to commit","git commit 失败":"git commit failed","缺少分支名":"Branch name required","切换分支失败":"Failed to switch branch","git log 失败":"git log failed","缺少 commit hash":"Commit hash required","revert 失败（可能有冲突，请手动处理）":"revert failed (possible conflicts — handle manually)","cherry-pick 失败（可能有冲突，请手动处理）":"cherry-pick failed (possible conflicts — handle manually)","读取提交 diff 失败":"Failed to read the commit diff","未知工具：":"Unknown tool: ","未找到可用的包管理器（":"No usable package manager found (","）。请手动安装。":"). Please install manually.","安装成功":"Installed successfully","安装失败":"Installation failed","$dlg.Description = '选择本地目录';":"$dlg.Description = 'Choose a local folder';","Gitee 修改可见性失败":"Failed to change Gitee visibility","需要先登录 GitHub CLI（gh）":"Log in to the GitHub CLI (gh) first","修改可见性失败：${}":"Failed to change visibility: ${}","gh repo edit 失败":"gh repo edit failed","缺少目录路径":"Folder path required","未选择目录":"No folder selected","目录不存在或不是文件夹：":"Folder does not exist or is not a directory: ","令牌不能为空":"Token cannot be empty","Gitee 令牌无效，请检查（需有 projects 权限）":"Invalid Gitee token — check it (needs projects permission)"};
const requestLangStore = new AsyncLocalStorage();
// 新增板块（④克隆 / ⑤npm）的 host 英文消息，追加进 HOST_EN。
Object.assign(HOST_EN, {
  "LLM 服务不可用（未加载 llm 服务）": "LLM service unavailable (llm service not loaded)",
  "未找到默认模型配置（agent-default-model）": "No default model config found (agent-default-model)",
  "目标目录不存在：": "Target directory does not exist: ",
  "已存在同名目录：": "A directory with that name already exists: ",
  "git clone 失败": "git clone failed",
  "无法识别仓库地址：": "Cannot parse repo URL: ",
  "没有可用的 PR 步骤（请先让 AI 分析规则）": "No PR steps available (run AI rule analysis first)",
  "确保 fork": "Ensure fork",
  "已 fork 或 fork 已存在": "Forked already, or fork exists",
  "克隆 fork": "Clone fork",
  "已存在本地副本：": "Local copy already exists: ",
  "已克隆到 ": "Cloned to ",
  "克隆 fork 失败": "Failed to clone fork",
  "添加上游": "Add upstream",
  "拉取上游": "Fetch upstream",
  "拉取失败": "Fetch failed",
  "新建分支": "Create branch",
  "创建分支失败": "Failed to create branch",
  "写入条目": "Write entry",
  "缺少条目文件路径": "Missing entry file path",
  "重生成 README": "Regenerate README",
  "无命令，跳过": "No command, skipped",
  "执行失败": "Command failed",
  "提交": "Commit",
  "推送": "Push",
  "创建 PR": "Create PR",
  "创建 PR 失败": "Failed to create PR",
  "未知步骤": "Unknown step",
  "未知步骤类型": "Unknown step type",
  "缺少仓库地址": "Repo URL required",
  "未登录 npm": "Not logged in to npm",
  "npm publish 已执行": "npm publish executed",
  "npm publish 失败": "npm publish failed",
  "已提交": "Committed",
  "已创建 PR": "PR created",
  "推送上游失败": "Failed to push",
  "AI 未输出有效规则": "AI produced no valid rules",
  "AI 输出无法解析": "AI output could not be parsed",
  "推送失败": "Push failed",
  "条目文件路径不安全（已拦截）": "Entry file path unsafe (blocked)",
  "重生成命令不安全（已拦截）": "Regenerate command unsafe (blocked)",
  "创建分支失败（上游分支可能不存在，请检查规则 baseBranch）": "Failed to create branch (upstream base may not exist — check the rule's baseBranch)",
  "已打开终端窗口，请完成 npm login 后回到面板点「重新检查」": "A terminal window has been opened — complete npm login, then click \"Re-check\" in the panel",
  "已打开终端窗口，请完成 gh 登录后回到面板点「重新检查」": "A terminal window has been opened — complete gh login, then click \"Re-check\" in the panel",
  "已打开终端窗口，请完成 gitee 登录后回到面板点「重新检查」": "A terminal window has been opened — complete gitee login, then click \"Re-check\" in the panel",
  "无法读取 Gitee CLI 令牌（请先 gitee auth login）": "Could not read the Gitee CLI token — run gitee auth login first",
  "无法读取当前版本": "Cannot read the current version",
  "无法获取最新版本": "Could not fetch the latest version",
  "未找到可用终端，请手动在终端运行：": "No usable terminal found — run this manually in a terminal: ",
  "未找到可用终端，请手动在目标目录运行：": "No usable terminal found — run this manually in the target directory: ",
  "需要管理员密码（当前 sudo 需要密码，无法在面板内自动执行），请在终端手动执行：": "Admin password required (sudo prompts for a password here, so the panel cannot run it) — run this manually in a terminal: ",
  "已触发安装，请按系统提示完成，然后点「重新检查」": "Installation started — follow the system prompt, then click \"Re-check\"",
  "查询最新版本…": "Fetching latest version…",
  "下载 gh 安装包…": "Downloading gh…",
  "解压…": "Extracting…",
  "安装到 ~/.local/bin…": "Installing to ~/.local/bin…",
  "清理临时文件…": "Cleaning up…",
  "执行安装命令：": "Running install command: ",
  "用户级安装失败，改用系统包管理器安装…": "User-level install failed — falling back to the system package manager…",
  "需要管理员密码，改用以下手动命令：": "Admin password required — run this manually: ",
  "配置源是镜像，发布将使用官方源：": "Configured registry is a mirror — publishing will use the official registry: ",
  "规则文件获取失败：": "Failed to fetch rules file: ",
  "规则文件读取失败：": "Failed to read rules file: ",
  "找不到规则文件：": "Rules file not found: ",
  "未获取到规则内容（文件为空或无法读取）": "Could not read any rule content (file empty or unreadable)",
})
function langOf(req) { try { const l = new URL(req.url ?? "", "http://localhost").searchParams.get("lang"); return l === "en" ? "en" : "zh" } catch { return "zh" } }
function lang() { return requestLangStore.getStore() ?? "zh" }
function tr(key, params) {
  let s = lang() === "en" ? (HOST_EN[key] ?? key) : key;
  if (params && params.length) { let i = 0; s = String(s).replace(/\$\{\}/g, () => String(params[i++] ?? "")) }
  return s
}


/** Stable cordis plugin name (also the browser bundle id). */
export const name = 'source-code-mgmt'

/** Services required before the routes can mount. */
export const inject = ['webServer']

/** API base path. */
const BASE = '/api/source-code-mgmt'

/** GitHub hard limit for a single committed file. */
const GH_FILE_LIMIT = 100 * 1024 * 1024

/** Detected platform. */
const IS_WIN = process.platform === 'win32'

/**
 * Cross-platform binary resolution.
 *
 * Every external command (git / gh / ssh / ssh-keygen) is resolved once at
 * module load through {@link resolveBin}, so the plugin works the same on any
 * machine regardless of whether the tool lives on PATH:
 *
 *   1. An explicit environment override wins (DSH_SCM_GIT / DSH_SCM_GH /
 *      DSH_SCM_SSH / DSH_SCM_SSH_KEYGEN).
 *   2. Otherwise the PATH is searched for the bare name (+ `.exe` on Windows).
 *   3. Windows Git bundles ssh/ssh-keygen inside its own prefix; when PATH
 *      has git but not ssh, the ssh tools fall back to that prefix first
 *      (`usr\bin`, then `bin`) and to common install locations.
 *   4. Last resort is the bare name — `run` then reports a descriptive error
 *      instead of a cryptic ENOENT.
 *
 * Resolution only performs pure probe calls (existsSync / directory walks),
 * never runs the tool, so it is safe at module scope.
 */

/** Resolved path to the git binary. */
const GIT = resolveBin('git', 'DSH_SCM_GIT')
/** Resolved path to the GitHub CLI binary. */
const GH = resolveBin('gh', 'DSH_SCM_GH')
/** Resolved path to the Gitee CLI binary (official oschina/gitee-cli, bin `gitee`). */
const GITEE = resolveBin('gitee', 'DSH_SCM_GITEE')
/** Resolved path to the ssh binary. */
const SSH = resolveBin('ssh', 'DSH_SCM_SSH')
/** Resolved path to the ssh-keygen binary. */
const SSH_KEYGEN = resolveBin('ssh-keygen', 'DSH_SCM_SSH_KEYGEN')
/** Resolved path to curl (used to call the Gitee OpenAPI). */
const CURL = resolveBin('curl', 'DSH_SCM_CURL')
/** Resolved path to npm (used by the ⑤ publish-npm section). */
const NPM = resolveBin('npm', 'DSH_SCM_NPM')

/**
 * Preferred ssh for git remote operations (injected via GIT_SSH).
 *
 * On Windows, Git for Windows ships an MSYS ssh (`usr\bin\ssh.exe`) that fails
 * with "couldn't create signal pipe, Win32 error 5" when spawned from a
 * detached/agent process, breaking `git push`/`git pull`. The Windows system
 * OpenSSH does not have this problem, so it is preferred when present,
 * regardless of PATH resolution order. Falls back to the resolved `SSH` (or
 * the bare name) otherwise.
 */
const WORKING_SSH = (() => {
  if (IS_WIN) {
    const sysOpenSsh = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    if (isFile(sysOpenSsh)) return sysOpenSsh
  }
  return SSH
})()

/** Return whether a filename exists and is a file (follows symlinks). */
function isFile(p) {
  try { return statSync(p).isFile() } catch { return false }
}

/** Split the platform PATH into absolute directories. */
function pathDirs() {
  return String(process.env.PATH ?? '')
    .split(IS_WIN ? ';' : ':')
    .map((p) => p.trim())
    .filter((p) => p !== '')
}

/** Resolve a bare command name against an explicit prefix directory. */
function probePrefix(prefix, name) {
  if (!name || !prefix) return undefined
  const candidates = [
    ...(IS_WIN ? [name + '.exe', name + '.cmd', name + '.bat', name] : [name]),
  ]
  for (const c of candidates) {
    const p = join(prefix, c)
    if (isFile(p)) return p
  }
  return undefined
}

/** Try to find `name` on PATH (with `.exe` on Windows). */
function findOnPath(name) {
  for (const dir of pathDirs()) {
    const found = probePrefix(dir, name)
    if (found) return found
  }
  return undefined
}

/** Git install prefix on Windows (where a bundled ssh / ssh-keygen lives). */
function windowsGitPrefixes() {
  const prefixes = []
  // Prefer a git that is already reachable: its install root is one level up
  // from the git binary on PATH (…\Git\cmd\git.exe -> …\Git).
  const gitOnPath = findOnPath('git')
  if (gitOnPath) {
    // …\Git\cmd\git.exe -> prefix …\Git
    const prefix = sanitizeWindowsGitPrefix(dirname(dirname(gitOnPath)))
    if (prefix) prefixes.push(prefix)
    // …\Git\usr\bin\git.exe -> prefix …\Git (when git came from usr/bin)
    const prefixUsr = sanitizeWindowsGitPrefix(dirname(dirname(dirname(gitOnPath))))
    if (prefixUsr) prefixes.push(prefixUsr)
  }
  for (const base of [
    'C:\\Program Files\\Git',
    'C:\\Program Files (x86)\\Git',
    join(homedir(), 'scoop', 'apps', 'git'),
    join(homedir(), 'AppData', 'Local', 'Programs', 'Git'),
  ]) {
    prefixes.push(base)
  }
  return prefixes
}

/** Clean a Windows Git prefix candidate (must look like a Git root). */
function sanitizeWindowsGitPrefix(p) {
  try {
    if (!p) return undefined
    // A Git root contains usr/bin; keep only if it seems plausible.
    if (isFile(join(p, 'usr', 'bin', 'ssh.exe')) || isFile(join(p, 'bin', 'ssh.exe'))) return p
  } catch { /* ignore */ }
  return undefined
}

/**
 * Resolve an external tool path. See the module doc on {@link resolveBin}.
 * @param {string} name - bare command name, e.g. 'ssh'.
 * @param {string} envVar - override env var, e.g. 'DSH_SCM_SSH'.
 * @returns {string} a usable path or the bare name.
 */
function resolveBin(name, envVar) {
  const override = process.env[envVar]
  if (override) return override
  // 1) PATH hit is the most portable answer.
  const onPath = findOnPath(name)
  if (onPath) return onPath
  // 1.5) Linux/macOS 用户级安装目录：免 sudo 安装的 gh（本插件的「一键安装」落点）
  //      也会装到这里，即使 ~/.local/bin 不在 shell PATH 中，模块加载时也能解析到。
  if (!IS_WIN) {
    const userBin = probePrefix(join(homedir(), '.local', 'bin'), name)
    if (userBin) return userBin
  }
  // 2) Windows: git bundles ssh / ssh-keygen.
  if (IS_WIN) {
    for (const prefix of windowsGitPrefixes()) {
      const probe = probePrefix(join(prefix, 'usr', 'bin'), name)
        ?? probePrefix(join(prefix, 'bin'), name)
      if (probe) return probe
    }
  }
  // 3) Fall back to the bare name so `run` reports the tool by name.
  return name
}

/** ~/.ssh path. */
function sshDir() {
  return join(homedir(), '.ssh')
}

/**
 * Scan ~/.ssh for ed25519 PUBLIC keys (`ssh-ed25519 ...`). Returns the base
 * names (file name without the `.pub` suffix), sorted alphabetically.
 */
function findEd25519Keys() {
  const dir = sshDir()
  const names = []
  let entries = []
  try { entries = readdirSync(dir) } catch { return names }
  for (const e of entries) {
    if (!e.endsWith('.pub')) continue
    try {
      const content = readFileSync(join(dir, e), 'utf8')
      if (/^\s*ssh-ed25519\s+/.test(content)) names.push(e.slice(0, -4))
    } catch { /* unreadable pub — skip */ }
  }
  return names.sort()
}

/**
 * Resolve the SSH key base name to use (file name without `.pub`):
 *   - prefer the conventional `id_ed25519` when it exists;
 *   - otherwise use the FIRST detected ed25519 key (supports a custom-named key);
 *   - if none exists, return the default `id_ed25519` (the name a newly generated
 *     key will get — the well-known standard name that SSH/Git tooling expect).
 */
function resolveKeyBase() {
  const names = findEd25519Keys()
  if (names.includes('id_ed25519')) return 'id_ed25519'
  if (names.length > 0) return names[0]
  return 'id_ed25519'
}

/** Full path to the ed25519 private key (base resolved from existing keys). */
function privateKeyPath() {
  return join(sshDir(), resolveKeyBase())
}

/** Full path to the ed25519 public key (base resolved from existing keys). */
function publicKeyPath() {
  return join(sshDir(), resolveKeyBase() + '.pub')
}

/** Full path to ssh config. */
function configPath() {
  return join(sshDir(), 'config')
}

/** Whether the host is a local (loopback) request. */
function isLoopbackRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return false
  } catch {
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read a JSON body (POST). */
async function readBody(req, limit = 1 << 20) {
  return await new Promise((resolve, reject) => {
    let data = ''
    let settled = false
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) {
        settled = true
        reject(new Error('body too large'))
        req.destroy()
        return
      }
    })
    req.on('end', () => { if (!settled) resolve(data) })
    req.on('error', (err) => reject(err))
  })
}

/** Run a command, capture combined stdout/stderr + exit code (never throws). */
function run(cmd, args, opts = {}) {
  // Git for Windows bundles an MSYS ssh (usr\bin\ssh.exe) that fails to create
  // its signal pipe when spawned from a detached/agent process, making
  // `git push`/`git pull` over SSH fail with "couldn't create signal pipe,
  // Win32 error 5". Force git to use the resolved (working, usually the system
  // OpenSSH) ssh via GIT_SSH so remote operations succeed on every platform.
  const env = { ...process.env, ...(opts.env ?? {}) }
  if (cmd === GIT && !env.GIT_SSH && WORKING_SSH) {
    env.GIT_SSH = WORKING_SSH
  }
  // core.quotepath 默认开启：git 会把含非 ASCII 字节的路径输出成带八进制转义
  // 的引号形式（如 "\346\270\270\346\210\217\346\250\241\345\274\217…md"），
  // 中文文件名在改动列表 / diff 里就会显示成乱码。统一用
  // `-c core.quotepath=false` 让 git 直接输出原始 UTF-8 路径，Node 以 utf8
  // 解码后即得到正确的中文文件名（git diff / git show 头部路径也一并修复）。
  const finalArgs = cmd === GIT ? ['-c', 'core.quotepath=false', ...args] : args
  // Windows + shell 模式：execFileSync 把 cmd 与参数拼成一条命令行交给 cmd.exe。
  // 若可执行文件路径含空格（如 "C:\Program Files\nodejs\npm.cmd"），不引号包裹会
  // 被截断成 "'C:\Program' 不是内部命令"。这里只包裹可执行文件本身（参数保持数组，
  // 由 execFileSync 逐个安全拼接），不触碰用户输入，无注入面。
  const execCmd = (opts.shell && IS_WIN && /\s/.test(cmd)) ? '"' + cmd + '"' : cmd
  try {
    const out = execFileSync(execCmd, finalArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 30_000,
      cwd: opts.cwd,
      env,
      shell: opts.shell ?? (IS_WIN && (opts.forceShell || false)),
    })
    return { ok: true, code: 0, stdout: out, stderr: '' }
  } catch (error) {
    const code = typeof error.status === 'number' ? error.status : 1
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : String(error.message ?? '')
    return { ok: code === 0, code, stdout, stderr }
  }
}

/**
 * 流式执行一条命令（spawn）：stdout/stderr 分块实时回调 onChunk，
 * 进程退出后 resolve { ok, code, stdout, stderr }。用于一键安装的进度展示。
 */
function runLive(cmd, args, opts = {}) {
  const { onChunk, timeout = 300_000 } = opts
  const env = { ...process.env, ...(opts.env ?? {}) }
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer = null
    let child
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      finish({ ok: false, code: 1, stdout: '', stderr: String(error?.message ?? error) })
      return
    }
    timer = timeout > 0 ? setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeout) : null
    const push = (buf, stream) => {
      const text = buf.toString('utf8')
      if (stream === 'out') stdout += text
      else stderr += text
      if (onChunk) { try { onChunk(text, stream) } catch {} }
    }
    child.stdout?.on('data', (b) => push(b, 'out'))
    child.stderr?.on('data', (b) => push(b, 'err'))
    child.on('error', (error) => {
      finish({ ok: false, code: 1, stdout, stderr: stderr || String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, code: code ?? 1, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------------------
// 纯本地解析 / 解码
// ---------------------------------------------------------------------------

/**
 * Decode a path as printed by git. With core.quotepath ON (the default) git
 * prints paths containing non-ASCII bytes / special characters as a
 * double-quoted C-style string with octal escapes, e.g.
 * `"\346\270\270\346\210\217\346\250\241\345\274\217Agent\351\242\204\350\256\276.md"`
 * for `游戏模式Agent预设.md`. This unescapes that form back into the real
 * UTF-8 path. Paths that are not quoted (already raw UTF-8, e.g. when
 * core.quotepath=false) pass through unchanged.
 * @param {string} raw - path fragment as printed by git.
 * @returns {string} decoded path.
 */
function parseGitPath(raw) {
  const s = String(raw ?? '')
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return s
  const inner = s.slice(1, -1)
  const bytes = []
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch !== '\\') { bytes.push(inner.charCodeAt(i)); continue }
    const nxt = inner[i + 1]
    if (nxt >= '0' && nxt <= '7') {
      let v = 0
      let n = 0
      while (n < 3 && i + 1 + n < inner.length) {
        const d = inner.charCodeAt(i + 1 + n) - 48
        if (d < 0 || d > 7) break
        v = v * 8 + d
        n++
      }
      bytes.push(v)
      i += n
      continue
    }
    const esc = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c }[nxt]
    if (esc !== undefined) { bytes.push(esc); i++; continue }
    bytes.push(inner.charCodeAt(i))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Check a tool (git/gh) — version when installed. */
function toolStatus(bin, args) {
  const r = run(bin, args)
  if (!r.ok) return { installed: false }
  const version = (r.stdout || r.stderr).trim().split(/\r?\n/)[0]
  return { installed: true, version }
}

/** Friendly OS label mapped from process.platform (win32 -> Windows, etc.). */
function platformLabel() {
  switch (process.platform) {
    case 'win32': return 'Windows'
    case 'darwin': return 'macOS'
    case 'linux': return 'Linux'
    case 'freebsd': return 'FreeBSD'
    default: return process.platform
  }
}

/** Environment check: git + gh presence (plus resolved ssh whereabouts). */
function checkEnv() {
  return {
    platform: process.platform,
    platformLabel: platformLabel(),
    isWin: IS_WIN,
    os: process.env.OS ?? '',
    home: homedir(),
    git: toolStatus(GIT, ['--version']),
    gh: toolStatus(GH, ['--version']),
    gitee: toolStatus(GITEE, ['--version']),
    ssh: {
      installed: SSH !== 'ssh' && SSH !== 'ssh.exe',
      path: SSH,
      sshKeygen: SSH_KEYGEN,
    },
    // 平台自适应的可复制安装命令（与「一键安装」走同一逻辑；无可用方式时为 null）。
    installHints: {
      git: installCommand('git')?.label ?? null,
      gh: installCommand('gh')?.label ?? null,
      gitee: installCommand('gitee')?.label ?? null,
      ssh: installCommand('ssh')?.label ?? null,
    },
    // gh 可选的下载镜像（全平台非空；UI 据此渲染「下载源」下拉）。Windows 也支持：
    // gh 未装时下载官方 msi（镜像=前缀+官方 URL）→ msiexec 静默安装，避免 winget 直连 GitHub 卡慢。
    ghMirrors: GH_MIRRORS,
  }
}

/**
 * Configuration for the active codeforge provider (github or gitee).
 * `port` 443 keeps SSH usable on many domestic networks that block port 22.
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 */
function providerCfg(provider) {
  const name = provider === 'gitee' ? 'gitee' : 'github'
  return {
    name, // 'github' | 'gitee'
    host: name === 'gitee' ? 'gitee.com' : 'github.com',       // Host key in ~/.ssh/config
    hostname: name === 'gitee' ? 'gitee.com' : 'ssh.github.com', // 443 SSH endpoint
    port: 443,
    gitUser: 'git',
    testAddr: name === 'gitee' ? 'git@gitee.com' : 'git@github.com',
    label: name === 'gitee' ? 'Gitee' : 'GitHub',
  }
}

/** SSH key & config & gh auth summary. */
function checkSsh() {
  const keyBase = resolveKeyBase()
  const hasKey = existsSync(privateKeyPath())
  const hasPub = existsSync(publicKeyPath())
  const hasConfig = existsSync(configPath())
  let pubContent = ''
  if (hasPub) {
    try { pubContent = readFileSync(publicKeyPath(), 'utf8').trim() } catch {}
  }
  let configContent = ''
  if (hasConfig) {
    try { configContent = readFileSync(configPath(), 'utf8') } catch {}
  }
  // gh auth status -> which account.
  const ghAuth = run(GH, ['auth', 'status'], { timeout: 20_000 })
  const ghLoggedIn = ghAuth.ok && /Logged in to github\.com/i.test(ghAuth.stdout + ghAuth.stderr)
  const ghAccount = (() => {
    const blob = ghAuth.stdout + ghAuth.stderr
    const m = /account\s+(\S+)/i.exec(blob)
    return m ? m[1] : undefined
  })()

  // gitee auth status（官方 Gitee CLI，未安装时 run 失败 → 未登录）。
  const giteeAuth = run(GITEE, ['auth', 'status'], { timeout: 20_000 })
  const giteeBlob = giteeAuth.stdout + giteeAuth.stderr
  const giteeLoggedIn = giteeAuth.ok && /logged in|已登录|登录成功|authenticated/i.test(giteeBlob)
  const giteeAccount = (() => {
    const m = /(?:account|账号|用户)\s*[:：]?\s*(\S+)/i.exec(giteeBlob)
    return m ? m[1] : undefined
  })()

  return {
    hasKey,
    hasPub,
    hasConfig,
    pubContent,
    configContent,
    sshDir: sshDir(),
    // 当前使用的密钥文件名（不含 .pub）：优先 id_ed25519，否则自动探测到的第一个 ed25519 密钥名。
    keyBase,
    keyName: hasPub ? keyBase : null,
    ghLoggedIn,
    ghAccount,
    // Gitee CLI 登录状态（官方 gitee CLI 的 auth status；未装 CLI 时 giteeLoggedIn=false）。
    giteeLoggedIn,
    giteeAccount,
    // Per-provider SSH config presence (used by the panel's provider selector).
    sshGitHubConfigured: /\bHost\s+github\.com\b/.test(configContent),
    sshGiteeConfigured: /\bHost\s+gitee\.com\b/.test(configContent),
  }
}

/** Generate ed25519 key with no passphrase (non-interactive). Note: the
 *  generated name is the conventional `id_ed25519` (the default when no key
 *  exists). If an existing ed25519 key (any name) is present, it is reused. */
function generateKey() {
  if (existsSync(privateKeyPath())) {
    return { ok: true, alreadyExists: true, path: privateKeyPath(), keyBase: resolveKeyBase() }
  }
  try {
    mkdirSync(sshDir(), { recursive: true })
    const r = run(SSH_KEYGEN, ['-t', 'ed25519', '-N', '', '-f', privateKeyPath()], { timeout: 30_000 })
    return {
      ok: r.ok,
      alreadyExists: false,
      path: privateKeyPath(),
      keyBase: resolveKeyBase(),
      error: r.ok ? undefined : (r.stderr || r.stdout).trim(),
    }
  } catch (error) {
    return { ok: false, alreadyExists: false, path: privateKeyPath(), keyBase: resolveKeyBase(), error: String(error) }
  }
}

/**
 * Write the SSH config block (Host <host> on port 443) for github or gitee.
 * Domestic 443 keeps SSH usable on networks that block port 22.
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 */
function writeSshConfig(provider) {
  const cfg = providerCfg(provider)
  try {
    mkdirSync(sshDir(), { recursive: true })
    let current = ''
    if (existsSync(configPath())) {
      current = readFileSync(configPath(), 'utf8')
    }
    if (new RegExp('\\bHost\\s+' + cfg.host + '\\b').test(current)) {
      return { ok: true, alreadyConfigured: true, path: configPath(), provider: cfg.name, host: cfg.host }
    }
    const block = [
      '',
      'Host ' + cfg.host,
      '  Hostname ' + cfg.hostname,
      '  Port ' + cfg.port,
      '  User ' + cfg.gitUser,
      '  IdentityFile ~/.ssh/' + resolveKeyBase(),
      '',
    ].join('\n')
    writeFileSync(configPath(), current + block, 'utf8')
    if (!IS_WIN) {
      try { chmodSync(configPath(), 0o600) } catch {}
    }
    return { ok: true, alreadyConfigured: false, path: configPath(), provider: cfg.name, host: cfg.host, block }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

/**
 * ssh -T git@<host> connectivity test for github or gitee
 * (accept-new so a new host key is auto-trusted).
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 */
function sshTest(provider) {
  const cfg = providerCfg(provider)
  const r = run(SSH, ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', '-T', cfg.testAddr], { timeout: 45_000 })
  const blob = (r.stdout + '\n' + r.stderr)
  const authed = /Hi\s+(\S+?)[!\s]/.exec(blob)
  return {
    ok: authed !== null,
    account: authed ? authed[1] : undefined,
    connected: r.ok || authed !== null,
    provider: cfg.name,
    host: cfg.host,
    detail: blob.trim(),
  }
}

// ---------------------------------------------------------------------------
// Gitee (OpenAPI) support — ③ 代码管理 in Gitee mode uses the Gitee REST API
// (https://gitee.com/api/v5) with a personal access token the user enters in
// the panel. The token is stored only under ~/.dsh/storages (0600), never in
// the plugin directory. When no token is configured, GitHub-mode features
// simply report "需要配置 Gitee 令牌".
// ---------------------------------------------------------------------------

/** Persisted file holding the user-entered Gitee personal access token. */
function giteeTokenFile() {
  return join(homedir(), '.dsh', 'storages', 'source-code-mgmt-gitee.json')
}

/** Read the stored Gitee token (trimmed, empty string when none). Never throws. */
function readGiteeToken() {
  try {
    const file = giteeTokenFile()
    if (!existsSync(file)) return ''
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return typeof data === 'object' && typeof data.token === 'string' ? data.token.trim() : ''
  } catch {
    return ''
  }
}

/** Persist (or clear, when empty) the Gitee token. Best-effort, never throws. */
function saveGiteeToken(token) {
  const value = String(token || '').trim()
  try {
    const file = giteeTokenFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ token: value }, null, 2), 'utf8')
    if (!IS_WIN) {
      try { chmodSync(file, 0o600) } catch {}
    }
  } catch { /* ignore persistence errors */ }
  return value
}

/**
 * Call the Gitee OpenAPI v5.
 * @param {string} method - 'GET' | 'POST' | 'PATCH' | 'DELETE' | ...
 * @param {string} path - API path (no leading slash), e.g. 'user', 'user/repos'.
 * @param {object} [body] - JSON body for POST/PATCH (mutates nothing).
 * @param {string} [token] - Gitee personal access token (uses stored one when omitted).
 * @returns {{ ok: boolean, status?: number, data?: any, error?: string }}
 */
function giteeApi(method, path, body, token) {
  const tok = token || readGiteeToken()
  if (!tok) return { ok: false, error: tr('尚未配置 Gitee 私人令牌（请打开 ③ 代码管理输入令牌）') }
  const args = [
    '-sS', '-L',
    '-X', String(method || 'GET').toUpperCase(),
    '-H', 'Authorization: token ' + tok,
    '-H', 'Content-Type: application/json; charset=utf-8',
    '-H', 'User-Agent: source-code-mgmt-dsh',
    '--connect-timeout', '15',
    '--max-time', '60',
  ]
  if (body !== undefined && body !== null) args.push('-d', JSON.stringify(body))
  args.push('https://gitee.com/api/v5/' + String(path).replace(/^\/+/, ''))
  const r = run(CURL, args, { timeout: 70_000 })
  if (!r.ok) {
    return { ok: false, error: (r.stderr || r.stdout || '').trim() || tr('Gitee API 请求失败（需要 curl）') }
  }
  let data
  try { data = JSON.parse(r.stdout || '{}') } catch { data = null }
  return { ok: true, status: r.code, data }
}

/** The Gitee account login (owner) for the configured token, or undefined. */
function giteeOwner() {
  const api = giteeApi('GET', 'user')
  if (!api.ok || !api.data) return undefined
  return typeof api.data.login === 'string' && api.data.login !== '' ? api.data.login : undefined
}

/** Whether the Gitee API returned an "auth required / repo not found" style error. */
function giteeApiFailed(data) {
  return !!(data && typeof data === 'object' && data.message && /(auth|not found|forbidden|token)/i.test(String(data.message)))
}

// ---------------------------------------------------------------------------
// Recursively find working-tree files >100MB (skips .git and node_modules).
// ---------------------------------------------------------------------------
/** Recursively find working-tree files >100MB (skips .git and node_modules). */
function findLargeFiles(dir) {
  const large = []
  const scan = (base, rel) => {
    let entries
    try { entries = readdirSync(base) } catch { return }
    for (const entry of entries) {
      if (entry === '.git' || entry === 'node_modules') continue
      const full = join(base, entry)
      const childRel = rel === '' ? entry : rel + '/' + entry
      let stat
      try { stat = statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        scan(full, childRel)
      } else if (stat.size > GH_FILE_LIMIT) {
        large.push({ path: childRel, bytes: stat.size })
      }
    }
  }
  scan(dir, '')
  return large
}

/**
 * Merge a list of >100MB files into top-level ignore entries.
 *
 * Rule (per user decision):
 *  - A large file living inside some first-level sub-directory
 *    (relative path contains '/') is treated as part of a unified folder,
 *    so the WHOLE first-level directory is ignored (e.g.
 *    `dsh-desktop/binary/dsh-desktop.exe` -> ignore `dsh-desktop/`).
 *  - A large file sitting directly at the repo root (no '/') is ignored as
 *    a single file (e.g. `dsh-desktop.zip`).
 *
 * Returns an array of unique entries:
 *   { path, bytes, kind: 'dir'|'file', source }
 * `bytes` is summed across every large file folded into the same entry.
 */
function groupIgnoreEntries(largeFiles) {
  const entries = new Map()
  for (const f of largeFiles) {
    const idx = f.path.indexOf('/')
    if (idx === -1) {
      // Root-level standalone large file -> ignore the single file.
      const cur = entries.get(f.path)
      entries.set(f.path, {
        path: f.path,
        bytes: f.bytes + (cur ? cur.bytes : 0),
        kind: 'file',
        source: f.path,
      })
    } else {
      // Inside a first-level sub-directory -> ignore the whole top directory.
      const top = f.path.slice(0, idx)
      const cur = entries.get(top)
      entries.set(top, {
        path: top,
        bytes: f.bytes + (cur ? cur.bytes : 0),
        kind: 'dir',
        source: f.path,
      })
    }
  }
  return [...entries.values()]
}

/** Whether a repo-relative path is already covered by .gitignore rules
 *  (git check-ignore exits 0 when ignored). */
function isIgnored(dir, rel) {
  if (!rel) return false
  const r = run(GIT, ['-C', dir, 'check-ignore', '-q', rel])
  return r.ok
}

/**
 * Plan the >100MB ignore strategy for a folder:
 * merges the raw large-file list into top-level entries and flags each entry
 * that is already covered by the existing .gitignore, so neither the status
 * panel nor the push flow re-adds duplicate/conflicting rules.
 */
function ignorePlan(dir) {
  const large = findLargeFiles(dir)
  const entries = groupIgnoreEntries(large).map((e) => ({
    ...e,
    ignored: isIgnored(dir, e.source),
  }))
  return { large, entries }
}

/**
 * Extract the repository owner (org/user) from a git remote URL, regardless of
 * form (`https://host/owner/repo.git` or `git@host:owner/repo.git`). Returns
 * the owner (lowercased) or undefined when it cannot be determined.
 */
function remoteOwner(url) {
  if (typeof url !== 'string' || url === '') return undefined
  // git@host:owner/repo.git
  let m = /git@[^:]+:(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (m) return m[1].toLowerCase()
  // https://host/owner/repo.git  或  ssh://git@host/owner/repo.git
  m = /(?:https?|ssh):\/\/[^\/]+\/(.+?)\/([^/]+?)(?:\.git)?\/?$/.exec(url)
  if (m) return m[1].toLowerCase()
  return undefined
}

/**
 * The current logged-in owner for a platform: 'github' -> gh owner (Zhucy123),
 * 'gitee' -> the Gitee token account (Zhucy2100). Returns undefined when the
 * account isn't available.
 *
 * A short-lived (5s) in-process cache is layered on top so a single /repo
 * request (which calls this up to 3 times via repoExists / providerRemoteName /
 * repoVisibility) only hits the network ONCE, and rapid sequential refreshes
 * stay instant.
 */
let ownerCache = { provider: undefined, value: undefined, ts: 0 }
function providerOwner(provider) {
  const p = provider === 'gitee' ? 'gitee' : 'github'
  const now = Date.now()
  if (ownerCache.provider === p && now - ownerCache.ts < 5000) return ownerCache.value
  const value = p === 'gitee' ? giteeOwner() : ghOwner()
  ownerCache = { provider: p, value, ts: now }
  return value
}

/**
 * Pick the git remote name that belongs to the given code-hosting platform AND
 * to the CURRENT logged-in account (owner). This way switching to Gitee reads
 * only gitee.com remotes, and a GitHub remote belonging to another user/org
 * (e.g. deepseek-ai/deepseek-harness) is NOT treated as the user's own remote.
 * Returns the remote name, or undefined when the folder has no remote for the
 * current platform + account.
 * @param {string} dir - local folder.
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 */
function providerRemoteName(dir, provider) {
  const want = provider === 'gitee' ? /gitee\.com/i : /github\.com/i
  const owner = providerOwner(provider)
  if (owner === undefined) return undefined
  const wantOwner = owner.toLowerCase()
  const r = run(GIT, ['-C', dir, 'remote'])
  if (!r.ok) return undefined
  let matched = undefined
  for (const name of r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')) {
    const u = run(GIT, ['-C', dir, 'remote', 'get-url', name])
    // 远程需属于所选平台 且 owner 等于当前账号，才视为「用户自己的远程」。
    if (u.ok && want.test(u.stdout) && remoteOwner(u.stdout) === wantOwner) {
      if (name === 'origin') return 'origin'
      if (matched === undefined) matched = name
    }
  }
  return matched
}

/**
 * Read a file for preview purposes, capped at `maxBytes` so a huge untracked
 * file never gets slurped into memory whole. Returns { buf, truncated }.
 * @param {string} full - absolute path.
 * @param {number} [maxBytes] - cap, default 1MB.
 */
function readFilePreview(full, maxBytes = 1024 * 1024) {
  const st = statSync(full)
  if (st.size <= maxBytes) return { buf: readFileSync(full), truncated: false }
  const fd = openSync(full, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    let off = 0
    while (off < maxBytes) {
      const n = readSync(fd, buf, off, maxBytes - off, off)
      if (n <= 0) break
      off += n
    }
    return { buf: buf.subarray(0, off), truncated: true }
  } finally {
    closeSync(fd)
  }
}

/**
 * Whether a changed file's content can be shown as text in the panel
 * (binary files cannot). 决定该文件是否显示「查看」：
 *  - 工作区里存在的文件：直接读取开头 8KB 嗅探（与 git 相同的 NUL 字节启发式）；
 *  - 已删除 / 工作区副本不存在的文件：用 `git diff --numstat` 的二进制标记判断
 *    （二进制条目输出 "-\t-"）。
 * @param {string} dir - repo root.
 * @param {string} path - repo-relative path.
 * @param {string} type - changedFiles 条目类型（untracked/added/deleted/renamed/modified）。
 * @returns {boolean} 内容是否可以按文本预览。
 */
function fileViewable(dir, path, type) {
  const p = String(path || '')
  if (p === '') return false
  try {
    const fd = openSync(join(dir, p), 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = readSync(fd, buf, 0, buf.length, 0)
      return !buf.subarray(0, n).includes(0)
    } finally {
      closeSync(fd)
    }
  } catch {
    // 工作区副本缺失（已删除、或暂存新增后又删掉）：交给 git 判断二进制。
    const cached = type === 'added' || type === 'renamed'
    const r = run(GIT, ['-C', dir, 'diff', ...(cached ? ['--cached', '--numstat'] : ['--numstat']), '--', p])
    const line = (r.stdout || '').split(/\r?\n/).find((l) => l.trim() !== '')
    return line ? !line.startsWith('-\t-') : false
  }
}

/**
 * Repo status for a selected folder: whether it is a git repo, remote,
 * branch, dirty count, tracked-over-100MB files, and new >100MB candidates.
 */
function repoStatus(dir, provider = 'github', full = false) {
  const base = { ok: false, dir, isGitRepo: false, provider }
  if (!dir || !existsSync(dir)) return { ...base, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    // 不是 git 仓库：仍返回文件夹名和同名仓库检测，便于「新建仓库」直接使用。
    const defaultRepoName = baseName(dir)
    const ev = repoExistenceAndVisibility(defaultRepoName, provider)
    return {
      ...base,
      defaultRepoName,
      repoExists: ev.checked ? ev.exists : undefined,
      repoOwner: ev.owner,
      visibility: ev.checked && ev.exists ? ev.visibility : undefined,
      provider,
      error: tr('not a git repository（尚未 git init，可用「新建仓库并推送」初始化为 git 仓库并上传）'),
    }
  }

  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const status = run(GIT, ['-C', dir, 'status', '--porcelain'])
  const statusLines = status.ok
    ? status.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
    : []
  const dirtyFiles = statusLines.length

  // Parse porcelain lines (two leading status letters then a path) into a
  // readable list, e.g. { "M " -> modified, "??" -> untracked, "A " -> added,
  // "D " -> deleted, "R " -> renamed }. Only the file/folder NAME is shown in
  // the panel, never the diff content.
  // 两字母 XY：X(第 1 位)非空格且非 '?' = 已暂存(index)，Y(第 2 位)非空格 = 未暂存(worktree)。
  const changedFiles = statusLines.map((line) => {
    const code = line.slice(0, 2)
    let path = line.slice(3)
    // Rename/copy lines read "R  old -> new": keep the destination name.
    if (/^(R|C)/.test(code)) {
      const arrow = path.indexOf(' -> ')
      if (arrow !== -1) path = path.slice(arrow + 4)
    }
    // Git may quote paths with special characters (core.quotepath) as
    // C-style "…" strings with octal escapes; decode them back to UTF-8.
    path = parseGitPath(path)
    const type = /^\?\?/.test(code) ? 'untracked'
      : /^A|^AM/.test(code) ? 'added'
      : /^D|^AD/.test(code) ? 'deleted'
      : /^R/.test(code) ? 'renamed'
      : 'modified'
    // code[0] 是 index/staged 状态列（' ' 或 '?' 表示未暂存/未跟踪）。
    const staged = code[0] !== ' ' && code[0] !== '?'
    // diff 内容不再在 /repo 里逐个生成（改动多时会跑 N 次 git diff，拖慢加载）；
    // 改为点开「查看改动」弹窗里的文件行时，由 /repo-diff 单独按需请求。
    // viewable=false 表示二进制等无法按文本预览的内容（列表里不显示「查看」）。
    return { type, path, staged, viewable: fileViewable(dir, path, type) }
  })

  // Tracked files that exceed 100MB (GitHub would reject a push of these).
  let trackedOverLimit = []
  const lsr = run(GIT, ['-C', dir, 'ls-files', '-z'])
  if (lsr.ok) {
    const tracked = lsr.stdout.split('\0').filter(Boolean).map(parseGitPath)
    for (const p of tracked) {
      const full = join(dir, p)
      try {
        const s = statSync(full)
        if (s.size > GH_FILE_LIMIT) trackedOverLimit.push({ path: p, bytes: s.size })
      } catch {}
    }
  }
  // Working-tree files >100MB, merged into top-level ignore entries. Only
  // entries NOT yet covered by .gitignore are surfaced to the panel, so help
  // is offered precisely for the files that would actually be rejected on push.
  const plan = ignorePlan(dir)
  const ignoredLarge = plan.entries.filter(
    (e) => !e.ignored && !trackedOverLimit.some((t) => t.path === e.source)
  )

  // Default repo name = folder basename; and whether the same-name repo exists
  // (single network call for both existence + visibility).
  const defaultRepoName = baseName(dir)
  const ev = repoExistenceAndVisibility(defaultRepoName, provider)

  // 按当前平台选择远程：Gitee 平台只看 gitee.com 的远程，GitHub 平台只看 github.com，
  // 避免切到 Gitee 时仍显示 GitHub 远程、并把 ahead/behind 算到错误的远程上。
  const remoteName = providerRemoteName(dir, provider)
  const hasRemote = remoteName !== undefined
  const remoteUrl = remoteName !== undefined
    ? (() => {
        const r = run(GIT, ['-C', dir, 'remote', 'get-url', remoteName])
        return r.ok ? r.stdout.trim() : undefined
      })()
    : undefined

  const branchName = branch.ok ? branch.stdout.trim() : undefined

  // ahead (unpushed local commits) / behind (remote commits not yet pulled),
  // measured against <providerRemote>/<branch>.
  //
  // `full` mode performs a `git fetch` so ahead/behind reflect the LIVE remote
  // state (used by the explicit "刷新状态" button). The default (fast) mode
  // SKIPS the network fetch entirely — this is what makes switching workspaces
  // and post-push refreshes feel instant; ahead/behind then fall back to the
  // last known tracking ref (no fetch = no freshness, but no 1-20s stall).
  let ahead = 0
  let behind = 0
  const upstream = hasRemote && branchName ? remoteName + '/' + branchName : undefined
  if (upstream) {
    if (full) {
      if (run(GIT, ['-C', dir, 'fetch', remoteName, branchName, '--quiet'], { timeout: 20_000 }).ok) {
        const rb = run(GIT, ['-C', dir, 'rev-list', '--left-right', '--count', upstream + '...HEAD'])
        if (rb.ok) {
          const m = rb.stdout.trim().split(/\s+/)
          behind = parseInt(m[0], 10) || 0   // left side = remote-only commits
          ahead = parseInt(m[1], 10) || 0    // right side = HEAD-only commits
        }
      }
    } else {
      // Fast path: trust the existing local tracking ref (origin/<branch>) which
      // was populated by any prior fetch. Avoids a blocking network call.
      const rb = run(GIT, ['-C', dir, 'rev-list', '--left-right', '--count', upstream + '...HEAD'])
      if (rb.ok) {
        const m = rb.stdout.trim().split(/\s+/)
        behind = parseInt(m[0], 10) || 0
        ahead = parseInt(m[1], 10) || 0
      }
    }
  }

  // Short commit lists for the "同步" detail view: commits we have locally but
  // not on origin (ahead), and commits origin has that we don't yet (behind).
  // Only computed in full mode (the detail view is a deliberate user action).
  const fmtLogLine = (l) => {
    // porcelain <hash> <subject>
    const sp = l.indexOf(' ')
    return sp === -1 ? l : l.slice(0, sp) + '  ' + l.slice(sp + 1)
  }
  const logRange = (range) => {
    if (!upstream) return []
    const r = run(GIT, ['-C', dir, 'log', '--oneline', '-20', range])
    return r.ok ? r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').map(fmtLogLine) : []
  }
  const aheadCommits = (full && ahead > 0) ? logRange(upstream + '..HEAD') : []
  const behindCommits = (full && behind > 0) ? logRange('HEAD..' + upstream) : []

  return {
    ok: true,
    isGitRepo: true,
    dir,
    defaultRepoName,
    repoExists: ev.checked ? ev.exists : undefined,
    repoOwner: ev.owner,
    provider,
    branch: branchName,
    hasRemote,
    remoteUrl,
    remoteName,
    dirty: dirtyFiles > 0,
    dirtyCount: dirtyFiles,
    // Changed/added/deleted/renamed file names (with their status), empty when clean.
    changedFiles,
    ahead,
    behind,
    // Commit lists for the "同步" detail view.
    aheadCommits,
    behindCommits,
    // Actual remote visibility (private/public) when the repo exists and the
    // account can view it; undefined when unknown (not token/logged in or repo absent).
    visibility: ev.checked && ev.exists ? ev.visibility : undefined,
    trackedOverLimit,
    ignoredLarge: ignoredLarge.slice(0, 200),
  }
}

/**
 * The push flow:
 *  1. ensure it's a git repo (init if needed)
 *  2. append explicit .gitignore entries for every >100MB file so they are not
 *     staged, then report those as "skipped + reason"
 *  3. stage everything remaining, commit, push to origin
 */
function pushFlow(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    const init = run(GIT, ['-C', dir, 'init'])
    if (!init.ok) return { ok: false, error: 'git init failed' }
  }

  // Plan which >100MB entries to ignore (merged top-level dirs or single
  // files). Entries already covered by .gitignore are left alone and reported
  // as already-ignored; the rest are appended once, each with a reason.
  const plan = ignorePlan(dir)
  const skipped = plan.entries.map((e) => {
    const reason = e.ignored
      ? tr("超过 GitHub 100MB 单文件限制（${}），已被 .gitignore 的 \"${}\" 排除", [fmtMB(e.bytes), e.path])
      : e.kind === 'dir'
        ? tr("超过 GitHub 100MB 单文件限制（${}），${} 所在的一级目录「${}」整体忽略（该文件夹为一整体）", [fmtMB(e.bytes), e.source, e.path])
        : tr("超过 GitHub 100MB 单文件限制（${}），已忽略单个文件「${}」", [fmtMB(e.bytes), e.path])
    return { path: e.kind === 'dir' ? e.path + '/' : e.path, reason }
  })

  // Append explicit ignore globs only for entries NOT already covered.
  const gitignorePath = join(dir, '.gitignore')
  const lines = []
  if (existsSync(gitignorePath)) {
    try { lines.push(...readFileSync(gitignorePath, 'utf8').split(/\r?\n/)) } catch {}
  }
  let changedIgnore = false
  for (const e of plan.entries) {
    if (e.ignored) continue
    const pat = '/' + e.path + (e.kind === 'dir' ? '/' : '')
    if (!lines.includes(pat)) { lines.push(pat); changedIgnore = true }
  }
  if (changedIgnore) {
    try { writeFileSync(gitignorePath, lines.join('\n') + '\n', 'utf8') } catch {}
  }

  // Stage everything remaining.
  run(GIT, ['-C', dir, 'add', '-A'])

  // What got staged? Report for transparency.
  const staged = run(GIT, ['-C', dir, 'diff', '--cached', '--name-only'])
  const stagedFiles = staged.ok ? staged.stdout.split(/\r?\n/).filter(Boolean).map(parseGitPath) : []

  let committed = false
  let commitHash
  const hasChanges = run(GIT, ['-C', dir, 'diff', '--cached', '--quiet']).code !== 0
  if (hasChanges) {
    const ident = run(GIT, ['-C', dir, 'config', 'user.email'])
    if (!ident.ok) {
      run(GIT, ['-C', dir, 'config', 'user.name', 'DSH User'])
      run(GIT, ['-C', dir, 'config', 'user.email', 'dsh@localhost'])
    }
    const commit = run(GIT, ['-C', dir, 'commit', '-m', 'chore: update workspace via DSH source-code-mgmt'])
    if (commit.ok) {
      committed = true
      const rev = run(GIT, ['-C', dir, 'rev-parse', '--short', 'HEAD'])
      commitHash = rev.ok ? rev.stdout.trim() : undefined
    }
  }

  const curBranch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = curBranch.ok ? curBranch.stdout.trim() : 'main'
  const hasRemote = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']).ok

  if (!hasRemote) {
    return {
      ok: false, needsRemote: true, branch: branchName,
      committed, commitHash, skipped,
      error: tr('尚未配置远程仓库 origin，请使用「新建仓库」创建远程仓库。'),
    }
  }

  const pushArgs = ['-C', dir, 'push', '-u', 'origin', branchName]
  const push = run(GIT, pushArgs, { timeout: 120_000 })
  const pushed = push.ok
  return {
    ok: pushed,
    needsRemote: false,
    committed,
    commitHash,
    pushed,
    branch: branchName,
    skipped,
    pushError: pushed ? undefined : (push.stderr || push.stdout).trim(),
  }
}

/**
 * Pull the latest changes from the remote `origin` into the current branch.
 * Uses `git pull --ff-only` so it never creates a surprise merge commit;
 * returns structured feedback: already up to date, pulled new commits, or a
 * conflict / error.
 * @param {string} dir - local folder.
 */
function pullFlow(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, error: tr('not a git repository（尚未 git init，无法拉取）') }
  }
  const hasRemote = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']).ok
  if (!hasRemote) {
    return { ok: false, error: tr('尚未配置远程仓库 origin，无法拉取。') }
  }

  // Was already up to date? First cheap check via ls-remote comparison.
  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.stdout.trim() : undefined

  const pull = run(GIT, ['-C', dir, 'pull', '--ff-only', 'origin', branchName], {
    timeout: 120_000,
  })
  const blob = (pull.stdout + '\n' + pull.stderr).trim()

  if (pull.ok) {
    const upToDate = /already up[- ]to[- ]date/i.test(blob)
    return {
      ok: true,
      upToDate,
      pulled: !upToDate,
      branch: branchName,
      detail: blob,
    }
  }

  // Fast-forward only failed — usually local commits ahead (need merge) or a file conflict.
  const conflict = /(conflict|CONFLICT|fix conflicts|commit your changes)/i.test(blob)
  return {
    ok: false,
    conflict,
    branch: branchName,
    error: conflict
      ? tr('拉取存在冲突：本地有未合并改动或与远程冲突，请手动 git pull 处理合并。')
      : (pull.stderr || pull.stdout).trim() || tr('git pull 失败'),
    detail: blob,
  }
}

/**
 * Merge push: rebase local commits onto the latest remote, then push.
 * Used when BOTH local changes and remote updates exist — combines them into
 * one clean history (no surprise merge commit). Returns structured feedback.
 * @param {string} dir - local folder.
 */
function mergePushFlow(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, error: tr('not a git repository（尚未 git init）') }
  }
  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.stdout.trim() : 'main'

  const rebase = run(GIT, ['-C', dir, 'pull', '--rebase', 'origin', branchName], {
    timeout: 180_000,
  })
  if (!rebase.ok) {
    const blob = (rebase.stdout + '\n' + rebase.stderr).trim()
    const conflict = /(conflict|CONFLICT|fix conflicts)/i.test(blob)
    return {
      ok: false, conflict, branch: branchName,
      error: conflict
        ? tr('拉取并推送失败：合并存在冲突，请手动解决后重试。')
        : (rebase.stderr || rebase.stdout).trim() || tr('pull --rebase 失败'),
      detail: blob,
    }
  }

  const push = run(GIT, ['-C', dir, 'push', '-u', 'origin', branchName], {
    timeout: 120_000,
  })
  if (!push.ok) {
    return {
      ok: false, branch: branchName, detail: (push.stdout + '\n' + push.stderr).trim(),
      error: (push.stderr || push.stdout).trim() || tr('push 失败'),
    }
  }
  return { ok: true, branch: branchName, rebased: true, pushed: true }
}

/**
 * Force push: git push --force origin <branch>. Overwrites the remote history
 * with local state. Only shown when the user explicitly wants to discard what
 * the remote has (e.g. the remote updates are not what they need).
 * @param {string} dir - local folder.
 */
function forcePushFlow(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, error: tr('not a git repository（尚未 git init）') }
  }
  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.stdout.trim() : 'main'
  const push = run(GIT, ['-C', dir, 'push', '--force', '-u', 'origin', branchName], {
    timeout: 120_000,
  })
  const blob = (push.stdout + '\n' + push.stderr).trim()
  return {
    ok: push.ok, branch: branchName, forced: push.ok,
    error: push.ok ? undefined : (push.stderr || push.stdout).trim() || tr('push --force 失败'),
    detail: blob,
  }
}

/**
 * Force pull: git pull --force origin <branch>. Pulls in the remote updates
 * while keeping local changes when they can be merged; local-only commits are
 * rebased/merged in. Shown when the remote updates are what the user needs
 * and the local changes are not what they want to keep.
 * @param {string} dir - local folder.
 */
function forcePullFlow(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, error: tr('not a git repository（尚未 git init）') }
  }
  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.stdout.trim() : 'main'
  const pull = run(GIT, ['-C', dir, 'pull', '--force', 'origin', branchName], {
    timeout: 180_000,
  })
  const blob = (pull.stdout + '\n' + pull.stderr).trim()
  const conflict = /(conflict|CONFLICT|fix conflicts)/i.test(blob)
  return {
    ok: pull.ok, conflict, branch: branchName,
    error: !pull.ok
      ? (conflict
        ? tr('强制拉取存在冲突，请手动处理。')
        : (pull.stderr || pull.stdout).trim() || tr('git pull --force 失败'))
      : undefined,
    detail: blob,
  }
}

/**
 * Create a new repo on GitHub or Gitee and push everything.
 *
 * GitHub mode: `gh repo create <name> [--private|--public] --source=. --push`.
 * Gitee mode: create the repo through the Gitee OpenAPI, then add an SSH
 * remote (`git@gitee.com:<owner>/<name>.git`, per the user's choice) and push.
 *
 * @param {string} dir - local folder.
 * @param {string} name - repo name.
 * @param {'private'|'public'} [visibility] - default 'private'.
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 */
function createRepoFlow(dir, name, visibility, provider = 'github') {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  const repoName = String(name || '').trim()
  if (!repoName) return { ok: false, error: tr('缺少仓库名称') }
  if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === '.') {
    return { ok: false, error: tr('仓库名称包含非法字符（仅允许字母、数字、点、下划线、横线）') }
  }
  if (!existsSync(join(dir, '.git'))) {
    const init = run(GIT, ['-C', dir, 'init'])
    if (!init.ok) return { ok: false, error: 'git init failed' }
  }
  run(GIT, ['-C', dir, 'checkout', '-b', 'main'])
  const ident = run(GIT, ['-C', dir, 'config', 'user.email'])
  if (!ident.ok) {
    run(GIT, ['-C', dir, 'config', 'user.name', 'DSH User'])
    run(GIT, ['-C', dir, 'config', 'user.email', 'dsh@localhost'])
  }
  // gh repo create --push requires at least one local commit. On a brand-new
  // (never-committed) folder, stage everything and create an initial commit so
  // the push has something to upload — otherwise gh fails with
  // "`--push` enabled but no commits found". Same requirement applies to a
  // plain `git push` to a fresh Gitee remote.
  const head = run(GIT, ['-C', dir, 'rev-parse', 'HEAD'])
  if (!head.ok) {
    const stagedCount = run(GIT, ['-C', dir, 'add', '-A'])
    if (!stagedCount.ok) {
      return { ok: false, error: tr("git add 失败：${}", [(stagedCount.stderr || '')]) }
    }
    const commit = run(GIT, ['-C', dir, 'commit', '-m', 'init: initial commit from DSH source-code-mgmt'])
    if (!commit.ok) {
      // Nothing to commit (fully empty directory / everything already ignored).
      // That is fine — gh can still create the (empty) remote repo.
      // Fall through to create.
    }
  }
  const vis = visibility === 'public' ? 'public' : 'private'

  if (provider === 'gitee') {
    // 1) Create the empty remote repo via the Gitee OpenAPI.
    const owner = giteeOwner()
    const token = readGiteeToken()
    if (!owner || !token) return { ok: false, error: tr('需要先配置 Gitee 私人令牌') }
    const api = giteeApi('POST', 'user/repos', { name: repoName, private: vis === 'private' }, token)
    if (!api.ok || giteeApiFailed(api.data)) {
      return { ok: false, error: (api.error || (api.data && api.data.message) || tr('Gitee 创建仓库失败')), detail: api.data }
    }
    // 2) Point origin at the SSH remote and push (SSH per user's choice).
    const sshUrl = 'git@gitee.com:' + owner + '/' + repoName + '.git'
    run(GIT, ['-C', dir, 'remote', 'remove', 'origin'])
    run(GIT, ['-C', dir, 'remote', 'add', 'origin', sshUrl])
    const push = run(GIT, ['-C', dir, 'push', '-u', 'origin', 'main'], { timeout: 180_000, env: { GIT_SSH: WORKING_SSH } })
    return {
      ok: push.ok,
      repoName,
      visibility: vis,
      provider: 'gitee',
      owner,
      remote: sshUrl,
      url: 'https://gitee.com/' + owner + '/' + repoName,
      pushError: push.ok ? undefined : (push.stderr || push.stdout).trim(),
      detail: (push.stdout + '\n' + push.stderr).trim(),
    }
  }

  const visFlag = vis === 'public' ? '--public' : '--private'
  const r = run(GH, ['repo', 'create', repoName, visFlag, '--source=' + dir, '--push'], {
    timeout: 180_000, cwd: dir, env: { GIT_SSH: WORKING_SSH },
  })
  const blob = (r.stdout + '\n' + r.stderr)
  const urlMatch = /https:\/\/github\.com\/[^\s"]+/.exec(blob)
  return {
    ok: r.ok,
    repoName,
    visibility: vis,
    provider: 'github',
    url: urlMatch ? urlMatch[0] : undefined,
    detail: blob.trim(),
  }
}

/** Human-readable MB. */
function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * Force-align the local folder to the remote branch: fetch origin then
 * `git reset --hard origin/<branch>`. Any local-only commits / working-tree
 * changes are discarded so local becomes an exact copy of the remote branch.
/**
 * Return the diff of a single changed file, on demand (the "查看改动" panel
 * expands a file row and fetches this instead of bundling every diff into
 * /repo, which would spawn N git processes and stall the load on large
 * change sets). untracked files have no git history, so their whole content
 * is returned as an "all added" diff so the panel can show it; binary /
 * unreadable files return viewable:false (the list then hides 查看).
 * @param {string} dir - local folder.
 * @param {string} path - repo-relative file path.
 */
function repoDiffFlow(dir, path) {
  if (!dir || !existsSync(dir) || !existsSync(join(dir, '.git'))) {
    return { ok: false, error: 'not a git repository' }
  }
  const p = String(path || '').trim()
  if (!p) return { ok: false, error: tr('缺少文件路径') }
  // Untracked files have no tracked diff.
  const status = run(GIT, ['-C', dir, 'status', '--porcelain', '--', p])
  const isUntracked = status.ok && /^\?\?/.test(status.stdout.trim().slice(0, 2))
  if (isUntracked) {
    // 新文件没有历史版本可对比：读取工作区内容，拼成「全部新增」的统一 diff，
    // 面板就能用现有的并排 diff 渲染器展示完整内容。二进制/不可读文件返回
    // viewable:false（列表里不显示「查看」）。
    const full = join(dir, p)
    let preview
    try { preview = readFilePreview(full) } catch { return { ok: true, path: p, diff: '', viewable: false } }
    if (preview.buf.includes(0)) return { ok: true, path: p, diff: '', viewable: false }
    const content = preview.buf.toString('utf8')
    const overSize = preview.truncated
    const noFinalNl = !overSize && !/[\r\n]$/.test(content)
    const lines = content.replace(/\r\n/g, '\n').split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length === 0) return { ok: true, path: p, diff: '', viewable: true }
    // 内容过长时只展示前 2000 行，避免面板渲染卡顿。
    const shown = lines.slice(0, 2000)
    const truncated = overSize || lines.length > shown.length
    let body = shown.map((l) => '+' + l).join('\n')
    if (truncated) body += '\n+…（内容较长，仅显示前 ' + shown.length + ' 行）'
    if (noFinalNl) body += '\n\\ No newline at end of file'
    const head = 'diff --git a/' + p + ' b/' + p + '\n' +
      '--- /dev/null\n' +
      '+++ b/' + p + '\n' +
      '@@ -0,0 +1,' + shown.length + ' @@\n'
    return { ok: true, path: p, viewable: true, diff: head + body + '\n' }
  }
  let r = run(GIT, ['-C', dir, 'diff', '--', p])
  if (r.ok && !r.stdout.trim()) {
    r = run(GIT, ['-C', dir, 'diff', '--cached', '--', p])
  }
  return { ok: true, path: p, diff: r.ok ? r.stdout : '' }
}

/**
 * Force-align the local folder to the remote branch: fetch origin then
 * `git reset --hard origin/<branch>`. Any local-only commits / working-tree
 * changes are discarded so local becomes an exact copy of the remote branch.
 * Only meaningful when the folder is a git repo with a configured origin.
 * @param {string} dir - local folder.
 */
function alignFlow(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    return { ok: false, error: tr('not a git repository（尚未 git init）') }
  }
  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.stdout.trim() : undefined
  if (!branchName) return { ok: false, error: tr('无法识别当前分支') }
  const hasRemote = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']).ok
  if (!hasRemote) return { ok: false, error: tr('尚未配置远程仓库 origin，无法对齐。') }

  const fetch = run(GIT, ['-C', dir, 'fetch', 'origin'], { timeout: 120_000 })
  if (!fetch.ok) {
    return { ok: false, error: (fetch.stderr || fetch.stdout).trim() || tr('git fetch 失败'), detail: (fetch.stdout + '\n' + fetch.stderr).trim() }
  }
  const reset = run(GIT, ['-C', dir, 'reset', '--hard', 'origin/' + branchName], { timeout: 60_000 })
  return {
    ok: reset.ok,
    branch: branchName,
    error: reset.ok ? undefined : (reset.stderr || reset.stdout).trim() || tr('git reset --hard 失败'),
    detail: (fetch.stdout + '\n' + reset.stdout).trim(),
  }
}

/**
 * Initialize a git repository in the folder (git init) and set a default local
 * identity if none is configured. Does NOT commit, configure a remote, or
 * push — the user decides the next step (pull / push) themselves.
 * @param {string} dir - local folder.
 */
function initGitFlow(dir) {
  if (!dir || !existsSync(dir)) return { ok: false, error: 'folder does not exist' }
  if (existsSync(join(dir, '.git'))) {
    return { ok: true, alreadyRepo: true, dir }
  }
  const init = run(GIT, ['-C', dir, 'init'])
  if (!init.ok) return { ok: false, error: (init.stderr || init.stdout).trim() || tr('git init 失败') }
  const ident = run(GIT, ['-C', dir, 'config', 'user.email'])
  if (!ident.ok) {
    run(GIT, ['-C', dir, 'config', 'user.name', 'DSH User'])
    run(GIT, ['-C', dir, 'config', 'user.email', 'dsh@localhost'])
  }
  return { ok: true, alreadyRepo: false, dir, branch: 'main' }
}

// ---------------------------------------------------------------------------
// 本地 Git 工作流 —— 选择性暂存 / 提交 / 分支 / 历史 / revert / cherry-pick / 提交 diff。
// 全部用本插件的 run() + GIT_SSH 注入实现（与 pushFlow 一致），不依赖第三方库。
// ---------------------------------------------------------------------------

/** Basic guard: the folder must exist and be a git repo; returns an error object or null. */
function requireGitRepo(dir) {
  if (!dir || !existsSync(dir)) return { error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) return { error: tr('not a git repository（尚未 git init）') }
  return null
}

/**
 * Stage paths (`git add`). `path` empty/null = stage everything (`git add -A`).
 * @param {string} dir - local folder.
 * @param {string} [path] - repo-relative path; empty = all.
 */
function stageFlow(dir, path) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const args = ['-C', dir, 'add', '-A']
  if (path && String(path).trim() !== '') args.push('--', String(path).trim())
  const r = run(GIT, args)
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || tr('git add 失败') }
  return { ok: true, path: path || null }
}

/**
 * Unstage paths (`git reset`). `path` empty/null = unstage everything.
 * @param {string} dir - local folder.
 * @param {string} [path] - repo-relative path; empty = all.
 */
function unstageFlow(dir, path) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const args = ['-C', dir, 'reset', '-q']
  if (path && String(path).trim() !== '') args.push('--', String(path).trim())
  const r = run(GIT, args)
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || tr('git reset 失败') }
  return { ok: true, path: path || null }
}

/**
 * Commit staged changes with the given message. `paths` (array) restricts the
 * commit to those files (they are staged first via `git add -- <paths>`);
 * when absent, commits whatever is already staged. If the repo has no local
 * identity configured, it uses the same DSH User / dsh@localhost fallback that
 * `pushFlow` uses, keeping behaviour consistent.
 * @param {string} dir - local folder.
 * @param {string} message - commit message.
 * @param {string[]} [paths] - optional files to stage & commit.
 */
function commitFlow(dir, message, paths) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const msg = String(message || '').trim()
  if (msg === '') return { ok: false, error: tr('提交信息不能为空') }

  const ident = run(GIT, ['-C', dir, 'config', 'user.email'])
  if (!ident.ok) {
    run(GIT, ['-C', dir, 'config', 'user.name', 'DSH User'])
    run(GIT, ['-C', dir, 'config', 'user.email', 'dsh@localhost'])
  }

  const list = Array.isArray(paths) ? paths.map((p) => String(p).trim()).filter(Boolean) : []
  let stagedPaths = []
  if (list.length > 0) {
    // 只提交指定文件：先把这些文件 add 进暂存区。
    const add = run(GIT, ['-C', dir, 'add', '--', ...list])
    if (!add.ok) return { ok: false, error: (add.stderr || add.stdout).trim() || tr('git add 失败') }
    stagedPaths = list
  } else {
    // 提交整个暂存区：列出已暂存文件用于提示。
    const st = run(GIT, ['-C', dir, 'diff', '--cached', '--name-only'])
    stagedPaths = st.ok ? st.stdout.split(/\r?\n/).filter(Boolean).map(parseGitPath) : []
  }

  // 无可提交内容时避免报错。
  const hasChanges = run(GIT, ['-C', dir, 'diff', '--cached', '--quiet']).code !== 0
  if (!hasChanges) return { ok: false, error: tr('没有已暂存（staged）的改动可提交'), staged: 0 }

  const commit = run(GIT, ['-C', dir, 'commit', '-m', msg])
  if (!commit.ok) return { ok: false, error: (commit.stderr || commit.stdout).trim() || tr('git commit 失败'), staged: stagedPaths.length }

  const rev = run(GIT, ['-C', dir, 'rev-parse', '--short', 'HEAD'])
  return {
    ok: true,
    message: msg,
    hash: rev.ok ? rev.stdout.trim() : undefined,
    staged: stagedPaths.length,
    paths: stagedPaths,
  }
}

/**
 * Push STAGED changes only: commit whatever is currently staged (using the
 * given message, or an autogenerated one when empty), then push to origin.
 * Unlike {@link pushFlow} it does NOT go on to stage untracked/unstaged files
 * itself and does NOT overwrite the user's own commit message. When nothing is
 * newly staged yet (e.g. the local branch already has commits ahead), it simply
 * pushes those existing commits.
 * @param {string} dir - local folder.
 * @param {string} [message] - commit message used only when something is staged
 *   and the caller supplies one; empty falls back to an autogenerated message.
 */
function pushStagedFlow(dir, message) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }

  // Remote must exist before we can push.
  const hasRemote = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']).ok
  if (!hasRemote) {
    return { ok: false, needsRemote: true, error: tr('尚未配置远程仓库 origin，请使用「新建仓库」创建远程仓库。') }
  }

  const msg = String(message || '').trim()
  let committed = false
  let commitHash
  // Commit staged content only if there is anything staged right now.
  const hasStaged = run(GIT, ['-C', dir, 'diff', '--cached', '--quiet']).code !== 0
  if (hasStaged) {
    const ident = run(GIT, ['-C', dir, 'config', 'user.email'])
    if (!ident.ok) {
      run(GIT, ['-C', dir, 'config', 'user.name', 'DSH User'])
      run(GIT, ['-C', dir, 'config', 'user.email', 'dsh@localhost'])
    }
    const useMsg = msg || ('chore: update ' + baseName(dir))
    const commit = run(GIT, ['-C', dir, 'commit', '-m', useMsg])
    if (!commit.ok) return { ok: false, error: (commit.stderr || commit.stdout).trim() || tr('git commit 失败') }
    committed = true
    const rev = run(GIT, ['-C', dir, 'rev-parse', '--short', 'HEAD'])
    commitHash = rev.ok ? rev.stdout.trim() : undefined
  }

  const curBranch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = curBranch.ok ? curBranch.stdout.trim() : 'main'
  const push = run(GIT, ['-C', dir, 'push', '-u', 'origin', branchName], { timeout: 120_000 })
  const pushed = push.ok
  return {
    ok: pushed,
    needsRemote: false,
    committed,
    commitHash,
    message: msg || (committed ? ('chore: update ' + baseName(dir)) : undefined),
    branch: branchName,
    pushed,
    pushError: pushed ? undefined : (push.stderr || push.stdout).trim(),
  }
}

/**
 * List branches (current first) using `git for-each-ref`.
 * @param {string} dir - local folder.
 */
function branchesFlow(dir) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const cur = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const current = cur.ok && cur.stdout.trim() !== 'HEAD' ? cur.stdout.trim() : cur.ok ? cur.stdout.trim() : 'HEAD'
  const r = run(GIT, ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  const names = r.ok ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '') : []
  if (!names.includes(current)) names.unshift(current)
  return { ok: true, current, branches: names }
}

/**
 * Checkout an existing branch.
 * @param {string} dir - local folder.
 * @param {string} branch - branch name to switch to.
 */
function checkoutFlow(dir, branch) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const b = String(branch || '').trim()
  if (b === '') return { ok: false, error: tr('缺少分支名') }
  const r = run(GIT, ['-C', dir, 'checkout', b])
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || tr('切换分支失败') }
  return { ok: true, branch: b }
}

/**
 * Recent commit history (newest first). Each row carries the short hash,
 * full hash, subject, author and date.
 * @param {string} dir - local folder.
 * @param {number} [count] - how many commits (default 30).
 */
function logFlow(dir, count) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const n = Math.max(1, Math.min(500, parseInt(count, 10) || 30))
  const r = run(GIT, ['-C', dir, '--no-pager', 'log', '-n', String(n), '--decorate=short',
    '--pretty=format:%h%x1f%s%x1f%an%x1f%ai%x1f%H%x1f%D'])
  if (!r.ok) {
    // 空仓库（无提交）时 git log 报错——视为空历史，而不是失败。
    if (/does not have any commits|bad revision|your current branch/i.test((r.stderr || r.stdout))) {
      return { ok: true, commits: [] }
    }
    return { ok: false, error: (r.stderr || r.stdout).trim() || tr('git log 失败') }
  }
  const commits = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').map((line) => {
    const [short, subject, author, date, full, refs] = line.split('\x1f')
    return {
      hash: short || '',
      hashFull: full || short || '',
      subject: subject || '',
      author: author || '',
      date: date || '',
      refs: refs || '',
    }
  })
  return { ok: true, commits }
}

/**
 * Revert a commit onto the current branch (auto-generated message, no editor).
 * @param {string} dir - local folder.
 * @param {string} hash - commit hash to revert.
 */
function revertFlow(dir, hash) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const h = String(hash || '').trim()
  if (h === '') return { ok: false, error: tr('缺少 commit hash') }
  const r = run(GIT, ['-C', dir, 'revert', '--no-edit', h], { timeout: 60_000 })
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || tr('revert 失败（可能有冲突，请手动处理）') }
  return { ok: true, hash: h }
}

/**
 * Cherry-pick a commit onto the current branch.
 * @param {string} dir - local folder.
 * @param {string} hash - commit hash to cherry-pick.
 */
function cherryPickFlow(dir, hash) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const h = String(hash || '').trim()
  if (h === '') return { ok: false, error: tr('缺少 commit hash') }
  const r = run(GIT, ['-C', dir, 'cherry-pick', h], { timeout: 60_000 })
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || tr('cherry-pick 失败（可能有冲突，请手动处理）') }
  return { ok: true, hash: h }
}

/**
 * Full patch text of one commit (header suppressed). Merge commits diff
 * against the first parent so a history click always has content.
 * @param {string} dir - local folder.
 * @param {string} hash - commit hash.
 */
function commitDiffFlow(dir, hash) {
  const guard = requireGitRepo(dir)
  if (guard) return { ok: false, error: guard.error }
  const h = String(hash || '').trim()
  if (h === '') return { ok: false, error: tr('缺少 commit hash') }
  const r = run(GIT, ['-C', dir, 'show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', h])
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || tr('读取提交 diff 失败') }
  return { ok: true, hash: h, diff: r.stdout }
}

// ---------------------------------------------------------------------------
// 工具安装（① 环境检查缺工具时的一键安装）——best-effort：按可用包管理器自动选取命令。
// ---------------------------------------------------------------------------

/** GitHub CLI Release 资产名（Linux/macOS）：gh_<版本>_<os>_<arch>.tar.gz */
function ghReleaseAsset(platform, arch) {
  const osName = platform === 'darwin' ? 'macOS' : 'linux'
  const archName = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : arch
  return { osName, archName }
}

/**
 * GitHub CLI 下载镜像（ghproxy 类：前缀 + 完整 GitHub URL）。
 * id 供 UI 下拉选择；url 是下载 URL 前缀；note 是对用户展示的说明。
 * 实测（2025-09，国内网络）：gh-proxy.com 约 2-3.5MB/s 且稳定；ghfast.top /
 * ghproxy.net 可用但偏慢（几十 KB/s）；其余常见镜像（ghps.cc / moeyy /
 * gh.llkk.cc / hub.gitmirror.com 等）不可用或限流，故不收录。
 */
const GH_MIRRORS = [
  { id: 'gh-proxy.com', url: 'https://gh-proxy.com/', note: '快（推荐）' },
  { id: 'ghfast.top', url: 'https://ghfast.top/', note: '可用，较慢' },
  { id: 'ghproxy.net', url: 'https://ghproxy.net/', note: '可用，较慢' },
]

/** 归一化下载源：'official'（官网直连）或 GH_MIRRORS 中的 id；未知值回退官网。 */
function normalizeGhSource(source) {
  const s = String(source || '').trim()
  if (s === '' || s === 'official') return 'official'
  return GH_MIRRORS.some((m) => m.id === s) ? s : 'official'
}

/**
 * 按下载源构造 gh release tarball 的下载 URL。
 * @param {string} ver - 版本号（不带 v，如 2.100.0）。
 * @param {string} osName - 'linux' | 'macOS'。
 * @param {string} archName - 'amd64' | 'arm64'。
 * @param {string} [source] - 'official' 或 GH_MIRRORS[].id。
 * @returns {string} 完整下载 URL（镜像为「前缀 + 官方 URL」）。
 */
function ghDownloadUrl(ver, osName, archName, source) {
  const base = `https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_${osName}_${archName}.tar.gz`
  const id = normalizeGhSource(source)
  if (id === 'official') return base
  const mirror = GH_MIRRORS.find((m) => m.id === id)
  return mirror.url + base
}

/** GitHub CLI 在 Windows 的 Release 资产名：gh_<版本>_windows_<arch>.msi（或 .zip）。 */
function ghWindowsArchName(arch) {
  return arch === 'arm64' ? 'arm64' : 'amd64'
}

/**
 * 按下载源构造 gh 在 Windows 的 msi 下载 URL（保持「镜像 = 前缀 + 官方 URL」一致，
 * 与 Linux/macOS 的 ghDownloadUrl 同一套镜像）。
 * @param {string} ver - 版本号（不带 v，如 2.100.0）。
 * @param {string} archName - 'amd64' | 'arm64'。
 * @param {string} [source] - 'official' 或 GH_MIRRORS[].id。
 * @returns {string} 完整 msi 下载 URL。
 */
function ghWindowsMsiUrl(ver, archName, source) {
  const base = `https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_windows_${archName}.msi`
  const id = normalizeGhSource(source)
  if (id === 'official') return base
  const mirror = GH_MIRRORS.find((m) => m.id === id)
  return mirror.url + base
}

/**
 * gh 在 Windows 的静默安装分步命令（每步独立执行，供「一键安装」进度逐条展示；
 * 版本号由调用方先在 JS 侧解析好，避免在 cmd 里解析 GitHub API 的转义地狱）。
 * 下载官方 msi（镜像=前缀+官方 URL，避免 winget 直连 GitHub 卡慢）→ msiexec 全静默安装。
 * msiexec 会把 gh 注册进 Program Files 与 PATH，装完新进程即可用，与 winget 效果一致。
 *
 * 注意：命令必须用「可执行文件 + 参数数组」返回（经 runLive(bin, args) 调用），
 * 绝不能拼成 `cmd /c "curl ... "https://..." -o "..."` 字符串——Node spawn 在 Windows
 * 会重排引号，把镜像 URL 里的第二个 `https://` 误判成 `host:端口`，curl 报
 * "URL rejected: Port number was not a decimal number"。参数数组逐个传值可完全规避。
 * @param {string} ver - 已解析的具体版本号（不带 v，如 2.100.0）。
 * @param {string} [source] - 下载源：'official' 或 GH_MIRRORS[].id。
 * @returns {Array<{label: string, bin: string, args: string[]}>}
 */
function ghWindowsSteps(ver, source) {
  const archName = ghWindowsArchName(process.arch)
  const msi = join(tmpdir(), 'gh-scm.msi')
  const dlUrl = ghWindowsMsiUrl(ver, archName, source)
  // gh 的 msi 是 per-machine 安装，DSH 进程通常非提权：用 PowerShell Start-Process -Verb RunAs
  // 触发 UAC（用户点「是」）并 -Wait 等待完成；msiexec /qn 全静默。
  // 用 -EncodedCommand（UTF-16LE base64）传脚本，彻底规避 Node spawn 对引号的重排，
  // 也避免把含空格/引号的 msi 路径写进内联字符串。
  const psScript = "Start-Process -FilePath msiexec.exe -ArgumentList '/i','" + msi + "','/qn','/norestart' -Verb RunAs -Wait"
  const psEncoded = Buffer.from(psScript, 'utf16le').toString('base64')
  return [
    { label: tr('下载 gh 安装包（镜像）…'), bin: 'curl.exe', args: ['-fsSL', dlUrl, '-o', msi] },
    { label: tr('静默安装…'), bin: 'powershell.exe', args: ['-NoProfile', '-EncodedCommand', psEncoded] },
    { label: tr('清理临时文件…'), bin: 'cmd.exe', args: ['/d', '/c', 'del', '/q', '/f', msi] },
  ]
}

/**
 * gh 在 Windows 的静默安装单行命令（供「复制安装命令」，用户在自己终端里跑）。
 * @param {string} ver - 已解析的具体版本号（不带 v，如 2.100.0）。
 * @param {string} [source] - 下载源：'official' 或 GH_MIRRORS[].id。
 * @returns {string} 可直接在 cmd.exe 里执行的命令（含镜像前缀时仍只影响下载）。
 */
function ghWindowsScript(ver, source) {
  const archName = ghWindowsArchName(process.arch)
  const msi = join(tmpdir(), 'gh-scm.msi')
  const dlUrl = ghWindowsMsiUrl(ver, archName, source)
  const q = JSON.stringify(msi)
  return 'curl.exe -fsSL "' + dlUrl + '" -o ' + q + ' && msiexec /i ' + q + ' /qn /norestart && del /q /f ' + q
}

/**
 * 免 sudo 用户级安装 GitHub CLI 的单行脚本（Linux / macOS）：
 * 解析官方最新版本号 → 按所选下载源下载对应平台/架构 tarball → 解压 →
 * 把 bin/gh 装到 ~/.local/bin/gh（目录不存在则创建）→ 清理临时文件。全程不要求 root。
 * @param {string} [source] - 下载源：'official' 或 GH_MIRRORS[].id（默认官网）。
 * @returns {string} 可直接 `sh -c` 执行 / 复制给用户的脚本。
 */
function ghUserLevelScript(source) {
  const { osName, archName } = ghReleaseAsset(process.platform, process.arch)
  const localBin = join(homedir(), '.local', 'bin')
  // 注意：VER 是脚本内的 shell 变量。ghDownloadUrl 收到字面 '${VER}'（单引号
  // 字符串不做 JS 插值），生成的 URL 里保留字面 ${VER}，由 shell 在执行时展开。
  const dlUrl = ghDownloadUrl('${VER}', osName, archName, source)
  return [
    'VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n \'s/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p\')',
    'VER=${VER#v}',
    `mkdir -p "${localBin}"`,
    `curl -fsSL "${dlUrl}" -o /tmp/gh-scm.tgz`,
    'tar -xzf /tmp/gh-scm.tgz -C /tmp',
    `install -m 755 "/tmp/gh_\${VER}_${osName}_${archName}/bin/gh" "${localBin}/gh"`,
    'rm -rf /tmp/gh-scm.tgz "/tmp/gh_${VER}_' + osName + '_' + archName + '"',
  ].join(' && ')
}

/**
 * gh 用户级安装的分步脚本（每步独立执行，供「一键安装」进度逐条展示）。
 * 与 ghUserLevelScript()（复制用单行版）保持同源逻辑；版本号经 /tmp/gh-scm-ver 传递。
 * @param {string} [source] - 下载源：'official' 或 GH_MIRRORS[].id（默认官网）。
 * @returns {Array<{label: string, cmd: string}>}
 */
function ghUserLevelSteps(source) {
  const { osName, archName } = ghReleaseAsset(process.platform, process.arch)
  const localBin = join(homedir(), '.local', 'bin')
  const verFile = '/tmp/gh-scm-ver'
  const fetchVer = 'VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n \'s/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p\'); [ -n "$VER" ] || exit 1; printf \'%s\' "${VER#v}" > ' + verFile
  const readVer = 'VER=$(cat ' + verFile + ')'
  // readVer 之后 VER 是 shell 变量：URL 保留字面 ${VER}，由 shell 展开。
  const dlUrl = ghDownloadUrl('${VER}', osName, archName, source)
  return [
    { label: tr('查询最新版本…'), cmd: fetchVer },
    { label: tr('下载 gh 安装包…'), cmd: readVer + ' && curl -fsSL "' + dlUrl + '" -o /tmp/gh-scm.tgz' },
    { label: tr('解压…'), cmd: 'tar -xzf /tmp/gh-scm.tgz -C /tmp' },
    { label: tr('安装到 ~/.local/bin…'), cmd: readVer + ' && mkdir -p "' + localBin + '" && install -m 755 "/tmp/gh_${VER}_' + osName + '_' + archName + '/bin/gh" "' + localBin + '/gh"' },
    { label: tr('清理临时文件…'), cmd: 'rm -rf /tmp/gh-scm.tgz ' + verFile + ' /tmp/gh_*_' + osName + '_' + archName },
  ]
}

/**
 * 免 sudo 用户级安装 Gitee CLI（官方 oschina/gitee-cli，bin `gitee`）的单行命令
 * （Linux / macOS）：官方安装脚本自动检测平台、校验 SHA-256，装到 ~/.local/bin/gitee
 * （root 时为 /usr/local/bin）。gitee.com 是国内站点，无需镜像。
 * @returns {string} 可直接 `sh -c` 执行 / 复制给用户的命令。
 */
function giteeUserLevelScript() {
  return 'curl -fsSL https://gitee.com/oschina/gitee-cli/raw/main/scripts/install.sh | sh'
}

/**
 * 从 `gh --version` / `gitee --version` / release tag_name 等文本提取 x.y.z 版本号。
 * @param {string} text
 * @returns {string|null}
 */
function parseVersion(text) {
  const m = /(?:^|[^0-9.])(\d+\.\d+\.\d+)/.exec(String(text || ''))
  return m ? m[1] : null
}

/** 简单 semver 比较：a > b → 1，a < b → -1，相等 → 0（非法段按 0）。 */
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0
    const y = pb[i] || 0
    if (x > y) return 1
    if (x < y) return -1
  }
  return 0
}

/** 提取 GitHub CLI 最新 release 的版本号（不带 v）；失败返回 null。 */
function latestGhVersion() {
  const r = run(CURL, ['-fsSL', '--max-time', '15', 'https://api.github.com/repos/cli/cli/releases/latest'], { timeout: 20_000 })
  if (!r.ok) return null
  try { return parseVersion(JSON.parse(r.stdout).tag_name || '') } catch { return null }
}

/** 检查 GitHub CLI 是否有可用更新（本地版本 vs GitHub 官方最新 release tag）。 */
function checkGhUpdate() {
  const local = run(GH, ['--version'], { timeout: 15_000 })
  const current = local.ok ? parseVersion(local.stdout + local.stderr) : null
  if (!current) return { ok: false, tool: 'gh', error: tr('无法读取当前版本') }
  const latest = latestGhVersion()
  if (!latest) return { ok: false, tool: 'gh', error: tr('无法获取最新版本') }
  return { ok: true, tool: 'gh', current, latest, hasUpdate: compareVersions(latest, current) > 0 }
}

/**
 * 提取 Git 最新稳定标签版本号（不带 v）。
 *
 * 注意：Git 官方（git/git）没有 GitHub Releases（/releases/latest 返回 404），它用
 * tag 发版，镜像仓库 git/git 的 tags 列表顶部仍是最新 tag。必须过滤预发布 tag：
 * RC / 预发布形如 v2.56.0-rc0、v2.55.0-rc1，比较时会被 parseVersion 误当成对应稳定版，
 * 不过滤会诱导用户「更新」到 RC。
 * @returns {string|null} 例如 '2.55.0'；失败返回 null。
 */
function latestGitVersion() {
  const r = run(CURL, ['-fsSL', '--max-time', '15', 'https://api.github.com/repos/git/git/tags?per_page=20'], { timeout: 20_000 })
  if (!r.ok) return null
  try {
    const tags = JSON.parse(r.stdout)
    if (!Array.isArray(tags)) return null
    for (const t of tags) {
      const name = String(t?.name ?? '')
      // 只要稳定版 tag：v 开头 + 纯 integer 段，剔除 -rc/-pre/后缀（如 v2.56.0-rc0）。
      const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(name)
      if (m) return `${m[1]}.${m[2]}.${m[3]}`
    }
    return null
  } catch {
    return null
  }
}

/** 检查 Git 是否有可用更新（本地 git --version vs Git 官方最新稳定 tag）。 */
function checkGitUpdate() {
  const local = run(GIT, ['--version'], { timeout: 15_000 })
  const current = local.ok ? parseVersion(local.stdout + local.stderr) : null
  if (!current) return { ok: false, tool: 'git', error: tr('无法读取当前版本') }
  const latest = latestGitVersion()
  if (!latest) return { ok: false, tool: 'git', error: tr('无法获取最新版本') }
  return { ok: true, tool: 'git', current, latest, hasUpdate: compareVersions(latest, current) > 0 }
}

/** 检查 Gitee CLI 是否有可用更新（本地版本 vs 官方 oschina/gitee-cli 最新 release tag）。
 *  公开仓库的 releases 端点无需令牌，直接 curl（不依赖 giteeApi 的令牌校验）。 */
function checkGiteeUpdate() {
  const local = run(GITEE, ['--version'], { timeout: 15_000 })
  const current = local.ok ? parseVersion(local.stdout + local.stderr) : null
  if (!current) return { ok: false, tool: 'gitee', error: tr('无法读取当前版本') }
  const r = run(CURL, ['-sS', '-L', '--connect-timeout', '15', '--max-time', '30',
    'https://gitee.com/api/v5/repos/oschina/gitee-cli/releases/latest'], { timeout: 40_000 })
  let latest = null
  if (r.ok) {
    try { latest = parseVersion(JSON.parse(r.stdout).tag_name || '') } catch { /* ignore */ }
  }
  if (!latest) return { ok: false, tool: 'gitee', error: tr('无法获取最新版本') }
  return { ok: true, tool: 'gitee', current, latest, hasUpdate: compareVersions(latest, current) > 0 }
}

/** 安装后即时复查工具是否真的可用（不依赖模块加载时缓存的历史解析结果）。 */
function toolInstalled(t) {
  if (t === 'gh') {
    // 用户级安装落点优先复查；不在 PATH 时也能发现。
    if (!IS_WIN) {
      const userGh = probePrefix(join(homedir(), '.local', 'bin'), 'gh')
      if (userGh && isFile(userGh)) return true
    } else {
      // Windows 的 gh msi 默认装到 Program Files\GitHub CLI\gh.exe。msiexec 装完后
      // 当前 DSH 进程的 PATH 仍是旧的，直接 run('gh') 会失败 → 先探官方固定落点。
      for (const pf of ['C:\\Program Files\\GitHub CLI', 'C:\\Program Files (x86)\\GitHub CLI']) {
        if (isFile(join(pf, 'gh.exe'))) return true
      }
    }
    return run('gh', ['--version']).ok
  }
  if (t === 'gitee') {
    // 官方安装脚本同样落到 ~/.local/bin/gitee，优先复查该落点。
    if (!IS_WIN) {
      const userGitee = probePrefix(join(homedir(), '.local', 'bin'), 'gitee')
      if (userGitee && isFile(userGitee)) return true
    }
    return run('gitee', ['--version']).ok
  }
  // git / ssh：直接按当前 PATH 实测（系统包管理器安装后即可发现，无需重启/刷新）。
  if (t === 'git') return run('git', ['--version']).ok
  if (t === 'ssh') return run('ssh', ['-V']).ok
  return false
}

/**
 * sudo 是否免密可用（`sudo -n true` 非交互探测）。
 * 需要密码的 sudo 在面板内无法自动输入，返回 false 以走用户级安装或手动指引。
 * @returns {boolean} 已是 root 或 sudo 免密可用时为 true。
 */
function canSudo() {
  if (IS_WIN) return false
  if (typeof process.getuid === 'function' && process.getuid() === 0) return true
  return run('sudo', ['-n', 'true'], { timeout: 5_000 }).ok
}

/**
 * Whether a command exists (probe `--version`; for shell scripts use `command -v`).
 * @param {string} bin - bare command name.
 */
function binExists(bin) {
  if (bin === 'apt-get' || bin === 'dnf' || bin === 'yum') {
    return run('sh', ['-c', 'command -v ' + bin]).ok
  }
  return run(bin, ['--version']).ok
}

/**
 * 仅按系统包管理器选择安装命令（不含 gh 的用户级路径）。
 * @param {'git'|'gh'|'ssh'} tool
 */
function installCommandSystem(tool) {
  if (IS_WIN) {
    // SSH 客户端：Windows 内置可选功能（需管理员），走 powershell。
    if (tool === 'ssh') {
      return { bin: 'powershell', args: ['-NoProfile', '-Command', 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'], label: 'Add-WindowsCapability -Online -Name OpenSSH.Client' }
    }
    // Gitee CLI：官方通过 npm 分发跨平台二进制（winget 无官方包），优先 npm。
    if (tool === 'gitee') {
      if (binExists('npm')) {
        return { bin: 'npm', args: ['install', '-g', '@gitee/gitee-cli'], label: 'npm install -g @gitee/gitee-cli' }
      }
      return null
    }
    const pkg = tool === 'git' ? 'Git.Git' : 'GitHub.cli'
    if (binExists('winget')) {
      return { bin: 'winget', args: ['install', '--id', pkg, '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'], label: 'winget install --id ' + pkg + ' -e' }
    }
    if (binExists('choco')) {
      return { bin: 'choco', args: ['install', tool === 'git' ? 'git' : 'gh', '-y'], label: 'choco install ' + (tool === 'git' ? 'git' : 'gh') + ' -y' }
    }
    if (binExists('scoop')) {
      return { bin: 'scoop', args: ['install', tool === 'git' ? 'git' : 'gh'], label: 'scoop install ' + (tool === 'git' ? 'git' : 'gh') }
    }
    return null
  }
  if (process.platform === 'darwin') {
    const pkg = tool === 'git' ? 'git' : tool === 'gh' ? 'gh' : 'openssh'
    if (binExists('brew')) return { bin: 'brew', args: ['install', pkg], label: 'brew install ' + pkg }
    // macOS 无 brew：git/ssh 走 Xcode 命令行工具（系统自带安装，含 git 与 ssh）。
    if (tool === 'git' || tool === 'ssh') {
      return { bin: 'sh', args: ['-c', 'xcode-select --install'], label: 'xcode-select --install', started: true }
    }
    return null
  }
  // Linux：按可用包管理器选择。安装需 root，用 sudo（非交互 -n，避免挂起等待密码；已是 root 则直接跑）。
  // needsSudo 标记供上层探测：sudo 需要密码时改走手动指引，避免静默失败。
  const pkg = tool === 'git' ? 'git' : tool === 'gh' ? 'gh' : 'openssh-client'
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const sudo = !isRoot && binExists('sudo') ? 'sudo -n ' : ''
  const tag = sudo === '' ? {} : { needsSudo: true }
  if (binExists('apt-get')) {
    return { bin: 'sh', args: ['-c', sudo + 'apt-get install -y ' + pkg], label: 'sudo apt-get install -y ' + pkg, ...tag }
  }
  if (binExists('dnf')) {
    return { bin: 'sh', args: ['-c', sudo + 'dnf install -y ' + pkg], label: 'sudo dnf install -y ' + pkg, ...tag }
  }
  if (binExists('pacman')) {
    return { bin: 'sh', args: ['-c', sudo + 'pacman -S --noconfirm ' + pkg], label: 'sudo pacman -S ' + pkg, ...tag }
  }
  return null
}

/**
 * 系统包管理器的「升级」命令（区别于 installCommandSystem 的安装命令）。
 * 供「检查更新 → 确认更新」复用：按平台给出升级 git（或指定工具）的实际命令。
 * 与安装命令同构，但动词换为 upgrade / update；同样需要 root 时标记 needsSudo。
 * @param {'git'} tool - 目前仅 Git 需要；SSH/gh 不走此路径。
 * @returns {{bin: string, args: string[], label: string, needsSudo?: boolean}|null}
 */
function upgradeCommandSystem(tool) {
  if (IS_WIN) {
    const pkg = tool === 'git' ? 'Git.Git' : 'GitHub.cli'
    if (binExists('winget')) {
      return { bin: 'winget', args: ['upgrade', '--id', pkg, '-e', '--source', 'winget'], label: 'winget upgrade --id ' + pkg + ' -e' }
    }
    if (binExists('choco')) return { bin: 'choco', args: ['upgrade', tool === 'git' ? 'git' : 'gh', '-y'], label: 'choco upgrade ' + (tool === 'git' ? 'git' : 'gh') + ' -y' }
    if (binExists('scoop')) return { bin: 'scoop', args: ['update', tool === 'git' ? 'git' : 'gh'], label: 'scoop update ' + (tool === 'git' ? 'git' : 'gh') }
    return null
  }
  if (process.platform === 'darwin') {
    const pkg = tool === 'git' ? 'git' : 'gh'
    if (binExists('brew')) return { bin: 'brew', args: ['upgrade', pkg], label: 'brew upgrade ' + pkg }
    // macOS 无 brew（git 走系统 Xcode CLT）：CLT 无独立升级命令，交系统更新。
    return { bin: 'sh', args: ['-c', 'xcode-select --install'], label: 'xcode-select --install', started: true }
  }
  // Linux：git 走系统包升级。需 root，用 sudo -n（同安装命令的降级约定）。
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const sudo = !isRoot && binExists('sudo') ? 'sudo -n ' : ''
  const tag = sudo === '' ? {} : { needsSudo: true }
  const pkg = tool === 'git' ? 'git' : 'gh'
  if (binExists('apt-get')) return { bin: 'sh', args: ['-c', sudo + 'apt-get install --only-upgrade -y ' + pkg], label: 'sudo apt-get install --only-upgrade -y ' + pkg, ...tag }
  if (binExists('dnf')) return { bin: 'sh', args: ['-c', sudo + 'dnf upgrade -y ' + pkg], label: 'sudo dnf upgrade -y ' + pkg, ...tag }
  if (binExists('pacman')) return { bin: 'sh', args: ['-c', sudo + 'pacman -S --noconfirm ' + pkg], label: 'sudo pacman -S ' + pkg, ...tag }
  return null
}

/**
 * Build the install command to run for `tool` on this machine, or null when no
 * usable package manager is available. Returns arrays usable with `run`.
 * @param {'git'|'gh'|'ssh'} tool
 * @param {string} [source] - gh 下载源：'official' 或 GH_MIRRORS[].id（默认官网）。
 */
function installCommand(tool, source) {
  // Linux/macOS 的 GitHub CLI：优先免 sudo 用户级安装（官方/镜像二进制 → ~/.local/bin）。
  if (tool === 'gh' && !IS_WIN) {
    const script = ghUserLevelScript(source)
    return { bin: 'sh', args: ['-c', script], label: script, userLevel: true }
  }
  // Linux/macOS 的 Gitee CLI：官方安装脚本同样免 sudo 装到 ~/.local/bin。
  if (tool === 'gitee' && !IS_WIN) {
    const script = giteeUserLevelScript()
    return { bin: 'sh', args: ['-c', script], label: script, userLevel: true }
  }
  return installCommandSystem(tool)
}

/**
 * Install a missing tool (git / gh / ssh). GitHub CLI on Linux/macOS installs
 * user-level (no sudo, official/mirror binary → ~/.local/bin); git/ssh keep the
 * system package manager. Best-effort: reports the command it ran and output.
 * @param {string} tool - 'git' | 'gh' | 'ssh'.
 * @param {(evt: object) => void} [emit] - 进度事件回调（{type:'step',label} / {type:'out',text}），
 *   由流式路由逐行转发给浏览器端弹窗。
 * @param {{source?: string}} [opts] - 选项：source 为 gh 下载源（'official' 或 GH_MIRRORS[].id）。
 */
async function installToolFlow(tool, emit, opts = {}) {
  const t = String(tool || '').trim().toLowerCase()
  if (t !== 'git' && t !== 'gh' && t !== 'gitee' && t !== 'ssh') return { ok: false, error: tr('未知工具：') + tool }
  const say = (obj) => { if (emit) { try { emit(obj) } catch {} } }
  const source = normalizeGhSource(opts.source)
  const force = !!opts.force // 更新场景：即使已安装也重新执行安装逻辑（覆盖到最新版）。
  // 已安装就直接返回，不重复安装（实测复查，不依赖模块加载时的缓存）。
  if (!force && toolInstalled(t)) return { ok: true, alreadyInstalled: true, tool: t }

  // Linux/macOS 的 gh：免 sudo 用户级安装优先；失败再退回系统包管理器。
  if (t === 'gh' && !IS_WIN) {
    const steps = ghUserLevelSteps(source)
    let lastOut = ''
    let failed = false
    for (const step of steps) {
      say({ type: 'step', label: step.label })
      const r = await runLive('sh', ['-c', step.cmd], { timeout: 300_000, onChunk: (text) => say({ type: 'out', text }) })
      lastOut = (r.stdout + '\n' + r.stderr).trim()
      if (!r.ok) { failed = true; break }
    }
    if (!failed && toolInstalled('gh')) {
      return {
        ok: true,
        tool: t,
        command: 'GitHub CLI',
        output: lastOut || tr('安装成功'),
        userLevel: true,
        source,
        path: join(homedir(), '.local', 'bin', 'gh'),
      }
    }
    // 用户级安装失败 → 退回系统包管理器（并说明原因）。
    const fallback = installCommandSystem(t)
    if (fallback) {
      // 回退命令需要 sudo 但 sudo 要密码时，同样改走手动指引。
      if (fallback.needsSudo && !canSudo()) {
        say({ type: 'step', label: tr('需要管理员密码，改用以下手动命令：') })
        return { ok: false, tool: t, error: tr('需要管理员密码（当前 sudo 需要密码，无法在面板内自动执行），请在终端手动执行：') + fallback.label, command: fallback.label, manual: true }
      }
      say({ type: 'step', label: tr('用户级安装失败，改用系统包管理器安装…') })
      const fr = await runLive(fallback.bin, fallback.args, { timeout: 300_000, onChunk: (text) => say({ type: 'out', text }) })
      const fout = (fr.stdout + '\n' + fr.stderr).trim()
      const fok = toolInstalled('gh')
      return { ok: fok, tool: t, command: fallback.label, output: fout || (fok ? tr('安装成功') : tr('安装失败')) }
    }
    return { ok: false, error: tr('未找到可用的包管理器（') + 'apt-get / dnf / pacman' + tr('）。请手动安装。'), tool: t }
  }

  // Windows 的 gh + 选了镜像源：直接按镜像下载官方 msi → msiexec 静默安装（免 winget 直连卡慢）。
  // 仅当用户在下拉里选了镜像时走此路径；选「官网（慢）」则回落系统包管理器（winget/choco/scoop）。
  if (t === 'gh' && IS_WIN && source !== 'official') {
    say({ type: 'step', label: tr('解析 gh 最新版本…') })
    const latest = await latestGhVersion()
    if (!latest) {
      say({ type: 'step', label: tr('无法获取 gh 最新版本，改用系统包管理器…') })
    } else {
      const steps = ghWindowsSteps(latest, source)
      let lastOut = ''
      let failed = false
      for (const step of steps) {
        say({ type: 'step', label: step.label })
        // 用参数数组直接 runLive(bin, args)，不经 cmd /c 拼字符串（避免 Windows 引号重排
        // 把镜像 URL 的第二个 https:// 误判成端口——见 ghWindowsSteps 注释）。
        const r = await runLive(step.bin, step.args, { timeout: 300_000, onChunk: (text) => say({ type: 'out', text }) })
        lastOut = (r.stdout + '\n' + r.stderr).trim()
        if (!r.ok) { failed = true; break }
      }
      if (!failed && toolInstalled('gh')) {
        return { ok: true, tool: t, installKind: 'msi', command: 'GitHub CLI (msiexec)', output: lastOut || tr('安装成功'), source }
      }
      say({ type: 'step', label: tr('镜像安装失败，改用系统包管理器安装…') })
    }
  }

  // git 检查更新触发的更新：force 时用系统包管理器「升级」命令（区别于安装命令）。
  // 仅 Windows 需要单独升级 git（官方直发版能对上）。Linux/macOS 的 git 是发行版/brew/
  // Xcode CLT 管理的、随系统更新走，版本与官方不同步——不在插件里单独升级（避免误报/版本错乱）。
  if (t === 'git' && force) {
    if (!IS_WIN) {
      return { ok: false, tool: t, error: tr('Git 随系统更新（') + (process.platform === 'darwin' ? 'brew / Xcode' : 'apt / dnf / pacman') + tr('），无需在插件内单独检查更新。') }
    }
    const up = upgradeCommandSystem(t)
    if (up) {
      say({ type: 'step', label: tr('执行更新命令：') + up.label })
      if (up.needsSudo && !canSudo()) {
        say({ type: 'step', label: tr('需要管理员密码，改用以下手动命令：') })
        return { ok: false, tool: t, error: tr('需要管理员密码（当前 sudo 需要密码，无法在面板内自动执行），请在终端手动执行：') + up.label, command: up.label, manual: true }
      }
      const r = await runLive(up.bin, up.args, { timeout: 300_000, onChunk: (text) => say({ type: 'out', text }) })
      const output = (r.stdout + '\n' + r.stderr).trim()
      if (up.started) {
        return { ok: false, started: true, tool: t, command: up.label, error: tr('已触发更新，请按系统提示完成，然后点「重新检查」') }
      }
      const ok = toolInstalled('git')
      return { ok, tool: t, command: up.label, output: output || (ok ? tr('更新成功') : tr('更新失败')), update: true }
    }
    return { ok: false, error: tr('未找到可用的包管理器（') + (IS_WIN ? 'winget / choco / scoop' : process.platform === 'darwin' ? 'brew' : 'apt-get / dnf / pacman') + tr('）。请手动更新。'), tool: t }
  }

  const cmd = installCommand(t)
  if (!cmd) {
    return { ok: false, error: tr('未找到可用的包管理器（') + (IS_WIN ? 'winget / choco / scoop' : process.platform === 'darwin' ? 'brew / Xcode CLT' : 'apt-get / dnf / pacman') + tr('）。请手动安装。'), tool: t }
  }
  // 需要 sudo 但 sudo 要密码：不执行（-n 必然失败），直接给出手动命令与原因。
  if (cmd.needsSudo && !canSudo()) {
    say({ type: 'step', label: tr('需要管理员密码，改用以下手动命令：') })
    return { ok: false, tool: t, error: tr('需要管理员密码（当前 sudo 需要密码，无法在面板内自动执行），请在终端手动执行：') + cmd.label, command: cmd.label, manual: true }
  }
  say({ type: 'step', label: tr('执行安装命令：') + cmd.label })
  const r = await runLive(cmd.bin, cmd.args, { timeout: 300_000, onChunk: (text) => say({ type: 'out', text }) })
  const output = (r.stdout + '\n' + r.stderr).trim()
  // 启动型安装（如 macOS xcode-select）：安装是系统弹窗异步完成的，返回「已触发」指引。
  if (cmd.started) {
    return { ok: false, started: true, tool: t, command: cmd.label, error: tr('已触发安装，请按系统提示完成，然后点「重新检查」') }
  }
  // 安装后复查是否已装上。
  const ok = toolInstalled(t)
  return {
    ok,
    tool: t,
    command: cmd.label,
    output: output || (ok ? tr('安装成功') : tr('安装失败')),
    needElevation: IS_WIN && t === 'ssh',
  }
}

// ---------------------------------------------------------------------------
// ④ 克隆远程仓库 / ⑤ 发布 npm 包 —— host 逻辑
// ---------------------------------------------------------------------------

// ---------- LLM 辅助：用 DSH 的 llm 服务 + 默认模型（当前对话/默认模型） ----------

/**
 * 读取 DSH 默认模型配置（agent-default-model）。优先走 settings 服务（ctx.settings
 * 在 host 侧同进程可用），拿不到时兜底解析 ~/.dsh/settings.yaml 的该段。
 * @returns {{provider: string, model: string}|undefined}
 */
function resolveDefaultModel(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const settings = ctx.get('settings')
      if (settings && typeof settings.get === 'function') {
        const v = settings.get('agent-default-model')
        if (v && typeof v === 'object' && typeof v.provider === 'string' && v.provider && typeof v.model === 'string' && v.model) {
          return { provider: v.provider, model: v.model }
        }
      }
    }
  } catch { /* fall through */ }
  try {
    const file = join(homedir(), '.dsh', 'settings.yaml')
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      // 捕获 `agent-default-model:` 后所有缩进（开头空白）的连续行，直到下一个顶格键。
      const m = /^\s*agent-default-model\s*:\s*\n((?:[ \t]+[^\n]*(?:\n|$))*)/m.exec(raw)
      if (m) {
        const block = m[1]
        const prov = /^\s*provider\s*:\s*"?([^\s"#]+)"?/m.exec(block)
        const mod = /^\s*model\s*:\s*"?([^\s"#]+)"?/m.exec(block)
        if (prov && mod) return { provider: prov[1], model: mod[1] }
      }
    }
  } catch { /* ignore */ }
  return undefined
}

/**
 * 调用 DSH 的 LLM（默认模型），收集完整文本。messages 传 { role: 'user'|'assistant', text } 简写。
 * @param {*} ctx - cordis context（apply 注入）。
 * @param {{system?: string, messages: Array<{role:string,text:string}>, maxTokens?: number, temperature?: number}} opts
 * @returns {Promise<{ok:boolean, text?:string, provider?:string, model?:string, error?:string}>}
 */
async function llmComplete(ctx, opts) {
  let llm = null
  try {
    if (ctx && typeof ctx.get === 'function') llm = ctx.get('llm')
    if (!llm && ctx && ctx.llm) llm = ctx.llm
  } catch { llm = null }
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, error: tr('LLM 服务不可用（未加载 llm 服务）') }
  }
  const cfg = resolveDefaultModel(ctx)
  if (!cfg) return { ok: false, error: tr('未找到默认模型配置（agent-default-model）') }
  const blocks = (Array.isArray(opts.messages) ? opts.messages : []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{ type: 'text', text: String(m.text ?? '') }],
  }))
  if (blocks.length === 0) blocks.push({ role: 'user', content: [{ type: 'text', text: '' }] })
  const chunks = []
  try {
    const stream = llm.stream({
      provider: cfg.provider,
      model: cfg.model,
      system: opts.system ? String(opts.system) : undefined,
      messages: blocks,
      maxTokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.6,
    })
    for await (const chunk of stream) {
      if (chunk && chunk.type === 'text-delta') chunks.push(chunk.text)
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true, text: chunks.join(''), provider: cfg.provider, model: cfg.model }
}

// ---------- ④ 克隆远程仓库（Clone） ----------

/** 用户 home 目录（④ 克隆默认位置：Windows=C:\Users\xxx，Linux/macOS=/home/xxx）。 */
function cloneHomeDir() {
  return homedir()
}

/** 默认克隆位置（⑤ 等板块的工作目录兜底）：DSH 默认工作区。 */
function cloneDefaultDir() {
  return resolveDefaultDir(process.cwd())
}


/** 某仓库名在 baseDir 下是否已有同名 git 仓库（含 baseDir 本身就是同名仓库的情形，
 *  如工作区 C:\Users\xxx\workspace 即对应仓库 workspace）。 */
function localRepoExists(baseDir, name) {
  try {
    if (!baseDir || !name) return false
    // baseDir/<name>/.git 存在
    if (existsSync(join(baseDir, name)) && existsSync(join(baseDir, name, '.git'))) return true
    // baseDir 本身就是同名仓库
    if (baseName(baseDir) === name && existsSync(join(baseDir, '.git'))) return true
    return false
  } catch { return false }
}

/**
 * 判断仓库在「当前选中的克隆目录」或「任何已登记的工作区/自定义目录」下是否已存在。
 * 用于 ④ 克隆仓库的「本地已有」标记：不遍历全盘，只查 ③代码管理登记过的目录——
 * 用户若把克隆目录选到其他（已登记）位置，那里的同名仓库同样算「本地已有」。
 * @param {string} name - 仓库名
 * @param {string} [chosenDir] - 当前下拉选中的克隆目标目录（可为空）
 */
function localRepoExistsAnywhere(name, chosenDir) {
  try {
    if (!name) return false
    if (localRepoExists(String(chosenDir || '').trim(), name)) return true
    for (const dir of listWorkspaces()) {
      if (localRepoExists(dir, name)) return true
    }
    return false
  } catch { return false }
}

/**
 * 列出已登录账号（GitHub / Gitee）的所有远程仓库，并标记本地是否已存在。
 * @param {string} [provider] - 'github' (default) | 'gitee'
 * @param {string} [baseDir] - 用于「本地是否已有」判定的目录（默认克隆位置）。
 */
async function listRemoteRepos(provider, baseDir) {
  const p = provider === 'gitee' ? 'gitee' : 'github'
  const base = baseDir || cloneDefaultDir()
  if (p === 'gitee') {
    const owner = giteeOwner()
    if (!owner) return { ok: true, provider: 'gitee', owner: undefined, repos: [], error: tr('需要先配置 Gitee 私人令牌') }
    // 分页拉取账号下所有仓库（每页 100，避免 20/页的默认截断遗漏）。
    const allRepos = []
    let page = 1
    while (page <= 10) {
      const api = giteeApi('GET', 'user/repos?per_page=100&page=' + page)
      if (!api.ok) {
        if (allRepos.length === 0) {
          return { ok: true, provider: 'gitee', owner, repos: [], error: api.error || tr('Gitee API 请求失败（需要 curl）') }
        }
        break
      }
      if (!Array.isArray(api.data)) break
      allRepos.push(...api.data)
      if (api.data.length < 100) break
      page++
    }
    const repos = allRepos.map((r) => ({
      name: String(r.name || ''),
      fullName: String(r.full_name || ''),
      owner,
      visibility: r.private === true ? 'private' : (r.private === false ? 'public' : undefined),
      description: typeof r.description === 'string' ? r.description : undefined,
      sshUrl: typeof r.ssh_url === 'string' ? r.ssh_url : undefined,
      htmlUrl: typeof r.html_url === 'string' ? r.html_url : undefined,
      local: localRepoExistsAnywhere(String(r.name || ''), base),
    }))
    return { ok: true, provider: 'gitee', owner, repos }
  }
  const owner = ghOwner()
  if (!owner) return { ok: true, provider: 'github', owner: undefined, repos: [], error: tr('需要先登录 GitHub CLI（gh）') }
  const r = run(GH, ['repo', 'list', owner, '--limit', '1000', '--json', 'name,owner,visibility,description,updatedAt,sshUrl'], { timeout: 60_000 })
  let parsed = []
  if (r.ok) {
    try {
      const arr = JSON.parse(r.stdout)
      if (Array.isArray(arr)) {
        parsed = arr.map((x) => ({
          name: String(x.name || ''),
          fullName: String((x.owner && x.owner.login ? x.owner.login + '/' : '') + (x.name || '')),
          owner: x.owner && x.owner.login,
          visibility: String(x.visibility || 'private').toLowerCase(),
          description: typeof x.description === 'string' ? x.description : undefined,
          sshUrl: typeof x.sshUrl === 'string' ? x.sshUrl : `git@github.com:${owner}/${x.name}.git`,
          htmlUrl: `https://github.com/${owner}/${x.name}`,
          updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : undefined,
        }))
      }
    } catch { /* ignore */ }
  }
  return { ok: true, provider: 'github', owner, repos: parsed.map((x) => ({ ...x, local: localRepoExistsAnywhere(x.name, base) })) }
}

/**
 * 执行 git clone：克隆到 dest（默认=默认工作区）下的 <name> 目录。成功后加入自定义目录列表。
 * @param {string} url - 远程仓库 URL（SSH 或 HTTPS）。
 * @param {string} [dest] - 目标父目录，空=默认克隆位置。
 * @param {string} [name] - 本地目录名，空=从 URL 推导。
 */
function cloneFlow(url, dest, name) {
  const target = String(dest || '').trim() || cloneDefaultDir()
  const repoName = String(name || '').trim()
  const full = repoName ? join(target, repoName) : ''
  if (!repoName) return { ok: false, error: tr('缺少仓库名称') }
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    return { ok: false, error: tr('目标目录不存在：') + target }
  }
  if (existsSync(full)) {
    return { ok: false, error: tr('已存在同名目录：') + full }
  }
  const r = run(GIT, ['clone', String(url || '').trim(), full], { timeout: 600_000, env: { GIT_SSH: WORKING_SSH } })
  if (!r.ok) {
    return { ok: false, error: (r.stderr || r.stdout || '').trim() || tr('git clone 失败') }
  }
  saveCustomDir(full)
  return { ok: true, dir: full, name: repoName }
}


// ---------- ⑤ 发布 npm 包（npm publish） ----------

/** 发布/登录统一使用的官方 npm registry（镜像源只同步、不接受发布）。 */
const NPM_OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

/** npm 状态：是否安装、registry、whoami、目标目录是否存在 package.json。
 *  whoami 与发布都固定走官方源 NPM_OFFICIAL_REGISTRY（用户全局可能是镜像源）。 */
function npmStatus(dir) {
  const npm = NPM
  const cwd = String(dir || '').trim() || cloneDefaultDir()
  const installed = npm !== 'npm' && npm !== 'npm.cmd'
  const registry = run(npm, ['config', 'get', 'registry'], { shell: IS_WIN })
  const whoami = run(npm, ['whoami', '--registry=' + NPM_OFFICIAL_REGISTRY], { shell: IS_WIN })
  const configReg = registry.ok ? registry.stdout.trim() : undefined
  return {
    ok: true,
    installed,
    npmPath: npm,
    dir: cwd,
    dirExists: existsSync(cwd),
    hasPackageJson: existsSync(join(cwd, 'package.json')),
    registry: configReg,
    // 发布实际使用的官方源；配置源是镜像时置 warning 供面板提示。
    publishRegistry: NPM_OFFICIAL_REGISTRY,
    mirrorConfigured: configReg !== undefined && !configReg.startsWith('https://registry.npmjs.org'),
    whoami: whoami.ok ? whoami.stdout.trim() : undefined,
    whoamiError: whoami.ok ? undefined : ((whoami.stderr || whoami.stdout || '').trim() || tr('未登录 npm')),
  }
}

/**
 * 打开一个终端窗口运行 `gh auth login`（交互式登录无法非交互执行，需要用户
 * 在弹出的终端里完成：选 GitHub.com → 认证方式 → 浏览器/粘贴 token）。
 * 安全要点同 npmLoginTerminal：先探测终端二进制、child 挂 'error' 兜底、
 * KDE konsole 用 --separate 开独立窗口。
 * @returns {{ok:boolean, opened:boolean, command:string, detail:string}}
 */
function ghLoginTerminal() {
  const command = 'gh auth login'
  try {
    if (IS_WIN) {
      // start cmd /k 打开独立窗口（第一引号段是窗口标题）；detached 不阻塞宿主。
      const child = spawn('cmd', ['/c', 'start', '"gh-login"', 'cmd', '/k', command], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => { /* 防御：错误已由返回文案覆盖 */ })
      child.unref()
      return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 gh 登录后回到面板点「重新检查」') }
    }
    const bin = findTerminal()
    if (bin === null) {
      return { ok: false, opened: false, command, detail: tr('未找到可用终端，请手动在终端运行：') + command }
    }
    const args = (bin === 'konsole')
      ? ['--separate', '-e', 'sh', '-c', command]                       // KDE：独立窗口，不并入宿主实例
      : (bin === 'gnome-terminal')
        ? ['--', 'sh', '-c', command]
        : ['-e', 'sh', '-c', command]                                   // xterm 系 / x-terminal-emulator 等
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => { /* 防御：二进制被删等竞态也不会崩宿主 */ })
    child.unref()
    return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 gh 登录后回到面板点「重新检查」') }
  } catch (e) {
    return { ok: false, opened: false, command, detail: String((e && e.message) || e) }
  }
}

/**
 * 打开一个终端窗口运行 `gitee auth login`（官方 Gitee CLI 交互式登录：粘贴
 * Gitee 私人令牌，Token 存 ~/.config/gitee/credentials.yml）。安全要点同
 * ghLoginTerminal。
 * @returns {{ok:boolean, opened:boolean, command:string, detail:string}}
 */
function giteeLoginTerminal() {
  const command = 'gitee auth login'
  try {
    if (IS_WIN) {
      const child = spawn('cmd', ['/c', 'start', '"gitee-login"', 'cmd', '/k', command], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => { /* 防御：错误已由返回文案覆盖 */ })
      child.unref()
      return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 gitee 登录后回到面板点「重新检查」') }
    }
    const bin = findTerminal()
    if (bin === null) {
      return { ok: false, opened: false, command, detail: tr('未找到可用终端，请手动在终端运行：') + command }
    }
    const args = (bin === 'konsole')
      ? ['--separate', '-e', 'sh', '-c', command]
      : (bin === 'gnome-terminal')
        ? ['--', 'sh', '-c', command]
        : ['-e', 'sh', '-c', command]
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => { /* 防御：二进制被删等竞态也不会崩宿主 */ })
    child.unref()
    return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 gitee 登录后回到面板点「重新检查」') }
  } catch (e) {
    return { ok: false, opened: false, command, detail: String((e && e.message) || e) }
  }
}

/**
 * 打开一个终端窗口，在目标目录运行 `npm login`（交互式登录无法非交互执行，
 * 需要用户在弹出的终端里完成）。登录固定走官方源。
 *
 * 安全要点：
 *  - 先探测终端二进制真实存在（findTerminal），绝不 spawn 不存在的程序——
 *    spawn 对 ENOENT 是异步 error，无监听器会抛未捕获异常把 host 进程打崩；
 *  - 每个 child 都挂 'error' 监听器兜底；
 *  - KDE 的 konsole 用 --separate 开独立窗口，避免与宿主所在的 konsole 实例纠缠。
 * @param {string} [dir] - 目标目录。
 * @returns {{ok:boolean, opened:boolean, command:string, detail:string}}
 */
function npmLoginTerminal(dir) {
  const cwd = String(dir || '').trim() || cloneDefaultDir()
  const command = 'npm login --registry=' + NPM_OFFICIAL_REGISTRY
  const cdCmd = IS_WIN
    ? `cd /d "${cwd}" && ${command}`
    : `cd "${cwd}" && ${command}`
  try {
    if (IS_WIN) {
      // start cmd /k 打开独立窗口（第一引号段是窗口标题）；detached 不阻塞宿主。
      const child = spawn('cmd', ['/c', 'start', '"npm-login"', 'cmd', '/k', cdCmd], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => { /* 防御：错误已由返回文案覆盖 */ })
      child.unref()
      return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 npm login 后回到面板点「重新检查」') }
    }
    const bin = findTerminal()
    if (bin === null) {
      return { ok: false, opened: false, command, detail: tr('未找到可用终端，请手动在目标目录运行：') + command }
    }
    const args = (bin === 'konsole')
      ? ['--separate', '-e', 'sh', '-c', cdCmd]                       // KDE：独立窗口，不并入宿主实例
      : (bin === 'gnome-terminal')
        ? ['--', 'sh', '-c', cdCmd]
        : ['-e', 'sh', '-c', cdCmd]                                   // xterm 系 / x-terminal-emulator 等
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => { /* 防御：二进制被删等竞态也不会崩宿主 */ })
    child.unref()
    return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 npm login 后回到面板点「重新检查」') }
  } catch (e) {
    return { ok: false, opened: false, command, detail: String((e && e.message) || e) }
  }
}

/** 在 PATH 中找可用的终端程序（找不到返回 null）。 */
function findTerminal() {
  const candidates = [
    'x-terminal-emulator', 'konsole', 'gnome-terminal', 'xfce4-terminal',
    'mate-terminal', 'lxterminal', 'xterm', 'kitty', 'alacritty', 'wezterm',
  ]
  for (const bin of candidates) {
    if (findOnPath(bin)) return bin
  }
  return null
}

/** 脱敏 npm config list 输出：隐藏 token / auth 等敏感值。 */
function redactNpmList(output) {
  return String(output || '').split(/\r?\n/).map((line) => {
    if (/(token|_auth|authtoken|password|\bauth\b)/i.test(line)) {
      return line.replace(/=.*$/, '=[REDACTED]')
    }
    return line
  }).join('\n')
}

/**
 * 执行 npm 流程的一步（registry / list / whoami / pack / publish）。
 * @param {string} [dir] - 目标目录（package.json 所在处）。
 * @param {string} step - 'registry'|'list'|'whoami'|'pack'|'publish'。
 */
function npmRunStep(dir, step) {
  const npm = NPM
  const cwd = String(dir || '').trim() || cloneDefaultDir()
  const runNpm = (args, timeout) => run(npm, args, { shell: IS_WIN, cwd, timeout: timeout ?? 60_000 })
  switch (step) {
    case 'registry': {
      const r = runNpm(['config', 'get', 'registry'])
      const cfg = r.ok ? r.stdout.trim() : ((r.stderr || '') + (r.stdout || '')).trim()
      // 配置源与发布源分离展示：发布固定走官方源，避免镜像源导致发布失败。
      const extra = cfg && !cfg.startsWith('https://registry.npmjs.org')
        ? '\n' + tr('配置源是镜像，发布将使用官方源：') + NPM_OFFICIAL_REGISTRY
        : ''
      return { ok: true, step, output: cfg + extra }
    }
    case 'list': {
      const r = runNpm(['config', 'list'])
      return { ok: true, step, output: redactNpmList((r.stdout || '') + (r.stderr || '')) }
    }
    case 'whoami': {
      const r = runNpm(['whoami', '--registry=' + NPM_OFFICIAL_REGISTRY])
      return { ok: true, step, output: r.ok ? r.stdout.trim() : ((r.stderr || r.stdout || '').trim() || tr('未登录 npm')), loggedIn: r.ok }
    }
    case 'pack': {
      const r = runNpm(['pack', '--dry-run'], 120_000)
      return { ok: true, step, output: (r.stdout || '') + (r.stderr || '') }
    }
    case 'publish': {
      // 发布固定走官方源（用户全局可能是 npmmirror 等镜像，镜像不接受发布）。
      const r = runNpm(['publish', '--registry=' + NPM_OFFICIAL_REGISTRY], 180_000)
      const blob = ((r.stdout || '') + (r.stderr || '')).trim()
      return { ok: r.ok, step, output: blob || tr('npm publish 已执行'), error: r.ok ? undefined : (blob || tr('npm publish 失败')) }
    }
    default:
      return { ok: false, step, output: tr('未知步骤') }
  }
}

// ---------- route handlers ----------

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(payload))
}

function forbidden(res) {
  json(res, 403, { ok: false, code: 'forbidden' })
}

function methodNotAllowed(res, method) {
  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(method + ' not allowed')
}

/** Read `?dir=` from the query string; fall back to `defaultDir` (the active workspace). */
function queryDir(req, defaultDir) {
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    return url.searchParams.get('dir') || defaultDir
  } catch {
    return defaultDir
  }
}

/** Determine the default (current) workspace directory, preferring the first
 *  entry from the durable workspace list (workspace.json). Falls back to the
 *  process cwd when no workspace is known. */
function resolveDefaultDir(fallback) {
  try {
    const ws = listWorkspaces()
    if (ws.length > 0) return ws[0]
  } catch { /* fall through */ }
  return fallback
}

/** The GitHub login owner (e.g. "Zhucy123"), if gh is signed in. */
function ghOwner() {
  const r = run(GH, ['api', 'user', '--jq', '.login'], { timeout: 20_000 })
  return r.ok && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
}

// ---------- plugin-owned custom directory list ----------
// User-picked directories are persisted by the plugin itself (not written into
// DSH's core workspace.json, which carries session linkage and must stay
// untouched). listWorkspaces() merges them with the DSH registry.

/** Persisted file for the plugin's custom (user-picked) directories. */
function customDirsFile() {
  return join(homedir(), '.dsh', 'storages', 'source-code-mgmt-dirs.json')
}

/** Read the plugin's custom directory list (path strings); never throws. */
function readCustomDirs() {
  try {
    const file = customDirsFile()
    if (!existsSync(file)) return []
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data) ? data.filter((p) => typeof p === 'string' && p !== '') : []
  } catch {
    return []
  }
}

/** Append a directory path to the custom list (dedup; keeps existing), never
 *  propagates errors. Returns the updated list. */
function saveCustomDir(dir) {
  const dirs = readCustomDirs()
  const norm = String(dir || '').trim()
  if (norm && !dirs.includes(norm)) dirs.push(norm)
  try {
    const file = customDirsFile()
    const parent = dirname(file)
    mkdirSync(parent, { recursive: true })
    writeFileSync(file, JSON.stringify(dirs, null, 2), 'utf8')
  } catch { /* ignore persistence errors */ }
  return dirs
}

/** Remove a directory path from the custom list (only the dropdown record, the
 *  real folder is untouched). Returns the updated list. */
function removeCustomDir(dir) {
  const norm = String(dir || '').trim()
  const dirs = readCustomDirs().filter((p) => p !== norm)
  try {
    const file = customDirsFile()
    const parent = dirname(file)
    mkdirSync(parent, { recursive: true })
    writeFileSync(file, JSON.stringify(dirs, null, 2), 'utf8')
  } catch { /* ignore persistence errors */ }
  return dirs
}

/**
 * List every workspace directory path the dropdown should offer: DSH's
 * registered workspaces (from ~/.dsh/storages/workspace.json, with the sessions
 * fallback) merged with the plugin's custom user-picked directories
 * (deduplicated, only existing ones).
 */
function listWorkspaces() {
  const seen = new Set()
  const out = []

  // Primary: workspace.json — tables.workspaces[].path (no ambiguity).
  try {
    const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      const tables = data && data.tables && data.tables.workspaces
      if (tables && typeof tables === 'object') {
        for (const w of Object.values(tables)) {
          const p = w && typeof w.path === 'string' ? w.path : null
          if (p && p !== '' && !seen.has(p)) { seen.add(p); out.push(p) }
        }
      }
    }
  } catch { /* fall through to sessions fallback */ }

  // Fallback: derive from ~/.dsh/sessions/<--encoded-path--> directory names
  // (only when the primary file produced nothing).
  if (out.length === 0) {
    try {
      const sessionsRoot = join(homedir(), '.dsh', 'sessions')
      if (existsSync(sessionsRoot)) {
        for (const e of readdirSync(sessionsRoot, { withFileTypes: true })) {
          if (!(e.isDirectory() && e.name.startsWith('--') && e.name.endsWith('--'))) continue
          const p = decodeSessionDir(e.name)
          if (p !== null && !seen.has(p) && existsSync(p)) { seen.add(p); out.push(p) }
        }
      }
    } catch { /* fall through */ }
  }

  // Plugin-owned custom directories (user-picked), merged & deduped.
  for (const p of readCustomDirs()) {
    if (existsSync(p) && !seen.has(p)) { seen.add(p); out.push(p) }
  }

  return out
}

/**
 * Open a native OS folder-picker dialog on the host and return the chosen path
 * (or undefined if cancelled). Uses a short STA PowerShell + FolderBrowserDialog
 * on Windows; other platforms fall back to the no-dialog (undefined) result.
 * @param {string} [initialDir] - directory the dialog opens at.
 */
function pickDirDialog(initialDir) {
  if (!IS_WIN) return undefined
  const initial = String(initialDir || '').replace(/"/g, '""')
  const script =
    'Add-Type -AssemblyName System.Windows.Forms;' +
    '$dlg = New-Object System.Windows.Forms.FolderBrowserDialog;' +
    tr('$dlg.Description = \'选择本地目录\';') +
    (initial ? `$dlg.SelectedPath = '${initial}';` : '') +
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }'
  const r = run('powershell', ['-NoProfile', '-STA', '-Command', script], { timeout: 180_000 })
  const outLine = (r.stdout || '').trim().split(/\r?\n/)[0] || ''
  return outLine !== '' && existsSync(outLine) ? outLine : undefined
}

/** Decode a session dir name back to a filesystem path (best-effort).
 *  Windows names look like `--C-Users-27775-workspace--` (drive + '-' joined
 *  segments → `\`); POSIX names like `--Users-name-workspace--` (segments → `/`).
 *  Ambiguous when a folder name itself contains '-', which is why
 *  workspace.json is preferred as the source of truth. */
function decodeSessionDir(name) {
  if (typeof name !== 'string') return null
  const inner = name.replace(/^--/, '').replace(/--$/, '')
  if (inner === '') return null
  const parts = inner.split('-')
  if (parts.length === 0) return null
  if (IS_WIN) {
    // Windows: first token is the drive letter, rest joined with '\'.
    const drive = parts[0]
    const rest = parts.slice(1).join('\\')
    return drive + ':\\' + rest
  }
  // POSIX (macOS / Linux): absolute path, segments joined with '/'.
  return '/' + parts.join('/')
}

/**
 * Whether a repo `<owner>/<name>` already exists. GitHub mode uses gh; Gitee
 * mode uses the Gitee OpenAPI (needs a configured personal token).
 * @param {string} name - repo name (without owner).
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 */
function repoExists(name, provider = 'github', owner) {
  if (provider === 'gitee') {
    const o = owner || giteeOwner()
    if (!o || !name) return { owner: o, checked: false, provider: 'gitee' }
    const api = giteeApi('GET', 'repos/' + o + '/' + name)
    if (!api.ok) return { owner: o, checked: false, provider: 'gitee', error: api.error }
    return { owner: o, checked: true, exists: !giteeApiFailed(api.data), provider: 'gitee' }
  }
  const o = owner || ghOwner()
  if (!o || !name) return { owner: o, checked: false, provider: 'github' }
  const r = run(GH, ['repo', 'view', o + '/' + name, '--json', 'name'], { timeout: 20_000 })
  return { owner: o, checked: true, exists: r.ok, provider: 'github' }
}

/**
 * Query the current visibility ('private' | 'public') of a repo. Returns
 * undefined when the account is not available or the repo cannot be viewed, so
 * callers treat "unknown" as "no visibility info".
 * @param {string} name - repo name (without owner).
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 * @param {string} [owner] - pre-resolved owner (skips a network lookup).
 */
function repoVisibility(name, provider = 'github', owner) {
  if (provider === 'gitee') {
    const o = owner || giteeOwner()
    if (!o || !name) return undefined
    const api = giteeApi('GET', 'repos/' + o + '/' + name)
    if (!api.ok || !api.data || giteeApiFailed(api.data)) return undefined
    return api.data.private === true ? 'private' : (api.data.private === false ? 'public' : undefined)
  }
  const o = owner || ghOwner()
  if (!o || !name) return undefined
  const r = run(GH, ['repo', 'view', o + '/' + name, '--json', 'visibility'], { timeout: 20_000 })
  if (!r.ok) return undefined
  try {
    const parsed = JSON.parse(r.stdout)
    const v = String(parsed.visibility || '').toLowerCase()
    return v === 'public' || v === 'private' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * One-shot check that returns BOTH whether a same-name repo exists AND its
 * current visibility, using a SINGLE network call (GitHub `gh repo view` with
 * both fields; Gitee `GET /repos/{owner}/{name}`). This collapses the two
 * separate `repoExists` + `repoVisibility` calls that `repoStatus` used to make
 * back-to-back, halving the remote round-trips for the common case.
 * @param {string} name - repo name (without owner).
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 * @param {string} [owner] - pre-resolved owner (skips a network lookup).
 */
function repoExistenceAndVisibility(name, provider = 'github', owner) {
  if (provider === 'gitee') {
    const o = owner || giteeOwner()
    if (!o || !name) return { owner: o, checked: false, provider: 'gitee' }
    const api = giteeApi('GET', 'repos/' + o + '/' + name)
    if (!api.ok) return { owner: o, checked: false, provider: 'gitee', error: api.error }
    const exists = !giteeApiFailed(api.data)
    const visibility = exists && api.data
      ? (api.data.private === true ? 'private' : (api.data.private === false ? 'public' : undefined))
      : undefined
    return { owner: o, checked: true, exists, visibility, provider: 'gitee' }
  }
  const o = owner || ghOwner()
  if (!o || !name) return { owner: o, checked: false, provider: 'github' }
  const r = run(GH, ['repo', 'view', o + '/' + name, '--json', 'name,visibility'], { timeout: 20_000 })
  if (!r.ok) return { owner: o, checked: true, exists: false, visibility: undefined, provider: 'github' }
  try {
    const parsed = JSON.parse(r.stdout)
    const v = String(parsed.visibility || '').toLowerCase()
    return {
      owner: o, checked: true, exists: true,
      visibility: v === 'public' || v === 'private' ? v : undefined, provider: 'github',
    }
  } catch {
    return { owner: o, checked: true, exists: true, visibility: undefined, provider: 'github' }
  }
}

/**
 * Change a repo's visibility. GitHub mode uses gh; Gitee mode uses the Gitee
 * OpenAPI. Returns the new visibility on success.
 * @param {string} name - repo name (without owner).
 * @param {'private'|'public'} target - desired visibility.
 * @param {string} [provider] - 'github' (default) | 'gitee'.
 */
function setVisibilityFlow(name, target, provider = 'github') {
  const vis = target === 'public' ? 'public' : 'private'
  if (provider === 'gitee') {
    const owner = giteeOwner()
    if (!owner || !name) return { ok: false, error: tr('需要先配置 Gitee 私人令牌') }
    const api = giteeApi('PATCH', 'repos/' + owner + '/' + name, { private: vis === 'private' })
    if (!api.ok || giteeApiFailed(api.data)) {
      return { ok: false, error: (api.error || (api.data && api.data.message) || tr('Gitee 修改可见性失败')) }
    }
    return { ok: true, name, visibility: vis, provider: 'gitee' }
  }
  const owner = ghOwner()
  if (!owner || !name) return { ok: false, error: tr('需要先登录 GitHub CLI（gh）') }
  const r = run(GH, [
    'repo', 'edit', owner + '/' + name,
    '--visibility', vis,
    '--accept-visibility-change-consequences',
  ], { timeout: 30_000 })
  if (!r.ok) {
    return {
      ok: false,
      error: tr("修改可见性失败：${}", [(r.stderr || r.stdout || '').trim() || tr('gh repo edit 失败')]),
    }
  }
  return { ok: true, name, visibility: vis, provider: 'github' }
}

/** basename of a directory path (cross-platform). */
function baseName(p) {
  const cleaned = String(p).replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] || cleaned
}

export function apply(ctx) {
  const fallbackDir = resolveDefaultDir(process.cwd())
  // 每个请求按 ?lang= 参数跑在独立语言上下文里（AsyncLocalStorage），
  // 所有 flow 函数内的 tr() 都能读到当前请求的语言，并发请求互不干扰。
  const handle = async (req, res, fn) => requestLangStore.run(langOf(req), async () => {
    if (!isLoopbackRequest(req)) return forbidden(res)
    const payload = await fn(req)
    json(res, 200, payload)
  })

  // 流式变体：逐行 NDJSON 事件（{type:'step'|'out'|'result'}），供一键安装弹窗展示实时进度。
  const handleStream = async (req, res, fn) => requestLangStore.run(langOf(req), async () => {
    if (!isLoopbackRequest(req)) return forbidden(res)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' })
    const emit = (obj) => { try { res.write(JSON.stringify(obj) + '\n') } catch { /* client gone */ } }
    try {
      const result = await fn(emit)
      emit({ type: 'result', result })
    } catch (error) {
      emit({ type: 'result', result: { ok: false, error: String((error && error.message) || error) } })
    }
    try { res.end() } catch { /* ignore */ }
  })

  const routes = {
    '/env': (req, res) => handle(req, res, async () => ({ ok: true, ...checkEnv() })),
    '/install-tool': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handleStream(req, res, async (emit) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        // force：更新场景——即使已安装也重新执行安装逻辑（覆盖到最新版）。
        return installToolFlow(body.tool, emit, { source: body.source, force: body.force })
      })
    },
    // 按工具（与下载源）返回可复制的安装命令（与「一键安装」同源；无可用方式时为 null）。
    '/install-command': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const tool = String(body.tool || '').trim()
        // Windows 的 gh + 镜像源：返回 msi 静默安装脚本（版本号先在 JS 侧解析；解析失败回退系统命令）。
        const src = normalizeGhSource(body.source)
        if (tool === 'gh' && IS_WIN && src !== 'official') {
          const ver = await latestGhVersion()
          if (ver) return { ok: true, tool, command: ghWindowsScript(ver, src) }
          // 版本解析失败：镜像安装不可用，回退包管理器（winget），复制其 label。
          const fb = installCommandSystem('gh')
          return { ok: true, tool, command: fb ? fb.label : null }
        }
        const cmd = installCommand(tool, src)
        return { ok: true, tool, command: cmd ? cmd.label : null }
      })
    },
    // 检查 gh / gitee 是否有可用更新（本地版本 vs 官方最新 release）。
    '/check-update': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const tool = String(body.tool || '').trim().toLowerCase()
        if (tool === 'gh') return checkGhUpdate()
        if (tool === 'gitee') return checkGiteeUpdate()
        if (tool === 'git') return checkGitUpdate()
        return { ok: false, error: tr('未知工具：') + tool }
      })
    },
    '/ssh': (req, res) => handle(req, res, async () => ({ ok: true, ...checkSsh() })),
    '/gh/login': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async () => ghLoginTerminal())
    },
    '/gitee/login': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async () => giteeLoginTerminal())
    },
    // 把 Gitee CLI 已保存的令牌（gitee auth token）导入本插件存储，③ 即可直接使用。
    '/gitee/import-token': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async () => {
        const r = run(GITEE, ['auth', 'token'], { timeout: 15_000 })
        const token = r.ok ? r.stdout.trim() : ''
        if (!token) return { ok: false, error: tr('无法读取 Gitee CLI 令牌（请先 gitee auth login）') }
        saveGiteeToken(token)
        const owner = giteeOwner()
        if (!owner) {
          // 令牌无效则清掉，避免留有坏令牌。
          saveGiteeToken('')
          return { ok: false, error: tr('Gitee 令牌无效，请检查（需有 projects 权限）') }
        }
        return { ok: true, configured: true, owner }
      })
    },
    '/gen-key': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async () => ({ ok: true, ...generateKey() }))
    },
    '/write-config': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return { ok: true, ...writeSshConfig(body.provider) }
      })
    },
    '/ssh-test': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return { ok: true, ...sshTest(body.provider) }
      })
    },
    '/default-dir': async (req, res) => {
      await handle(req, res, async () => ({ ok: true, dir: fallbackDir, name: baseName(fallbackDir) }))
    },
    '/repo-exists': async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      await handle(req, res, async () => {
        const r = repoExists(body.name, body.provider)
        return { ok: true, ...r }
      })
    },
    '/workspaces': async (req, res) => {
      await handle(req, res, async () => ({ ok: true, workspaces: listWorkspaces(), customDirs: readCustomDirs() }))
    },
    '/remove-workspace': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const dir = String(body.dir || '').trim()
        if (!dir) return { ok: false, error: tr('缺少目录路径') }
        removeCustomDir(dir)
        return { ok: true, removed: dir, customDirs: readCustomDirs(), workspaces: listWorkspaces() }
      })
    },
    '/align': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return alignFlow(body.dir || fallbackDir)
      })
    },
    '/init-git': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return initGitFlow(body.dir || fallbackDir)
      })
    },
    '/pick-dir': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const picked = pickDirDialog(body.initial || fallbackDir)
        if (!picked) return { ok: false, cancelled: true, error: tr('未选择目录') }
        return { ok: true, dir: picked, name: baseName(picked) }
      })
    },
    '/add-workspace': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const dir = String(body.dir || '').trim()
        if (!dir) return { ok: false, error: tr('缺少目录路径') }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          return { ok: false, error: tr('目录不存在或不是文件夹：') + dir }
        }
        saveCustomDir(dir)
        return { ok: true, dir, name: baseName(dir), workspaces: listWorkspaces(), customDirs: readCustomDirs() }
      })
    },
    '/repo': async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        try {
          const q = new URL(req.url ?? '', 'http://localhost')
          const provider = q.searchParams.get('provider') || 'github'
          const full = q.searchParams.get('full') === '1'
          return repoStatus(queryDir(req, fallbackDir), provider, full)
        } catch {
          return repoStatus(queryDir(req, fallbackDir), 'github', false)
        }
      })
    },
    '/repo-diff': async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const q = new URL(req.url ?? '', 'http://localhost')
        const dir = q.searchParams.get('dir') || fallbackDir
        const path = q.searchParams.get('path') || ''
        return repoDiffFlow(dir, path)
      })
    },
    '/stage': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return stageFlow(body.dir || fallbackDir, body.path)
      })
    },
    '/unstage': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return unstageFlow(body.dir || fallbackDir, body.path)
      })
    },
    '/commit': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return commitFlow(body.dir || fallbackDir, body.message, body.paths)
      })
    },
    '/branches': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return branchesFlow(body.dir || fallbackDir)
      })
    },
    '/checkout': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return checkoutFlow(body.dir || fallbackDir, body.branch)
      })
    },
    '/log': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return logFlow(body.dir || fallbackDir, body.count)
      })
    },
    '/revert': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return revertFlow(body.dir || fallbackDir, body.hash)
      })
    },
    '/cherrypick': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return cherryPickFlow(body.dir || fallbackDir, body.hash)
      })
    },
    '/commit-diff': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return commitDiffFlow(body.dir || fallbackDir, body.hash)
      })
    },
    '/push': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return pushFlow(body.dir || fallbackDir)
      })
    },
    '/push-staged': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return pushStagedFlow(body.dir || fallbackDir, body.message)
      })
    },
    '/pull': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return pullFlow(body.dir || fallbackDir)
      })
    },
    '/merge-push': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return mergePushFlow(body.dir || fallbackDir)
      })
    },
    '/force-push': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return forcePushFlow(body.dir || fallbackDir)
      })
    },
    '/force-pull': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return forcePullFlow(body.dir || fallbackDir)
      })
    },
    '/create': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return createRepoFlow(body.dir || fallbackDir, body.name, body.visibility, body.provider || 'github')
      })
    },
    '/set-visibility': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const name = body.name || baseName(body.dir || fallbackDir)
        return setVisibilityFlow(name, body.visibility, body.provider || 'github')
      })
    },
    '/gitee-token': async (req, res) => {
      if (req.method === 'GET') {
        await handle(req, res, async () => ({
          ok: true,
          // 只回传「是否已配置」，不回传令牌本身，避免把密钥写进浏览器/日志。
          configured: readGiteeToken() !== '',
          owner: giteeOwner(),
        }))
      } else if (req.method === 'POST') {
        await handle(req, res, async (req) => {
          const body = JSON.parse((await readBody(req)) || '{}')
          if (body.clear) {
            saveGiteeToken('')
            return { ok: true, configured: false, cleared: true }
          }
          const token = String(body.token || '').trim()
          if (!token) return { ok: false, error: tr('令牌不能为空') }
          saveGiteeToken(token)
          const owner = giteeOwner()
          if (!owner) {
            // 令牌无效则清掉，避免留有坏令牌。
            saveGiteeToken('')
            return { ok: false, error: tr('Gitee 令牌无效，请检查（需有 projects 权限）') }
          }
          return { ok: true, configured: true, owner }
        })
      } else {
        return methodNotAllowed(res, req.method)
      }
    },

    // ---- ④ 克隆远程仓库 ----
    // 默认工作区（⑤ 等板块兜底）。
    '/clone/default-dir': (req, res) => handle(req, res, async () => {
      const dir = cloneDefaultDir()
      return { ok: true, dir, name: baseName(dir) }
    }),
    // home 目录（④ 克隆默认：Windows C:\Users\xxx，Linux/macOS /home/xxx）。
    '/clone/home': (req, res) => handle(req, res, async () => {
      const dir = cloneHomeDir()
      return { ok: true, dir, name: baseName(dir) }
    }),
    '/clone/repos': async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const q = new URL(req.url ?? '', 'http://localhost')
        const provider = q.searchParams.get('provider') || 'github'
        const baseDir = q.searchParams.get('dir') || cloneHomeDir()
        return listRemoteRepos(provider, baseDir)
      })
    },
    '/clone/run': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return cloneFlow(body.url, body.dest, body.name)
      })
    },

    // ---- ⑤ 发布 npm 包 ----
    '/npm/status': async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const q = new URL(req.url ?? '', 'http://localhost')
        return npmStatus(q.searchParams.get('dir') || '')
      })
    },
    '/npm/login': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return npmLoginTerminal(body.dir)
      })
    },
    '/npm/step': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return npmRunStep(body.dir, body.step)
      })
    },
  }

  ctx.effect(() => {
    const disposers = Object.entries(routes).map(([path, handler]) =>
      ctx.webServer.register({ kind: 'exact', path: BASE + path, handler })
    )
    return () => { for (const d of disposers) d() }
  }, 'source-code-mgmt: routes')
}

export default { name, inject, apply }

// 供插件作者 / 测试直接调用（不影响插件加载）。
export { parseVersion, compareVersions, checkGhUpdate, checkGiteeUpdate, checkEnv, installCommand, installCommandSystem, ghUserLevelScript, ghUserLevelSteps, ghReleaseAsset, ghDownloadUrl, normalizeGhSource, GH_MIRRORS, giteeUserLevelScript, toolInstalled, canSudo, installToolFlow, npmStatus, npmLoginTerminal, npmRunStep, ghLoginTerminal, giteeLoginTerminal, findTerminal }
