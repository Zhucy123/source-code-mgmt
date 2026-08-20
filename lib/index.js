/**
 * source-code-mgmt — host half (Node).
 *
 * Provides /api routes for the browser half that wrap the git / gh / ssh
 * command line for a "源代码管理" (source code management) sidebar tool:
 *
 *   GET  /api/source-code-mgmt/env          — git & gh presence/version
 *   GET  /api/source-code-mgmt/ssh          — ssh key + config + gh auth status
 *   POST /api/source-code-mgmt/gen-key      — generate ed25519 key (no passphrase)
 *   POST /api/source-code-mgmt/write-config — write ~/.ssh/config for github.com
 *   POST /api/source-code-mgmt/ssh-test     — ssh -T git@github.com connectivity
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

/** Full path to the ed25519 private key. */
function privateKeyPath() {
  return join(sshDir(), 'id_ed25519')
}

/** Full path to the ed25519 public key. */
function publicKeyPath() {
  return join(sshDir(), 'id_ed25519.pub')
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

/** SSH key & config & gh auth summary. */
function checkSsh() {
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
    ghLoggedIn,
    ghAccount,
    sshGitHubConfigured: /ssh\.github\.com/.test(configContent),
  }
}

/** Generate ed25519 key with no passphrase (non-interactive). */
function generateKey() {
  if (existsSync(privateKeyPath())) {
    return { ok: true, alreadyExists: true, path: privateKeyPath() }
  }
  try {
    mkdirSync(sshDir(), { recursive: true })
    const r = run(SSH_KEYGEN, ['-t', 'ed25519', '-N', '', '-f', privateKeyPath()], { timeout: 30_000 })
    return {
      ok: r.ok,
      alreadyExists: false,
      path: privateKeyPath(),
      error: r.ok ? undefined : (r.stderr || r.stdout).trim(),
    }
  } catch (error) {
    return { ok: false, alreadyExists: false, path: privateKeyPath(), error: String(error) }
  }
}

/** Write the github.com ssh config (ssh.github.com:443) for domestic networks. */
function writeSshConfig() {
  try {
    mkdirSync(sshDir(), { recursive: true })
    let current = ''
    if (existsSync(configPath())) {
      current = readFileSync(configPath(), 'utf8')
    }
    if (/\bHost\s+github\.com\b/.test(current)) {
      return { ok: true, alreadyConfigured: true, path: configPath() }
    }
    const block = [
      '',
      'Host github.com',
      '  Hostname ssh.github.com',
      '  Port 443',
      '  User git',
      '  IdentityFile ~/.ssh/id_ed25519',
      '',
    ].join('\n')
    writeFileSync(configPath(), current + block, 'utf8')
    if (!IS_WIN) {
      try { chmodSync(configPath(), 0o600) } catch {}
    }
    return { ok: true, alreadyConfigured: false, path: configPath() }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

/** ssh -T git@github.com connectivity test (accept-new so a new host key is auto-trusted). */
function sshTest() {
  const r = run(SSH, ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20', '-T', 'git@github.com'], { timeout: 45_000 })
  const blob = (r.stdout + '\n' + r.stderr)
  const authed = /Hi\s+(\S+?)[!\s]/.exec(blob)
  return {
    ok: authed !== null,
    account: authed ? authed[1] : undefined,
    connected: r.ok || authed !== null,
    detail: blob.trim(),
  }
}

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
 * Repo status for a selected folder: whether it is a git repo, remote,
 * branch, dirty count, tracked-over-100MB files, and new >100MB candidates.
 */
function repoStatus(dir) {
  const base = { ok: false, dir, isGitRepo: false }
  if (!dir || !existsSync(dir)) return { ...base, error: 'folder does not exist' }
  if (!existsSync(join(dir, '.git'))) {
    // 不是 git 仓库：仍返回文件夹名和同名仓库检测，便于「新建仓库」直接使用。
    const defaultRepoName = baseName(dir)
    const existence = repoExists(defaultRepoName)
    return {
      ...base,
      defaultRepoName,
      repoExists: existence.checked ? existence.exists : undefined,
      repoOwner: existence.owner,
      visibility: existence.checked && existence.exists ? repoVisibility(defaultRepoName) : undefined,
      error: 'not a git repository（尚未 git init，可用「新建仓库并推送」初始化为 git 仓库并上传）',
    }
  }

  const branch = run(GIT, ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const status = run(GIT, ['-C', dir, 'status', '--porcelain'])
  const dirtyFiles = status.ok
    ? status.stdout.split(/\r?\n/).filter((l) => l.trim() !== '').length
    : 0

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

  // Default repo name = folder basename; and whether the same-name repo exists.
  const defaultRepoName = baseName(dir)
  const existence = repoExists(defaultRepoName)

  const branchName = branch.ok ? branch.stdout.trim() : undefined
  const hasRemote = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin']).ok

  // ahead (unpushed local commits) / behind (remote commits not yet pulled),
  // measured against origin/<branch>. A lightweight fetch keeps this fresh;
  // a failed fetch is tolerated (falls back to the last known tracking ref).
  let ahead = 0
  let behind = 0
  if (hasRemote && branchName) {
    if (run(GIT, ['-C', dir, 'fetch', 'origin', branchName, '--quiet'], { timeout: 20_000 }).ok) {
      const rb = run(GIT, ['-C', dir, 'rev-list', '--left-right', '--count', 'origin/' + branchName + '...HEAD'])
      if (rb.ok) {
        const m = rb.stdout.trim().split(/\s+/)
        behind = parseInt(m[0], 10) || 0   // left side = origin-only commits
        ahead = parseInt(m[1], 10) || 0    // right side = HEAD-only commits
      }
    }
  }

  return {
    ok: true,
    isGitRepo: true,
    dir,
    defaultRepoName,
    repoExists: existence.checked ? existence.exists : undefined,
    repoOwner: existence.owner,
    branch: branchName,
    hasRemote,
    remoteUrl: (() => {
      const r = run(GIT, ['-C', dir, 'remote', 'get-url', 'origin'])
      return r.ok ? r.stdout.trim() : undefined
    })(),
    dirty: dirtyFiles > 0,
    dirtyCount: dirtyFiles,
    ahead,
    behind,
    // Actual remote visibility (private/public) when the repo exists and gh
    // can view it; undefined when unknown (not logged in / repo absent).
    visibility: existence.checked && existence.exists ? repoVisibility(defaultRepoName) : undefined,
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
 * Create a new repo on GitHub and push everything: gh repo create
 * <name> [--private|--public] --source=. --push.
 * @param {string} dir - local folder.
 * @param {string} name - repo name.
 * @param {'private'|'public'} [visibility] - default 'private'.
 */
function createRepoFlow(dir, name, visibility) {
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
  const visFlag = visibility === 'public' ? '--public' : '--private'
  const r = run(GH, ['repo', 'create', repoName, visFlag, '--source=' + dir, '--push'], {
    timeout: 180_000, cwd: dir, env: { GIT_SSH: WORKING_SSH },
  })
  const blob = (r.stdout + '\n' + r.stderr)
  const urlMatch = /https:\/\/github\.com\/[^\s"]+/.exec(blob)
  return {
    ok: r.ok,
    repoName,
    visibility: visibility === 'public' ? 'public' : 'private',
    url: urlMatch ? urlMatch[0] : undefined,
    detail: blob.trim(),
  }
}

/** Human-readable MB. */
function fmtMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
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

/** Decode a `--C-Users-27775-workspace--` session dir name back to a Windows
 *  path (best-effort; segments are joined by '\'). Ambiguous when a folder
 *  name itself contains '-', which is why workspace.json is preferred. */
function decodeSessionDir(name) {
  if (typeof name !== 'string') return null
  const inner = name.replace(/^--/, '').replace(/--$/, '')
  if (inner === '') return null
  // Split on '-'; first token is the drive letter.
  const parts = inner.split('-')
  if (parts.length === 0) return null
  const drive = parts[0]
  const rest = parts.slice(1).join('\\')
  return drive + ':\\' + rest
}

/** Whether a public/private GitHub repo `<owner>/<name>` already exists
 *  (needs gh auth; network call). */
function repoExists(name) {
  const owner = ghOwner()
  if (!owner || !name) return { owner, checked: false }
  const r = run(GH, ['repo', 'view', owner + '/' + name, '--json', 'name'], { timeout: 20_000 })
  return { owner, checked: true, exists: r.ok }
}

/**
 * Query the current visibility ('private' | 'public') of a repo. Returns
 * undefined when gh is not signed in or the repo cannot be viewed, so callers
 * treat "unknown" as "no visibility info".
 * @param {string} name - repo name (without owner).
 */
function repoVisibility(name) {
  const owner = ghOwner()
  if (!owner || !name) return undefined
  const r = run(GH, ['repo', 'view', owner + '/' + name, '--json', 'visibility'], { timeout: 20_000 })
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
 * Change a repo's visibility via gh. Requires the user to have already
 * accepted the consequences prompt (handled on the caller side through the
 * --accept-visibility-change-consequences flag, which gh requires for this
 * op). Returns the new visibility on success.
 * @param {string} name - repo name (without owner).
 * @param {'private'|'public'} target - desired visibility.
 */
function setVisibilityFlow(name, target) {
  const owner = ghOwner()
  if (!owner || !name) return { ok: false, error: '需要先登录 GitHub CLI（gh）' }
  const vis = target === 'public' ? 'public' : 'private'
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
  return { ok: true, name, visibility: vis }
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
    '/ssh': (req, res) => handle(req, res, async () => ({ ok: true, ...checkSsh() })),
    '/gen-key': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async () => ({ ok: true, ...generateKey() }))
    },
    '/write-config': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async () => ({ ok: true, ...writeSshConfig() }))
    },
    '/ssh-test': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async () => ({ ok: true, ...sshTest() }))
    },
    '/default-dir': async (req, res) => {
      await handle(req, res, async () => ({ ok: true, dir: fallbackDir, name: baseName(fallbackDir) }))
    },
    '/repo-exists': async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      await handle(req, res, async () => {
        const r = repoExists(body.name)
        return { ok: true, ...r }
      })
    },
    '/workspaces': async (req, res) => {
      await handle(req, res, async () => ({ ok: true, workspaces: listWorkspaces() }))
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
        return { ok: true, dir, name: baseName(dir), workspaces: listWorkspaces() }
      })
    },
    '/repo': async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => repoStatus(queryDir(req, fallbackDir)))
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
        return createRepoFlow(body.dir || fallbackDir, body.name, body.visibility)
      })
    },
    '/set-visibility': async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, req.method)
      await handle(req, res, async (req) => {
        const body = JSON.parse((await readBody(req)) || '{}')
        const name = body.name || baseName(body.dir || fallbackDir)
        return setVisibilityFlow(name, body.visibility)
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
