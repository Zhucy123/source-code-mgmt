# source-code-mgmt — DSH Source Code Management Plugin

> Version: **v1.10.0**　|　中文版见 [README.md](README.md)

> A source-code management plugin for the DSH Web GUI: it bundles「environment check → SSH setup → commit/push/upload code」into one「Code Management」panel with GitHub / Gitee dual-platform support.

> **Bilingual UI, live**: the panel and host-side messages follow DSH's language setting (Settings → General → Language) — switching between 中文 and English takes effect instantly, no refresh or restart needed.

> The entry point adapts automatically: when [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) is installed,「Code Management」appears as a new sidebar **Tab** of that sidebar; otherwise a「Code Management」button is registered in the **right-aligned header list beside "Session log"** (same pill style, 8px gap), opening a right-side integrated panel that pushes the main content. Both forms share the same panel UI and no longer use a left-rail bottom button.

> **UI language:** the panel follows DSH's language setting (Settings → General → Language), live — Chinese (中文) or English, including all host-side messages. No restart needed when you switch.

## Features

Entry points (auto-detected, no manual switching):

- **dsh-better-sidebar installed:**「Code Management」registers as a new **Tab page** of its sidebar;
- **dsh-better-sidebar not installed:** a「Code Management」button in the **right-aligned header list beside "Session log"** (registered through DSH's `conversation.session.header.utilities` slot), opening a right-side integrated panel that pushes the main content left.

> Detection is a single in-memory read at activation time (`ctx.get('betterSidebar')`) — zero I/O, zero network, no impact on DSH startup.

The panel has three steps:

### ① Environment Check
- Shows the **OS** (friendly names `Windows` / `macOS` / `Linux`, from the underlying `win32` / `darwin` / `linux` platform ids)
- Detects **Git** and **GitHub CLI** presence and versions (e.g. `git version 2.55.0`, `gh version 2.97.0`)
- Detects whether an **SSH** client is available
- **Missing tools → install guidance + one-click install**: when a tool is missing, the row shows「❌ 未安装」+「复制安装命令」(copy install command) +「安装」(install) — install picks the package manager automatically (winget / built-in features on Windows, brew on macOS, apt/dnf/pacman on Linux, may need admin rights) and re-detects afterwards

### ② SSH Key & Connectivity
- **Platform selector**: GitHub (default) / Gitee — decides the SSH config target and connectivity test below
- **Auto-detect ed25519 key**: scans `~/.ssh/*.pub` for existing ed25519 public keys — prefers `id_ed25519`, otherwise the first found (any name, e.g. `github_ed25519`); falls back to `id_ed25519` when none exist. The status line shows the actual key filename, and the SSH config `IdentityFile` uses it too
- One-click **generate ed25519 key** (no passphrase; reuses an existing ed25519 key instead of duplicating)
- One-click **write SSH config** (GitHub: `github.com → ssh.github.com:443`; Gitee: `gitee.com` port 443) — see [Do I need the 443 config?](#do-i-need-the-443-config) below
- **Test connection** `ssh -T git@github.com` (GitHub) or `ssh -T git@gitee.com` (Gitee)
- Shows the public key content for easy copy-upload to the platform
- Detects whether `gh` is logged in and which account

### ③ Code Management
- **Follows ②'s platform**: all「detect / create / visibility」logic switches with the platform selector (GitHub via `gh` CLI, Gitee via Gitee OpenAPI)
- **Gitee token** (Gitee mode only): enter a Gitee personal access token (needs `projects` permission) → stored at `~/.dsh/storages/source-code-mgmt-gitee.json` on the machine (0600, **not inside the plugin dir**, never echoed to the browser/logs); one-click clear; invalid tokens are removed automatically
- **Workspace selector**: dropdown of DSH-registered workspace folders
- **Select folder →**: paste an absolute path or click「Browse…」for a native folder picker; confirmed folders are **persisted into a custom folder list** (`~/.dsh/storages/source-code-mgmt-dirs.json`, separate from the plugin dir — no personal paths leak), shown with a custom-folder badge and a ✕ to remove the entry (record only, never deletes the actual folder)
- Shows repo status: platform source, branch, remote, pending change count, ahead/behind remote, >100MB files
- **View details**: when there are changes, a「查看」(view) button opens a dialog listing changed/added/deleted/renamed **files or folders**; tracked changes can be expanded to show an inline **side-by-side diff** (old left / new right, deletions red, additions green); untracked files are listed by name only. When local and remote diverge, a view button on the sync row lists the concrete commits you're ahead/behind
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

After installing, **fully restart dsh web** (stop the old process — not a page refresh), then **F5** in the browser. The「Code Management」entry appears (sidebar Tab with dsh-better-sidebar, otherwise the header button + right panel).

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

After installing and restarting:

1. **Dependency written**: `source-code-mgmt` is in `dependencies` of `~/.dsh/profiles/web/package.json`.
2. **Added to the config layer**: `source-code-mgmt` is in the `dsh.profile.bundles` list of the same file (written automatically by `dsh plugin add` — no manual editing).
3. **Symlink created (`link:` only)**: `~/.dsh/profiles/web/node_modules/source-code-mgmt` points at your source dir (a Junction on Windows).
4. **Entry visible after restart**: sidebar「Code Management」Tab with dsh-better-sidebar, otherwise the header button beside "Session log" opening the right panel.

### Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Installed with `dsh plugin add` and restarted, but no button | Most common: the process was **refreshed, not fully restarted**. Stop the old `dsh web` process (it may still hold port 3080) and start it again. |
| Install prints「declares no dsh.bundle」 | The installed version lacks the bundle declaration (old version or a package missing `cordis.patch.yml`). Reinstall/update with version ≥ 1.9.0. |
|「Failed to load plugins」 | The host-side `lib/index.js` failed to boot (usually a dependency resolution issue). Check the startup log and confirm `node_modules` dependencies are complete. |

## Usage

1. Restart dsh web and refresh the browser.
2. Click the「**Code Management**」entry (sidebar Tab with dsh-better-sidebar, otherwise the header button beside "Session log").
3. ① Confirm Git / GitHub CLI are installed → ② generate a key and test connectivity → ③ pick a workspace, then push or create a new repo.

## Backend API routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/source-code-mgmt/env` | GET | Environment check (git/gh versions) |
| `/api/source-code-mgmt/install-tool` | POST | One-click install of a missing tool (body `tool`: `git`/`gh`/`ssh`, package manager picked per platform) |
| `/api/source-code-mgmt/ssh` | GET | SSH key / config / gh login status |
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
- **One-click missing-tool install across platforms**: winget / built-in features (fallback choco/scoop) on Windows, brew on macOS, apt-get / dnf / pacman on Linux (auto `sudo -n`; skipped when already root). The native folder picker is Windows-only; on macOS/Linux paste the path into the input box instead

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

### v1.10.0 (current)
- **Bilingual UI, live (follows DSH's language setting)**: every piece of panel copy (steps ①②③, buttons, dialogs, status/result messages, confirm dialogs, the sidebar Tab title) plus host-side error/result messages is now driven by a bilingual dictionary. Language comes from DSH's Settings → General → Language and switches **instantly** — the panel re-renders via a `ctx.locale` subscription (the Tab title follows too), no refresh or restart. The host returns messages per-request based on `?lang=` (AsyncLocalStorage-scoped, so concurrent requests never cross languages). The Chinese UI is byte-identical to v1.9.0; English is a complete translation (including >100MB skip reasons, Gitee token hints, git command fallback messages). The `tools/` directory now holds the i18n extract/apply/test scripts for future maintenance.

### v1.9.0 (history)
- **Profile Bundle distribution — install = activate**: `dsh.bundle` changed from the bare string `"./lib/index.js"` to the object form `{ "patch": "./cordis.patch.yml" }`, with a new `cordis.patch.yml` (inserts the `source-code-mgmt` row). `dsh plugin --profile web add source-code-mgmt` now appends the package to `dsh.profile.bundles` and registers it into the Cordis loader tree automatically — **no manual `cordis.patch.yml` editing**. The「install ≠ activate」warning and the PowerShell activation script were removed from the README. Behavior is otherwise unchanged (same `lib/index.js` host half + `lib/client.js` browser half).

### v1.8.0 and earlier (history)
See the full Chinese changelog in [README.md](README.md#版本历史). Highlights of recent releases: push-staged button (v1.8.0), fetch-on-open with refreshing indicator (v1.7.0), header button + right panel when better-sidebar is absent (v1.6.0), one-click missing-tool install (v1.5.0), SSH key auto-detection (v1.4.0), local Git workflow — stage/unstage, custom commit message, branch switch, history with revert/cherry-pick, side-by-side diff (v1.3.0), adaptive entry + Gitee support (v1.1–1.2), first release (v1.0.0).

## License

MIT
