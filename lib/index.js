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
import { homedir } from 'node:os'

import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'

// ---------- i18n: host messages follow the client’s language (?lang= query param, per request) ----------
const HOST_EN = {"尚未配置 Gitee 私人令牌（请打开 ③ 代码管理输入令牌）":"No Gitee personal token configured (enter one in ③ Code Management)","Gitee API 请求失败（需要 curl）":"Gitee API request failed (curl required)","not a git repository（尚未 git init，可用「新建仓库并推送」初始化为 git 仓库并上传）":"not a git repository (run \"Create repo & push\" to init one and upload)","超过 GitHub 100MB 单文件限制（${}），已被 .gitignore 的 \"${}\" 排除":"Exceeds GitHub's 100MB file limit (${}) — already excluded by .gitignore entry \"${}\"","超过 GitHub 100MB 单文件限制（${}），${} 所在的一级目录「${}」整体忽略（该文件夹为一整体）":"Exceeds GitHub's 100MB file limit (${}) — the whole first-level folder \"${}\" of ${} is ignored (the folder is one unit)","超过 GitHub 100MB 单文件限制（${}），已忽略单个文件「${}」":"Exceeds GitHub's 100MB file limit (${}) — the file \"${}\" was ignored individually","尚未配置远程仓库 origin，请使用「新建仓库」创建远程仓库。":"No origin remote configured — use \"Create repo\" to create a remote repo.","not a git repository（尚未 git init，无法拉取）":"not a git repository (no git init yet — cannot pull)","尚未配置远程仓库 origin，无法拉取。":"No origin remote configured — cannot pull.","拉取存在冲突：本地有未合并改动或与远程冲突，请手动 git pull 处理合并。":"Pull conflicts: you have unmerged local changes or conflicts with the remote — resolve them manually with git pull.","git pull 失败":"git pull failed","not a git repository（尚未 git init）":"not a git repository (run git init first)","拉取并推送失败：合并存在冲突，请手动解决后重试。":"Pull-and-push failed: merge conflicts — resolve them manually and retry.","pull --rebase 失败":"pull --rebase failed","push 失败":"push failed","push --force 失败":"push --force failed","强制拉取存在冲突，请手动处理。":"Force-pull conflicts — handle them manually.","git pull --force 失败":"git pull --force failed","缺少仓库名称":"Repo name required","仓库名称包含非法字符（仅允许字母、数字、点、下划线、横线）":"Repo name contains invalid characters (only letters, digits, dots, underscores, dashes)","git add 失败：${}":"git add failed: ${}","需要先配置 Gitee 私人令牌":"Configure the Gitee personal token first","Gitee 创建仓库失败":"Failed to create the Gitee repo","缺少文件路径":"File path required","无法识别当前分支":"Cannot determine the current branch","尚未配置远程仓库 origin，无法对齐。":"No origin remote configured — cannot align.","git fetch 失败":"git fetch failed","git reset --hard 失败":"git reset --hard failed","git init 失败":"git init failed","git add 失败":"git add failed","git reset 失败":"git reset failed","提交信息不能为空":"Commit message cannot be empty","没有已暂存（staged）的改动可提交":"Nothing staged to commit","git commit 失败":"git commit failed","缺少分支名":"Branch name required","切换分支失败":"Failed to switch branch","git log 失败":"git log failed","缺少 commit hash":"Commit hash required","revert 失败（可能有冲突，请手动处理）":"revert failed (possible conflicts — handle manually)","cherry-pick 失败（可能有冲突，请手动处理）":"cherry-pick failed (possible conflicts — handle manually)","读取提交 diff 失败":"Failed to read the commit diff","未知工具：":"Unknown tool: ","未找到可用的包管理器（":"No usable package manager found (","）。请手动安装。":"). Please install manually.","安装成功":"Installed successfully","安装失败":"Installation failed","$dlg.Description = '选择本地目录';":"$dlg.Description = 'Choose a local folder';","Gitee 修改可见性失败":"Failed to change Gitee visibility","需要先登录 GitHub CLI（gh）":"Log in to the GitHub CLI (gh) first","修改可见性失败：${}":"Failed to change visibility: ${}","gh repo edit 失败":"gh repo edit failed","缺少目录路径":"Folder path required","未选择目录":"No folder selected","目录不存在或不是文件夹：":"Folder does not exist or is not a directory: ","令牌不能为空":"Token cannot be empty","Gitee 令牌无效，请检查（需有 projects 权限）":"Invalid Gitee token — check it (needs projects permission)"};
const requestLangStore = new AsyncLocalStorage();
// 新增板块（④克隆 / ⑤PR / ⑥npm）的 host 英文消息，追加进 HOST_EN。
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
  "未找到可用终端，请手动在目标目录运行：": "No usable terminal found — run this manually in the target directory: ",
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
/** Resolved path to the ssh binary. */
const SSH = resolveBin('ssh', 'DSH_SCM_SSH')
/** Resolved path to the ssh-keygen binary. */
const SSH_KEYGEN = resolveBin('ssh-keygen', 'DSH_SCM_SSH_KEYGEN')
/** Resolved path to curl (used to call the Gitee OpenAPI). */
const CURL = resolveBin('curl', 'DSH_SCM_CURL')
/** Resolved path to npm (used by the ⑥ publish-npm section). */
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
    ssh: {
      installed: SSH !== 'ssh' && SSH !== 'ssh.exe',
      path: SSH,
      sshKeygen: SSH_KEYGEN,
    },
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
 * Build the install command to run for `tool` on this machine, or null when no
 * usable package manager is available. Returns arrays usable with `run`.
 * @param {'git'|'gh'|'ssh'} tool
 */
function installCommand(tool) {
  if (IS_WIN) {
    // SSH 客户端：Windows 内置可选功能（需管理员），走 powershell。
    if (tool === 'ssh') {
      return { bin: 'powershell', args: ['-NoProfile', '-Command', 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'], label: 'Add-WindowsCapability -Online -Name OpenSSH.Client' }
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
    return null
  }
  // Linux：按可用包管理器选择。安装需 root，用 sudo（非交互 -n，避免挂起等待密码；已是 root 则直接跑）。
  const pkg = tool === 'git' ? 'git' : tool === 'gh' ? 'gh' : 'openssh-client'
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const sudo = !isRoot && binExists('sudo') ? 'sudo -n ' : ''
  if (binExists('apt-get')) {
    return { bin: 'sh', args: ['-c', sudo + 'apt-get install -y ' + pkg], label: 'sudo apt-get install -y ' + pkg }
  }
  if (binExists('dnf')) {
    return { bin: 'sh', args: ['-c', sudo + 'dnf install -y ' + pkg], label: 'sudo dnf install -y ' + pkg }
  }
  if (binExists('pacman')) {
    return { bin: 'sh', args: ['-c', sudo + 'pacman -S --noconfirm ' + pkg], label: 'sudo pacman -S ' + pkg }
  }
  return null
}

/**
 * Install a missing tool (git / gh / ssh) using the best available package
 * manager. Best-effort: reports the command it ran and its output.
 * @param {string} tool - 'git' | 'gh' | 'ssh'.
 */
function installToolFlow(tool) {
  const t = String(tool || '').trim().toLowerCase()
  if (t !== 'git' && t !== 'gh' && t !== 'ssh') return { ok: false, error: tr('未知工具：') + tool }
  // 已安装就直接返回，不重复安装。
  const present = t === 'git' ? (GIT && GIT !== 'git')
    : t === 'gh' ? (GH && GH !== 'gh')
    : (SSH && SSH !== 'ssh' && SSH !== 'ssh.exe')
  if (present) return { ok: true, alreadyInstalled: true, tool: t }

  const cmd = installCommand(t)
  if (!cmd) {
    return { ok: false, error: tr('未找到可用的包管理器（') + (IS_WIN ? 'winget / choco / scoop' : process.platform === 'darwin' ? 'brew' : 'apt-get / dnf / pacman') + tr('）。请手动安装。'), tool: t }
  }
  const r = run(cmd.bin, cmd.args, { timeout: 300_000 })
  const output = (r.stdout + '\n' + r.stderr).trim()
  // 安装后复查是否已装上。
  const ok = r.ok && (t === 'git' ? (GIT && GIT !== 'git') : t === 'gh' ? (GH && GH !== 'gh') : !(SSH === 'ssh' || SSH === 'ssh.exe'))
  return {
    ok,
    tool: t,
    command: cmd.label,
    output: output || (ok ? tr('安装成功') : tr('安装失败')),
    needElevation: IS_WIN && t === 'ssh',
  }
}

// ---------------------------------------------------------------------------
// ④ 克隆远程仓库 / ⑤ 提交 PR / ⑥ 发布 npm 包 —— host 逻辑
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

/** 默认克隆位置（⑤⑥ 等板块的工作目录兜底）：DSH 默认工作区。 */
function cloneDefaultDir() {
  return resolveDefaultDir(process.cwd())
}

/**
 * 从仓库 URL / SSH 地址 / owner/repo 解析平台、owner、repo。
 * @param {string} raw - https://github.com/owner/repo | git@github.com:owner/repo.git | owner/repo
 * @returns {{provider:'github'|'gitee', owner:string, repo:string}|{}}
 */
function parseRepoUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return {}
  const gh = /github\.com[/:]([^/\s?#]+)\/([^/\s?#]+)/i.exec(url)
  if (gh) return { provider: 'github', owner: gh[1], repo: gh[2].replace(/\.git$/i, '') }
  const gt = /gitee\.com[/:]([^/\s?#]+)\/([^/\s?#]+)/i.exec(url)
  if (gt) return { provider: 'gitee', owner: gt[1], repo: gt[2].replace(/\.git$/i, '') }
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(url)
  if (bare) return { provider: 'github', owner: bare[1], repo: bare[2].replace(/\.git$/i, '') }
  return {}
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

// ---------- ⑤ 提交 PR（Pull Request） ----------

/** 用户填写的 PR 目标仓库列表（记录到 ~/.dsh/storages，不写入插件目录）。 */
function prTargetsFile() {
  return join(homedir(), '.dsh', 'storages', 'source-code-mgmt-pr-targets.json')
}
function readPrTargets() {
  try {
    const f = prTargetsFile()
    if (!existsSync(f)) return []
    const data = JSON.parse(readFileSync(f, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch { return [] }
}
function savePrTarget(url) {
  const { provider, owner, repo } = parseRepoUrl(url)
  if (!owner || !repo) return readPrTargets()
  const list = readPrTargets()
  const clean = list.filter((t) => String(t.url || '').trim().toLowerCase() !== String(url).trim().toLowerCase())
  clean.unshift({ url: String(url).trim(), provider, owner, repo, addedAt: new Date().toISOString() })
  try {
    const f = prTargetsFile()
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(clean.slice(0, 50), null, 2), 'utf8')
  } catch { /* ignore */ }
  return clean
}
function removePrTarget(url) {
  const list = readPrTargets().filter((t) => String(t.url || '').trim().toLowerCase() !== String(url || '').trim().toLowerCase())
  try {
    const f = prTargetsFile()
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(list, null, 2), 'utf8')
  } catch { /* ignore */ }
  return list
}

/** 插件根目录（用于存放 AI 思考出的 PR 规则缓存）。 */
function pluginRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}
function prRulesDir() {
  return join(pluginRoot(), 'rules')
}
function prRulePath(owner, repo) {
  return join(prRulesDir(), owner + '__' + repo + '.json')
}
function readPrRule(owner, repo) {
  try {
    const p = prRulePath(owner, repo)
    if (!existsSync(p)) return undefined
    const data = JSON.parse(readFileSync(p, 'utf8'))
    return data && typeof data === 'object' ? data : undefined
  } catch { return undefined }
}
function writePrRule(owner, repo, rule) {
  try {
    mkdirSync(prRulesDir(), { recursive: true })
    writeFileSync(prRulePath(owner, repo), JSON.stringify(rule, null, 2), 'utf8')
    return true
  } catch { return false }
}

/** 从 { 到 } 尽量提取 JSON（AI 可能包裹 markdown 代码块）。 */
function parseJsonLoose(text) {
  const s = String(text || '').trim()
  try { return JSON.parse(s) } catch { /* continue */ }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

/** 读取 GitHub 仓库内某文件的文本内容（gh api），失败返回 undefined。 */
function ghFileText(owner, repo, path) {
  const r = run(GH, ['api', 'repos/' + owner + '/' + repo + '/contents/' + path, '--jq', '.content'], { timeout: 30_000 })
  if (!r.ok) return undefined
  try {
    const b64 = r.stdout.trim()
    if (!b64) return undefined
    return Buffer.from(b64, 'base64').toString('utf8')
  } catch { return undefined }
}

/** 抓取目标仓库的关键文档（README / CONTRIBUTING / PR 模板 / package.json scripts），供 AI 分析 PR 规则。 */
async function gatherRepoDocs(provider, owner, repo) {
  const docs = {}
  const candidates = [
    'README.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md',
    '.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'package.json',
  ]
  for (const c of candidates) {
    if (provider === 'gitee') {
      const api = giteeApi('GET', 'repos/' + owner + '/' + repo + '/contents/' + c)
      if (api.ok && api.data && typeof api.data.content === 'string') {
        try { docs[c] = Buffer.from(api.data.content, 'base64').toString('utf8') } catch {}
      }
    } else {
      const txt = ghFileText(owner, repo, c)
      if (txt !== undefined) docs[c] = txt
    }
  }
  return docs
}

/** AI 思考 PR 规则的 system 提示词：要求输出结构化 JSON（步骤数组）。 */
const PR_RULE_SYSTEM = [
  '你是一个开源仓库 PR 流程分析器。用户要往一个 GitHub/Gitee 仓库提交 Pull Request（提交内容通常是「把某个 DSH 插件收录进该仓库的插件列表 / 或按该仓库规则提交一份变更」）。',
  '请先分析该仓库的 PR 规则（基于 README / CONTRIBUTING / PR 模板 / package.json scripts），然后输出一个 JSON（不要任何多余文字、不要 markdown 代码块，直接输出 JSON 对象）：',
  '{',
  '  "baseBranch": "上游默认分支，如 main 或 master",',
  '  "entryFilePath": "新增条目文件的相对路径（若适用；如 data/plugins/owner__repo.yml），否则 null",',
  '  "entryTemplate": "条目文件的内容模板（含占位符，如 {NAME} {DESCRIPTION}），若适用；否则 null",',
  '  "regenerateCommands": ["重生成 README 的命令数组（如 [\\"node\\", \\"scripts/generate-readme.mjs\\"]），没有则为 []"],',
  '  "prTitle": "PR 标题建议，如 Add owner/repo",',
  '  "prBodyHint": "PR 描述应包含的要点（中文一句话概括）",',
  '  "steps": [',
  '    { "type": "ensure-fork" },',
  '    { "type": "clone-fork" },',
  '    { "type": "add-upstream" },',
  '    { "type": "fetch-upstream" },',
  '    { "type": "branch", "name": "add-<插件名>" },',
  '    { "type": "write-entry" },',
  '    { "type": "regenerate-readme" },',
  '    { "type": "commit", "message": "Add owner/repo" },',
  '    { "type": "push" },',
  '    { "type": "create-pr" }',
  '  ]',
  '}',
  '要求：steps 按真实执行顺序排列，只包含上面列出的 type；不确定的字段给 null 或空数组，不要编造。',
].join('\n')

/**
 * 用户已提供规则（手动文本或规则文件）时的 system 提示词：忠实整理为结构化 JSON，
 * 不额外抓取仓库文档、不编造——精简提示词以节省 token。
 */
const PR_RULE_SYSTEM_USER = [
  '你是一个开源仓库 PR 流程规则整理器。用户已直接提供该仓库的 PR 规则（手写文本或规则文件，如 README / CONTRIBUTING）。',
  '请把用户提供的规则忠实整理成下面的 JSON（不要任何多余文字、不要 markdown 代码块，直接输出 JSON 对象）：',
  '{',
  '  "baseBranch": "上游默认分支，如 main 或 master",',
  '  "entryFilePath": "新增条目文件的相对路径（若适用；如 data/plugins/owner__repo.yml），否则 null",',
  '  "entryTemplate": "条目文件的内容模板（含占位符，如 {NAME} {DESCRIPTION}），若适用；否则 null",',
  '  "regenerateCommands": ["重生成 README 的命令数组（如 [\\"node\\", \\"scripts/generate-readme.mjs\\"]），没有则为 []"],',
  '  "prTitle": "PR 标题建议，如 Add owner/repo",',
  '  "prBodyHint": "PR 描述应包含的要点（中文一句话概括）",',
  '  "steps": [',
  '    { "type": "ensure-fork" },',
  '    { "type": "clone-fork" },',
  '    { "type": "add-upstream" },',
  '    { "type": "fetch-upstream" },',
  '    { "type": "branch", "name": "add-<插件名>" },',
  '    { "type": "write-entry" },',
  '    { "type": "regenerate-readme" },',
  '    { "type": "commit", "message": "Add owner/repo" },',
  '    { "type": "push" },',
  '    { "type": "create-pr" }',
  '  ]',
  '}',
  '要求：steps 按真实执行顺序排列，只包含上面列出的 type；只依据用户提供的规则整理，不要额外假设、不要编造用户没提到的字段。',
].join('\n')

/**
 * 解析用户提供的规则来源：ruleText（手写文本）或 ruleFile（本地路径 / http(s) URL）。
 * @param {string} [ruleText] - 用户手动填写的 PR 规则文本。
 * @param {string} [ruleFile] - 规则文件路径或 URL（如某仓库 README）。
 * @returns {Promise<{text?:string, error?:string}>} 读取到的文本或错误。
 */
async function resolveRuleInput(ruleText, ruleFile) {
  const text = String(ruleText || '').trim()
  if (text) return { text }
  const file = String(ruleFile || '').trim()
  if (!file) return {}
  if (/^https?:\/\//i.test(file)) {
    // 远程 URL：优先 Node 全局 fetch，失败回退 curl。
    try {
      if (typeof fetch === 'function') {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 20000)
        try {
          const resp = await fetch(file, { redirect: 'follow', signal: ctrl.signal })
          if (resp.ok) {
            const body = await resp.text()
            if (body) return { text: body }
          }
        } finally { clearTimeout(timer) }
      }
    } catch { /* 继续尝试 curl */ }
    const r = run('curl', ['-sL', '--max-time', '20', file], { timeout: 30000 })
    if (r.ok && r.stdout) return { text: r.stdout }
    return { error: tr('规则文件获取失败：') + file }
  }
  if (existsSync(file)) {
    try { return { text: readFileSync(file, 'utf8') } }
    catch (e) { return { error: tr('规则文件读取失败：') + String((e && e.message) || e) } }
  }
  return { error: tr('找不到规则文件：') + file }
}

/**
 * 分析某仓库的 PR 规则：命中插件目录 rules/ 缓存则直接返回；否则抓取仓库文档（或用户提供的
 * 规则文本/文件）→ LLM 思考 → 保存缓存。
 * @param {*} ctx - cordis context。
 * @param {{url: string, force?: boolean, ruleText?: string, ruleFile?: string}} input -
 *   目标仓库 URL；force=true 忽略缓存重新分析；ruleText/ruleFile 为用户提供的规则来源（可选）。
 */
async function prAnalyzeFlow(ctx, { url, force, ruleText, ruleFile }) {
  const { provider, owner, repo } = parseRepoUrl(url)
  if (!owner || !repo) return { ok: false, error: tr('无法识别仓库地址：') + String(url || '') }
  // 用户提供了规则（文本或文件）→ 视为新的分析输入，忽略缓存直接分析。
  const hasUserInput = !!String(ruleText || '').trim() || !!String(ruleFile || '').trim()
  if (!force && !hasUserInput) {
    const cached = readPrRule(owner, repo)
    if (cached) return { ok: true, cached: true, provider, owner, repo, rule: cached }
  }
  let userRule = ''
  if (hasUserInput) {
    const r = await resolveRuleInput(ruleText, ruleFile)
    if (r.error) return { ok: false, error: r.error }
    userRule = String(r.text || '').trim()
    if (!userRule) return { ok: false, error: tr('未获取到规则内容（文件为空或无法读取）') }
  }
  let system, messages, docSources
  if (userRule) {
    system = PR_RULE_SYSTEM_USER
    messages = [{
      role: 'user',
      text: '目标仓库：' + provider + ' ' + owner + '/' + repo + '\n\n用户提供的该仓库 PR 规则（请忠实整理，不要编造）：\n' + userRule.slice(0, 20000),
    }]
    docSources = []
  } else {
    const docs = await gatherRepoDocs(provider, owner, repo)
    system = PR_RULE_SYSTEM
    messages = [{
      role: 'user',
      text: '目标仓库：' + provider + ' ' + owner + '/' + repo + '\n\n仓库关键文档（尽力抓取，可能不全）：\n'
        + (Object.keys(docs).length ? JSON.stringify(docs, null, 2).slice(0, 12000) : '(无可用文档)'),
    }]
    docSources = Object.keys(docs)
  }
  const res = await llmComplete(ctx, { system, messages, maxTokens: 3000, temperature: 0.3 })
  if (!res.ok) return res
  const rule = parseJsonLoose(res.text)
  if (!rule || typeof rule !== 'object') return { ok: false, error: tr('AI 未输出有效规则') }
  if (!Array.isArray(rule.steps)) rule.steps = []
  rule.owner = owner; rule.repo = repo; rule.provider = provider
  rule.generatedAt = new Date().toISOString()
  rule.model = res.model
  rule.docSources = docSources
  if (userRule) rule.userProvided = true
  writePrRule(owner, repo, rule)
  return { ok: true, cached: false, provider, owner, repo, rule, model: res.model }
}

/**
 * 用 AI 生成 PR 内容（标题 + 描述 + 条目文件内容）。生成后由用户在 UI 里修改，不直接提交。
 * 当规则自带 entryTemplate 且插件信息齐全时，直接按模板本地填充（零 AI 消耗、可编辑）；
 * 否则调用 LLM 生成。
 * @param {*} ctx - cordis context。
 * @param {{url: string, rule?: object, pluginInfo?: object}} input
 */
async function prGenerateFlow(ctx, { url, rule, pluginInfo }) {
  const { owner, repo } = parseRepoUrl(url)
  if (!owner || !repo) return { ok: false, error: tr('无法识别仓库地址：') + String(url || '') }
  const info = (pluginInfo && typeof pluginInfo === 'object') ? pluginInfo : {}
  const vars = { owner, repo, info }

  // 模板直填路径：规则带 entryTemplate 时按 {VAR} 占位符本地生成（零 AI，仍可编辑）。
  if (rule && typeof rule.entryTemplate === 'string' && rule.entryTemplate !== '') {
    const entry = fillPrTemplate(rule.entryTemplate, vars)
    const title = fillPrTemplate(String(rule.prTitle || 'Add {NAME}'), vars) || ('Add ' + owner + '/' + repo)
    const body = fillPrTemplate(String(rule.prBodyHint || ''), vars)
    return {
      ok: true,
      title,
      body,
      entry,
      fromTemplate: true,
      provider: rule.provider || undefined,
      model: rule.model || 'template',
    }
  }

  const system = [
    '你是 PR 内容生成助手。下面给出目标仓库的 PR 规则与用户要提交的插件信息，请生成三样内容并输出 JSON：',
    '{ "title": "PR 标题", "body": "PR 描述（markdown，说明改动内容、已满足的前置条件）", "entry": "条目文件内容（若规则有 entryFilePath/entryTemplate 则按模板生成；否则 null）" }',
    '直接输出 JSON，不要 markdown 代码块，不要多余文字。',
  ].join('\n')
  const messages = [{
    role: 'user',
    text: '目标仓库规则：\n' + JSON.stringify(rule || {}, null, 2) + '\n\n用户要提交的插件信息：\n' + JSON.stringify(info, null, 2),
  }]
  const res = await llmComplete(ctx, { system, messages, maxTokens: 3000, temperature: 0.5 })
  if (!res.ok) return res
  const parsed = parseJsonLoose(res.text)
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: tr('AI 输出无法解析') }
  return {
    ok: true,
    title: String(parsed.title || ''),
    body: String(parsed.body || ''),
    entry: parsed.entry == null ? null : String(parsed.entry),
    provider: res.provider,
    model: res.model,
  }
}

/** 当前分支名（git rev-parse --abbrev-ref HEAD），失败回退 'main'。 */
function currentBranch(dir) {
  const r = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok && r.stdout.trim() && r.stdout.trim() !== 'HEAD' ? r.stdout.trim() : 'main'
}

/**
 * 校验 PR 规则里的条目文件路径：必须是仓库内相对路径，且解析后不得逃出 cloneDir
 * （防路径穿越 —— 规则来自 AI/缓存，可能被恶意仓库文档诱导出 "../.." 路径）。
 * @param {string} cloneDir - fork 克隆目录。
 * @param {string} p - 规则给出的 entryFilePath。
 * @returns {boolean} 安全则 true。
 */
function safeEntryPath(cloneDir, p) {
  if (typeof p !== 'string' || p === '') return false
  // 绝对路径（Windows 盘符 / POSIX 根 / 反斜杠）一律拒绝。
  if (/^([a-zA-Z]:[\\/]|\/|\\)/.test(p)) return false
  // 任何 .. 段（含 \..\、/../、..\ 前缀、../ 前缀）一律拒绝。
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return false
  const root = join(cloneDir, p)
  const base = cloneDir.replace(/[\\/]+$/, '')
  return root === base || root.startsWith(base + '\\') || root.startsWith(base + '/')
}

/**
 * 校验 PR 规则里的重生成命令：只允许常见构建/脚本命令 + 纯参数，拒绝绝对路径、
 * 环境变量展开、shell 元字符、重定向与明显危险的命令名。命令本身仍是数组传递
 * （execFileSync 不经过 shell），此校验是纵深防御，防止 AI 规则注入恶意命令。
 * @param {string[]} cmds - [bin, ...args]
 * @returns {boolean}
 */
const SAFE_REGENERATE_BINS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'py',
  'make', 'cmake',
  'sh', 'bash', 'zsh',
  'ruby', 'perl', 'php',
  'dotnet', 'go', 'cargo', 'rustc',
  'git', 'awk', 'sed', 'grep', 'cat',
])
// 参数不允许 shell 元字符 / 重定向 / 命令替换。命令名已由白名单约束（不经 shell，
// 数组传递），此处只拦会被 shell 语义扩展、可能被后续误用的字符。
const SHELL_META_PATTERN = /[|&;<>`$]/
function safeRegenerateCommand(cmds) {
  // 兼容两种形态：单条 [bin, ...args] 或多条 [[bin,...],[bin,...]]（顺序执行）。
  const list = (Array.isArray(cmds) && cmds.length > 0 && Array.isArray(cmds[0])) ? cmds : [cmds]
  for (const c of list) {
    if (!Array.isArray(c) || c.length === 0) return false
    const bin = String(c[0] || '').trim()
    if (bin === '') return false
    // 命令名必须是裸名称（不含路径分隔符），且在白名单内。
    if (/[\\/]/.test(bin)) return false
    if (!SAFE_REGENERATE_BINS.has(bin)) return false
    // 参数不允许 shell 元字符 / 重定向。
    for (let i = 1; i < c.length; i++) {
      const a = String(c[i] ?? '')
      if (SHELL_META_PATTERN.test(a)) return false
    }
  }
  return true
}

/**
 * 用 {VAR} 占位符填充规则模板（OWNER/REPO/NAME/CATEGORY/DESC_EN/DESC_ZH）。
 * @param {string} tpl
 * @param {{owner:string,repo:string,info:object}} vars
 */
function fillPrTemplate(tpl, vars) {
  const map = {
    OWNER: vars.owner,
    REPO: vars.repo,
    NAME: String(vars.info && vars.info.name ? vars.info.name : vars.owner + '/' + vars.repo),
    CATEGORY: String(vars.info && vars.info.category ? vars.info.category : ''),
    DESC_EN: String(vars.info && vars.info.descriptionEn ? vars.info.descriptionEn : ''),
    DESC_ZH: String(vars.info && vars.info.descriptionZh ? vars.info.descriptionZh : ''),
  }
  return String(tpl ?? '').replace(/\{(OWNER|REPO|NAME|CATEGORY|DESC_EN|DESC_ZH)\}/g, (_, k) => map[k] ?? '')
}

/**
 * 预置规则：awesome-dsh-plugin 插件收录 PR（依据 提示词.md §2 流程）。
 * 写入插件目录 rules/awesome-dsh-plugin__awesome-dsh-plugin.json；已存在则不覆盖
 * （用户/AI 更新过的规则优先）。
 */
const PRESET_PR_RULES = [{
  owner: 'awesome-dsh-plugin',
  repo: 'awesome-dsh-plugin',
  rule: {
    provider: 'github',
    owner: 'awesome-dsh-plugin',
    repo: 'awesome-dsh-plugin',
    baseBranch: 'main',
    entryFilePath: 'data/plugins/{OWNER}__{REPO}.yml',
    entryTemplate: [
      'url: https://github.com/{OWNER}/{REPO}',
      'name: {NAME}',
      'category: {CATEGORY}',
      'description:',
      "  en: '{DESC_EN}'",
      "  zh: '{DESC_ZH}'",
      '',
    ].join('\n'),
    regenerateCommands: [['npm', 'ci'], ['node', 'scripts/generate-readme.mjs']],
    prTitle: 'Add {NAME}',
    prBodyHint: '新增条目文件 data/plugins/{OWNER}__{REPO}.yml；已运行重生成命令更新 README；仓库已满足 dsh.bundle 声明、满 1 天、提交数 ≥10、dsh-plugin topic；描述已对照源码核实。',
    steps: [
      { type: 'ensure-fork' },
      { type: 'clone-fork' },
      { type: 'add-upstream' },
      { type: 'fetch-upstream' },
      { type: 'branch', name: 'add-{REPO}' },
      { type: 'write-entry' },
      { type: 'regenerate-readme' },
      { type: 'commit', message: 'Add {NAME}' },
      { type: 'push' },
      { type: 'create-pr' },
    ],
    preset: true,
    generatedAt: '2026-09 (preset)',
    model: 'preset',
  },
}]

/** 启动时把预置规则写入插件目录 rules/（仅当对应文件不存在）。 */
function seedPresetPrRules() {
  for (const p of PRESET_PR_RULES) {
    if (readPrRule(p.owner, p.repo)) continue
    writePrRule(p.owner, p.repo, p.rule)
  }
}

/**
 * 按规则执行 PR：fork → 克隆 fork → 加 upstream → 拉取 → 建分支 → 写条目 → 重生成 README →
 * 提交 → 推送 → 开 PR（GitHub 走 gh，Gitee 走 OpenAPI）。
 * @param {*} ctx - cordis context。
 * @param {{url: string, workdir?: string, rule?: object, entryContent?: string, title?: string, body?: string, base?: string}} input
 */
async function prExecuteFlow(ctx, { url, workdir, rule, entryContent, title, body, base }) {
  const { provider, owner, repo } = parseRepoUrl(url)
  if (!owner || !repo) return { ok: false, error: tr('无法识别仓库地址：') + String(url || '') }
  const steps = rule && Array.isArray(rule.steps) ? rule.steps : []
  if (steps.length === 0) return { ok: false, error: tr('没有可用的 PR 步骤（请先让 AI 分析规则）') }
  const work = String(workdir || '').trim() || cloneDefaultDir()
  const cloneDir = join(work, repo)
  const upstreamUrl = provider === 'gitee'
    ? 'https://gitee.com/' + owner + '/' + repo + '.git'
    : 'https://github.com/' + owner + '/' + repo + '.git'
  const baseBranch = base || (rule && rule.baseBranch) || 'main'
  const logs = []
  const stepRun = (label, cmd, args, opts = {}) => {
    const r = run(cmd, args, { ...opts, timeout: opts.timeout ?? 300_000, cwd: opts.cwd || cloneDir, env: { ...process.env, GIT_SSH: WORKING_SSH, ...(opts.env || {}) } })
    logs.push({ label, ok: r.ok, output: ((r.stdout || '') + (r.stderr || '')).trim() })
    return r
  }
  for (const s of steps) {
    const type = s && typeof s === 'object' ? String(s.type || '') : String(s || '')
    switch (type) {
      case 'ensure-fork': {
        if (provider === 'gitee') {
          const o = giteeOwner()
          if (!o) return { ok: false, logs, error: tr('需要先配置 Gitee 私人令牌') }
          const api = giteeApi('POST', 'repos/' + owner + '/' + repo + '/forks')
          logs.push({ label: tr('确保 fork'), ok: api.ok || giteeApiFailed(api.data) === false, output: (api.error || tr('已 fork 或 fork 已存在')) })
        } else {
          const fr = run(GH, ['repo', 'fork', owner + '/' + repo, '--remote=false'], { timeout: 120_000, env: { GIT_SSH: WORKING_SSH } })
          const blob = ((fr.stdout || '') + (fr.stderr || '')).trim()
          // gh repo fork 在 fork 已存在时以非零退出并提示 "already exists"，视为成功；
          // 其他失败（网络/权限）才记为失败。
          const already = /already exists/i.test(blob)
          logs.push({ label: tr('确保 fork'), ok: fr.ok || already, output: blob || tr('已 fork 或 fork 已存在') })
        }
        break
      }
      case 'clone-fork': {
        if (existsSync(cloneDir) && existsSync(join(cloneDir, '.git'))) {
          logs.push({ label: tr('克隆 fork'), ok: true, output: tr('已存在本地副本：') + cloneDir })
        } else {
          const me = provider === 'gitee' ? (giteeOwner() || owner) : (ghOwner() || owner)
          const forkUrl = provider === 'gitee'
            ? ('git@gitee.com:' + me + '/' + repo + '.git')
            : ('git@github.com:' + me + '/' + repo + '.git')
          const r = run(GIT, ['clone', forkUrl, cloneDir], { timeout: 600_000, env: { GIT_SSH: WORKING_SSH } })
          logs.push({ label: tr('克隆 fork'), ok: r.ok, output: ((r.stdout || '') + (r.stderr || '')).trim() || tr('已克隆到 ') + cloneDir })
          if (!r.ok) return { ok: false, logs, error: tr('克隆 fork 失败') }
        }
        break
      }
      case 'add-upstream': {
        let r = stepRun(tr('添加上游'), GIT, ['remote', 'add', 'upstream', upstreamUrl])
        if (!r.ok) r = stepRun(tr('添加上游'), GIT, ['remote', 'set-url', 'upstream', upstreamUrl])
        logs[logs.length - 1].output = ((r.stdout || '') + (r.stderr || '')).trim() || upstreamUrl
        break
      }
      case 'fetch-upstream': {
        const r = stepRun(tr('拉取上游'), GIT, ['fetch', 'upstream'], { timeout: 120_000 })
        if (!r.ok) logs[logs.length - 1].output = ((r.stdout || '') + (r.stderr || '')).trim() || tr('拉取失败')
        break
      }
      case 'branch': {
        const raw = (s && s.name) || ('add-' + repo)
        const b = fillPrTemplate(String(raw), { owner, repo, info: {} })
        const r = stepRun(tr('新建分支'), GIT, ['checkout', '-B', b, 'upstream/' + baseBranch])
        if (!r.ok) {
          logs[logs.length - 1].output = ((r.stdout || '') + (r.stderr || '')).trim() || tr('创建分支失败')
          // 分支创建失败必须中止：后续 write-entry/commit/push 会在错误的当前分支上
          // 继续（例如推送到 fork 默认分支），可能造成非预期提交。
          return { ok: false, logs, error: tr('创建分支失败（上游分支可能不存在，请检查规则 baseBranch）') }
        }
        break
      }
      case 'write-entry': {
        const p = fillPrTemplate(String((s && s.path) || (rule && rule.entryFilePath) || '').trim(), { owner, repo, info: {} })
        if (!p) { logs.push({ label: tr('写入条目'), ok: false, output: tr('缺少条目文件路径') }); break }
        // 防路径穿越：条目路径必须安全落在 cloneDir 内（规则来自 AI/缓存，可能被诱导）。
        if (!safeEntryPath(cloneDir, p)) {
          logs.push({ label: tr('写入条目'), ok: false, output: tr('条目文件路径不安全（已拦截）') + ': ' + p })
          return { ok: false, logs, error: tr('条目文件路径不安全（已拦截）') }
        }
        try {
          mkdirSync(dirname(join(cloneDir, p)), { recursive: true })
          writeFileSync(join(cloneDir, p), entryContent || '', 'utf8')
          logs.push({ label: tr('写入条目'), ok: true, output: p })
        } catch (e) { logs.push({ label: tr('写入条目'), ok: false, output: String(e) }) }
        break
      }
      case 'regenerate-readme': {
        const raw = (Array.isArray(s && s.commands) ? s.commands : (rule && rule.regenerateCommands)) || []
        // 兼容两种形态：单条 [bin, ...args] 或多条 [[bin,...],[bin,...]]（顺序执行）。
        const cmds = (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) ? raw : [raw]
        if (cmds.length > 0) {
          // 防恶意规则：只允许白名单构建命令 + 安全参数（AI 规则可能注入任意命令）。
          if (!safeRegenerateCommand(cmds)) {
            logs.push({ label: tr('重生成 README'), ok: false, output: tr('重生成命令不安全（已拦截）') + ': ' + String(cmds[0] && cmds[0][0] || '') })
            return { ok: false, logs, error: tr('重生成命令不安全（已拦截）') }
          }
          let failed = false
          for (const c of cmds) {
            const r = stepRun(tr('重生成 README'), c[0], c.slice(1), { timeout: 180_000 })
            if (!r.ok) { logs[logs.length - 1].output = ((r.stdout || '') + (r.stderr || '')).trim() || tr('执行失败'); failed = true; break }
          }
          if (failed) return { ok: false, logs, error: tr('执行失败') }
        } else {
          logs.push({ label: tr('重生成 README'), ok: true, output: tr('无命令，跳过') })
        }
        break
      }
      case 'commit': {
        run(GIT, ['-C', cloneDir, 'add', '-A'])
        const ident = run(GIT, ['-C', cloneDir, 'config', 'user.email'])
        if (!ident.ok) {
          run(GIT, ['-C', cloneDir, 'config', 'user.name', 'DSH User'])
          run(GIT, ['-C', cloneDir, 'config', 'user.email', 'dsh@localhost'])
        }
        const msg = fillPrTemplate(String((s && s.message) || '').trim(), { owner, repo, info: {} }) || ('Add ' + owner + '/' + repo)
        const r = run(GIT, ['-C', cloneDir, 'commit', '-m', msg], { timeout: 60_000 })
        logs.push({ label: tr('提交'), ok: r.ok || /nothing to commit|no changes added/i.test(((r.stdout || '') + (r.stderr || ''))), output: ((r.stdout || '') + (r.stderr || '')).trim() || tr('已提交') })
        break
      }
      case 'push': {
        const r = stepRun(tr('推送'), GIT, ['push', '-u', 'origin', currentBranch(cloneDir)], { timeout: 180_000 })
        if (!r.ok) {
          logs[logs.length - 1].output = ((r.stdout || '') + (r.stderr || '')).trim() || tr('推送失败')
          return { ok: false, logs, error: tr('推送失败') }
        }
        break
      }
      case 'create-pr': {
        const titleTxt = String(title || '').trim()
          || fillPrTemplate(String((s && s.title) || (rule && rule.prTitle) || ''), { owner, repo, info: {} })
          || ('Add ' + owner + '/' + repo)
        const bodyTxt = String(body || '').trim()
        const branchName = currentBranch(cloneDir)
        if (provider === 'gitee') {
          const tok = readGiteeToken()
          const o = giteeOwner()
          if (!o || !tok) return { ok: false, logs, error: tr('需要先配置 Gitee 私人令牌') }
          const api = giteeApi('POST', 'repos/' + owner + '/' + repo + '/pulls', { title: titleTxt, head: o + ':' + branchName, base: baseBranch, body: bodyTxt || undefined }, tok)
          const urlM = api.ok && api.data && typeof api.data.html_url === 'string' ? api.data.html_url : undefined
          logs.push({ label: tr('创建 PR'), ok: api.ok, output: urlM || (api.error || (api.data && api.data.message) || tr('创建 PR 失败')) })
          return { ok: api.ok, logs, prUrl: urlM, error: api.ok ? undefined : (api.error || (api.data && api.data.message) || tr('创建 PR 失败')) }
        }
        const me = ghOwner() || owner
        const args = ['pr', 'create', '--repo', owner + '/' + repo, '--head', me + ':' + branchName, '--base', baseBranch, '--title', titleTxt]
        if (bodyTxt) args.push('--body', bodyTxt)
        const r = run(GH, args, { timeout: 180_000, cwd: cloneDir, env: { GIT_SSH: WORKING_SSH } })
        const blob = ((r.stdout || '') + (r.stderr || '')).trim()
        const urlM = /https:\/\/github\.com\/[^\s"]+/.exec(blob)
        logs.push({ label: tr('创建 PR'), ok: r.ok, output: blob || tr('已创建 PR') })
        return { ok: r.ok, logs, prUrl: urlM ? urlM[0] : undefined, error: r.ok ? undefined : (blob || tr('创建 PR 失败')) }
      }
      default:
        logs.push({ label: type || tr('未知步骤'), ok: false, output: tr('未知步骤类型') })
    }
  }
  return { ok: true, logs }
}

// ---------- ⑥ 发布 npm 包（npm publish） ----------

/** npm 状态：是否安装、registry、whoami、目标目录是否存在 package.json。 */
function npmStatus(dir) {
  const npm = NPM
  const cwd = String(dir || '').trim() || cloneDefaultDir()
  const installed = npm !== 'npm' && npm !== 'npm.cmd'
  const registry = run(npm, ['config', 'get', 'registry'], { shell: IS_WIN })
  const whoami = run(npm, ['whoami'], { shell: IS_WIN })
  return {
    ok: true,
    installed,
    npmPath: npm,
    dir: cwd,
    dirExists: existsSync(cwd),
    hasPackageJson: existsSync(join(cwd, 'package.json')),
    registry: registry.ok ? registry.stdout.trim() : undefined,
    whoami: whoami.ok ? whoami.stdout.trim() : undefined,
    whoamiError: whoami.ok ? undefined : ((whoami.stderr || whoami.stdout || '').trim() || tr('未登录 npm')),
  }
}

/**
 * 打开一个终端窗口，在目标目录运行 `npm login`（交互式登录无法非交互执行，
 * 需要用户在弹出的终端里完成）。Windows 用 `start cmd /k`；macOS/Linux 探测常见终端。
 * @param {string} [dir] - 目标目录。
 * @returns {{ok:boolean, opened:boolean, command:string, detail:string}}
 */
function npmLoginTerminal(dir) {
  const cwd = String(dir || '').trim() || cloneDefaultDir()
  const command = 'npm login'
  const cdCmd = IS_WIN
    ? `cd /d "${cwd}" && ${command}`
    : `cd "${cwd}" && ${command}`
  try {
    if (IS_WIN) {
      // start cmd /k 打开独立窗口（第一引号段是窗口标题）；detached 不阻塞宿主。
      const child = spawn('cmd', ['/c', 'start', '"npm-login"', 'cmd', '/k', cdCmd], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 npm login 后回到面板点「重新检查」') }
    }
    const terms = [
      ['x-terminal-emulator', ['-e', 'sh', '-c', cdCmd]],
      ['gnome-terminal', ['--', 'sh', '-c', cdCmd]],
      ['konsole', ['-e', 'sh', '-c', cdCmd]],
      ['xterm', ['-e', 'sh', '-c', cdCmd]],
    ]
    for (const [bin, args] of terms) {
      try {
        const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
        child.unref()
        return { ok: true, opened: true, command, detail: tr('已打开终端窗口，请完成 npm login 后回到面板点「重新检查」') }
      } catch { /* try next terminal */ }
    }
    return { ok: false, opened: false, command, detail: tr('未找到可用终端，请手动在目标目录运行：') + command }
  } catch (e) {
    return { ok: false, opened: false, command, detail: String((e && e.message) || e) }
  }
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
      return { ok: true, step, output: r.ok ? r.stdout.trim() : ((r.stderr || '') + (r.stdout || '')).trim() }
    }
    case 'list': {
      const r = runNpm(['config', 'list'])
      return { ok: true, step, output: redactNpmList((r.stdout || '') + (r.stderr || '')) }
    }
    case 'whoami': {
      const r = runNpm(['whoami'])
      return { ok: true, step, output: r.ok ? r.stdout.trim() : ((r.stderr || r.stdout || '').trim() || tr('未登录 npm')), loggedIn: r.ok }
    }
    case 'pack': {
      const r = runNpm(['pack', '--dry-run'], 120_000)
      return { ok: true, step, output: (r.stdout || '') + (r.stderr || '') }
    }
    case 'publish': {
      const r = runNpm(['publish'], 180_000)
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
  // 启动时把预置 PR 规则（awesome-dsh-plugin 等）写入插件目录 rules/（不存在才写）。
  seedPresetPrRules()
  const fallbackDir = resolveDefaultDir(process.cwd())
  // 每个请求按 ?lang= 参数跑在独立语言上下文里（AsyncLocalStorage），
  // 所有 flow 函数内的 tr() 都能读到当前请求的语言，并发请求互不干扰。
  const handle = async (req, res, fn) => requestLangStore.run(langOf(req), async () => {
    if (!isLoopbackRequest(req)) return forbidden(res)
    const payload = await fn(req)
    json(res, 200, payload)
  })

  const routes = {
    '/env': (req, res) => handle(req, res, async () => ({ ok: true, ...checkEnv() })),
    '/install-tool': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return installToolFlow(body.tool)
      })
    },
    '/ssh': (req, res) => handle(req, res, async () => ({ ok: true, ...checkSsh() })),
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
    // 默认工作区（⑤⑥ 等板块兜底）。
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

    // ---- ⑤ 提交 PR ----
    '/pr/targets': async (req, res) => {
      if (req.method === 'GET') {
        await handle(req, res, async () => ({ ok: true, targets: readPrTargets() }))
      } else if (req.method === 'POST') {
        await handle(req, res, async (req) => {
          const body = JSON.parse((await readBody(req)) || '{}')
          const url = String(body.url || '').trim()
          if (!url) return { ok: false, error: tr('缺少仓库地址') }
          if (body.remove) return { ok: true, targets: removePrTarget(url) }
          return { ok: true, targets: savePrTarget(url) }
        })
      } else {
        return methodNotAllowed(res, req.method)
      }
    },
    // 只读查询某仓库是否有缓存规则（命中插件目录 rules/，不触发 AI，不生成）。
    '/pr/rule': async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const q = new URL(req.url ?? '', 'http://localhost')
        const url = q.searchParams.get('url') || ''
        const { provider, owner, repo } = parseRepoUrl(url)
        if (!owner || !repo) return { ok: true, hasRule: false, url: String(url) }
        const cached = readPrRule(owner, repo)
        return {
          ok: true, hasRule: !!cached, url: String(url),
          provider, owner, repo,
          rule: cached || null,
        }
      })
    },
    '/pr/analyze': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return prAnalyzeFlow(ctx, { url: body.url, force: !!body.force, ruleText: body.ruleText, ruleFile: body.ruleFile })
      })
    },
    '/pr/generate': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return prGenerateFlow(ctx, { url: body.url, rule: body.rule, pluginInfo: body.pluginInfo })
      })
    },
    '/pr/execute': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        return prExecuteFlow(ctx, {
          url: body.url, workdir: body.workdir, rule: body.rule,
          entryContent: body.entryContent, title: body.title, body: body.body, base: body.base,
        })
      })
    },

    // ---- ⑥ 发布 npm 包 ----
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
