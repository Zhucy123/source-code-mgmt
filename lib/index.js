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
  readdirSync, statSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

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
  try {
    const out = execFileSync(cmd, args, {
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
  if (!tok) return { ok: false, error: '尚未配置 Gitee 私人令牌（请打开 ③ 代码管理输入令牌）' }
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
    return { ok: false, error: (r.stderr || r.stdout || '').trim() || 'Gitee API 请求失败（需要 curl）' }
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
      error: 'not a git repository（尚未 git init，可用「新建仓库并推送」初始化为 git 仓库并上传）',
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
    // Git may quote paths with special characters; strip surrounding quotes.
    if (path.length >= 2 && path[0] === '"' && path[path.length - 1] === '"') {
      path = path.slice(1, -1)
    }
    const type = /^\?\?/.test(code) ? 'untracked'
      : /^A|^AM/.test(code) ? 'added'
      : /^D|^AD/.test(code) ? 'deleted'
      : /^R/.test(code) ? 'renamed'
      : 'modified'
    // code[0] 是 index/staged 状态列（' ' 或 '?' 表示未暂存/未跟踪）。
    const staged = code[0] !== ' ' && code[0] !== '?'
    // diff 内容不再在 /repo 里逐个生成（改动多时会跑 N 次 git diff，拖慢加载）；
    // 改为点开「查看改动」弹窗里的文件行时，由 /repo-diff 单独按需请求。
    return { type, path, staged }
  })

  // Tracked files that exceed 100MB (GitHub would reject a push of these).
  let trackedOverLimit = []
  const lsr = run(GIT, ['-C', dir, 'ls-files', '-z'])
  if (lsr.ok) {
    const tracked = lsr.stdout.split('\0').filter(Boolean)
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
      ? `超过 GitHub 100MB 单文件限制（${fmtMB(e.bytes)}），已被 .gitignore 的 "${e.path}" 排除`
      : e.kind === 'dir'
        ? `超过 GitHub 100MB 单文件限制（${fmtMB(e.bytes)}），${e.source} 所在的一级目录「${e.path}」整体忽略（该文件夹为一整体）`
        : `超过 GitHub 100MB 单文件限制（${fmtMB(e.bytes)}），已忽略单个文件「${e.path}」`
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
  const stagedFiles = staged.ok ? staged.stdout.split(/\r?\n/).filter(Boolean) : []

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
      error: '尚未配置远程仓库 origin，请使用「新建仓库」创建远程仓库。',
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
    return { ok: false, error: 'not a git repository（尚未 git init，无法拉取）' }
  }
  const hasRemote = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']).ok
  if (!hasRemote) {
    return { ok: false, error: '尚未配置远程仓库 origin，无法拉取。' }
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
      ? '拉取存在冲突：本地有未合并改动或与远程冲突，请手动 git pull 处理合并。'
      : (pull.stderr || pull.stdout).trim() || 'git pull 失败',
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
    return { ok: false, error: 'not a git repository（尚未 git init）' }
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
        ? '拉取并推送失败：合并存在冲突，请手动解决后重试。'
        : (rebase.stderr || rebase.stdout).trim() || 'pull --rebase 失败',
      detail: blob,
    }
  }

  const push = run(GIT, ['-C', dir, 'push', '-u', 'origin', branchName], {
    timeout: 120_000,
  })
  if (!push.ok) {
    return {
      ok: false, branch: branchName, detail: (push.stdout + '\n' + push.stderr).trim(),
      error: (push.stderr || push.stdout).trim() || 'push 失败',
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
    return { ok: false, error: 'not a git repository（尚未 git init）' }
  }
  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.stdout.trim() : 'main'
  const push = run(GIT, ['-C', dir, 'push', '--force', '-u', 'origin', branchName], {
    timeout: 120_000,
  })
  const blob = (push.stdout + '\n' + push.stderr).trim()
  return {
    ok: push.ok, branch: branchName, forced: push.ok,
    error: push.ok ? undefined : (push.stderr || push.stdout).trim() || 'push --force 失败',
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
    return { ok: false, error: 'not a git repository（尚未 git init）' }
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
        ? '强制拉取存在冲突，请手动处理。'
        : (pull.stderr || pull.stdout).trim() || 'git pull --force 失败')
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
  if (!repoName) return { ok: false, error: '缺少仓库名称' }
  if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName === '.') {
    return { ok: false, error: '仓库名称包含非法字符（仅允许字母、数字、点、下划线、横线）' }
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
      return { ok: false, error: `git add 失败：${(stagedCount.stderr || '')}` }
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
    if (!owner || !token) return { ok: false, error: '需要先配置 Gitee 私人令牌' }
    const api = giteeApi('POST', 'user/repos', { name: repoName, private: vis === 'private' }, token)
    if (!api.ok || giteeApiFailed(api.data)) {
      return { ok: false, error: (api.error || (api.data && api.data.message) || 'Gitee 创建仓库失败'), detail: api.data }
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
 * change sets). untracked files have no diff (git doesn't track them) and
 * return an empty string.
 * @param {string} dir - local folder.
 * @param {string} path - repo-relative file path.
 */
function repoDiffFlow(dir, path) {
  if (!dir || !existsSync(dir) || !existsSync(join(dir, '.git'))) {
    return { ok: false, error: 'not a git repository' }
  }
  const p = String(path || '').trim()
  if (!p) return { ok: false, error: '缺少文件路径' }
  // Untracked files have no tracked diff.
  const status = run(GIT, ['-C', dir, 'status', '--porcelain', '--', p])
  const isUntracked = status.ok && /^\?\?/.test(status.stdout.trim().slice(0, 2))
  if (isUntracked) return { ok: true, path: p, diff: '' }
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
    return { ok: false, error: 'not a git repository（尚未 git init）' }
  }
  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const branchName = branch.ok ? branch.stdout.trim() : undefined
  if (!branchName) return { ok: false, error: '无法识别当前分支' }
  const hasRemote = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']).ok
  if (!hasRemote) return { ok: false, error: '尚未配置远程仓库 origin，无法对齐。' }

  const fetch = run(GIT, ['-C', dir, 'fetch', 'origin'], { timeout: 120_000 })
  if (!fetch.ok) {
    return { ok: false, error: (fetch.stderr || fetch.stdout).trim() || 'git fetch 失败', detail: (fetch.stdout + '\n' + fetch.stderr).trim() }
  }
  const reset = run(GIT, ['-C', dir, 'reset', '--hard', 'origin/' + branchName], { timeout: 60_000 })
  return {
    ok: reset.ok,
    branch: branchName,
    error: reset.ok ? undefined : (reset.stderr || reset.stdout).trim() || 'git reset --hard 失败',
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
  if (!init.ok) return { ok: false, error: (init.stderr || init.stdout).trim() || 'git init 失败' }
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
  if (!existsSync(join(dir, '.git'))) return { error: 'not a git repository（尚未 git init）' }
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
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || 'git add 失败' }
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
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || 'git reset 失败' }
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
  if (msg === '') return { ok: false, error: '提交信息不能为空' }

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
    if (!add.ok) return { ok: false, error: (add.stderr || add.stdout).trim() || 'git add 失败' }
    stagedPaths = list
  } else {
    // 提交整个暂存区：列出已暂存文件用于提示。
    const st = run(GIT, ['-C', dir, 'diff', '--cached', '--name-only'])
    stagedPaths = st.ok ? st.stdout.split(/\r?\n/).filter(Boolean) : []
  }

  // 无可提交内容时避免报错。
  const hasChanges = run(GIT, ['-C', dir, 'diff', '--cached', '--quiet']).code !== 0
  if (!hasChanges) return { ok: false, error: '没有已暂存（staged）的改动可提交', staged: 0 }

  const commit = run(GIT, ['-C', dir, 'commit', '-m', msg])
  if (!commit.ok) return { ok: false, error: (commit.stderr || commit.stdout).trim() || 'git commit 失败', staged: stagedPaths.length }

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
  if (b === '') return { ok: false, error: '缺少分支名' }
  const r = run(GIT, ['-C', dir, 'checkout', b])
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || '切换分支失败' }
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
    return { ok: false, error: (r.stderr || r.stdout).trim() || 'git log 失败' }
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
  if (h === '') return { ok: false, error: '缺少 commit hash' }
  const r = run(GIT, ['-C', dir, 'revert', '--no-edit', h], { timeout: 60_000 })
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || 'revert 失败（可能有冲突，请手动处理）' }
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
  if (h === '') return { ok: false, error: '缺少 commit hash' }
  const r = run(GIT, ['-C', dir, 'cherry-pick', h], { timeout: 60_000 })
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || 'cherry-pick 失败（可能有冲突，请手动处理）' }
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
  if (h === '') return { ok: false, error: '缺少 commit hash' }
  const r = run(GIT, ['-C', dir, 'show', '--no-ext-diff', '--no-color', '--format=', '-m', '--first-parent', h])
  if (!r.ok) return { ok: false, error: (r.stderr || r.stdout).trim() || '读取提交 diff 失败' }
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
  if (t !== 'git' && t !== 'gh' && t !== 'ssh') return { ok: false, error: '未知工具：' + tool }
  // 已安装就直接返回，不重复安装。
  const present = t === 'git' ? (GIT && GIT !== 'git')
    : t === 'gh' ? (GH && GH !== 'gh')
    : (SSH && SSH !== 'ssh' && SSH !== 'ssh.exe')
  if (present) return { ok: true, alreadyInstalled: true, tool: t }

  const cmd = installCommand(t)
  if (!cmd) {
    return { ok: false, error: '未找到可用的包管理器（' + (IS_WIN ? 'winget / choco / scoop' : process.platform === 'darwin' ? 'brew' : 'apt-get / dnf / pacman') + '）。请手动安装。', tool: t }
  }
  const r = run(cmd.bin, cmd.args, { timeout: 300_000 })
  const output = (r.stdout + '\n' + r.stderr).trim()
  // 安装后复查是否已装上。
  const ok = r.ok && (t === 'git' ? (GIT && GIT !== 'git') : t === 'gh' ? (GH && GH !== 'gh') : !(SSH === 'ssh' || SSH === 'ssh.exe'))
  return {
    ok,
    tool: t,
    command: cmd.label,
    output: output || (ok ? '安装成功' : '安装失败'),
    needElevation: IS_WIN && t === 'ssh',
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
    '$dlg.Description = \'选择本地目录\';' +
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
    if (!owner || !name) return { ok: false, error: '需要先配置 Gitee 私人令牌' }
    const api = giteeApi('PATCH', 'repos/' + owner + '/' + name, { private: vis === 'private' })
    if (!api.ok || giteeApiFailed(api.data)) {
      return { ok: false, error: (api.error || (api.data && api.data.message) || 'Gitee 修改可见性失败') }
    }
    return { ok: true, name, visibility: vis, provider: 'gitee' }
  }
  const owner = ghOwner()
  if (!owner || !name) return { ok: false, error: '需要先登录 GitHub CLI（gh）' }
  const r = run(GH, [
    'repo', 'edit', owner + '/' + name,
    '--visibility', vis,
    '--accept-visibility-change-consequences',
  ], { timeout: 30_000 })
  if (!r.ok) {
    return {
      ok: false,
      error: `修改可见性失败：${(r.stderr || r.stdout || '').trim() || 'gh repo edit 失败'}`,
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
  const handle = async (req, res, fn) => {
    if (!isLoopbackRequest(req)) return forbidden(res)
    const payload = await fn(req)
    json(res, 200, payload)
  }

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
        if (!dir) return { ok: false, error: '缺少目录路径' }
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
        if (!picked) return { ok: false, cancelled: true, error: '未选择目录' }
        return { ok: true, dir: picked, name: baseName(picked) }
      })
    },
    '/add-workspace': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const dir = String(body.dir || '').trim()
        if (!dir) return { ok: false, error: '缺少目录路径' }
        if (!existsSync(dir) || !statSync(dir).isDirectory()) {
          return { ok: false, error: '目录不存在或不是文件夹：' + dir }
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
          if (!token) return { ok: false, error: '令牌不能为空' }
          saveGiteeToken(token)
          const owner = giteeOwner()
          if (!owner) {
            // 令牌无效则清掉，避免留有坏令牌。
            saveGiteeToken('')
            return { ok: false, error: 'Gitee 令牌无效，请检查（需有 projects 权限）' }
          }
          return { ok: true, configured: true, owner }
        })
      } else {
        return methodNotAllowed(res, req.method)
      }
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
