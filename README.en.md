# source-code-mgmt — DSH Source Code Management Plugin

> Version: **v1.21.0**　|　中文版见 [README.md](README.md)

> A source-code management plugin for the DSH Web GUI: it bundles「environment check → SSH setup → commit/push/upload code」into one「Code Management」panel with GitHub / Gitee dual-platform support.

> **Bilingual UI, live**: the panel and host-side messages follow DSH's language setting (Settings → General → Language) — switching between 中文 and English takes effect instantly, no refresh or restart needed.

> The entry point adapts automatically: when [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is installed,「Code Management」appears as a new sidebar **Tab** of that sidebar; otherwise a「Code Management」button is registered in the **right-aligned header list beside "Session log"** (same pill style, 8px gap), opening a right-side integrated panel that pushes the main content. Both forms share the same panel UI and no longer use a left-rail bottom button.

> **UI language:** the panel follows DSH's language setting (Settings → General → Language), live — Chinese (中文) or English, including all host-side messages. No restart needed when you switch.

## Features

Entry points (auto-detected, no manual switching):

- **dsh-better-sidebar installed:**「Code Management」registers as a new **Tab page** of its sidebar;
- **dsh-better-sidebar not installed:** a「Code Management」button in the **right-aligned header list beside "Session log"** (registered through DSH's `conversation.session.header.utilities` slot), opening a right-side integrated panel that pushes the main content left.

> Detection is a single in-memory read at activation time (`ctx.get('betterSidebar')`) — zero I/O, zero network, no impact on DSH startup.

The panel has five steps (①②③ are the core three; ④⑤ are the newer extensions, collapsed by default):

### ① Environment Check
- Shows the **OS** (friendly names `Windows` / `macOS` / `Linux`, from the underlying `win32` / `darwin` / `linux` platform ids)
- Detects **Git** and **GitHub CLI** presence and versions (e.g. `git version 2.55.0`, `gh version 2.97.0`)
- Detects whether an **SSH** client is available
- **Missing tools → adaptive install guidance + one-click install (mostly sudo-free)**: when a tool is missing, the row shows「❌ 未安装」+「复制安装命令」(copy install command) +「安装」(install):
  - **GitHub CLI (Linux / macOS)**: **user-level install without sudo** — downloads the official binary for the current platform/architecture from GitHub Releases, extracts it and installs to `~/.local/bin/gh` (the directory is created if missing; no admin rights needed); falls back to the system package manager on failure.
  - **Git (Linux)**: apt / dnf / pacman (auto `sudo -n`; **passwordless sudo is probed first** — when a password is required the panel does not run a doomed command, it shows "run this manually in a terminal" guidance with the exact command). **Git (macOS)**: brew, or **Xcode Command Line Tools** (`xcode-select --install`, the OS-provided installer that also ships git/ssh) when brew is absent.
  - **SSH (Windows)**: built-in optional feature (admin); **SSH (Linux)**: openssh-client via apt / dnf / pacman (same sudo probe); **macOS**: bundled with the OS.
  - **Copy install command** and the **Install** button share the same platform-adaptive logic (no more hardcoded Windows winget commands on Linux/macOS).
  - **Download source selector for GitHub CLI (all platforms)**: because direct `github.com` downloads can stall on domestic networks, when gh is missing the row shows a「下载源」(download source) dropdown — **`gh-proxy.com` (fastest in tests, ~2-3.5MB/s)** → `ghfast.top` / `ghproxy.net` (usable, slower) → `Official (slow)`. On Linux/macOS the mirrored `.tar.gz` is unpacked to `~/.local/bin`; on **Windows** the mirrored official `.msi` is downloaded and silently installed via `msiexec /qn` (same effect as winget but bypasses the slow direct download). The host builds the download URL from the chosen source (mirror = prefix + official Releases URL); **Install** and **Copy install command** both follow the selection. The mirror list is served by `/env` (`ghMirrors`), so the browser never hardcodes mirrors.
  - **Re-check button whenever something is missing**: the hint row under the tool list always includes a「**重新检查**」(Re-check) button — after a manual install or a refresh you can re-detect without restarting anything.
- **Live install-progress dialog**: clicking Install opens a progress window showing each step ("fetch latest version → download → extract → install → clean up") with streaming output; success/failure reasons are shown when done. On success the dialog says「安装完成…，刷新网页即可生效」(installed — refresh the page to apply); **no DSH restart is needed**.
- Re-detects automatically after install.

### ② SSH Key & Connectivity
- **Platform selector**: GitHub (default) / Gitee — decides the SSH config target and connectivity test below
- **Auto-detect ed25519 key**: scans `~/.ssh/*.pub` for existing ed25519 public keys — prefers `id_ed25519`, otherwise the first found (any name, e.g. `github_ed25519`); falls back to `id_ed25519` when none exist. The status line shows the actual key filename, and the SSH config `IdentityFile` uses it too
- One-click **generate ed25519 key** (no passphrase; reuses an existing ed25519 key instead of duplicating)
- One-click **write SSH config** (GitHub: `github.com → ssh.github.com:443`; Gitee: `gitee.com` port 443) — see [Do I need the 443 config?](#do-i-need-the-443-config) below
- **Test connection** `ssh -T git@github.com` (GitHub) or `ssh -T git@gitee.com` (Gitee)
- Shows the public key content for easy copy-upload to the platform
- Detects whether `gh` is logged in and which account; when **not logged in**, the「GH login」row shows a「**登录 GitHub**」(Log in to GitHub) button (host opens a terminal running `gh auth login` — interactive, complete it there, then click Re-check) plus「复制登录命令」(copy login command) and「重新检查」(Re-check)

### ③ Code Management
- **Follows ②'s platform**: all「detect / create / visibility」logic switches with the platform selector (GitHub via `gh` CLI, Gitee via Gitee OpenAPI)
- **Gitee token** (Gitee mode only): enter a Gitee personal access token (needs `projects` permission) → stored at `~/.dsh/storages/source-code-mgmt-gitee.json` on the machine (0600, **not inside the plugin dir**, never echoed to the browser/logs); one-click clear; invalid tokens are removed automatically
- **Workspace selector**: dropdown of DSH-registered workspace folders
- **Select folder →**: paste an absolute path or click「Browse…」for a native folder picker; confirmed folders are **persisted into a custom folder list** (`~/.dsh/storages/source-code-mgmt-dirs.json`, separate from the plugin dir — no personal paths leak), shown with a custom-folder badge and a ✕ to remove the entry (record only, never deletes the actual folder)
- Shows repo status: platform source, branch, remote, pending change count, ahead/behind remote, >100MB files
- **View details**: when there are changes, a「查看」(view) button opens a dialog listing changed/added/deleted/renamed **files or folders**. Every **text-previewable** file — including new/untracked files — can be expanded to show an inline **side-by-side diff** (old left / new right, deletions red, additions green); files with no old version (pure additions) show only the **「新版本」column**; **binary files show no「查看」button** (their content can't be previewed as text). When local and remote diverge, a view button on the sync row lists the concrete commits you're ahead/behind
- **Local Git workflow** (does not change the remote-sync logic):
  - **Stage / unstage** per file in the changes dialog (distinguishing staged/unstaged by `git status` XY codes), with「已暂存 / 未暂存」markers
  - **Commit message input + Commit button** above the repo name (git repos with changes only) — custom message, or auto-generated when left empty
  - **Branch「Switch」** button — dialog listing branches, click to `checkout`
  - **History button** — dialog listing commits (hash + subject + author + date), each with view (side-by-side diff), **revert**, **cherry-pick** (both with confirmation, as they rewrite history)
- **Remote matching by platform + current account**: ③'s「remote / sync」only counts remotes of the current platform **whose owner equals the currently logged-in account** (GitHub platform = `gh` account, Gitee platform = Gitee token account). So switching to Gitee never reads the GitHub origin; someone else's / another org's repos (e.g. `deepseek-ai/deepseek-harness`) are never treated as "your own remote", and ahead/behind is not computed for them. With no account-owned remote, the panel shows「(无)」and offers the same-name repo check + create-and-push flow
- **Init Git**: shown when the folder is **not** a git repo but a same-name repo already exists remotely — runs `git init` only (+ default identity), **no pull, no push**, you choose the next step
- **Create repo & push**: repo name defaults to the **folder name** (read-only), optional private/public; the button is disabled with a hint when a same-name repo already exists. For a brand-new directory with no commits, it auto-stages an initial commit before creating the repo to avoid "no commits found"
  - GitHub: `gh repo create --private|--public --source=. --push`
  - Gitee: Gitee OpenAPI `POST /user/repos` to create, then sets the SSH remote `git@gitee.com:<owner>/<name>.git` and `git push` (through ②'s SSH key)

### ④ Clone repos
- Follows ②'s platform: lists **every remote repo of the signed-in account** (GitHub via `gh repo list`, Gitee via OpenAPI `user/repos`) and flags which already exist locally (default = default workspace + registered workspaces + custom dirs)
- **Clone into**: optional target parent directory (default = DSH's default workspace; leave empty to clone to the default location); cloning uses the SSH URL and auto-adds the clone to the custom-directory list so ③ can select it directly
- Repos already present locally can't be re-cloned; every other repo has a「克隆」(clone) button

### ⑤ Publish npm package
- Five-step wizard (run in the target directory): **① check registry** `npm config get registry` → **② view auth config** `npm config list` (auto-redacts token/auth/password) → **③ verify identity** `npm whoami` → **④ preview packed files** `npm pack --dry-run` (see exactly what would be published, nothing is packed or uploaded) → **⑤ publish** `npm publish`
- **Login and publish always use the official registry `https://registry.npmjs.org`**: even when your global npm config points at a mirror (e.g. `registry.npmmirror.com` — mirrors only sync, they do not accept publishes), `whoami` / `npm login` / `npm publish` all carry `--registry=https://registry.npmjs.org`; the status area shows a yellow "publishing uses the official registry" hint when a mirror is configured.
- **"Open terminal to run npm login" now spawns a terminal safely**: it first probes for a terminal that actually exists on PATH (`konsole` / `gnome-terminal` / xterm-family, etc.), attaches an `error` listener to every child, and uses `konsole --separate` on KDE — fixing the old bug where spawning a missing binary (e.g. no `x-terminal-emulator` on SteamOS) raised an uncaught async ENOENT that **crashed the dsh host process** (which looked like your `pnpm dsh web` terminal dying). When no terminal exists it returns explicit "run manually: <command>" guidance instead of pretending success.
- Publishing requires ticking「I've reviewed the above — confirm publishing to the npm registry」first, preventing accidental publishes

### Data loading timing (fetch on open, "refreshing…" indicator)
DSH does **not** sync repos on startup — it only prefetches static env/SSH/workspace lists. Opening the plugin, switching workspace/folder, refreshing, and any push/pull/stage/commit operation fetch the latest repo status over the network and show a「⟳ 刷新中…」indicator — no stale data (like an old "no changes") when opening/reopening/switching.

## Do I need the 443 config?

Short answer for users outside mainland China / port-22-blocked networks: **usually no.**

- GitHub's standard SSH endpoint is `git@github.com` on **port 22**, and it works out of the box on almost every network outside mainland China.
- The plugin's「write SSH config」step writes GitHub's **officially supported** port-443 fallback (`Host github.com → HostName ssh.github.com, Port 443`). It exists for networks that block port 22 (common in mainland China, plus some corporate/school/campus or otherwise firewalled networks).
- The step is **fully optional and user-initiated** — you can simply skip it: generate the key → add the public key to GitHub → test connection → push. Everything runs over port 22.
- Writing it anyway is harmless (GitHub officially supports SSH over 443; the only edge case is networks that block 443 as well). Gitee is a China-hosted platform, so it's only relevant if you actually use Gitee.

## Installation

> This plugin ships as a **Profile Bundle**: its `package.json` declares `dsh.bundle` (carrying a `cordis.patch.yml` config layer), so `dsh plugin --profile web add` **installs and activates it in one step** — no manual config editing.

### Option 1: npm package (recommended)

Run this from **any directory** (the command locates/initializes the `web` profile itself):

```bash
dsh plugin --profile web add source-code-mgmt
```

> The command runs `pnpm add` in the web profile directory, then reconciles the plugin layer: because this package declares `dsh.bundle`, it is automatically appended to `dsh.profile.bundles` (see `~/.dsh/profiles/web/package.json`) and registered into the Cordis loader tree — **one command, done**.

After installing, **refresh the browser** (**F5**). The「Code Management」entry appears (sidebar Tab with dsh-better-sidebar, otherwise the header button + right panel). No DSH restart is needed — host-side tool detection re-probes on every check.

### Option 2: local directory (development / testing)

**Windows (PowerShell):**
```powershell
# install local source (link: protocol — a symlink, source edits take effect immediately)
dsh plugin --profile web add link:C:/path/to/source-code-mgmt
dsh web
```

**Linux / macOS:**
```bash
dsh plugin --profile web add link:/home/yourname/path/to/source-code-mgmt
dsh web
```

### Option 3: from GitHub (distribution)

```bash
dsh plugin --profile web add git+https://github.com/Zhucy123/source-code-mgmt.git
dsh web
```

> A git install **copies** the source into node_modules — to pick up source changes, re-run `dsh plugin --profile web add ...` (unlike `link:`, which is a symlink).

### Verifying the install

After installing and refreshing the page:

1. **Dependency written**: `source-code-mgmt` is in `dependencies` of `~/.dsh/profiles/web/package.json`.
2. **Added to the config layer**: `source-code-mgmt` is in the `dsh.profile.bundles` list of the same file (written automatically by `dsh plugin add` — no manual editing).
3. **Symlink created (`link:` only)**: `~/.dsh/profiles/web/node_modules/source-code-mgmt` points at your source dir (a Junction on Windows).
4. **Entry visible after refresh**: sidebar「Code Management」Tab with dsh-better-sidebar, otherwise the header button beside "Session log" opening the right panel.

### Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Installed with `dsh plugin add` but no button | Usually the page was not reloaded after install. **Refresh the browser** (F5); if the entry still does not appear, restart the `dsh web` process (it may hold port 3080). |
| Install prints「declares no dsh.bundle」 | The installed version lacks the bundle declaration (old version or a package missing `cordis.patch.yml`). Reinstall/update with version ≥ 1.9.0. |
|「Failed to load plugins」 | The host-side `lib/index.js` failed to boot (usually a dependency resolution issue). Check the startup log and confirm `node_modules` dependencies are complete. |

## Usage

1. Refresh the browser (F5) — no DSH restart needed.
2. Click the「**Code Management**」entry (sidebar Tab with dsh-better-sidebar, otherwise the header button beside "Session log").
3. ① Confirm Git / GitHub CLI are installed → ② generate a key and test connectivity → ③ pick a workspace, then push or create a new repo.

## Backend API routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/source-code-mgmt/env` | GET | Environment check (git/gh versions) |
| `/api/source-code-mgmt/install-tool` | POST | One-click install of a missing tool (body `tool`: `git`/`gh`/`ssh`; optional `source` for gh: `official` or a mirror id like `gh-proxy.com`; package manager picked per platform; NDJSON event stream response) |
| `/api/source-code-mgmt/install-command` | POST | Copyable install command for a tool + download source (body `tool` + optional `source`; same logic as Install) |
| `/api/source-code-mgmt/ssh` | GET | SSH key / config / gh login status |
| `/api/source-code-mgmt/gh/login` | POST | Open a terminal running `gh auth login` (interactive — complete it there, then click Re-check) |
| `/api/source-code-mgmt/gen-key` | POST | Generate an ed25519 key |
| `/api/source-code-mgmt/write-config` | POST | Write SSH config (body `provider`: `github` default / `gitee`) |
| `/api/source-code-mgmt/ssh-test` | POST | Test SSH connectivity (body `provider`: `github` default / `gitee`) |
| `/api/source-code-mgmt/default-dir` | GET | Current workspace folder |
| `/api/source-code-mgmt/workspaces` | GET | List all workspace folders + custom folder set |
| `/api/source-code-mgmt/pick-dir` | POST | Native folder picker on the host; returns the chosen path |
| `/api/source-code-mgmt/add-workspace` | POST | Validate a folder and persist it to the custom list; returns the merged workspace list |
| `/api/source-code-mgmt/remove-workspace` | POST | Remove a custom-folder dropdown record only (never deletes the folder) |
| `/api/source-code-mgmt/align` | POST | Hard align: `git fetch` + `git reset --hard origin/<branch>` (full reset to remote) |
| `/api/source-code-mgmt/init-git` | POST | `git init` + default identity only — no pull/push |
| `/api/source-code-mgmt/repo-exists` | POST | Check whether a same-name repo exists (body `provider`: `github`/`gitee`) |
| `/api/source-code-mgmt/repo?dir=` | GET | Repo status (query `provider`: `github`/`gitee`) |
| `/api/source-code-mgmt/repo-diff?dir=&path=` | GET | Unified diff text for one changed file, on demand |
| `/api/source-code-mgmt/stage` | POST | Stage changes (body `dir`, `path`; empty `path` = all) |
| `/api/source-code-mgmt/unstage` | POST | Unstage changes (body `dir`, `path`; empty `path` = all) |
| `/api/source-code-mgmt/commit` | POST | Commit with a custom message (body `dir`, `message`, `paths?`) |
| `/api/source-code-mgmt/branches` | POST | List branches (current first) |
| `/api/source-code-mgmt/checkout` | POST | Switch branch (body `dir`, `branch`) |
| `/api/source-code-mgmt/log` | POST | Recent commit history (body `dir`, `count?`; returns hash/subject/author/date) |
| `/api/source-code-mgmt/revert` | POST | Revert a commit (body `dir`, `hash`) |
| `/api/source-code-mgmt/cherrypick` | POST | Cherry-pick a commit (body `dir`, `hash`) |
| `/api/source-code-mgmt/commit-diff` | POST | Full patch of a commit (body `dir`, `hash`) |
| `/api/source-code-mgmt/push` | POST | Commit and push (git operation, platform-agnostic) |
| `/api/source-code-mgmt/push-staged` | POST | Commit only staged content with your message, then push |
| `/api/source-code-mgmt/pull` | POST | `git pull --ff-only` (up-to-date / success / conflict feedback) |
| `/api/source-code-mgmt/merge-push` | POST | Pull and push (`git pull --rebase` + `git push`) |
| `/api/source-code-mgmt/force-push` | POST | Force push (`git push --force`) |
| `/api/source-code-mgmt/force-pull` | POST | Force pull (`git pull --force`) |
| `/api/source-code-mgmt/create` | POST | Create a repo and push (body `provider`; GitHub via `gh repo create`, Gitee via OpenAPI + SSH push) |
| `/api/source-code-mgmt/set-visibility` | POST | Change repo visibility (body `provider`; GitHub via `gh repo edit`, Gitee via `PATCH /repos/{owner}/{repo}`) |
| `/api/source-code-mgmt/gitee-token` | GET/POST | GET: token configured? + account; POST: save (`{token}`) or clear (`{clear:true}`) the Gitee token |

## Security

All routes are **loopback-only** (`sec-fetch-site` + Origin checks) — only the local machine's browser can call them; LAN/mobile sources get a 403, same policy as the control panel.

## Cross-platform

- **Windows / Linux / macOS**
- Platform detected via `process.platform`; `~/.ssh` resolved via `homedir()` (Windows: `C:\Users\<user>\.ssh`, Linux/macOS: `/home/<user>/.ssh` or `/Users/<user>/.ssh`)
- SSH config gets 0600 permissions on Linux/macOS
- **Automatic git / gh / ssh / ssh-keygen binary resolution** at startup: ① env overrides → ② PATH lookup (`.exe` added on Windows) → ③ (Windows only) Git's bundled dirs (`usr\bin` / `bin`), with the bare command name as a last resort. Git alone is enough even when `ssh` isn't on PATH — no per-machine config
- Optional explicit binary paths via env vars: `DSH_SCM_GIT` / `DSH_SCM_GH` / `DSH_SCM_SSH` / `DSH_SCM_SSH_KEYGEN`
- **SSH transport fix**: Git for Windows' bundled MSYS `ssh.exe` (`usr\bin\ssh.exe`) can fail with `couldn't create signal pipe, Win32 error 5` when spawned from a detached/agent process, breaking `git push`/`git pull`. The plugin injects `GIT_SSH` pointing at a working `ssh` (usually the system OpenSSH `C:\Windows\System32\OpenSSH\ssh.exe`) for git remote operations
- **Non-ASCII filename compatibility**: git's default `core.quotepath` prints paths with non-ASCII bytes as octal-escaped quoted strings (which display as garbled text). The plugin injects `-c core.quotepath=false` into every git invocation (raw UTF-8 output) and additionally unescapes any still-quoted paths via `parseGitPath()` — Chinese filenames display correctly in the changes list and in diff headers
- **One-click missing-tool install across platforms (since v1.15.0, adaptive & mostly sudo-free)**: GitHub CLI installs user-level on Linux/macOS (official binary → `~/.local/bin/gh`, no sudo); git/ssh on Linux use apt-get / dnf / pacman (passwordless sudo probed first, manual guidance otherwise); macOS uses brew or the Xcode Command Line Tools; Windows uses winget / built-in features (fallback choco/scoop). The install runs in a live progress dialog, and a one-click DSH restart is offered when the running host needs it. The native folder picker is Windows-only; on macOS/Linux paste the path into the input box instead

## Development

```bash
git clone https://github.com/Zhucy123/source-code-mgmt.git
cd source-code-mgmt
# test in your local DSH (installs to the web profile, auto-activated)
dsh plugin --profile web add link:$(pwd)
```

- Changes to `lib/client.js` (browser side) → a page refresh is enough
- Changes to `lib/index.js` (host/Node side) → restart dsh web

## Version history

### v1.21.0 (current)
**Gitee CLI fully removed + the Gitee personal token moved to ②**:

- **Background**: the Gitee CLI was never required — the plugin's Gitee features (create repo / push / clone / ②③) are driven by the **personal token (OpenAPI)** and **SSH public keys**, not the CLI binary; and on Windows its install often failed (ENOENT without npm.exe / EINVAL spawning npm.cmd) with a misleading "no usable package manager" error.
- **Host**: removed `GITEE` const, `env.gitee`, `installHints.gitee`, `giteeLoggedIn`/`giteeAccount` in `checkSsh`, `giteeUserLevelScript`, `checkGiteeUpdate`, `giteeLoginTerminal`, the `/gitee/login` and `/gitee/import-token` routes, and every `gitee` branch in `installCommandSystem`/`installCommand`/`installToolFlow`/`toolInstalled`/`/check-update`. `installCommandSystem` now returns null for unknown tools (including gitee) so it cannot fall through to gh's package id.
- **Client**: ① Env Check always checks gh (no platform-switched Gitee CLI row); ② **now holds the Gitee personal-token input/save/clear** (`/gitee-token` storage; ③④ refresh immediately via the token tick); ③ only shows the token status read-only (pointing to ② when unset) and drops the "Import from Gitee CLI" button.
- **Unchanged**: the Gitee platform itself, the personal-token storage (`~/.dsh/storages`, 0600), create/push/clone, and SSH-443 config all remain.
- Scope: `lib/index.js` (restart dsh web), `lib/client.js` (refresh). Version 1.20.0 → 1.21.0.

### v1.20.0 (current — historical note kept)
① Env Check gains a **Git check-update (Windows only)** (same interaction as gh/gitee):

- **Installed Git rows show a「检查更新」button on Windows only**: the host compares the local `git --version` against the latest official stable Git; when an update exists it confirms via `window.confirm` and upgrades in one click (live progress dialog).
- **The official version source cannot use GitHub Releases** (`git/git` has no releases — `/releases/latest` is 404), so it uses the **tags API** and **filters out pre-release/RC tags** (e.g. `v2.56.0-rc0`, avoiding a bogus prompt to update to an RC).
- **Update = system package-manager "upgrade" command**: Windows `winget upgrade Git.Git` (winget handles elevation).
- **Linux/macOS do NOT show the Git check-update**: there the git is managed by the distro / brew / Xcode CLT and its version lags the official one (distros pin versions), so comparing against the official latest would **always report an update**, and it updates via the system anyway. The host also guards this: a non-Windows git-update request returns "Git follows your system updates".
- SSH stays untouched (a system component with no independently upgradable version worth tracking).
- New `tool=git` branch on `POST /check-update` (returns `{ok, current, latest, hasUpdate}`).
- Scope: `lib/index.js` (refresh/restart to apply), `lib/client.js` (refresh to apply). Version 1.19.0 → 1.20.0.

### v1.19.0 (current — historical note kept)
Extends the GitHub CLI download-source selector to **Windows** (previously Linux/macOS only):

- **Windows now shows the「下载源」dropdown**: when gh is missing, ① Env Check on Windows renders the mirror selector too (defaults to the first mirror `gh-proxy.com`).
- **Windows mirror install = download official `.msi` + silent `msiexec`**: the host fetches `gh_<version>_windows_<arch>.msi` with the chosen mirror prefix (measured ~5-6MB/s) and installs it silently via `msiexec /qn` (elevated through PowerShell `Start-Process -Verb RunAs -Wait`, which pops a UAC prompt — the DSH process usually is not elevated) — registers into Program Files & PATH like winget, but avoids the slow direct-to-GitHub segment. One-click install (step progress), **Copy install command**, and **Check update** all follow the selected mirror.
- **Fix for `curl: (3) URL rejected: Port number...` on Windows**: the first implementation ran curl through `cmd /c`, whose quote-reshuffling by Node spawn made curl misread the second `https://` in a mirror URL as `host:port`. Now the download calls `curl.exe` with an **arg array** (`runLive(bin, args)`), passing values individually and bypassing the shell-quote rewrite entirely.
- **Same mirror list** as Linux/macOS (`GH_MIRRORS`); only the downloaded asset changes from `.tar.gz` to `.msi`.
- **「下载源」dropdown now also shows when gh is already installed (all three platforms)**: previously it only rendered when gh was missing, so a user clicking **Check update** had no way to pick a mirror (updates used the hidden `ghSource`, and if it defaulted to official the re-download was slow) — the same gap on Linux/macOS and Windows. Now the gh row keeps the selector visible: when not installed it governs one-click install; when installed it governs the update-triggered reinstall. The default-mirror timing was also hardened (independent `useEffect` on `env`) so "click Check update right away" no longer races to the official source.
- **Fallback**: selecting「官网（慢）」or when the version lookup fails, Windows falls back to the system package manager (winget / choco / scoop) unchanged.
- Scope: `lib/index.js` (refresh/restart to apply), `lib/client.js` (refresh to apply). Version 1.18.0 → 1.19.0. (Versions v1.15–v1.18 are covered in the Chinese README.)

### v1.14.0 (current — historical note kept)
Per your request the **⑤ "Submit PR" feature has been removed**:

- **Front-end**: `lib/client.js` drops the whole `PrSection` (its render in the panel and the "⑤ Submit PR" mention in the panel intro), along with the now-unused `EN_DICT` PR keys.
- **Host**: `lib/index.js` removes the entire PR implementation — the `/pr/targets`, `/pr/rule`, `/pr/analyze`, `/pr/generate`, `/pr/execute` routes; `prAnalyzeFlow` / `prGenerateFlow` / `prExecuteFlow`; the PR-targets local store (`source-code-mgmt-pr-targets.json`); the PR-rule cache read/write under `rules/` (`readPrRule`/`writePrRule`, etc.); `parseRepoUrl`; `fillPrTemplate`; the safety checks (`safeEntryPath`/`safeRegenerateCommand`); `PRESET_PR_RULES` and the startup rule-seeding call.
- `llmComplete()` (the generic LLM helper) is kept — it is independent of PR and reusable.
- Version bumped 1.13.0 → 1.14.0; `package.json` description now drops "AI-assisted Pull Requests". The clone section (by-URL clone, local-exists detection) and ⑥ npm (empty-by-default dir) keep their v1.13.0 behavior unchanged.
- Scope: `lib/client.js` (refresh to apply), `lib/index.js` (restart dsh web).

> Note: the old `rules/awesome-dsh-plugin__awesome-dsh-plugin.json` preset is no longer referenced by any code — you may delete it or leave it (it doesn't affect anything).

### v1.13.0 (history)
Second feedback pass (④⑤⑥ interaction tightening):

- **④ "Already local" detection widened to registered dirs**: previously the clone list only checked under the currently-selected clone dir; if you switched the clone target elsewhere (e.g. the `workspace` dir) where a repo already existed, it still showed "cloneable". Now a new `localRepoExistsAnywhere()` checks the selected dir **plus every workspace / favorite dir registered by step ③** (from `~/.dsh/storages/workspace.json` + `source-code-mgmt-dirs.json`) — a repo present in any registered location is marked "Already local". Since clone success already records the destination into favorite dirs, "this location already has the repo" knowledge persists automatically and the list hits on it next time.
- **④ New "clone any repo by URL into any location"**: the clone section gained a bottom row — paste any git URL (HTTPS or SSH; GitHub / Gitee / self-hosted), choose a destination dir, and the repo name is derived from the last URL segment (`.git` stripped) and sent to `POST /clone/run`. Reuses the "Choose directory…" button (absolute path or native folder picker, remembered into favorite dirs). The destination defaults to the top dropdown selection; a hint appears if none is chosen.
- **⑥ npm: target dir now defaults empty**: previously it pre-filled with the default workspace, risking publishing to an unexpected dir. Now the target dir **starts empty**, with a hint "left empty on purpose — it will NOT auto-use the default dir"; "Re-check / login / Run" buttons are disabled and guarded until the user picks a directory (via the step-③/④ "Choose directory…" button).
- **⑤ narrowed to "submit an awesome-dsh-plugin listing PR"**: keeping just the most-used path first — hidden the "target repo URL" input, the "record locally / recorded" row & chips, the "Analyze PR rules / Re-analyze (ignore cache)" buttons and the manual-rules panel, and the generic-PR-flow fallback box. The target repo is locked to `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`; on mount it loads that repo's **preset listing rules** once (no AI spent) with a loading state. The lower section stays: plugin info (name / category / description en/zh) → "Generate PR content (AI)" (preset-template fill without AI when complete, still editable) → editable title / description / entry-file content + workdir → "Run PR" (step-by-step logs + PR link). Host routes (`/pr/analyze`, `/pr/targets`, …) and the preset-rule file are unchanged — only the front-end narrowed.

### v1.12.0 (history)
Three new panel sections (④ Clone / ⑤ Pull Request / ⑥ npm publish):

- **④ Clone repos**: lists every remote repo of the signed-in account (GitHub via `gh repo list`, Gitee via OpenAPI `user/repos`) and flags which already exist locally (default = default workspace + registered workspaces + custom dirs). **Default target directory = the user's home directory** (`os.homedir()`; `C:\Users\<name>` on Windows, `$HOME` on Linux/macOS) — leave empty to clone there. Every directory row has a 「选择目录…」(Choose directory…) button matching ③ Code Management (type an absolute path or open the native folder picker; confirmed paths are remembered as custom dirs). Cloning uses SSH URLs and adds the clone to the custom-directory list automatically. The "already exists" check also covers "a sibling dir whose basename equals the repo name and contains `.git`". Host routes: `GET /clone/default-dir`, `GET /clone/home`, `GET /clone/repos`, `POST /clone/run`.
- **⑤ Pull Request**: target repo URLs are recorded to `~/.dsh/storages/source-code-mgmt-pr-targets.json` (**not** the plugin directory). **Entering a URL automatically reads that repo's local rule** (`GET /pr/rule`, read-only cache, no AI spend): a preset/cached rule shows its specific PR flow, otherwise a generic flow is shown with a prompt to 「Analyze PR rules」. A **preset rule is seeded to `rules/awesome-dsh-plugin__awesome-dsh-plugin.json`** — enter `https://github.com/awesome-dsh-plugin/awesome-dsh-plugin` and its exact contribution flow is shown (fork → clone → write entry in `data/plugins/<owner>__<repo>.yml` → `npm ci && node scripts/generate-readme.mjs` to regenerate README → commit → push → PR; the rule lives in the plugin directory). 「Analyze PR rules」fetches the repo's README/CONTRIBUTING/PR template/package.json and has the **DSH default model** figure out how to PR to that repo, then caches the structured step rule to the plugin directory `rules/<owner>__<repo>.json` — next time it runs straight from cache with **no AI spend** (「Re-analyze (ignore cache)」forces a fresh pass). 「Generate PR content」produces title/description/entry-file content from the rule template (preset templates can be filled with **zero AI spend** and remain editable); **it is editable and never submitted directly**. 「Run PR」executes `fork → clone fork → add upstream → fetch → create branch → write entry → regenerate README → commit → push → gh pr create` (Gitee via OpenAPI) with step-by-step logs and a PR link. Host routes: `GET /pr/targets`, `POST /pr/targets`, `POST /pr/rule`, `POST /pr/analyze`, `POST /pr/generate`, `POST /pr/execute`.
- **⑥ Publish npm package**: a five-step wizard (`npm config get registry` → `npm config list` (token/auth/password redacted) → `npm whoami` → `npm pack --dry-run` → `npm publish`); the publish button needs an explicit confirmation checkbox. **The package directory is switchable** (with the same 「选择目录…」 button). **Not logged in / not configured is called out**: the panel shows the current registry and whoami; when logged out it offers 「Open a terminal to run npm login」 (host spawns a system terminal in the target dir, `POST /npm/login`) and 「Copy login command」; re-check after logging in. `GET /npm/status` also reports whether the directory exists and has a `package.json`, with matching warnings. Host routes: `GET /npm/status`, `POST /npm/step`, `POST /npm/login`.
- **Host AI plumbing**: `llmComplete()` calls the DSH LLM runtime through `ctx.get('llm')`, resolving the default model from `ctx.get('settings').get('agent-default-model')` (falling back to parsing `~/.dsh/settings.yaml`), assembling `text-delta` chunks into the final text.
- **Maintainability**: new i18n keys are merged via `Object.assign` into `EN_DICT` / `HOST_EN` without touching the original long dictionary lines; a shared `inputStyle()` helper was added; both halves pass `node --check`.
- **Adversarial-review fixes (same version)**:
  - **Windows npm path with spaces broke ⑥**: the resolved npm path (e.g. `C:\Program Files\nodejs\npm.cmd`) was truncated to `'C:\Program' is not recognized` under shell mode. `run()` now quotes the executable path when it contains whitespace (path only; args still passed safely as an array); npm registry / whoami / version verified live.
  - **「Re-analyze (ignore cache)」was a no-op**: `/pr/analyze` never forwarded `force` to the analysis flow, so the button always hit the cache. It now passes `body.force` through.
  - **Dotted repo names mis-parsed**: `parseRepoUrl` truncated `owner/my.repo` to `my` (the regex excluded dots). It now allows dots and only strips a trailing `.git`.
  - **Hardened PR rule execution**: rules come from AI/cache and are trusted by default. `safeEntryPath()` blocks entry-file path traversal (`..` / absolute paths) and `safeRegenerateCommand()` only allows a whitelist of build commands with no shell metacharacters — preventing a malicious repo's docs from steering the AI into dangerous auto-executed rules.
  - **「Ensure fork」false-success log fixed**: a failed `gh repo fork` previously still showed ✅; it now reports success only on a real success or an "already exists" result.
  - **Gitee repo list pagination**: `user/repos` defaults to 20 per page, so only the first 20 showed. It now pages at 100 per page (up to 10 pages ≈ 1000 repos, matching GitHub).
  - `tools/smoke-test.mjs` extended to 31 cases (dotted repo names, path traversal, command whitelist, etc.) — all green; both halves pass `node --check`.
- **Feedback refinements (same version)**:
  - **④ Default clone dir changed to the user's home**: it previously defaulted to the DSH workspace, and a workspace whose folder is itself a repo was wrongly flagged as cloneable. It now defaults to `os.homedir()` and the "already exists" check additionally covers "basename of the base dir == repo name AND contains `.git`".
  - **④⑥ Directory buttons match ③**: both the clone target and the npm package directory offer a 「选择目录…」(Choose directory…) button identical to ③ Code Management — type an absolute path or pop the native folder picker, and confirmed paths are remembered as custom dirs (not limited to inside the workspace).
  - **⑤ Per-repo PR features**: entering a target repo URL automatically runs `GET /pr/rule` (cache only, no AI spend) — a rule shows its specific flow, otherwise a generic flow appears with a prompt to analyze; the awesome-dsh-plugin contribution rule is preset into the plugin `rules/` dir, so entering its official repo URL hits it directly.
  - **⑥ Login/configuration guidance**: when `npm whoami` is not logged in, the panel warns clearly and offers 「Open a terminal to run npm login」 (`POST /npm/login`; Windows spawns `cmd /k`, other platforms fall back to common terminal emulators) or 「Copy login command」 — then just re-check to continue the publish flow.
  - **⑤ Rule analysis accepts manual input**: clicking 「Analyze PR rules」 now expands an input panel — you can type the repo's PR rules yourself, or point to a rules file (local path / URL, e.g. a repo README); leave empty and AI auto-fetches the repo's docs (README/CONTRIBUTING/PR template) to analyze. When content is supplied, a **lean prompt** is used (faithfully organize only the user input, no doc fetching, no inventing — saving tokens), and the result is still cached in a structured form to the plugin `rules/` dir. If the repo already has a local rule, clicking 「Analyze PR rules」 first asks whether to re-analyze (choosing "no" does nothing).

### v1.11.0 (history)
This release focuses on the changed-files preview experience and Chinese-filename compatibility:

- **New/untracked files are now viewable**: an untracked (新增) file row now shows「▸ 查看」and expands to display the file's full content (rendered as an "all added" diff; oversized files show the first 2000 lines with a truncation note, capped at 1 MB so huge files are never slurped into memory); an empty new file shows「（空文件）」.
- **No「旧版本」column for new files**: the side-by-side diff shows only the「新版本」column when the diff has no deletion rows (pure additions, e.g. new/untracked files); diffs with deletions keep the two-column comparison.
- **Binary files show no「查看」button**: each changed file is sniffed (NUL-byte heuristic, the same one git uses) to decide whether its content can be previewed as text — binary files (images, executables, …) get no「查看」button (tooltip: "Binary file — text preview unavailable"); files without a working-tree copy (deleted, or staged-then-removed) are judged via `git diff --numstat` (`-\t-` marks binary).
- **Chinese filename compatibility fix**: git's default `core.quotepath` prints Chinese paths as octal-escaped quoted strings (e.g. `"\346\270\270…md"`), which showed up garbled in the changes list and diff headers. Every git invocation now gets `-c core.quotepath=false` (raw UTF-8 paths), plus a defensive `parseGitPath()` unescaper applied to every path-parsing site — `status --porcelain`, `ls-files -z`, `diff --name-only`, and `git diff`/`git show` headers.
- New regression test `tools/verify-cn-paths.test.mjs` (Chinese path parsing, text/binary viewability, new-file diff generation, deleted-file detection).

### v1.10.1 (history)
- **Fix: the top-right「代码管理」button lingered even after dsh-better-sidebar was installed.** For the fallback entry (better-sidebar absent) the teardown handler was only wired for the ReactDOM fallback path — the slots path never stored it, so switching to the sidebar-Tab form left the header entry behind. The `slots.inject` disposer is now captured into `entryUnmount`, so switching to a Tab tears the header entry down correctly.
- **Fix: when better-sidebar is absent, the entry only showed inside a conversation and vanished in the new-conversation / no-conversation empty state.** The old entry lived in `conversation.session.header.utilities` (`scope: 'session'`), and the whole session header is hidden via `hideChrome` in the empty state. It is now **always present at the top-right**: with an active session it sits beside「Session log」(the right-aligned session-header utilities); in the new/no-conversation empty state it becomes a fixed top-right button registered in the always-mounted `shell.overlay` slot (shown only when the session is blank or absent, so it never duplicates the header button).
- **Fix: on refresh the「代码管理」button overlapped「Session log」.** `captureSessions()` takes ~1.2s to populate the session list, and before that the button wrongly believed there was no session and lit up early. The overlap button now renders nothing until the session list is captured.
- **Corrected visibility signal:** the fixed button now keys off whether the current session is blank (`sessions.list.getSnapshot().byId[current].blank`) — show only for blank/no-session, hide for an active (non-blank) session — replacing the inaccurate `current === undefined` check.
- **Robustness:** better-sidebar detection now uses a **bounded multi-tick retry** (fast start then slowing, ~44s, stopping on success and cleared on teardown) instead of a single 1.5s retry, covering slow client cold-start so the Tab-switch race no longer misses.

> All changes are client-side (`lib/client.js`); refresh the page to pick them up. Host `/api` routes and the push/ignore logic are untouched.

### v1.10.0 (history)
- **Bilingual UI, live (follows DSH's language setting)**: every piece of panel copy (steps ①②③, buttons, dialogs, status/result messages, confirm dialogs, the sidebar Tab title) plus host-side error/result messages is now driven by a bilingual dictionary. Language comes from DSH's Settings → General → Language and switches **instantly** — the panel re-renders via a `ctx.locale` subscription (the Tab title follows too), no refresh or restart. The host returns messages per-request based on `?lang=` (AsyncLocalStorage-scoped, so concurrent requests never cross languages). The Chinese UI is byte-identical to v1.9.0; English is a complete translation (including >100MB skip reasons, Gitee token hints, git command fallback messages). The `tools/` directory now holds the i18n extract/apply/test scripts for future maintenance.

### v1.9.0 (history)
- **Profile Bundle distribution — install = activate**: `dsh.bundle` changed from the bare string `"./lib/index.js"` to the object form `{ "patch": "./cordis.patch.yml" }`, with a new `cordis.patch.yml` (inserts the `source-code-mgmt` row). `dsh plugin --profile web add source-code-mgmt` now appends the package to `dsh.profile.bundles` and registers it into the Cordis loader tree automatically — **no manual `cordis.patch.yml` editing**. The「install ≠ activate」warning and the PowerShell activation script were removed from the README. Behavior is otherwise unchanged (same `lib/index.js` host half + `lib/client.js` browser half).

### v1.8.0 and earlier (history)
See the full Chinese changelog in [README.md](README.md#版本历史). Highlights of recent releases: ① now shows a **Check update** button for GitHub CLI / Gitee CLI — compares local vs official latest, confirms, then re-runs the install flow with `force` to update (v1.18.0), Gitee mode now detects/installs the official **Gitee CLI** (platform-adaptive ① tool rows, one-click install, `gitee auth login` button in ②, one-click token import into ③) and one-click DSH restart removed (v1.17.0), GitHub CLI download-source selector with mirrors + gh login button (v1.16.0), npm-login terminal fix (no host crash) + official-registry publish (v1.15.1), adaptive sudo-free installs with live progress dialog and one-click DSH restart (v1.15.0), PR removal (v1.14.0), push-staged button (v1.8.0), fetch-on-open with refreshing indicator (v1.7.0), header button + right panel when better-sidebar is absent (v1.6.0), one-click missing-tool install (v1.5.0), SSH key auto-detection (v1.4.0), local Git workflow — stage/unstage, custom commit message, branch switch, history with revert/cherry-pick, side-by-side diff (v1.3.0), adaptive entry + Gitee support (v1.1–1.2), first release (v1.0.0).

## License

MIT
