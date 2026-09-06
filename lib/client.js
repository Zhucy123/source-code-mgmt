/**
 * source-code-mgmt — browser half (client.js).
 *
 * Classic-script plugin bundle (no build step). On activation it detects
 * whether dsh-better-sidebar is installed (a single in-memory `ctx.get`,
 * zero I/O — does not slow DSH startup):
 *
 *   - branch A: dsh-better-sidebar installed → register「代码管理」as a new
 *     sidebar Tab page through `ctx.betterSidebar.registerTab`.
 *   - branch B: not installed → register a「代码管理」button into the DSH
 *     `conversation.session.header.utilities` slot (the right-aligned list that
 *     holds "Session log"), so it sits beside "Session log" with the same pill
 *     look and 8px gap; clicking opens a RIGHT-side integrated panel (pushing
 *     #root left, dsh-better-sidebar style) holding the existing panel.
 *     If the `slots` service is unavailable, it falls back to a floating
 *     top-right button opening the same right-side panel.
 *
 * The old left-rail bottom button (`sidebar.footer.action` slot) is removed.
 * Either way clicking the entry opens a "源代码管理" panel with:
 *
 *   1. 环境检查 — git / gh presence & version
 *   2. SSH — key presence, ed25519 generation, github.com ssh config, test
 *   3. 代码 — pick a folder, show repo status, push (auto-.gitignore >100MB),
 *            or create a new private cloud repo & push
 *
 * React is a platform module (`require("react")`). Everything is plain
 * createElement — this file runs verbatim as a classic script.
 */
window.__ModuleLoader__.load({
	id: "source-code-mgmt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const PLUGIN_ID = "source-code-mgmt";
		const API = "/api/source-code-mgmt";

		let React = null;
		try { React = require("react"); } catch {}
		let ReactDOM = null;
		try { ReactDOM = require("react-dom"); } catch {}

		const { useState, useEffect, useRef, useCallback } = React;

		// theme tokens (dark/light aware)
		const T = {
			border: "var(--dsw-alias-border-l2, rgba(128,128,128,.35))",
			label: "var(--dsw-alias-label-primary, inherit)",
			secondary: "var(--dsw-alias-label-secondary, rgba(128,128,128,.8))",
			layer1: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))",
			layer2: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))",
			hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))",
			active: "var(--dsw-alias-interactive-bg-active, rgba(128,128,128,.18))",
			success: "var(--dsw-alias-state-success-primary, #22c55e)",
			danger: "var(--dsw-alias-text-danger, #ef4444)",
			warn: "var(--dsw-alias-state-warn-primary, #f59e0b)",
			brand: "var(--dsw-alias-brand-primary, #4f8cff)",
			mask: "var(--dsw-alias-bg-mask-1, rgba(0,0,0,.5))",
		};

		// ---------- fetch helpers ----------
		// 每个请求都带上当前语言（?lang=zh|en），host 端据此返回对应语言的错误/结果消息。
		async function jget(path) {
			const res = await fetch(API + path + (path.indexOf("?") >= 0 ? "&" : "?") + "lang=" + currentLang());
			if (!res.ok) throw new Error("HTTP " + String(res.status));
			return await res.json();
		}
		async function jpost(path, body) {
			const res = await fetch(API + path + (path.indexOf("?") >= 0 ? "&" : "?") + "lang=" + currentLang(), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			if (!res.ok) throw new Error("HTTP " + String(res.status));
			return await res.json();
		}
		/** POST 并逐行消费 NDJSON 事件流（{type:'step'|'out'|'result'}，用于一键安装进度）。返回 result 对象。 */
		async function jpostStream(path, body, onEvent) {
			const res = await fetch(API + path + (path.indexOf("?") >= 0 ? "&" : "?") + "lang=" + currentLang(), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			if (!res.ok || !res.body) {
				const text = await res.text().catch(() => "");
				throw new Error("HTTP " + String(res.status) + (text ? ": " + text : ""));
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			let result = null;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				let nl;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl).trim();
					buf = buf.slice(nl + 1);
					if (!line) continue;
					let evt;
					try { evt = JSON.parse(line); } catch { continue }
					if (evt && evt.type === "result") result = evt.result;
					else if (onEvent) { try { onEvent(evt); } catch {} }
				}
			}
			if (result === null) throw new Error("no result");
			return result;
		}

		// ---------- preload cache ----------
		// 只在打开插件时按需拉取仓库状态；DSH 打开（插件激活）时只预取静态的 env / ssh /
		// workspaces / 默认工作区，绝不联网同步仓库——避免打开 DSH 就 fetch、并把可能过期的
		// 数据缓存起来，导致打开/重开面板时显示旧状态（如旧的「无改动」）。
		const cache = {
			env: null,
			ssh: null,
			defDir: null,
			repo: null,
			// 各工作区的最近一次结果（dir -> repo 状态），仅作展示历史，不再用于「秒显无刷新」。
			reposByDir: {},
			// 单文件改动 diff 缓存（"dir\u0000path" -> diff 文本），点击「查看」秒出。
			diffs: {},
			workspaces: [],
			customDirs: [],
			ready: false,
		};
		let preloadPromise = null;

		/** 清空某个目录（或全部）的 diff 缓存，避免切目录后残留上一个目录的文件 diff。 */
		function clearDiffCache(dir) {
			if (!dir) { cache.diffs = {}; return }
			const prefix = dir + "\u0000"
			for (const key of Object.keys(cache.diffs)) {
				if (key.startsWith(prefix)) delete cache.diffs[key]
			}
		}

		/** 并发上限 N 地预取一批改动文件的 diff，结果写入 cache.diffs，用于点击「查看」秒出。
		 *  纯本地 git 读取（host 端 /repo-diff），并发低、不阻塞主流程，后台慢慢填。 */
		async function prefetchDiffs(dir, files, limit) {
			if (!dir || !Array.isArray(files) || files.length === 0) return;
			let i = 0
			const worker = async () => {
				while (i < files.length) {
					const f = files[i++]
					if (!f || typeof f !== "object") continue
					const key = dir + "\u0000" + f.path
					if (cache.diffs[key] !== undefined) continue
					// 二进制等无法按文本预览的文件（列表里不显示「查看」），跳过预取。
					if (f.viewable === false) { cache.diffs[key] = null; continue }
					try {
						const r = await jget("/repo-diff?dir=" + encodeURIComponent(dir) + "&path=" + encodeURIComponent(f.path)).catch(() => null)
						cache.diffs[key] = (r && typeof r.diff === "string") ? r.diff : null
					} catch { cache.diffs[key] = null }
				}
			}
			const n = Math.max(1, Math.min(limit || 3, files.length || 1))
			const workers = []
			for (let k = 0; k < n; k++) workers.push(worker())
			await Promise.all(workers)
		}

		/** 预取 env / ssh / default-dir / workspaces（仅静态资源），结果写入 cache。可并发安全。
		 *  注意：仓库状态不在此预取（需要用户打开面板/切换工作区时才按需联网获取，并显示刷新中）。 */
		function preload() {
			if (!preloadPromise) {
				preloadPromise = (async () => {
					try {
						const [env, ssh, def, ws] = await Promise.all([
							jget("/env").catch(() => null),
							jget("/ssh").catch(() => null),
							jget("/default-dir").catch(() => null),
							jget("/workspaces").catch(() => null),
						]);
						cache.env = env;
						cache.ssh = ssh;
						if (ws && Array.isArray(ws.workspaces)) {
							cache.workspaces = ws.workspaces;
						}
						if (ws && Array.isArray(ws.customDirs)) {
							cache.customDirs = ws.customDirs;
						}
						if (def && def.dir) {
							cache.defDir = def.dir;
						}
						cache.ready = true;
					} catch {
						/* 保持部分缓存 */
					}
				})();
			}
			return preloadPromise;
		}

		/** 忽略缓存强制重新拉取某个资源并更新 cache。 */
		async function refreshCache(key) {
			if (key === "env") cache.env = await jget("/env").catch(() => cache.env);
			else if (key === "ssh") cache.ssh = await jget("/ssh").catch(() => cache.ssh);
			else if (key === "workspaces") {
				const w = await jget("/workspaces").catch(() => null);
				if (w && Array.isArray(w.workspaces)) cache.workspaces = w.workspaces;
				if (w && Array.isArray(w.customDirs)) cache.customDirs = w.customDirs;
			}
			else if (key === "repo") {
				cache.repo = await jget("/repo?dir=" + encodeURIComponent(cache.defDir || "")).catch(() => cache.repo);
			}
			return cache[key];
		}

		// ---------- small presentational bits ----------
		const h = React.createElement;

// ---------- i18n: follows DSH’s language setting (Settings → General → Language), live ----------
const EN_DICT = {"展开":"Expand","折叠":"Collapse","展开该部分":"Expand this section","折叠该部分":"Collapse this section","已安装":"Installed","❌ 未安装":"❌ Not installed","复制安装命令":"Copy install command","一键安装（会自动选包管理器）":"Install automatically (picks a package manager)","安装中…":"Installing…","安装中，请稍候…":"Installing, please wait…","安装完成":"Installation complete","，刷新网页即可生效":" — refresh the page to apply","安装":"Install"," 执行成功":" executed successfully","（已装到 ~/.local/bin，免 sudo）":" (installed to ~/.local/bin, no sudo needed)","（如未生效需以管理员身份重试）":" (retry as administrator if it did not take effect)","安装失败":"Install failed","① 环境检查":"① Environment","✅ 均存在":"✅ All present","操作系统":"OS","已找到":"Found","检测中":"Checking","失败: ":"Failed: ","未找到的工具可用上方「安装」按钮一键安装（":"Missing tools can be installed with the \"Install\" button above (","Windows 用 winget / 内置功能":"winget / built-in features on Windows","用系统包管理器":"your system package manager","，可能需管理员权限）；也可手动复制安装命令执行，安装后点「重新检查」。":"; admin rights may be required). You can also copy the install command and run it manually, then click \"Re-check\".","重新检查":"Re-check","：已存在，无需重复操作":": already exists, no need to repeat","成功":" succeeded","失败":" failed","失败：":"Failed: ","平台":"Platform","选择代码托管平台：GitHub 或 Gitee（默认 GitHub），③代码管理会跟随切换":"Choose the code hosting platform: GitHub or Gitee (GitHub default); step ③ follows this switch","GitHub（默认）":"GitHub (default)","② SSH 密钥与连接":"② SSH Key & Connection","密钥":"Key"," 已生成":" generated","⚠️ 未生成":"⚠️ Not generated","GH 登录":"GH login","已登录":"Logged in","⚠️ 未登录":"⚠️ Not logged in","SSH 配置":"SSH config"," 已配置(443)":" configured (443)","⚠️ 未配置/限制 22 端口需配置":"⚠️ Not configured / port 22 blocked — use 443","生成密钥":"Generate key","配置 SSH(config)":"Configure SSH config","配置 SSH":"Configure SSH","测试连接":"Test connection","SSH 连接成功（":"SSH connection succeeded (","已认证":"authenticated","连接失败，请确认密钥已上传到 ":"Connection failed. Make sure the key is uploaded to "," 或已登录 gh":" or that gh is logged in","测试失败：":"Test failed: ","公钥（复制上传到 ":"Public key (copy and upload to ","Gitee → 设置 → SSH 公钥":"Gitee → Settings → SSH keys","，或运行 gh auth login 自动上传）：":", or run gh auth login to upload it automatically):","该目录不是 git 仓库":"This folder is not a git repository","读取令牌状态失败：":"Failed to read token status: ","已保存 Gitee 令牌（账号：":"Gitee token saved (account: ","保存令牌失败":"Failed to save token","保存令牌失败：":"Failed to save token: ","已清除 Gitee 令牌":"Gitee token cleared","清除失败":"Clear failed","清除令牌失败：":"Failed to clear token: ","已推送":"Pushed","推送失败":"Push failed","推送失败：":"Push failed: ","已拉取远程更新（本地已对齐到远程最新状态）":"Pulled remote updates (local is now aligned with the latest remote state)","拉取失败":"Pull failed","拉取失败：":"Pull failed: ","已拉取远程更新并推送更改":"Pulled remote updates and pushed changes","合并推送失败":"Merge-push failed","合并推送失败：":"Merge-push failed: ","强制推送会用本地版本覆盖远程仓库，远程上非本地的更改将被丢弃。确定继续？":"Force-push overwrites the remote repo with your local version; remote-only changes will be lost. Continue?","已强制推送，远程已更新为本地状态":"Force-pushed; the remote is now your local state","强制推送失败":"Force-push failed","强制推送失败：":"Force-push failed: ","强制拉取会把远程更新并入本地。如果本地有不想保留的内容，将按冲突处理或遗失。确定继续？":"Force-pull merges remote updates into local; anything you don't want kept may conflict or be lost. Continue?","已强制拉取远程更新":"Force-pulled remote updates","强制拉取失败":"Force-pull failed","强制拉取失败：":"Force-pull failed: ","请先加载一个有效的文件夹":"Load a valid folder first","确定把仓库 ":"Change repo "," 改为「":" visibility to「","公开":"Public","私有":"Private","」？修改可见性可能影响 Star、关注者等。":"」? Changing visibility may affect stars, watchers, etc.","已把仓库设置为「":"Repo set to「","修改可见性失败":"Failed to change visibility","修改可见性失败：":"Failed to change visibility: ","仓库已创建并推送：":"Repo created and pushed: ","创建失败":"Create failed","创建失败：":"Create failed: ","未选择目录":"No folder selected","选择失败：":"Selection failed: ","请输入或选择目录路径":"Enter or pick a folder path","添加目录失败":"Failed to add folder","添加目录失败：":"Failed to add folder: ","删除失败":"Delete failed","删除失败：":"Delete failed: ","强制对齐会用远程分支覆盖本地（丢弃本地未推送的更改与提交），确定继续？":"Force-align overwrites local with the remote branch (drops unpushed local changes and commits). Continue?","已强制对齐到远程分支":"Force-aligned to the remote branch","强制对齐失败":"Force-align failed","强制对齐失败：":"Force-align failed: ","已是 git 仓库":"Already a git repository","已创建 git 仓库，请自行拉取或推送":"Git repository created — pull or push as you wish","创建 git 失败":"Failed to init git","创建 git 失败：":"Failed to init git: ","暂存失败":"Stage failed","暂存失败：":"Stage failed: ","取消暂存失败":"Unstage failed","取消暂存失败：":"Unstage failed: ","已提交 ":"Committed "," 个文件":" file(s)","提交失败":"Commit failed","提交失败：":"Commit failed: ","已提交「":"Committed「","（自动生成）":" (auto-generated)","」并推送":"」 and pushed","已推送本地已有的提交":"Pushed existing local commits","读取分支失败":"Failed to load branches","读取分支失败：":"Failed to load branches: ","切换到分支「":"Switch to branch「","」？（若当前有未提交改动，git 会拒绝切换）":"」? (git will refuse if you have uncommitted changes)","已切换到分支 ":"Switched to branch ","切换分支失败":"Failed to switch branch","切换分支失败：":"Failed to switch branch: ","读取历史失败":"Failed to load history","读取历史失败：":"Failed to load history: ","revert 提交「":"Revert commit「","」——会生成一个反向提交，期间可能产生冲突，确定继续？":"」 — this creates a reverse commit and may cause conflicts. Continue?","已 revert 提交 ":"Reverted commit ","revert 失败":"Revert failed","revert 失败：":"Revert failed: ","cherry-pick 提交「":"Cherry-pick commit「","」到当前分支——期间可能产生冲突，确定继续？":"」 onto the current branch — this may cause conflicts. Continue?","已 cherry-pick 提交 ":"Cherry-picked commit ","cherry-pick 失败":"Cherry-pick failed","cherry-pick 失败：":"Cherry-pick failed: ","读取失败":"Failed to load","已复制":"Copied","短哈希":"short hash","完整哈希":"full hash","提交信息":"commit message","复制失败：请手动复制":"Copy failed — copy it manually","③ 代码管理":"③ Code Management","Gitee 私人令牌（OpenAPI，需 projects 权限）":"Gitee personal token (OpenAPI, requires projects permission)","✅ 已配置":"✅ Configured","（账号 ":" (account ","清除令牌":"Clear token","粘贴 Gitee 私人令牌（https://gitee.com/personal_access_tokens）":"Paste the Gitee personal token (https://gitee.com/personal_access_tokens)","保存令牌":"Save token","令牌只保存在本机 ~/.dsh/storages（0600），不会写进插件目录；需勾选个人令牌的 projects 权限。公钥需已上传到 Gitee（② 里检查）。":"The token is stored only on this machine at ~/.dsh/storages (0600), never in the plugin directory; the personal token must have projects permission. Your public key must be uploaded to Gitee (checked in ②).","选择工作区":"Workspace","选择 DSH 已登记的工作区文件夹":"Choose a workspace folder registered in DSH","（暂无可选工作区）":"(no workspaces available)","— 请选择 —":"— Select —","选择目录":"Choose folder","自定义目录：":"Custom folder: ","删除该目录记录":"Remove this folder entry","删除该目录记录（不删除实际文件夹）":"Remove this folder entry (does not delete the actual folder)","目录":"Folder","分支":"Branch","（无）":"(none)","切换分支":"Switch branch","切换":"Switch","查看提交历史":"View commit history","历史":"History","远程":"Remote","改动":"Changes","无":"None","查看改动的文件列表":"View the list of changed files","查看":"View","同步":"Sync","本地领先 ":"Ahead by "," 提交":" commit(s)","、落后 ":", behind by ","落后 ":"behind by ","与远程一致":"Up to date with remote","查看本地与远程的提交差异":"View commit differences between local and remote","⚠️ 以下 ":"⚠️ The following "," 项 >100MB（超过 GitHub 限制，推送时将自动忽略不上传）：":" item(s) >100MB (over GitHub's limit — auto-ignored on push):","/（整个文件夹）":"/ (entire folder)","创建 Git":"Init Git","仅初始化 git 仓库，不拉取不推送，由你决定下一步":"Initializes a git repo only — no pull/push; you decide the next step","本地有改动且远程有更新，可直接用「强制对齐」将本地重置为远程状态":"You have local changes AND remote updates — use \"Force align\" to reset local to the remote state","强制对齐":"Force align","本地完全重置为远程分支（丢弃本地差异），解决“文件相同仍显示同步差异”的情况":"Fully resets local to the remote branch (drops local differences); fixes \"files identical but sync still shows a difference\"","推送更改":"Push changes","拉取更新":"Pull updates","✓ 已是最新":"✓ Up to date","⟳ 正在刷新状态，联网同步 GitHub/Gitee 最新数据…":"⟳ Refreshing status — syncing the latest GitHub/Gitee data…","⟳ 切换平台，正在重新检测「":"⟳ Switching platform, re-checking「","」仓库状态…":"」 repo status…","推送中…":"Pushing…","推送暂存":"Push staged","把已暂存的内容用填写的（或自动生成的）信息提交后推送到远程；不会自动暂存其他未暂存的改动":"Commits only what is staged (with your message, or auto-generated) and pushes it; does not auto-stage other changes","刷新中…":"Refreshing…","刷新状态":"Refresh status","提交信息（留空则用默认）":"Commit message (default if empty)","填写提交信息后点「提交」；留空则自动生成（chore: update <文件夹名>）":"Type a message then click \"Commit\"; leave empty to auto-generate (chore: update <folder>)","提交":"Commit","仓库名称自动取文件夹名（不可修改）":"Repo name is taken from the folder name (read-only)","（未加载文件夹）":"(no folder loaded)","仓库可见性：私有 / 公开":"Repo visibility: private / public","（修改当前仓库的可见性）":" (changes the current repo's visibility)","新建仓库并推送":"Create repo & push","修改仓库状态":"Change repo status","✓ 仓库已是「":"✓ Repo is already「","」状态，如需修改请调整左侧可见性选择。":"」 — to change it, adjust the visibility dropdown.","将把仓库从「":"Will change the repo from「","」改为「":"」 to「","」，点击「修改仓库状态」执行。":"」 — click \"Change repo status\" to apply.","⚠️ 同名仓库已经创建（无法读取当前可见性，可能未":"⚠️ A repo with this name already exists (couldn't read its visibility — maybe not ","配置 Gitee 令牌":"Gitee token configured","登录 gh":"logged into gh","✓ 同名仓库 ":"✓ No repo named "," 不存在，可在 ":" exists — you can create it on ","「新建仓库并推送」创建（可选私有/公开）。":" with \"Create repo & push\" (private or public).","已忽略未上传（":"Skipped uploads ("," 项 >100MB）：":" item(s) >100MB):","已提交":"Committed"," 并推送":" and pushed","（推送省略）":" (push skipped)","查看详情":"View details","改动文件":"Changed files","提交历史":"Commit history","与远程同步差异":"Sync differences vs remote","关闭":"Close","已安装 dsh-better-sidebar，此处只列改动文件列表；具体改动内容请到 dsh-better-sidebar 的「源代码管理面板」查看。":"dsh-better-sidebar is installed — this lists changed files only; see the actual changes in its \"Source Control panel\".","点击收起":"Click to collapse","点击查看改动内容":"Click to view the diff","新文件（untracked）暂无内容 diff":"New (untracked) file — no diff yet","已暂存":"Staged","未暂存":"Unstaged","取消暂存":"Unstage","暂存":"Stage","加载中…":"Loading…","▾ 收起":"▾ Collapse","▸ 查看":"▸ View","正在加载改动内容…":"Loading changes…","（无内容差异）":"(no diff)","当前没有改动。":"No changes.","正在读取分支…":"Loading branches…","（无分支）":"(no branches)","（当前）":"(current)","正在读取历史…":"Loading history…","（暂无提交）":"(no commits)","更多操作（右键也可打开）":"More actions (right-click also works)","查看提交差异":"View commit diff","复制短哈希":"Copy short hash","复制完整哈希":"Copy full hash","复制提交信息":"Copy commit message","还原此提交":"Revert this commit","拾取此提交":"Cherry-pick this commit","正在加载提交 diff…":"Loading commit diff…","本地落后 ":"Behind by "," 个提交（远程有而本地没有）：":" commit(s) (on remote, not local):"," 个提交（本地有而远程没有）：":" commit(s) (on local, not remote):","✓ 已与远程同步，无差异。":"✓ In sync with remote — no differences.","选择代码目录":"Choose a code folder","可手动输入/粘贴目录绝对路径，或点击「浏览…」弹出本地文件夹选择器。确认后将添加到下方下拉并记住，下次打开无需重新选择。":"Paste an absolute folder path, or click \"Browse…\" for the native picker. Confirmed folders are added to the dropdown and remembered.","C:\\Users\\你的用户名\\项目目录":"C:\\Users\\your-name\\project","浏览…":"Browse…","取消":"Cancel","确定":"OK","新增":"Added","删除":"Deleted","重命名":"Renamed","修改":"Modified","旧版本":"Old","新版本":"New","源代码管理":"Source Control","按顺序完成：①环境检查 → ②SSH 密钥与连接 → ③代码管理。推送会自动忽略 >100MB 的文件（":"Work through in order: ① Environment → ② SSH Key & Connection → ③ Code Management. Files over 100MB are auto-ignored on push ("," 限制）并说明原因。":" limit) with the reason shown.","代码管理":"Code Management","拖动调整面板宽度":"Drag to resize the panel","二进制文件，无法查看文本内容":"Binary file — text preview unavailable","（空文件）":"(empty file)"};
Object.assign(EN_DICT, {
  // ④ 克隆仓库
  "④ 克隆仓库": "④ Clone repos",
  "刷新仓库列表": "Refresh repo list",
  "克隆到目录": "Clone into",
  "远程仓库列表": "Remote repos",
  "（暂无仓库）": "(no repos)",
  "本地已有": "Local",
  "可克隆": "Cloneable",
  "克隆": "Clone",
  "克隆中…": "Cloning…",
  "已克隆到 ": "Cloned to ",
  "克隆失败": "Clone failed",
  "克隆失败：": "Clone failed: ",
  "加载失败": "Load failed",
  "加载失败：": "Load failed: ",
  "加载中…": "Loading…",
  "（无）": "(none)",
  "已记录到本地": "Saved locally",
  "保存失败：": "Save failed: ",
  "生成中…": "Generating…",
  "如 https://github.com/owner/repo 或 owner/repo": "e.g. https://github.com/owner/repo or owner/repo",
  "目标目录不存在：": "Target directory does not exist: ",
  "已存在同名目录：": "A directory with the same name already exists: ",
  "请先登录 GitHub CLI（gh）": "Log in to GitHub CLI (gh) first",
  "需要先配置 Gitee 私人令牌": "Configure the Gitee personal token first",
  "克隆一个账号下的远程仓库到本地": "Clone a remote repo from your account locally",
  "删除": "Remove",
  // ⑤ 发布 npm 包
  "⑤ 发布 npm 包": "⑤ Publish npm package",
  "目标目录（含 package.json）": "Target dir (contains package.json)",
  "① 确认源（registry）": "① Check registry",
  "② 查看认证配置（config list）": "② Auth config (config list)",
  "③ 验证身份（whoami）": "③ Verify identity (whoami)",
  "④ 预览打包文件（pack --dry-run）": "④ Preview packed files (pack --dry-run)",
  "⑤ 发布（publish）": "⑤ Publish",
  "执行": "Run",
  "执行中…": "Running…",
  "npm 未安装（请先在 ① 环境检查安装）": "npm is not installed (install it in ① Environment first)",
  "已登录：": "Logged in as: ",
  "未登录 npm": "Not logged in to npm",
  "npm 状态": "npm status",
  "registry：": "registry: ",
"发布将使用官方源：": "Publishing uses the official registry: ",
  "我已核对以上内容，确认发布到 npm registry": "I've reviewed the above — confirm publishing to the npm registry",
  "发布完成": "Publish complete",
  "发布失败": "Publish failed",
  "发布失败：": "Publish failed: ",
  "读取 npm 状态失败：": "Failed to read npm status: ",
  "发布 npm 包五步向导：确认源 → 认证配置 → 身份 → 打包预览 → 发布": "Five-step npm publish guide: registry → auth config → identity → pack preview → publish",
  "按顺序完成：①环境检查 → ②SSH 密钥与连接 → ③代码管理，以及 ④克隆仓库 / ⑤发布 npm 包。推送会自动忽略 >100MB 的文件（": "In order: ①Environment → ②SSH key & connection → ③Code management, plus ④Clone repos / ⑤Publish npm. Pushing auto-ignores >100MB files (",
  " 限制）并说明原因。": " limit) with a reason.",
  // ④ 目录选择（复用 ③ 的「选择目录」交互）
  "克隆到目录（默认=用户主目录 home）": "Clone into (default = user home directory)",
  "选择目录…": "Choose directory…",
  "记住到常用目录": "Remember as a favorite dir",
  "已记住目录": "Directory remembered",
  "记住目录失败：": "Failed to remember dir: ",
  "目录不存在或不是文件夹：": "Directory does not exist or is not a folder: ",
  "可手动输入/粘贴目录绝对路径，或点击「浏览…」弹出本地文件夹选择器。确认后将添加到常用目录并记住，下次打开无需重新选择。": "Type/paste an absolute path, or click \"Browse…\" to open the native folder picker. Confirming adds it to your favorite dirs so you won't re-pick it next time.",
  // ⑤ npm 登录与目录
  "未登录 npm，发布前需先登录": "Not logged in to npm — log in before publishing",
  "打开终端执行 npm login": "Open a terminal to run npm login",
  "复制登录命令": "Copy login command",
  "登录窗口已打开，请在弹出的终端完成登录后点「重新检查」": "A login terminal has been opened — complete login there, then click \"Re-check\"",
  "该目录没有 package.json（请选择含 package.json 的包目录）": "This directory has no package.json (choose a package directory with one)",
  "（当前目录不存在）": " (directory does not exist)",
  "打开终端失败": "Failed to open a terminal",
  "请手动在终端运行：": "Run this manually in a terminal: ",
  "已复制：": "Copied: ",
  "目录不存在：": "Directory does not exist: ",
  "提交": "Commit",
  "取消": "Cancel",
  // ④ 按地址克隆
  "也可以按仓库地址克隆到任意位置": "You can also clone any repo by URL into any location",
  "仓库地址": "Repo URL",
  "克隆到": "Clone into",
  "请输入仓库地址": "Enter a repo URL",
  "请选择克隆到目录": "Choose a destination directory first",
  "无法从地址识别仓库名称": "Cannot derive a repo name from this URL",
  // ⑤ 目录默认留空，需手动选择
  "请先选择目标目录": "Choose a target directory first",
  "请先选择目标目录（当前留空，不会自动使用默认目录）": "Choose a target directory first (left empty on purpose — it will NOT auto-use the default dir)",
  // ① 环境检查：gh 下载源 / 安装完成刷新提示
  "下载源": "Download source",
  "官网（慢）": "Official (slow)",
  "选择下载源：官网直连在国内网络可能很慢；镜像走加速代理（gh-proxy.com 实测最快）。": "Choose a download source: direct official downloads can be very slow on domestic networks; mirrors go through an acceleration proxy (gh-proxy.com is fastest in tests).",
  // ② SSH：gh 登录
  "登录 GitHub": "Log in to GitHub",
  "登录失败": "Login failed",
  "登录失败：": "Login failed: ",
  // ② SSH：Gitee 登录（跟随平台切换；优先 Gitee CLI）
  "Gitee 登录": "Gitee login",
  "（Gitee）": " (Gitee)",
  "⚠️ 未安装 Gitee CLI": "⚠️ Gitee CLI not installed",
  "请在 ① 环境检查安装 Gitee CLI": "Install Gitee CLI in ① Environment",
  "（③ 已配置私人令牌）": " (token configured in ③)",
  "（Gitee API 仍需私人令牌，可在 ③ 配置）": " (Gitee API still needs a personal token — configure in ③)",
  "登录 Gitee": "Log in to Gitee",
  " 或已配置 Gitee 令牌": " or that the Gitee token is configured",
  // ③ 从 Gitee CLI 导入令牌
  "从 Gitee CLI 导入": "Import from Gitee CLI",
  "已从 Gitee CLI 导入令牌（账号：": "Token imported from Gitee CLI (account: ",
  "导入失败": "Import failed",
  "导入失败：": "Import failed: ",
  // ① 环境检查：检查更新
  "检查更新": "Check update",
  "正在检查更新…": "Checking for updates…",
  "检查更新（对比官方最新版本）": "Check for updates (compares with the latest official release)",
  "已是最新版本（": "Already up to date (",
  "发现新版本：": "A new version is available: ",
  "，是否立即更新？": " — update now?",
  "检查更新失败": "Update check failed",
  "检查更新失败：": "Update check failed: ",
  // ③ Gitee 未配令牌时新建/改可见性不可用的提示
  "未配置 Gitee 私人令牌，「新建仓库并推送」「修改仓库状态」暂不可用（仅推送/拉取已有仓库可用 SSH 公钥，无需令牌；令牌在下方配置后即可使用）": "Gitee token not configured — \"Create repo & push\" and \"Change repo status\" are unavailable (pushing/pulling an existing repo works with SSH keys alone, no token needed; configure the token below to enable them)",
});

let scmLang = (() => { try { return String(navigator.language || "zh").toLowerCase().split("-")[0] === "en" ? "en" : "zh" } catch { return "zh" } })();
let scmLocaleFace = null; // ctx.locale (the DSH LocaleRuntime), set in apply()
let scmSessionList = null; // ctx.get('sessions').list (ObservableSnapshot), set in apply() — 用于判断「无会话空态」
function currentLang() { try { if (scmLocaleFace && typeof scmLocaleFace.getLocale === "function") return scmLocaleFace.getLocale().active } catch {} return scmLang }
function t(key, params) {
  let s = key;
  try { if (currentLang() === "en") s = EN_DICT[key] ?? key } catch {}
  if (params && params.length) { let i = 0; s = String(s).replace(/\$\{\}/g, () => String(params[i++] ?? "")) }
  return s
}
/** Re-render the subtree when DSH switches language (subscribe to the LocaleRuntime).
 *  依赖 scmLocaleFace：若 client-locale 晚于本插件激活、捕获发生在组件挂载之后，
 *  effect 会重跑并补上订阅；订阅后立即重渲染一次，晚捕获时立刻用上当前语言。 */
function useLocale() {
  const [, force] = useState(0);
  useEffect(() => {
    if (!scmLocaleFace || typeof scmLocaleFace.subscribe !== "function") return;
    const off = scmLocaleFace.subscribe(() => force((n) => n + 1));
    force((n) => n + 1);
    return off;
  }, [scmLocaleFace]);
}

/** Re-render when the session list changes（新增/切换/清空会话）。用于空态常驻按钮判断：
 *  读到 current === undefined 即「当前没有会话」。 */
function useSession() {
  const [, force] = useState(0);
  useEffect(() => {
    if (!scmSessionList || typeof scmSessionList.subscribe !== "function") return;
    const off = scmSessionList.subscribe(() => force((n) => n + 1));
    force((n) => n + 1);
    return off;
  }, [scmSessionList]);
}


		function Field({ label, value, children }) {
			return h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 } },
				h("span", { style: { color: T.secondary, fontSize: 13, width: 84, flexShrink: 0 } }, label),
				children ?? h("span", { style: { color: T.label, fontSize: 13, fontWeight: 500 } }, value ?? "")
			);
		}
		function Btn({ label, onClick, tone, disabled, wide, noBg }) {
			const bg =
				noBg ? "transparent"
				: tone === "primary" ? T.brand
				: "transparent";
			const color =
				tone === "primary" ? (noBg ? T.brand : "#fff")
				: tone === "danger" ? T.danger
				: tone === "success" ? T.success
				: T.label;
			return h("button", {
				type: "button",
				disabled: !!disabled,
				onClick,
				style: {
					appearance: "none", font: "inherit", cursor: disabled ? "not-allowed" : "pointer",
					border: "1px solid " + (tone === "danger" ? T.danger : T.border),
					borderRadius: 8, padding: "5px 14px", fontSize: 13, lineHeight: 1.5,
					background: bg,
					color,
					opacity: disabled ? 0.5 : 1,
					flex: wide ? "1" : undefined,
				},
			}, label);
		}
		function Box({ title, badge, defaultCollapsed, collapsible, titleExtra, collapsed: controlledCollapsed, onToggle, children }) {
			// 每个部分默认可折叠：标题行右侧一个「折叠/展开」按钮，点击收起只显示标题。
			// defaultCollapsed 控制初始是否收起（如①环境检查全就绪时默认折叠）。
			// titleExtra：标题行里标题与折叠按钮之间的额外内容（如②的平台切换下拉），
			//            折叠时仍可见、可交互（切换平台会由调用方触发展开）。
			// 受控模式：传入 collapsed/onToggle 时由父组件接管折叠状态（用于「切换标题行控件
			//            后自动展开」）；否则用内部 state。
			const [inner, setInner] = useState(!!defaultCollapsed);
			const collapsed = controlledCollapsed !== undefined ? !!controlledCollapsed : inner;
			const setCollapsed = controlledCollapsed !== undefined ? onToggle : setInner;
			const canCollapse = collapsible !== false;
			return h("div", { style: { border: "1px solid " + T.border, borderRadius: 12, padding: 14 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
					h("span", { style: { fontSize: 13, fontWeight: 600, color: T.label, flexShrink: 0, minWidth: 0 } }, title),
					titleExtra || null,
					badge ? h("span", { style: { fontSize: 12, color: T.success, flexShrink: 0, whiteSpace: "nowrap" } }, badge) : null,
					canCollapse ? h("span", { style: { flex: 1 } }) : null,
					canCollapse ? h("button", {
						type: "button",
						title: collapsed ? t("展开") : t("折叠"),
						"aria-label": collapsed ? t("展开该部分") : t("折叠该部分"),
						onClick: () => setCollapsed(!collapsed),
						style: collapseBtnStyle(),
					}, collapsed ? "▸" : "▾") : null
				),
				collapsed ? null : h("div", { style: { marginTop: 10 } }, children)
			);
		}
		// 折叠/展开按钮样式（标题行右侧的小圆角按钮）。
		function collapseBtnStyle() {
			return {
				appearance: "none", border: "none", background: "transparent",
				color: T.secondary, cursor: "pointer", fontSize: 14, lineHeight: 1,
				width: 24, height: 24, borderRadius: 6, flexShrink: 0, padding: 0,
				display: "inline-flex", alignItems: "center", justifyContent: "center",
			};
		}
		function pre(code) {
			return h("pre", { style: { whiteSpace: "pre-wrap", fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 12, lineHeight: 1.6, color: T.secondary, margin: 0 } }, code);
		}

		// ---------- section 1: 环境检查 ----------
		// 每类工具缺失时给出安装命令 + 「一键安装」按钮（best-effort，走 host 自动选包管理器）。
		const INSTALL_HINTS = {
			git: "winget install --id Git.Git -e",
			gh: "winget install --id GitHub.cli -e",
			ssh: "Add-WindowsCapability -Online -Name OpenSSH.Client",
		};
		// 一键安装进度弹窗：实时展示分步进度 + 尾部输出 + 结果提示。
		// 安装完成即生效，刷新网页即可让面板重新检测到新工具（无需重启 DSH）。
		function InstallDialog({ tool, logs, result, onClose }) {
			const scrollRef = useRef(null);
			useEffect(() => {
				if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			}, [logs]);
			const done = result !== null;
			const ok = !!(result && result.ok);
			const toolName = tool === "gh" ? "GitHub CLI" : tool === "git" ? "Git" : "SSH";
			return h("div", { style: { position: "fixed", inset: 0, zIndex: 9999, background: T.mask, display: "flex", alignItems: "center", justifyContent: "center" } },
				h("div", { style: { width: 460, maxWidth: "92vw", background: T.layer1, border: "1px solid " + T.border, borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 10 } },
					h("div", { style: { fontSize: 14, fontWeight: 600, color: T.label } },
						(done ? (ok ? "✅ " : "❌ ") : "⏳ ") + toolName + " " + (done ? t("安装完成") : t("安装中…"))),
					h("div", { ref: scrollRef, style: { overflowY: "auto", maxHeight: 240, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 12, lineHeight: 1.7 } },
						logs.length === 0
							? h("div", { style: { color: T.secondary } }, "…")
							: logs.map((log, i) =>
								h("div", { key: i, style: { display: "flex", gap: 6, alignItems: "baseline" } },
									h("span", { style: { color: log.state === "running" ? T.brand : T.success } },
										log.state === "running" ? "▶" : "✓"),
									h("span", { style: { color: T.label, whiteSpace: "pre-wrap", wordBreak: "break-all" } },
										log.label + (log.tail ? " " + log.tail : "")),
								)
							)),
					done
						? ok
							? h("div", { style: { fontSize: 12, color: T.success, lineHeight: 1.6 } },
								t("安装完成") + (result.userLevel ? t("（已装到 ~/.local/bin，免 sudo）") : "") + t("，刷新网页即可生效"))
							: h("div", { style: { fontSize: 12, color: T.danger } },
								"❌ " + (result.error || t("安装失败")) + (result.command && !result.manual ? "：" + result.command : ""))
						: h("div", { style: { fontSize: 12, color: T.secondary } }, t("安装中，请稍候…")),
					h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
						h(Btn, { label: t("关闭"), onClick: onClose, tone: "ghost" })
					)
				)
			);
		}

		function EnvSection({ provider }) {
			// 平台来自 ②（ScmPanel 共享）：github 检查 GitHub CLI (gh)，gitee 检查 Gitee CLI (gitee)。
			const prov = provider || "github";
			const [env, setEnv] = useState(() => cache.env);
			const [err, setErr] = useState(null);
			const [msg, setMsg] = useState(null);
			const [installing, setInstalling] = useState(null); // 'git'|'gh'|'ssh'|null
			const [installResult, setInstallResult] = useState(null);
			const [installLogs, setInstallLogs] = useState([]); // [{label, state:'running'|'done', tail}]
			// 正在检查更新的工具（'gh'|'gitee'|null）：对应按钮显示「正在检查更新…」并禁用。
			const [checkingUpdate, setCheckingUpdate] = useState(null);
			// gh 下载源：'official'（官网）或 env.ghMirrors[].id（镜像）。默认镜像（国内网络
			// 下官网直连极慢）；ghSourceTouched 标记用户是否手动改过，避免每次刷新被重置。
			const [ghSource, setGhSource] = useState("official");
			const ghSourceTouched = useRef(false);
			const load = useCallback(async () => {
				setErr(null);
				// 先读缓存（DSH 打开时已预取），再后台刷新保持最新
				if (cache.env) setEnv(cache.env);
				try {
					const next = await refreshCache("env");
					setEnv(next);
					// env 到达后，若用户还没手动选过下载源，默认用第一个镜像（通常比官网快）。
					if (!ghSourceTouched.current && next && Array.isArray(next.ghMirrors) && next.ghMirrors.length > 0) {
						setGhSource(next.ghMirrors[0].id);
					}
				}
				catch (e) { setErr(String(e)); }
			}, []);
			useEffect(() => { void preload().then(load); }, [load]);

			// 一键安装：流式调用 host（NDJSON 进度事件），弹窗实时展示分步进度，成功后重新检测。
			// force=true：更新场景——即使已安装也重新执行安装逻辑（覆盖到最新版）。
			const doInstall = useCallback(async (tool, source, force) => {
				setInstalling(tool); setInstallResult(null); setInstallLogs([]);
				try {
					const r = await jpostStream("/install-tool", { tool, source, force: !!force }, (evt) => {
						if (evt.type === "step") {
							setInstallLogs((logs) => [
								...logs.map((l) => l.state === "running" ? { ...l, state: "done" } : l),
								{ label: evt.label, state: "running", tail: "" },
							]);
						} else if (evt.type === "out" && typeof evt.text === "string") {
							setInstallLogs((logs) => {
								if (logs.length === 0) return logs;
								const next = [...logs];
								const last = next[next.length - 1];
								next[next.length - 1] = { ...last, tail: (last.tail + evt.text).slice(-300) };
								return next;
							});
						}
					});
					setInstallResult(r);
					setInstallLogs((logs) => logs.map((l) => l.state === "running" ? { ...l, state: "done" } : l));
					if (r.ok) void load();
				} catch (e) { setInstallResult({ ok: false, tool, error: String(e) }); }
				finally { setInstalling(null); }
			}, [load]);

			// 检查 gh / gitee 更新：host 对比本地与官方最新版本；有更新则询问并复用安装流（force）覆盖更新。
			const checkUpdate = useCallback(async (tool) => {
				setErr(null); setMsg(null);
				setCheckingUpdate(tool);
				try {
					const r = await jpost("/check-update", { tool });
					if (!r || !r.ok) { setErr((r && r.error) || t("检查更新失败")); return; }
					if (!r.hasUpdate) { setMsg(t("已是最新版本（") + r.current + "）"); return; }
					const doIt = window.confirm(t("发现新版本：") + r.current + " → " + r.latest + t("，是否立即更新？"));
					if (!doIt) return;
					// 更新 = 按安装逻辑重新执行（gh 走用户级安装脚本+所选下载源，gitee 走官方安装脚本）。
					// 进度与结果由安装弹窗展示（成功/失败都清楚）。
					await doInstall(tool, tool === "gh" ? ghSource : undefined, true);
				} catch (e) { setErr(t("检查更新失败：") + e); }
				finally { setCheckingUpdate(null); }
			}, [doInstall, ghSource]);

			// 是否所有工具都就绪（git / CLI / ssh 均已安装；CLI 按平台：github=gh，gitee=gitee）
			// ——就绪时该部分默认折叠，只显示「① 环境检查」标题 + 「均存在」提示。
			const allPresent = !!(cache.env && cache.env.git && cache.env.git.installed
				&& cache.env.ssh && cache.env.ssh.installed
				&& (prov === "gitee"
					? (cache.env.gitee && cache.env.gitee.installed)
					: (cache.env.gh && cache.env.gh.installed)));
			const winOs = (env && env.platform === "win32");

			// gh 下载镜像列表（host 下发；Windows 为空 → 不显示下载源选择）。
			const ghMirrors = (env && Array.isArray(env.ghMirrors)) ? env.ghMirrors : [];

			// 渲染单个工具行；缺失时带安装命令 + 安装按钮（gh 另带「下载源」选择）。
			const toolRow = (tool, label, installed, version) => {
				// 优先用 host 返回的平台自适应命令（与「一键安装」同源）；
				// Windows 兜底用内置提示；非 Windows 且 host 未返回时留空（不误导）。
				const hint = (env && env.installHints && env.installHints[tool])
					|| (winOs ? INSTALL_HINTS[tool] : "")
				// 复制安装命令：gh 按当前所选下载源从 host 取同源命令；其余工具用 hint。
				const copyInstallCommand = async (e) => {
					e.stopPropagation();
					let text = hint;
					if (tool === "gh" && ghMirrors.length > 0) {
						try {
							const r = await jpost("/install-command", { tool: "gh", source: ghSource });
							if (r && typeof r.command === "string" && r.command !== "") text = r.command;
						} catch {}
					}
					void copyText(text);
				};
				const status = installed
					? h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
						h("span", { style: { color: T.label, fontSize: 13 } }, "✅ " + (version || t("已安装"))),
						// gh / gitee 已安装时提供「检查更新」（对比官方最新版本，有更新可一键按安装逻辑更新）。
						(tool === "gh" || tool === "gitee")
							? h("button", {
								type: "button",
								title: t("检查更新（对比官方最新版本）"),
								disabled: installing !== null || checkingUpdate !== null,
								style: { ...changeBtnStyle(), color: checkingUpdate === tool ? T.secondary : T.brand },
								onClick: (e) => { e.stopPropagation(); void checkUpdate(tool); },
							}, checkingUpdate === tool ? t("正在检查更新…") : t("检查更新"))
							: null
					)
					: h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
						h("span", { style: { color: T.danger, fontSize: 13 } }, t("❌ 未安装")),
						h("button", { type: "button", title: t("复制安装命令"), disabled: installing !== null, style: changeBtnStyle(), onClick: copyInstallCommand }, t("复制安装命令")),
						h("button", { type: "button", title: t("一键安装（会自动选包管理器）"), disabled: installing !== null, style: { ...changeBtnStyle(), color: T.brand, fontWeight: 600 }, onClick: (e) => { e.stopPropagation(); void doInstall(tool, tool === "gh" ? ghSource : undefined); } }, installing === tool ? t("安装中…") : t("安装"))
					)
				// gh 且未安装时：显示「下载源」下拉（官网直连可能极慢，镜像更快）。
				const sourcePicker = (tool === "gh" && !installed && ghMirrors.length > 0)
					? h("div", { style: { marginTop: 4, display: "flex", alignItems: "center", gap: 6, fontSize: 12 } },
						h("span", { style: { color: T.secondary, flexShrink: 0 } }, t("下载源")),
						h("select", {
							value: ghSource,
							onChange: (e) => { ghSourceTouched.current = true; setGhSource(e.target.value); },
							title: t("选择下载源：官网直连在国内网络可能很慢；镜像走加速代理（gh-proxy.com 实测最快）。"),
							style: { font: "inherit", fontSize: 12, padding: "2px 6px", border: "1px solid " + T.border, borderRadius: 6, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
						},
							h("option", { value: "official" }, t("官网（慢）")),
							ghMirrors.map((m) => h("option", { key: m.id, value: m.id }, m.id + (m.note ? "（" + m.note + "）" : "")))
						)
					)
					: null
				const feedback = installResult && installResult.tool === tool
					? (installResult.started
						? h("div", { style: { marginTop: 4, color: T.secondary, fontSize: 12 } }, "⏳ " + (installResult.error || ""))
						: installResult.ok
						? h("div", { style: { marginTop: 4, color: T.success, fontSize: 12 } }, "✅ " + (installResult.command || t("已安装")) + t(" 执行成功") + (installResult.userLevel ? t("（已装到 ~/.local/bin，免 sudo）") : "") + (installResult.needElevation ? t("（如未生效需以管理员身份重试）") : "") + t("，刷新网页即可生效"))
						: h("div", { style: { marginTop: 4, color: T.danger, fontSize: 12 } }, "❌ " + (installResult.error || t("安装失败")) + (installResult.command && !installResult.manual ? "：" + installResult.command : "")))
					: null
				return h("div", { key: tool, style: { marginTop: 4 } },
					h(Field, { label }, status),
					sourcePicker,
					feedback
				)
			}

			const cliOk = prov === "gitee"
				? !!(env && env.gitee && env.gitee.installed)
				: !!(env && env.gh && env.gh.installed);
			const missingAny = !env || !env.git || !env.ssh
				|| !env.git.installed || !env.ssh.installed || !cliOk;
			return h(Box, { title: t("① 环境检查"), badge: allPresent ? t("✅ 均存在") : null, defaultCollapsed: !!allPresent },
				h(Field, { label: t("操作系统") }, h("span", { style: { color: T.label, fontSize: 13 } }, env ? (env.platformLabel || env.platform) : "...")),
				env ? h(React.Fragment, null,
					toolRow("git", "Git", env.git.installed, env.git.version),
					prov === "gitee"
						? toolRow("gitee", "Gitee CLI", !!(env.gitee && env.gitee.installed), env.gitee && env.gitee.installed ? env.gitee.version : null)
						: toolRow("gh", "GitHub CLI", env.gh.installed, env.gh.version),
					toolRow("ssh", "SSH", !!(env.ssh && env.ssh.installed), env.ssh && env.ssh.installed ? t("已找到") : null)
				) : h(Field, { label: t("检测中"), value: err ? t("失败: ") + err : "…" }),
				// 检查更新结果提示（已是最新版本等）
				msg ? h("div", { style: { marginTop: 6, color: T.success, fontSize: 12 } }, "✅ " + msg) : null,
				// 有缺失时同样提供「重新检查」按钮（手动安装 / 刷新后无需重启，点此重新检测）。
				missingAny ? h("div", { style: { marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: T.secondary, lineHeight: 1.6 } },
					h("span", { style: { flex: "1 1 260px" } },
						t("未找到的工具可用上方「安装」按钮一键安装（") + (winOs ? t("Windows 用 winget / 内置功能") : t("用系统包管理器")) + t("，可能需管理员权限）；也可手动复制安装命令执行，安装后点「重新检查」。")),
					h(Btn, { label: t("重新检查"), onClick: load, tone: "ghost" })
				) : h("div", { style: { marginTop: 8, display: "flex", justifyContent: "flex-end" } },
					h(Btn, { label: t("重新检查"), onClick: load, tone: "ghost" })
				),
				installing !== null ? h(InstallDialog, { tool: installing, logs: installLogs, result: installResult, onClose: () => { setInstalling(null); } }) : null
			);
		}

		// ---------- section 2: SSH ----------
		function SshSection({ provider, setProvider }) {
			const [ssh, setSsh] = useState(() => cache.ssh);
			// env（判断 Gitee CLI 是否已安装；数据由 ① 预取/刷新维护，这里只读缓存）
			const [env, setEnv] = useState(() => cache.env);
			const [busy, setBusy] = useState(false);
			const [loginBusy, setLoginBusy] = useState(false);
			const [giteeLoginBusy, setGiteeLoginBusy] = useState(false);
			const [msg, setMsg] = useState(null);
			const [err, setErr] = useState(null);
			// Gitee 登录状态（仅 gitee 模式显示）：令牌是否配置 + 账号。
			// 令牌本身在 ③ 代码管理里配置，这里只读状态（未配置时提示去 ③）。
			const [giteeConfigured, setGiteeConfigured] = useState(null); // null=未加载
			const [giteeOwnerName, setGiteeOwnerName] = useState("");
			// 平台状态由 ScmPanel 共享（②里选择，③跟随）
			const prov = provider || "github";
			const setProv = setProvider || (() => {});
			// ② 默认折叠；在标题行也能切平台，切换时自动展开（因为要做后续配置）。
			const [collapsed, setCollapsed] = useState(true);

			// ---- Gitee 登录状态：只读令牌是否已配置（与 ③ 共用 /gitee-token 存储）----
			const loadGiteeStatus = useCallback(async () => {
				try {
					const r = await jget("/gitee-token");
					setGiteeConfigured(!!r.configured);
					setGiteeOwnerName(r.owner || "");
				} catch { setGiteeConfigured(false); setGiteeOwnerName(""); }
			}, []);

			// 加载 SSH 状态；Gitee 模式一并刷新令牌登录状态（如已在 ③ 保存/清除令牌，
			// 回到 ② 点「重新检查」即同步）。prov 变化会重建 load 并重跑预取 effect。
			// 注意：load 必须先于所有依赖它的回调（ghLogin/giteeLogin/act）定义。
			const load = useCallback(async () => {
				setErr(null);
				if (cache.ssh) setSsh(cache.ssh);
				try { setSsh(await refreshCache("ssh")); }
				catch (e) { setErr(String(e)); }
				// 同步 env 缓存（Gitee CLI 是否已安装；env 数据由 ① 维护）
				if (cache.env) setEnv(cache.env);
				if (prov === "gitee") void loadGiteeStatus();
			}, [prov, loadGiteeStatus]);
			useEffect(() => { void preload().then(load); }, [load]);

			// gh 登录：gh auth login 是交互式的，host 端打开一个终端窗口让用户完成；
			// 完成后点「重新检查」刷新登录状态。
			const ghLogin = useCallback(async () => {
				setLoginBusy(true); setErr(null); setMsg(null);
				try {
					const r = await jpost("/gh/login", {});
					if (r && r.ok) setMsg(r.detail || t("登录窗口已打开，请在弹出的终端完成登录后点「重新检查」"));
					else setErr((r && (r.detail || r.error)) || t("登录失败"));
					void load();
				} catch (e) { setErr(t("登录失败：") + e); }
				finally { setLoginBusy(false); }
			}, [load]);

			// gitee 登录：官方 Gitee CLI 的 `gitee auth login`（交互式粘贴私人令牌），
			// host 打开终端完成；CLI 未安装时按钮不出现（提示去 ① 安装）。
			const giteeLogin = useCallback(async () => {
				setGiteeLoginBusy(true); setErr(null); setMsg(null);
				try {
					const r = await jpost("/gitee/login", {});
					if (r && r.ok) setMsg(r.detail || t("登录窗口已打开，请在弹出的终端完成登录后点「重新检查」"));
					else setErr((r && (r.detail || r.error)) || t("登录失败"));
					void load();
				} catch (e) { setErr(t("登录失败：") + e); }
				finally { setGiteeLoginBusy(false); }
			}, [load]);

			const act = useCallback(async (path, label, payload) => {
				setBusy(true); setMsg(null); setErr(null);
				try {
					const r = await jpost(path, payload);
					if (r.alreadyExists || r.alreadyConfigured) setMsg(label + t("：已存在，无需重复操作"));
					else if (r.ok) setMsg(label + t("成功"));
					else setErr(r.error || label + t("失败"));
					void load();
				} catch (e) { setErr(label + t("失败：") + e); }
				finally { setBusy(false); }
			}, [load]);

			// 依据所选平台判断各自的 SSH config 是否已配置
			const providerConfigured = prov === "gitee"
				? !!(ssh && ssh.sshGiteeConfigured)
				: !!(ssh && ssh.sshGitHubConfigured);
			const providerHost = prov === "gitee" ? "gitee.com" : "github.com";

			// 标题行的平台切换下拉：折叠时也可见、可交互；切换后自动展开（要做配置）。
			const titleExtra = h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 } },
				h("span", { style: { fontSize: 12, color: T.secondary } }, t("平台")),
				h("select", {
					value: prov,
					onChange: (e) => { setProv(e.target.value); setCollapsed(false); },
					title: t("选择代码托管平台：GitHub 或 Gitee（默认 GitHub），③代码管理会跟随切换"),
					style: { font: "inherit", fontSize: 12, padding: "3px 6px", border: "1px solid " + T.border, borderRadius: 6, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
				},
					h("option", { value: "github" }, t("GitHub（默认）")),
					h("option", { value: "gitee" }, "Gitee"),
				)
			);

			// Gitee 登录行：优先 Gitee CLI（gitee auth status）；CLI 未安装时提示去 ① 安装，
			// 并显示令牌兜底状态（Gitee API 仍需要私人令牌，可在 ③ 配置）。
			const renderGiteeLogin = () => {
				const cliInstalled = env ? !!(env.gitee && env.gitee.installed) : null; // null=env 未加载
				if (cliInstalled === null) return "…";
				if (!cliInstalled) {
					return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
						h("span", { style: { color: T.warn, fontSize: 13 } }, t("⚠️ 未安装 Gitee CLI")),
						h("span", { style: { color: T.secondary, fontSize: 12 } }, t("请在 ① 环境检查安装 Gitee CLI")),
						giteeConfigured === true
							? h("span", { style: { color: T.success, fontSize: 12 } }, t("（③ 已配置私人令牌）"))
							: h("span", { style: { color: T.secondary, fontSize: 12 } }, t("（Gitee API 仍需私人令牌，可在 ③ 配置）")),
						h(Btn, { label: t("重新检查"), onClick: load, tone: "ghost", noBg: true, disabled: busy })
					);
				}
				return ssh
					? (ssh.giteeLoggedIn
						? h("span", { style: { color: T.success, fontSize: 13 } }, "✅ " + (ssh.giteeAccount || t("已登录")) + t("（Gitee）"))
						: h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
							h("span", { style: { color: T.warn, fontSize: 13 } }, t("⚠️ 未登录")),
							h(Btn, { label: giteeLoginBusy ? t("执行中…") : t("登录 Gitee"), onClick: giteeLogin, tone: "primary", noBg: true, disabled: giteeLoginBusy || busy }),
							h(Btn, { label: t("复制登录命令"), onClick: () => { void copyText("gitee auth login"); setMsg(t("已复制：") + "gitee auth login"); }, noBg: true, disabled: giteeLoginBusy || busy }),
							h(Btn, { label: t("重新检查"), onClick: load, tone: "ghost", noBg: true, disabled: giteeLoginBusy || busy })
						))
					: "…";
			};

			return h(Box, {
				title: t("② SSH 密钥与连接"),
				defaultCollapsed: true,
				collapsed,
				onToggle: (v) => setCollapsed(v),
				titleExtra,
			},
				// key status（显示实际检测到的密钥名，可能不是 id_ed25519）
				h(Field, { label: t("密钥") }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (ssh.hasKey ? "✅ " + (ssh.keyBase || "id_ed25519") + t(" 已生成") : t("⚠️ 未生成")) : "…")
				),
				h(Field, { label: prov === "gitee" ? t("Gitee 登录") : t("GH 登录") },
					prov === "gitee"
						? renderGiteeLogin()
						: ssh
						? (ssh.ghLoggedIn
							? h("span", { style: { color: T.success, fontSize: 13 } }, "✅ " + (ssh.ghAccount || t("已登录")))
							: h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
								h("span", { style: { color: T.warn, fontSize: 13 } }, t("⚠️ 未登录")),
								h(Btn, { label: loginBusy ? t("执行中…") : t("登录 GitHub"), onClick: ghLogin, tone: "primary", noBg: true, disabled: loginBusy || busy }),
								h(Btn, { label: t("复制登录命令"), onClick: () => { void copyText("gh auth login"); setMsg(t("已复制：") + "gh auth login"); }, noBg: true, disabled: loginBusy || busy }),
								h(Btn, { label: t("重新检查"), onClick: load, tone: "ghost", noBg: true, disabled: loginBusy || busy })
							))
						: "…"
				),
				h(Field, { label: t("SSH 配置") }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (providerConfigured ? "✅ " + providerHost + t(" 已配置(443)") : t("⚠️ 未配置/限制 22 端口需配置")) : "…")
				),

				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 } },
					h(Btn, { label: t("生成密钥"), onClick: () => act("/gen-key", t("生成密钥")), disabled: busy }),
					h(Btn, { label: t("配置 SSH(config)"), onClick: () => act("/write-config", t("配置 SSH"), { provider: prov }), disabled: busy }),
					h(Btn, { label: t("测试连接"), onClick: async () => {
						setBusy(true); setErr(null); setMsg(null);
						try {
							const r = await jpost("/ssh-test", { provider: prov });
							if (r.connected) setMsg(t("SSH 连接成功（") + (prov === "gitee" ? "Gitee" : "GitHub") + "）：" + (r.account ? "Hi " + r.account : t("已认证")));
							else setErr(t("连接失败，请确认密钥已上传到 ") + (prov === "gitee" ? "Gitee" : "GitHub") + (prov === "gitee" ? t(" 或已配置 Gitee 令牌") : t(" 或已登录 gh")));
							void load();
						} catch (e) { setErr(t("测试失败：") + e); }
						finally { setBusy(false); }
					}, tone: "primary", noBg: true, disabled: busy }),
				),
				ssh && ssh.pubContent ? h("div", { style: { marginTop: 10 } },
					h("div", { style: { color: T.secondary, fontSize: 12, marginBottom: 4 } }, t("公钥（复制上传到 ") + (prov === "gitee" ? t("Gitee → 设置 → SSH 公钥") : "GitHub → Settings → SSH keys") + (prov === "gitee" ? "）：" : t("，或运行 gh auth login 自动上传）："))),
					h("code", { style: { display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, lineHeight: 1.5, color: T.secondary, background: T.layer1, padding: 10, borderRadius: 8 } }, ssh.pubContent)
				) : null,
				msg ? h("div", { style: { marginTop: 10, color: T.success, fontSize: 13 } }, "✅ " + msg) : null,
				err ? h("div", { style: { marginTop: 10, color: T.danger, fontSize: 13 } }, "❌ " + err) : null,
				(!ssh || ssh.gitHubNotConfigured) ? null : null
			);
		}

		// ---------- section 3: 代码管理 ----------
		function RepoSection({ provider, onGiteeTokenChange }) {
			// 平台（来自②，默认 GitHub），③随其切换检测/创建等逻辑
			const prov = provider || "github";
			const [dir, setDir] = useState(() => cache.defDir ?? "");
			const [dirDraft, setDirDraft] = useState(() => cache.defDir ?? "");
			const [repo, setRepo] = useState(() => cache.repo);
			const [busy, setBusy] = useState(false);
			// 「推送暂存」进行中标记：把已暂存的内容用填写的（或自动生成的）信息提交后推送。
			const [pushStagedBusy, setPushStagedBusy] = useState(false);
			// 刷新状态（联网同步）进行中的提示状态，避免刷新时界面闪成「未加载文件夹」。
			const [refreshing, setRefreshing] = useState(false);
			// 切换平台（② 里 GitHub/Gitee）时，③ 需要重新拉取对应平台的仓库状态；此标记在拉取期间为真，
			// 用于显示「切换平台，正在重新检测…」提示——避免保留原内容几秒而让用户以为没反应。
			const [switching, setSwitching] = useState(false);
			const [result, setResult] = useState(null);
			const [msg, setMsg] = useState(null);
			const [err, setErr] = useState(null);
			const [visibility, setVisibility] = useState("private");
			const [workspaces, setWorkspaces] = useState(() => cache.workspaces || []);
			// Gitee 令牌相关（仅在 prov==='gitee' 时显示/使用）
			const [giteeToken, setGiteeToken] = useState("");
			const [giteeConfigured, setGiteeConfigured] = useState(null); // null=未加载, true/false
			const [giteeOwnerName, setGiteeOwnerName] = useState("");
			const [giteeTokenMsg, setGiteeTokenMsg] = useState(null);
			const [giteeTokenErr, setGiteeTokenErr] = useState(null);
			const [giteeTokenBusy, setGiteeTokenBusy] = useState(false);
			// 自定义目录（用户手动选择的非 DSH 工作区，持久化于插件本地），用于给下拉项加 X 删除
			const [customDirs, setCustomDirs] = useState(() => cache.customDirs || []);
			// 详情弹窗：'changes'（改动文件列表）| 'sync'（同步差异）| 'branches'（分支切换）
			// | 'history'（提交历史）| null（关闭）
			const [detail, setDetail] = useState(null);
			// 改动详情里被展开显示 diff 的文件下标集合（点击文件名展开/收起内容）
			const [expandedDiffs, setExpandedDiffs] = useState(() => new Set());
			// 按需加载的 diff：{ [index]: { loading, diff, error } }，点开文件行时才请求 /repo-diff
			const [diffs, setDiffs] = useState({});
			// 提交信息输入框 + 暂存/取消暂存进行中标记
			const [commitMsg, setCommitMsg] = useState("");
			const [stageBusy, setStageBusy] = useState(false);
			// 分支切换弹窗数据 + 进行中标记
			const [branches, setBranches] = useState([]);
			const [branchCurrent, setBranchCurrent] = useState("");
			const [branchBusy, setBranchBusy] = useState(false);
			// 提交历史弹窗数据 + 进行中标记；historyDetail 存放某条 commit 的并排 diff
			const [commits, setCommits] = useState([]);
			const [commitsLoading, setCommitsLoading] = useState(false);
			const [historyBusy, setHistoryBusy] = useState(false);
			// historyDetail：{ hash, loading, diff, error }，点某提交时按需拉 /commit-diff
			const [historyDetail, setHistoryDetail] = useState(null);
			// 提交行右键/更多菜单：当前打开的 commit（hashFull）或 null
			const [commitMenu, setCommitMenu] = useState(null);
			// 复制成功的即时提示（菜单里短暂显示「已复制」）
			const [copiedTip, setCopiedTip] = useState(null);
			// 仓库名称强制 = 文件夹名（不允许手动填写）
			const repoName = (repo && repo.defaultRepoName) || "";
			// 目录选择器状态
			const [pickOpen, setPickOpen] = useState(false);
			const [pickPath, setPickPath] = useState("");
			const [pickErr, setPickErr] = useState(null);
			const [picking, setPicking] = useState(false);

			// 平台 ref：让各 useCallback（空依赖）能读取最新 provider，避免大量依赖改写
			const provRef = useRef(prov);
			provRef.current = prov;

			// 竞态保护：loadRepo 是异步的（await 网络），首次挂载的预加载请求可能与
			// 用户手动切换工作区/平台的请求并发。若旧请求后返回，会把它对应的目录
			// 内容（并 setDir 改回旧目录）覆盖到界面上，表现为「切换后过一会儿又跳回
			// 切换前的目录」。用自增 token 保证只有最新一次调用才允许写入状态。
			const loadSeq = useRef(0);

			// 可见性默认取值：优先用当前仓库的实际私有/公开状态；当该工作区没有远程
			// （属于当前账号/平台的远程、即即将新建的仓库）时，默认选「公开」。供
			// loadRepo 的各个返回路径（网络 / 快速缓存 / 预取秒显）统一调用。
			const syncVisibility = useCallback((r) => {
				if (r && r.repoExists === true && (r.visibility === "public" || r.visibility === "private")) {
					setVisibility(r.visibility);
				} else if (r && !r.hasRemote) {
					setVisibility("public");
				}
			}, []);

			const loadRepo = useCallback(async (d, keepRepo, full) => {
				// 注意：不能在这里无条件清空 err —— 操作回调（推送/拉取/对齐等）会先
				// setErr/setMsg 再调 loadRepo 刷新状态，此处清空会立刻抹掉刚设置的
				// 结果/错误提示，造成「点了按钮没有任何反馈」。需要清空 err 的调用方
				// （切换目录 / 切换平台 / 刷新状态）自行清空。
				// full=true 时才让 host 端执行 git fetch 联网同步（用于「刷新状态」及
				// 推送/拉取/对齐等操作后的刷新）；full 模式自动显示「刷新中…」提示，
				// 提示只在最新一次调用归来时关闭。**始终走网络获取最新仓库状态，绝不命中
				// 缓存秒显**——否则打开/重开/切换工作区会显示旧数据（如旧的「无改动」）。
				const doFull = full === true;
				const mySeq = ++loadSeq.current;
				if (doFull) setRefreshing(true);
				const dirty = !keepRepo;
				if (dirty) setRepo(null);
				const curProv = provRef.current || "github";
				try {
					const p = curProv;
					const r = await jget("/repo?dir=" + encodeURIComponent(d) + "&provider=" + encodeURIComponent(p) + (doFull ? "&full=1" : ""));
					// 竞态保护：若期间又发起了更新的 loadRepo（序列号更大），丢弃本次过期结果，
					// 避免旧请求后到时把界面刷回旧目录。
					if (mySeq !== loadSeq.current) return;
					setRepo(r);
					// 切换仓库/刷新后清空旧的改动 diff 缓存与展开状态，避免残留上一个目录的内容。
					setExpandedDiffs(new Set());
					setDiffs({});
					// 默认选中当前工作区：/repo 在未传 dir 时返回当前工作区路径，
					// 把返回的实际目录同步到输入框和当前选中目录。
					if (r && r.dir) {
						setDirDraft(r.dir);
						setDir(r.dir);
						cache.defDir = r.dir;
					}
					// 记录最新 repo 状态（仅作展示历史，绝不再用于「无刷新秒显」）。
					cache.repo = r;
					if (r && r.dir) cache.reposByDir[r.dir] = r;
					// 默认可见性：优先当前仓库实际状态；无远程（即将新建的仓库）默认「公开」。
					syncVisibility(r);
					// 后台预取本目录所有改动文件的 diff，点击「查看」时秒出。
					// 先清掉上次残留的缓存（文件集刚可能变化），再并发拉取。
					clearDiffCache(r && r.dir);
					if (!hasBetterSidebar) void prefetchDiffs(r && r.dir, r && r.changedFiles, 3);
					if (r && !r.isGitRepo) setErr(r.error || t("该目录不是 git 仓库"));
				} catch (e) { setErr(String(e)); }
				finally {
					// 只有本次是最新调用时才收起「刷新中…」提示，避免旧请求失败把提示提前关掉。
					if (doFull && mySeq === loadSeq.current) setRefreshing(false);
				}
			}, []);

			useEffect(() => {
				// 首次加载：只预取静态的 env/ssh/workspaces/默认目录；仓库状态一律在面板打开后
				// 通过 loadRepo(..., true) 联网获取最新（并显示「刷新中…」），绝不命中可能过期的
				// 缓存——这样关闭面板再打开、或切换工作区，都会重新同步，不会停留在旧的「无改动」。
				if (cache.workspaces && cache.workspaces.length) setWorkspaces(cache.workspaces);
				if (cache.customDirs && cache.customDirs.length) setCustomDirs(cache.customDirs);
				void preload().then(() => {
					if (cache.workspaces && cache.workspaces.length) setWorkspaces(cache.workspaces);
					if (cache.customDirs && cache.customDirs.length) setCustomDirs(cache.customDirs);
					const d = cache.defDir
						|| (cache.workspaces && cache.workspaces[0])
						|| dir || "";
					if (!d) return;
					setDir(d); setDirDraft(d);
					// 始终 full 同步（联网 fetch + 显示刷新中），获取当前工作区的最新状态。
					loadRepo(d, true, true);
				});
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			// ---- Gitee 令牌：查询/保存/清除（仅 gitee 模式使用）----
			const loadGiteeTokenStatus = useCallback(async () => {
				try {
					const r = await jget("/gitee-token");
					setGiteeConfigured(!!r.configured);
					setGiteeOwnerName(r.owner || "");
					setGiteeTokenMsg(null);
					setGiteeTokenErr(null);
				} catch (e) { setGiteeConfigured(false); setGiteeTokenErr(t("读取令牌状态失败：") + e); }
			}, []);

			const saveGiteeToken = useCallback(async () => {
				setGiteeTokenBusy(true); setGiteeTokenErr(null); setGiteeTokenMsg(null);
				try {
					const r = await jpost("/gitee-token", { token: giteeToken });
					if (r.ok) {
						setGiteeConfigured(true);
						setGiteeOwnerName(r.owner || "");
						setGiteeToken("");
						setGiteeTokenMsg(t("已保存 Gitee 令牌（账号：") + (r.owner || "？") + "）");
						// 令牌就绪后刷新仓库，让同名检测等按 Gitee 生效；并通知 ④ 克隆重新加载列表。
						loadRepo(dir || cache.defDir || "", true, true);
						if (typeof onGiteeTokenChange === "function") onGiteeTokenChange();
					} else {
						setGiteeConfigured(false);
						setGiteeTokenErr(r.error || t("保存令牌失败"));
					}
				} catch (e) { setGiteeConfigured(false); setGiteeTokenErr(t("保存令牌失败：") + e); }
				finally { setGiteeTokenBusy(false); }
			}, [giteeToken, dir, loadRepo]);

			const clearGiteeToken = useCallback(async () => {
				setGiteeTokenBusy(true); setGiteeTokenErr(null); setGiteeTokenMsg(null);
				try {
					const r = await jpost("/gitee-token", { clear: true });
					setGiteeConfigured(false);
					setGiteeOwnerName("");
					setGiteeToken("");
					setGiteeTokenMsg(r.ok ? t("已清除 Gitee 令牌") : t("清除失败"));
					loadRepo(dir || cache.defDir || "", true, true);
					if (typeof onGiteeTokenChange === "function") onGiteeTokenChange();
				} catch (e) { setGiteeTokenErr(t("清除令牌失败：") + e); }
				finally { setGiteeTokenBusy(false); }
			}, [dir, loadRepo]);

			// 从 Gitee CLI 导入已保存的令牌（gitee auth token → 本插件存储），
			// 免去手动复制粘贴（仅当 Gitee CLI 已安装且已登录时显示该按钮）。
			const importGiteeCliToken = useCallback(async () => {
				setGiteeTokenBusy(true); setGiteeTokenErr(null); setGiteeTokenMsg(null);
				try {
					const r = await jpost("/gitee/import-token", {});
					if (r.ok) {
						setGiteeConfigured(true);
						setGiteeOwnerName(r.owner || "");
						setGiteeTokenMsg(t("已从 Gitee CLI 导入令牌（账号：") + (r.owner || "？") + "）");
						loadRepo(dir || cache.defDir || "", true, true);
						if (typeof onGiteeTokenChange === "function") onGiteeTokenChange();
					} else {
						setGiteeConfigured(false);
						setGiteeTokenErr(r.error || t("导入失败"));
					}
				} catch (e) { setGiteeConfigured(false); setGiteeTokenErr(t("导入失败：") + e); }
				finally { setGiteeTokenBusy(false); }
			}, [dir, loadRepo]);

			// 平台切换：gitee 时读取令牌状态；无论切到哪都刷新仓库（跟随平台检测/显示）
			useEffect(() => {
				if (prov === "gitee") void loadGiteeTokenStatus();
				// 切换平台等同切换检测目标，清掉旧的错误提示，避免残留上一个平台的报错。
				setErr(null);
				if (dir || cache.defDir) {
					// 显示「切换平台，正在重新检测…」提示，避免切换后旧内容停留几秒看起来像没变化。
					setSwitching(true);
					loadRepo(dir || cache.defDir || "", true, true).finally(() => setSwitching(false));
				}
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [prov]);

			const push = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/push", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(t("已推送"));
					else setErr(r.error || r.pushError || t("推送失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("推送失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const pull = useCallback(async () => {
				// 「拉取更新」在“本地干净 + 远程有更新”状态出现：本地没有任何改动/提交，
				// reset --hard 不会丢失任何内容，因此直接复用「强制对齐」的实现
				// （git fetch + git reset --hard origin/<branch>），且无需弹确认框，
				// 等同于把本地快速前进到远程最新状态。
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/align", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(t("已拉取远程更新（本地已对齐到远程最新状态）"));
					else setErr(r.error || t("拉取失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("拉取失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const mergePush = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/merge-push", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(t("已拉取远程更新并推送更改"));
					else setErr(r.error || t("合并推送失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("合并推送失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const forcePush = useCallback(async () => {
				if (!window.confirm(t("强制推送会用本地版本覆盖远程仓库，远程上非本地的更改将被丢弃。确定继续？"))) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/force-push", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(t("已强制推送，远程已更新为本地状态"));
					else setErr(r.error || t("强制推送失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("强制推送失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const forcePull = useCallback(async () => {
				if (!window.confirm(t("强制拉取会把远程更新并入本地。如果本地有不想保留的内容，将按冲突处理或遗失。确定继续？"))) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/force-pull", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(t("已强制拉取远程更新"));
					else setErr(r.error || t("强制拉取失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("强制拉取失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const changeVisibility = useCallback(async () => {
				const name = (repo && repo.defaultRepoName) || "";
				if (!name) { setErr(t("请先加载一个有效的文件夹")); return; }
				const target = visibility === "public" ? "public" : "private";
				if (!window.confirm(t("确定把仓库 ") + name + t(" 改为「") + (target === "public" ? t("公开") : t("私有")) + t("」？修改可见性可能影响 Star、关注者等。"))) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/set-visibility", { dir: dir || undefined, name, visibility: target, provider: provRef.current || "github" });
					setResult(r);
					if (r.ok) setMsg(t("已把仓库设置为「") + (target === "public" ? t("公开") : t("私有")) + "」");
					else setErr(r.error || t("修改可见性失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("修改可见性失败：") + e); }
				finally { setBusy(false); }
			}, [dir, repo, visibility, loadRepo]);

			const create = useCallback(async () => {
				const name = (repo && repo.defaultRepoName) || "";
				if (!name) { setErr(t("请先加载一个有效的文件夹")); return; }
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/create", { dir: dir || undefined, name, visibility, provider: provRef.current || "github" });
					setResult(r);
					if (r.ok) setMsg(t("仓库已创建并推送：") + (r.url || name) + (r.provider === "gitee" ? "（Gitee）" : ""));
					else setErr(r.error || t("创建失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("创建失败：") + e); }
				finally { setBusy(false); }
			}, [dir, repo, visibility, loadRepo]);

			// 打开目录选择器，预填当前目录
			const openPicker = useCallback(() => {
				setPickPath(dir || cache.defDir || "");
				setPickErr(null);
				setPickOpen(true);
			}, [dir]);

			// 调用宿主原生文件夹选择对话框，回填路径
			const browseDir = useCallback(async () => {
				setPicking(true); setPickErr(null);
				try {
					const r = await jpost("/pick-dir", { initial: pickPath || cache.defDir || undefined });
					if (r.ok && r.dir) setPickPath(r.dir);
					else setPickErr(r.error || t("未选择目录"));
				} catch (e) { setPickErr(t("选择失败：") + e); }
				finally { setPicking(false); }
			}, [pickPath]);

			// 确认：持久化加入列表 + 加载
			const confirmPick = useCallback(async () => {
				const path = String(pickPath || "").trim();
				if (!path) { setPickErr(t("请输入或选择目录路径")); return; }
				setPicking(true); setPickErr(null);
				try {
					const r = await jpost("/add-workspace", { dir: path });
					if (r.ok) {
						if (Array.isArray(r.workspaces)) setWorkspaces(r.workspaces);
						if (Array.isArray(r.customDirs)) setCustomDirs(r.customDirs);
						setDir(r.dir); setDirDraft(r.dir);
						cache.defDir = r.dir;
						// 切换到新目录，清空上一个目录的操作结果/提示。
						setResult(null); setMsg(null); setErr(null);
						setPickOpen(false);
						loadRepo(r.dir, true, true);
					} else {
						setPickErr(r.error || t("添加目录失败"));
					}
				} catch (e) { setPickErr(t("添加目录失败：") + e); }
				finally { setPicking(false); }
			}, [pickPath, loadRepo]);

			const cancelPick = useCallback(() => {
				setPickOpen(false); setPickErr(null); setPickPath("");
			}, []);

			// 删除下拉中的自定义目录记录（只删记录，不删实际文件夹）
			const removeWorkspace = useCallback(async (path) => {
				setBusy(true); setErr(null);
				try {
					const r = await jpost("/remove-workspace", { dir: path });
					if (r.ok) {
						if (Array.isArray(r.workspaces)) setWorkspaces(r.workspaces);
						if (Array.isArray(r.customDirs)) setCustomDirs(r.customDirs);
						cache.workspaces = r.workspaces || cache.workspaces;
						cache.customDirs = r.customDirs || cache.customDirs;
						// 如果删除的是当前选中目录，清空选中并刷新为默认工作区
						if (dir === path) {
							const next = (r.workspaces && r.workspaces[0]) || "";
							setDir(next); setDirDraft(next);
							if (next) loadRepo(next, true, true); else setRepo(null);
						}
					} else {
						setErr(r.error || t("删除失败"));
					}
				} catch (e) { setErr(t("删除失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			// 强制对齐：本地完全重置为远程分支状态（丢弃本地差异）
			const align = useCallback(async () => {
				if (!window.confirm(t("强制对齐会用远程分支覆盖本地（丢弃本地未推送的更改与提交），确定继续？"))) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/align", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(t("已强制对齐到远程分支"));
					else setErr(r.error || t("强制对齐失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("强制对齐失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			// 只创建 git 仓库（不拉取不推送），由用户自行决定下一步
			const initGit = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/init-git", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(r.alreadyRepo ? t("已是 git 仓库") : t("已创建 git 仓库，请自行拉取或推送"));
					else setErr(r.error || t("创建 git 失败"));
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("创建 git 失败：") + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			// ---- 本地 Git 工作流：选择性暂存 / 提交 / 分支 / 历史 / revert / cherry-pick ----

			// 暂存某文件（path 空 = 全部），成功后刷新 repo 状态。
			const doStage = useCallback(async (path) => {
				setStageBusy(true); setErr(null);
				try {
					const r = await jpost("/stage", { dir: dir || undefined, path: path || undefined });
					if (r.ok) {
						// 暂存会改变文件的 staged 状态：清掉该目录的缓存快照，强制走网络路径
						// 重新拉取最新 repo（含最新「已暂存/未暂存」标记），并清 diff 展开状态。
						if (dir) delete cache.reposByDir[dir];
						loadRepo(dir, true, true);
					} else setErr(r.error || t("暂存失败"));
				} catch (e) { setErr(t("暂存失败：") + e); }
				finally { setStageBusy(false); }
			}, [dir, loadRepo]);

			// 取消暂存某文件（path 空 = 全部）。
			const doUnstage = useCallback(async (path) => {
				setStageBusy(true); setErr(null);
				try {
					const r = await jpost("/unstage", { dir: dir || undefined, path: path || undefined });
					if (r.ok) {
						if (dir) delete cache.reposByDir[dir];
						loadRepo(dir, true, true);
					} else setErr(r.error || t("取消暂存失败"));
				} catch (e) { setErr(t("取消暂存失败：") + e); }
				finally { setStageBusy(false); }
			}, [dir, loadRepo]);

			// 用自定义信息提交暂存区；成功后刷新并提示。
			const doCommit = useCallback(async () => {
				const name = repoName || (repo && repo.dir ? String(repo.dir).split(/[\\/]/).filter(Boolean).pop() : "");
				const message = commitMsg.trim() || ("chore: update " + name);
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/commit", { dir: dir || undefined, message });
					setResult(r);
					if (r.ok) {
						setMsg(t("已提交 ") + r.staged + t(" 个文件") + (r.hash ? "（" + r.hash + "）" : ""));
						setCommitMsg("");
						void loadRepo(dir, true, true);
					} else setErr(r.error || t("提交失败"));
				} catch (e) { setErr(t("提交失败：") + e); }
				finally { setBusy(false); }
			}, [dir, repo, commitMsg, repoName, loadRepo]);

			// 「推送暂存」：把已暂存的内容用填写的（或自动生成的）信息提交后推送远程。
			// 与「推送更改」不同：它只提交暂存区、沿用自定义信息，不自动 add 全部改动。
			const doPushStaged = useCallback(async () => {
				setPushStagedBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/push-staged", { dir: dir || undefined, message: commitMsg.trim() });
					setResult(r);
					if (r.ok) {
						const info = r.committed
							? t("已提交「") + (r.message || t("（自动生成）")) + t("」并推送") + (r.commitHash ? "（" + r.commitHash + "）" : "")
							: t("已推送本地已有的提交");
						setMsg(info);
						setCommitMsg("");
					} else setErr(r.error || r.pushError || t("推送失败"));
					// 推送成功后刷新状态（full 联网同步，显示「刷新中…」）。
					void loadRepo(dir, true, true);
				} catch (e) { setErr(t("推送失败：") + e); }
				finally { setPushStagedBusy(false); }
			}, [dir, commitMsg, loadRepo]);

			// 打开分支切换弹窗。
			const openBranches = useCallback(async () => {
				setDetail("branches"); setBranchBusy(true); setBranches([]);
				try {
					const r = await jpost("/branches", { dir: dir || undefined });
					if (r.ok) { setBranches(r.branches || []); setBranchCurrent(r.current || ""); }
					else setErr(r.error || t("读取分支失败"));
				} catch (e) { setErr(t("读取分支失败：") + e); }
				finally { setBranchBusy(false); }
			}, [dir]);

			// 切换到某分支。
			const doCheckout = useCallback(async (branch) => {
				if (branch === branchCurrent) { setDetail(null); return; }
				if (!window.confirm(t("切换到分支「") + branch + t("」？（若当前有未提交改动，git 会拒绝切换）"))) return;
				setBranchBusy(true); setMsg(null); setErr(null);
				try {
					const r = await jpost("/checkout", { dir: dir || undefined, branch });
					if (r.ok) {
						setMsg(t("已切换到分支 ") + branch);
						setDetail(null);
						void loadRepo(dir, true, true);
					} else setErr(r.error || t("切换分支失败"));
				} catch (e) { setErr(t("切换分支失败：") + e); }
				finally { setBranchBusy(false); }
			}, [dir, branchCurrent, loadRepo]);

			// 打开提交历史弹窗。
			const openHistory = useCallback(async () => {
				setDetail("history"); setCommitsLoading(true); setCommits([]); setHistoryDetail(null);
				try {
					const r = await jpost("/log", { dir: dir || undefined, count: 30 });
					if (r.ok) setCommits(r.commits || []);
					else setErr(r.error || t("读取历史失败"));
				} catch (e) { setErr(t("读取历史失败：") + e); }
				finally { setCommitsLoading(false); }
			}, [dir]);

			// 对某提交执行 revert（改写历史，需确认）。
			const doRevert = useCallback(async (hash, subject) => {
				if (!window.confirm(t("revert 提交「") + (subject || hash) + t("」——会生成一个反向提交，期间可能产生冲突，确定继续？"))) return;
				setHistoryBusy(true); setMsg(null); setErr(null);
				try {
					const r = await jpost("/revert", { dir: dir || undefined, hash });
					if (r.ok) {
						setMsg(t("已 revert 提交 ") + hash);
						setDetail(null);
						void loadRepo(dir, true, true);
					} else setErr(r.error || t("revert 失败"));
				} catch (e) { setErr(t("revert 失败：") + e); }
				finally { setHistoryBusy(false); }
			}, [dir, loadRepo]);

			// 对某提交执行 cherry-pick（改写历史，需确认）。
			const doCherryPick = useCallback(async (hash, subject) => {
				if (!window.confirm(t("cherry-pick 提交「") + (subject || hash) + t("」到当前分支——期间可能产生冲突，确定继续？"))) return;
				setHistoryBusy(true); setMsg(null); setErr(null);
				try {
					const r = await jpost("/cherrypick", { dir: dir || undefined, hash });
					if (r.ok) {
						setMsg(t("已 cherry-pick 提交 ") + hash);
						setDetail(null);
						void loadRepo(dir, true, true);
					} else setErr(r.error || t("cherry-pick 失败"));
				} catch (e) { setErr(t("cherry-pick 失败：") + e); }
				finally { setHistoryBusy(false); }
			}, [dir, loadRepo]);

			// 打开某提交的并排 diff（复用 /commit-diff）。
			const openCommitDiff = useCallback(async (hash) => {
				if (historyDetail && historyDetail.hash === hash) { setHistoryDetail(null); return; }
				setHistoryDetail({ hash, loading: true, diff: "", error: null });
				try {
					const r = await jpost("/commit-diff", { dir: dir || undefined, hash });
					setHistoryDetail({ hash, loading: false, diff: (r && r.diff) || "", error: r && !r.ok ? (r.error || t("读取失败")) : null });
				} catch (e) {
					setHistoryDetail({ hash, loading: false, diff: "", error: String(e) });
				}
			}, [dir, historyDetail]);

			// 复制提交相关信息（短哈希 / 完整哈希 / 提交信息），成功后短暂提示并关闭菜单。
			const copyCommit = useCallback(async (kind, commit) => {
				let text = "";
				if (kind === "short") text = commit.hash;
				else if (kind === "full") text = commit.hashFull;
				else text = commit.subject || "";
				const ok = await copyText(text);
				setCommitMenu(null);
				if (ok) {
					setCopiedTip(t("已复制") + (kind === "short" ? t("短哈希") : kind === "full" ? t("完整哈希") : t("提交信息")));
					window.setTimeout(() => setCopiedTip(null), 1600);
				} else {
					setErr(t("复制失败：请手动复制"));
				}
			}, []);

			// Gitee CLI 是否已安装且已登录（决定「从 Gitee CLI 导入」按钮显隐；
			// 数据来自 ①/② 的预取缓存，重新检查后更新）。
			const cliLoggedIn = !!(cache.ssh && cache.ssh.giteeLoggedIn
				&& cache.env && cache.env.gitee && cache.env.gitee.installed);

			return h(Box, { title: t("③ 代码管理") },
				// 平台提示 + Gitee 令牌（仅 gitee 模式）
				prov === "gitee" ? h("div", { style: { border: "1px solid " + T.border, borderRadius: 10, padding: 10, marginBottom: 10, background: T.layer1 } },
					h("div", { style: { fontSize: 12, fontWeight: 600, color: T.label, marginBottom: 6 } },
						t("Gitee 私人令牌（OpenAPI，需 projects 权限）")),
					giteeConfigured === true
						? h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
							h("span", { style: { color: T.success, fontSize: 12 } }, t("✅ 已配置") + (giteeOwnerName ? t("（账号 ") + giteeOwnerName + "）" : "")),
							h(Btn, { label: t("清除令牌"), onClick: clearGiteeToken, disabled: giteeTokenBusy, noBg: true, tone: "danger" })
						)
						: h("div", null,
							h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
								h("input", {
									type: "password", value: giteeToken, disabled: giteeTokenBusy,
									placeholder: t("粘贴 Gitee 私人令牌（https://gitee.com/personal_access_tokens）"),
									onChange: (e) => setGiteeToken(e.target.value),
									onKeyDown: (e) => { if (e.key === "Enter") void saveGiteeToken(); },
									style: { flex: 1, minWidth: 200, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))", color: T.label, outline: "none" },
								}),
								h(Btn, { label: t("保存令牌"), onClick: saveGiteeToken, tone: "primary", noBg: true, disabled: giteeTokenBusy || !String(giteeToken || "").trim() }),
								// Gitee CLI 已登录时：一键把 CLI 保存的令牌导入本插件，无需手动复制。
								cliLoggedIn ? h(Btn, { label: t("从 Gitee CLI 导入"), onClick: importGiteeCliToken, noBg: true, disabled: giteeTokenBusy }) : null,
							),
							h("div", { style: { fontSize: 11, color: T.secondary, marginTop: 6, lineHeight: 1.6 } },
								t("令牌只保存在本机 ~/.dsh/storages（0600），不会写进插件目录；需勾选个人令牌的 projects 权限。公钥需已上传到 Gitee（② 里检查）。"))
						),
					giteeTokenMsg ? h("div", { style: { marginTop: 6, color: T.success, fontSize: 12 } }, "✅ " + giteeTokenMsg) : null,
					giteeTokenErr ? h("div", { style: { marginTop: 6, color: T.danger, fontSize: 12 } }, "❌ " + giteeTokenErr) : null
				) : null,
				h("div", { style: { display: "flex", gap: 8, marginBottom: 10, alignItems: "center" } },
					h("span", { style: { color: T.secondary, fontSize: 13, whiteSpace: "nowrap" } }, t("选择工作区")),
					h("select", {
						value: dir,
						disabled: workspaces.length === 0,
						onChange: (e) => {
							const v = e.target.value;
							if (!v) return;
							// 切换工作区时清空上一个工作区的操作结果/提示。
							setResult(null); setMsg(null); setErr(null);
							setDir(v);
							setDirDraft(v);
							// full 同步：联网获取切换后工作区的最新状态，并显示「刷新中…」。
							loadRepo(v, true, true);
						},
						title: t("选择 DSH 已登记的工作区文件夹"),
						style: { flex: 1, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
					},
						workspaces.length === 0 ? h("option", { key: "__empty", value: "" }, t("（暂无可选工作区）"))
							: h("option", { key: "__none", value: "" }, t("— 请选择 —")),
						workspaces.map((w) =>
							h("option", { key: w, value: w }, String(w).split(/[\\/]/).filter(Boolean).pop() || w)
						)
					),
					h(Btn, { label: t("选择目录"), onClick: openPicker, disabled: picking, noBg: true, tone: "primary" }),
				),
				dir && customDirs && customDirs.includes(dir) ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10, alignItems: "center" } },
					h("span", { style: { color: T.secondary, fontSize: 12, whiteSpace: "nowrap" } }, t("自定义目录：")),
					h("span", { key: dir, style: { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", border: "1px solid " + T.border, borderRadius: 12, fontSize: 12, background: T.layer1, color: T.label, cursor: "pointer" }, title: dir, onClick: () => { setResult(null); setMsg(null); setErr(null); setDir(dir); setDirDraft(dir); loadRepo(dir, true, true); } },
						String(dir).split(/[\\/]/).filter(Boolean).pop() || dir,
						h("span", {
							role: "button", "aria-label": t("删除该目录记录"),
							title: t("删除该目录记录（不删除实际文件夹）"),
							onClick: (e) => { e.stopPropagation(); void removeWorkspace(dir); },
							style: { color: T.danger, fontWeight: 700, padding: "0 2px", cursor: "pointer" },
						}, "✕")
					)
				) : null,
				repo && repo.isGitRepo ? h("div", { style: { marginBottom: 10 } },
					h(Field, { label: t("目录"), value: repo.dir }),
					h(Field, { label: t("分支") }, h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
						h("span", { style: { color: T.label, fontSize: 13 } }, repo.branch || t("（无）")),
						!hasBetterSidebar ? h(React.Fragment, null,
							repo.branch ? h("button", {
								type: "button",
								onClick: openBranches,
								title: t("切换分支"),
								style: changeBtnStyle(),
							}, t("切换")) : null,
							h("button", {
								type: "button",
								onClick: openHistory,
								title: t("查看提交历史"),
								style: changeBtnStyle(),
							}, t("历史"))
						) : null
					)),
					h(Field, { label: t("远程"), value: repo.remoteUrl || t("（无）") }),
					h(Field, { label: t("改动") }, h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
						h("span", { style: { color: T.label, fontSize: 13 } }, repo.dirty ? repo.dirtyCount + t(" 个文件") : t("无")),
						repo.changedFiles && repo.changedFiles.length > 0 ? h("button", {
							type: "button",
							onClick: () => setDetail("changes"),
							title: t("查看改动的文件列表"),
							style: changeBtnStyle(),
						}, t("查看"))
							: null
					)),
					h(Field, { label: t("同步") }, h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
						h("span", { style: { color: T.label, fontSize: 13 } },
							// 没有（属于当前账号/平台的）远程时不做同步判断，避免误显示「与远程一致」
							!repo.hasRemote
								? t("（无）")
								: (repo.ahead > 0 ? t("本地领先 ") + repo.ahead + t(" 提交") : "") +
								  (repo.ahead > 0 && repo.behind > 0 ? t("、落后 ") + repo.behind + t(" 提交") : (repo.behind > 0 ? t("落后 ") + repo.behind + t(" 提交") : "")) +
								  ((repo.ahead === 0 && repo.behind === 0) ? t("与远程一致") : "")
						),
						(repo.ahead > 0 || repo.behind > 0) ? h("button", {
							type: "button",
							onClick: () => setDetail("sync"),
							title: t("查看本地与远程的提交差异"),
							style: changeBtnStyle(),
						}, t("查看"))
							: null
					)),
					repo.ignoredLarge && repo.ignoredLarge.length > 0 ? h("div", { style: { marginTop: 8 } },
						h("div", { style: { color: T.warn, fontSize: 12, marginBottom: 4 } },
							t("⚠️ 以下 ") + repo.ignoredLarge.length + t(" 项 >100MB（超过 GitHub 限制，推送时将自动忽略不上传）：")),
						h("div", { style: { maxHeight: 120, overflow: "auto", background: T.layer1, borderRadius: 8, padding: 8 } },
							repo.ignoredLarge.slice(0, 30).map((f, i) =>
								h("div", { key: i, style: { fontSize: 11, color: T.secondary, lineHeight: 1.5 } },
									(f.kind === "dir" ? "📁 " + f.path + t("/（整个文件夹）") : "📄 " + f.path) +
									" — " + fmtMB(f.bytes))
							)
						)
					) : null,
				) : err ? h("div", { style: { color: T.warn, fontSize: 12, marginBottom: 8 } }, err) : null,

				(() => {
					// 状态机：根据本地是否有更改、远程是否有更新，动态显示按钮。
					const hasRemote = !!(repo && repo.hasRemote);
					const localChanges = hasRemote && ((repo.dirty && repo.dirtyCount > 0) || (repo.ahead > 0));
					const remoteUpdates = hasRemote && (repo.behind > 0);
					const isBlocked = busy || !dir;
					const btns = [];
					// 非 git 仓库但远程存在同名仓库 -> 只「创建 Git」（由用户决定后续拉取/推送）
					if (repo && !repo.isGitRepo && repo.repoExists === true) {
						btns.push(h(Btn, { key: "init", label: t("创建 Git"), onClick: initGit, tone: "primary", noBg: true, disabled: isBlocked, title: t("仅初始化 git 仓库，不拉取不推送，由你决定下一步") }));
					} else if (hasRemote) {
						if (localChanges && remoteUpdates) {
							// 本地和远程都有更新：原名展示「拉取更新并推送更改 / 强制推送 /
							// 强制拉取」三按钮，但这三种操作在此场景下容易因未提交改动、
							// 分支保护等原因失败且行为难预测，故不再展示——该状态唯一的
							// 操作按钮是「强制对齐」（fetch + reset --hard，本地完全重置为远程）。
							btns.push(h("span", { key: "both-note", style: { color: T.warn, fontSize: 12 } },
								t("本地有改动且远程有更新，可直接用「强制对齐」将本地重置为远程状态")));
							if (repo && repo.isGitRepo) {
								btns.push(h(Btn, { key: "align", label: t("强制对齐"), onClick: align, disabled: isBlocked, title: t("本地完全重置为远程分支（丢弃本地差异），解决“文件相同仍显示同步差异”的情况") }));
							}
						} else if (localChanges) {
							// 只有本地有更改 -> 只显示推送（正常 push）
							btns.push(h(Btn, { key: "push", label: t("推送更改"), onClick: push, tone: "primary", noBg: true, disabled: isBlocked || repo?.repoExists === false }));
						} else if (remoteUpdates) {
							// 只有远程有更新（本地干净）-> 只显示「拉取更新」。
							// 实现复用「强制对齐」逻辑（fetch + reset --hard）：本地干净
							// 无改动可丢，reset 等同快速前进到远程最新，直接执行不弹确认。
							btns.push(h(Btn, { key: "pull", label: t("拉取更新"), onClick: pull, disabled: isBlocked || repo?.repoExists !== true }));
						} else {
							// 完全同步 -> 无按钮，显示已是最新
							btns.push(h("span", { key: "synced", style: { color: T.success, fontSize: 13 } }, t("✓ 已是最新")));
						}
					}
					// 刷新/切换平台进行中给出明确提示，让用户知道正在联网同步或重新检测。
					const refreshingTip = refreshing
						? h("div", { style: { color: T.brand, fontSize: 12, marginTop: 8 } }, t("⟳ 正在刷新状态，联网同步 GitHub/Gitee 最新数据…"))
						: switching
						? h("div", { style: { color: T.brand, fontSize: 12, marginTop: 8 } }, t("⟳ 切换平台，正在重新检测「") + (prov === "gitee" ? "Gitee" : "GitHub") + t("」仓库状态…"))
						: null
					return h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
						btns,
						// 「推送暂存」：放在「推送更改」与「刷新状态」之间，按需显示——
						// 有远程且「本地领先有提交」或「有已暂存的改动」时才出现（未装 better-sidebar 时）。
						(!hasBetterSidebar && repo && repo.hasRemote
							&& (repo.ahead > 0 || ((repo.changedFiles || []).some((f) => f.staged)))) ? h(Btn, {
							key: "push-staged",
							label: pushStagedBusy ? t("推送中…") : t("推送暂存"),
							onClick: doPushStaged,
							tone: "primary", noBg: true,
							disabled: busy || pushStagedBusy || !dir,
							title: t("把已暂存的内容用填写的（或自动生成的）信息提交后推送到远程；不会自动暂存其他未暂存的改动"),
						}) : null,
						// keepRepo=true 保留旧内容避免闪烁；full=true 触发 loadRepo 的「刷新中…」提示 + 联网同步。
						h(Btn, {
							label: refreshing ? t("刷新中…") : t("刷新状态"),
							onClick: () => { setResult(null); setMsg(null); setErr(null); loadRepo(dir, true, true); },
							disabled: busy || refreshing,
						}),
						refreshingTip,
					);
				})(),
				// 提交信息输入框 + 「提交」（仅 git 仓库且有改动时、且未装 better-sidebar 时显示）。
				!hasBetterSidebar && repo && repo.isGitRepo && repo.dirty ? h("div", { style: { display: "flex", gap: 8, marginTop: 10, alignItems: "center" } },
					h("input", {
						type: "text", value: commitMsg,
						placeholder: t("提交信息（留空则用默认）"),
						title: t("填写提交信息后点「提交」；留空则自动生成（chore: update <文件夹名>）"),
						onChange: (e) => setCommitMsg(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") void doCommit(); },
						style: { flex: 1, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none" },
					}),
					h(Btn, { label: t("提交"), onClick: doCommit, tone: "primary", noBg: true, disabled: busy || stageBusy || repo.dirtyCount <= 0 || !dir }),
				) : null,
				h("div", { style: { display: "flex", gap: 8, marginTop: 10, alignItems: "center" } },
					h("input", {
						type: "text", value: repoName, readOnly: true,
						title: t("仓库名称自动取文件夹名（不可修改）"),
						placeholder: t("（未加载文件夹）"),
						style: { flex: 1, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "not-allowed", opacity: 0.85 },
					}),
					h("select", {
						value: visibility,
						onChange: (e) => setVisibility(e.target.value),
						title: t("仓库可见性：私有 / 公开") + (repo && repo.repoExists === true ? t("（修改当前仓库的可见性）") : ""),
						style: { font: "inherit", fontSize: 12, padding: "6px 8px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
					},
						h("option", { value: "private" }, t("私有")),
						h("option", { value: "public" }, t("公开"))
					),
					repo && repo.repoExists === true ? (
						// 仓库已存在：根据所选值与当前实际可见性决定按钮 / 提示
						repo.visibility === visibility ? h(Btn, {
							key: "create", label: t("新建仓库并推送"), onClick: create, tone: "success",
							disabled: true,
						}) : h(Btn, {
							key: "setvis", label: t("修改仓库状态"), onClick: changeVisibility, tone: "success",
							disabled: busy || !repoName || (prov === "gitee" && giteeConfigured !== true),
						})
					) : h(Btn, {
						key: "create", label: t("新建仓库并推送"), onClick: create, tone: "success",
						disabled: busy || !repoName || (prov === "gitee" && giteeConfigured !== true),
					})
				),
				// Gitee 未配令牌：新建/修改仓库走 OpenAPI，需先配令牌；仅推送已有仓库不受影响。
				(prov === "gitee" && giteeConfigured === false) ? h("div", { style: { marginTop: 6, fontSize: 12, color: T.warn } },
					t("未配置 Gitee 私人令牌，「新建仓库并推送」「修改仓库状态」暂不可用（仅推送/拉取已有仓库可用 SSH 公钥，无需令牌；令牌在下方配置后即可使用）")
				) : null,
				repo && repo.repoExists === true ? h("div", { style: { marginTop: 8, fontSize: 12 } },
					repo.visibility
						? (repo.visibility === visibility
							? h("span", { style: { color: T.success } }, t("✓ 仓库已是「") + (repo.visibility === "public" ? t("公开") : t("私有")) + t("」状态，如需修改请调整左侧可见性选择。"))
							: h("span", { style: { color: T.warn } }, t("将把仓库从「") + (repo.visibility === "public" ? t("公开") : t("私有")) + t("」改为「") + (visibility === "public" ? t("公开") : t("私有")) + t("」，点击「修改仓库状态」执行。")))
						: h("span", { style: { color: T.secondary } }, t("⚠️ 同名仓库已经创建（无法读取当前可见性，可能未") + (prov === "gitee" ? t("配置 Gitee 令牌") : t("登录 gh")) + "）")
				) : repo && repo.repoExists === false ? h("div", { style: { marginTop: 8, color: T.success, fontSize: 12 } },
					t("✓ 同名仓库 ") + repoName + t(" 不存在，可在 ") + (prov === "gitee" ? "Gitee" : "GitHub") + t("「新建仓库并推送」创建（可选私有/公开）。")
				) : null,

				result ? h("div", { style: { marginTop: 12, borderTop: "1px solid " + T.border, paddingTop: 10 } },
					msg ? h("div", { style: { color: T.success, fontSize: 13 } }, "✅ " + msg) : null,
					result.skipped && result.skipped.length > 0 ? h("div", { style: { marginTop: 8 } },
						h("div", { style: { color: T.warn, fontSize: 12, marginBottom: 4 } },
							t("已忽略未上传（") + result.skipped.length + t(" 项 >100MB）：")),
						result.skipped.map((s, i) => h("div", { key: i, style: { fontSize: 11, color: T.warn, lineHeight: 1.5 } }, "· " + s.path + " — " + s.reason)))
					: result.ok ? h("div", { style: { color: T.success, fontSize: 12, marginTop: 6 } },
						t("已提交") + (result.commitHash ? " " + result.commitHash : "") + (result.pushed ? t(" 并推送") : t("（推送省略）")))
					: err ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + err)
					: result.pushError ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + result.pushError)
					: null
				) : err ? h("div", { style: { marginTop: 10, color: T.danger, fontSize: 13 } }, "❌ " + err) : null,
				detail ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }, role: "presentation" },
						h("div", { style: { position: "absolute", inset: 0, background: T.mask }, "aria-hidden": "true", onClick: () => setDetail(null) }),
						h("div", { style: { position: "relative", zIndex: 1, width: detail === "changes" ? 700 : 520, maxWidth: "calc(100vw - 48px)", maxHeight: "calc(100vh - 100px)", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border, borderRadius: 14, padding: 18, color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))" }, role: "dialog", "aria-modal": "true", "aria-label": t("查看详情") },
							h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 } },
								h("div", { style: { fontSize: 15, fontWeight: 600, flex: 1 } },
									detail === "changes" ? t("改动文件")
										: detail === "branches" ? t("切换分支")
										: detail === "history" ? t("提交历史")
										: t("与远程同步差异")),
								h("button", { type: "button", style: closeBtnStyle(), "aria-label": t("关闭"), onClick: () => setDetail(null) }, "✕")
							),
							h("div", { style: { flex: 1, overflow: "auto" } },
								detail === "changes" ? h(React.Fragment, null,
									hasBetterSidebar ? h("div", { style: { marginBottom: 10, padding: "8px 10px", borderRadius: 8, background: T.layer1, color: T.secondary, fontSize: 12, lineHeight: 1.6 } },
										t("已安装 dsh-better-sidebar，此处只列改动文件列表；具体改动内容请到 dsh-better-sidebar 的「源代码管理面板」查看。"))
										: null,
									repo && repo.changedFiles && repo.changedFiles.length > 0
										? repo.changedFiles.map((f, i) => {
											// 未装 better-sidebar 才能展开 diff（装了它由它的 Git 面板负责，避免重复）。
											// viewable=false（二进制等无法按文本预览）不显示「查看」；
											// 其余文件（含 untracked 新文件）都可查看内容。
											const canHaveDiff = !hasBetterSidebar && f.viewable !== false
											const open = hasBetterSidebar ? false : expandedDiffs.has(i)
											const d = diffs[i] || {}
											const onClick = canHaveDiff ? async () => {
												const next = new Set(expandedDiffs)
												if (next.has(i)) { next.delete(i); setExpandedDiffs(next); return }
												next.add(i); setExpandedDiffs(next)
												// 优先用预取缓存（点击「查看」秒出）；未命中才按需请求并写入缓存。
												if (!diffs[i]) {
													const key = (repo.dir || "") + "\u0000" + f.path
													const cached = cache.diffs[key]
													// 命中且非失败标记（null=上次预取失败），才秒出；否则重新请求。
													if (cached !== undefined && cached !== null) {
														setDiffs(prev => ({ ...prev, [i]: { loading: false, diff: cached, error: null } }))
														return
													}
													setDiffs(prev => ({ ...prev, [i]: { loading: true, diff: '' } }))
													try {
														const r = await jget("/repo-diff?dir=" + encodeURIComponent(repo.dir || "") + "&path=" + encodeURIComponent(f.path))
														const diff = (r && r.diff) || ''
														cache.diffs[key] = diff
														setDiffs(prev => ({ ...prev, [i]: { loading: false, diff } }))
													} catch (e) {
														cache.diffs[key] = null
														setDiffs(prev => ({ ...prev, [i]: { loading: false, diff: '', error: String(e) } }))
													}
												}
											} : undefined
											return h("div", { key: i },
												h("div", {
													style: {
														display: "flex", gap: 8, alignItems: "center",
														fontSize: 13, lineHeight: 1.8,
														borderBottom: "1px solid " + T.border, padding: "3px 2px",
														cursor: canHaveDiff ? "pointer" : "default",
													},
													title: canHaveDiff ? (open ? t("点击收起") : t("点击查看改动内容")) : (f.viewable === false ? t("二进制文件，无法查看文本内容") : t("新文件（untracked）暂无内容 diff")),
													onClick: onClick,
												},
													h("span", { style: { color: typeColor(f.type), fontSize: 11, flexShrink: 0, width: 52 } }, typeLabel(f.type)),
													h("span", { style: { color: T.label, wordBreak: "break-all", flex: 1 } }, f.path),
													!hasBetterSidebar ? h(React.Fragment, null,
														h("span", { style: { fontSize: 11, flexShrink: 0, color: f.staged ? T.success : T.secondary } }, f.staged ? t("已暂存") : t("未暂存")),
														h("button", {
															type: "button",
															title: f.staged ? t("取消暂存") : t("暂存"),
															disabled: stageBusy,
															style: changeBtnStyle(),
															onClick: (e) => { e.stopPropagation(); if (f.staged) void doUnstage(f.path); else void doStage(f.path); },
														}, f.staged ? t("取消暂存") : t("暂存")),
														canHaveDiff ? h("span", { style: { color: T.brand, fontSize: 11, flexShrink: 0 } },
															d.loading ? t("加载中…") : (open ? t("▾ 收起") : t("▸ 查看")))
															: null
													) : null
												),
												open && canHaveDiff ? (
													d.loading ? h("div", { style: { fontSize: 12, color: T.secondary, padding: "4px 8px" } }, t("正在加载改动内容…"))
														: d.error ? h("div", { style: { fontSize: 12, color: T.danger, padding: "4px 8px" } }, "❌ " + d.error)
														: d.diff ? renderSideBySideDiff(d.diff)
														: f.type === 'untracked' ? h("div", { style: { fontSize: 12, color: T.secondary, padding: "4px 8px" } }, t("（空文件）"))
														: h("div", { style: { fontSize: 12, color: T.secondary, padding: "4px 8px" } }, t("（无内容差异）"))
												) : null
											);
										})
										: h("div", { style: { color: T.secondary, fontSize: 13 } }, t("当前没有改动。"))
								) : detail === "branches" ? (
									branchBusy ? h("div", { style: { color: T.secondary, fontSize: 13 } }, t("正在读取分支…"))
										: branches.length === 0 ? h("div", { style: { color: T.secondary, fontSize: 13 } }, t("（无分支）"))
										: branches.map((b) =>
											h("div", { key: b, style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 2px", borderBottom: "1px solid " + T.border } },
												h("span", { style: { flex: 1, color: b === branchCurrent ? T.success : T.label, fontSize: 13, fontWeight: b === branchCurrent ? 600 : 400 } },
													b + (b === branchCurrent ? t("（当前）") : "")),
												b !== branchCurrent ? h(Btn, { label: t("切换"), onClick: () => doCheckout(b), disabled: historyBusy || branchBusy, noBg: true, tone: "primary" }) : null
											)
										)
								) : detail === "history" ? (
									commitsLoading ? h("div", { style: { color: T.secondary, fontSize: 13 } }, t("正在读取历史…"))
										: commits.length === 0 ? h("div", { style: { color: T.secondary, fontSize: 13 } }, t("（暂无提交）"))
										: commits.map((c) => {
											const hd = historyDetail && historyDetail.hash === c.hash ? historyDetail : null
											const menuOpen = commitMenu === c.hashFull
											// 菜单项 hover 高亮。
											const hoverProps = () => ({
												onMouseEnter: (e) => { e.currentTarget.style.background = T.hover; },
												onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
											})
											return h("div", { key: c.hashFull, style: { borderBottom: "1px solid " + T.border, padding: "6px 2px", position: "relative" }, onContextMenu: (e) => { e.preventDefault(); setCommitMenu(c.hashFull); } },
												h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
													h("span", { style: { fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 12, color: T.brand, flexShrink: 0 } }, c.hash),
													h("span", { style: { flex: 1, color: T.label, fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, c.subject || ""),
													h("button", { type: "button", title: t("更多操作（右键也可打开）"), disabled: historyBusy, style: changeBtnStyle(), onClick: (e) => { e.stopPropagation(); setCommitMenu(menuOpen ? null : c.hashFull); } }, "⋯")
												),
												h("div", { style: { fontSize: 11, color: T.secondary, marginTop: 2 } },
													c.author + (c.date ? " · " + c.date : "")),
												menuOpen ? h("div", { style: menuPanelStyle() },
													h("div", { ...hoverProps(), style: menuItemStyle(), onClick: () => { setCommitMenu(null); openCommitDiff(c.hash); } },
														h("span", { style: { width: 16, fontSize: 11, textAlign: "center", color: T.secondary } }, "▸"), t("查看提交差异")),
													h("div", { ...hoverProps(), style: menuItemStyle(), onClick: () => copyCommit("short", c) },
														h("span", { style: { width: 16, fontSize: 11, textAlign: "center", color: T.secondary } }, "⧉"), t("复制短哈希")),
													h("div", { ...hoverProps(), style: menuItemStyle(), onClick: () => copyCommit("full", c) },
														h("span", { style: { width: 16, fontSize: 11, textAlign: "center", color: T.secondary } }, "⧉"), t("复制完整哈希")),
													h("div", { ...hoverProps(), style: menuItemStyle(), onClick: () => copyCommit("msg", c) },
														h("span", { style: { width: 16, fontSize: 11, textAlign: "center", color: T.secondary } }, "⧉"), t("复制提交信息")),
													h("div", { ...hoverProps(), style: menuItemStyle({ danger: true }), onClick: () => { setCommitMenu(null); doRevert(c.hash, c.subject); } },
														h("span", { style: { width: 16, fontSize: 11, textAlign: "center", color: T.danger } }, "↩"), t("还原此提交")),
													h("div", { ...hoverProps(), style: menuItemStyle({ danger: true }), onClick: () => { setCommitMenu(null); doCherryPick(c.hash, c.subject); } },
														h("span", { style: { width: 16, fontSize: 11, textAlign: "center", color: T.danger } }, "↪"), t("拾取此提交"))
												) : null,
												hd ? (
													hd.loading ? h("div", { style: { fontSize: 12, color: T.secondary, padding: "4px 8px" } }, t("正在加载提交 diff…"))
														: hd.error ? h("div", { style: { fontSize: 12, color: T.danger, padding: "4px 8px" } }, "❌ " + hd.error)
														: hd.diff ? renderSideBySideDiff(hd.diff) : h("div", { style: { fontSize: 12, color: T.secondary, padding: "4px 8px" } }, t("（无内容差异）"))
												) : null
											)
										})
								) : (
									h("div", null,
										repo && (repo.ahead > 0 || repo.behind > 0) ? h("div", null,
											repo.behind > 0 ? h("div", { style: { marginBottom: 10 } },
												h("div", { style: { color: T.warn, fontSize: 12, fontWeight: 600, marginBottom: 4 } }, t("本地落后 ") + repo.behind + t(" 个提交（远程有而本地没有）：")),
												repo.behindCommits && repo.behindCommits.length > 0
													? repo.behindCommits.map((c, i) => h("div", { key: i, style: { fontSize: 12, color: T.secondary, lineHeight: 1.7, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)" } }, c))
													: null
											) : null,
											repo.ahead > 0 ? h("div", null,
												h("div", { style: { color: T.brand, fontSize: 12, fontWeight: 600, marginBottom: 4 } }, t("本地领先 ") + repo.ahead + t(" 个提交（本地有而远程没有）：")),
												repo.aheadCommits && repo.aheadCommits.length > 0
													? repo.aheadCommits.map((c, i) => h("div", { key: i, style: { fontSize: 12, color: T.secondary, lineHeight: 1.7, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)" } }, c))
													: null
											) : null
										) : h("div", { style: { color: T.success, fontSize: 13 } }, t("✓ 已与远程同步，无差异。"))
									)
								)
							)
						)
					),
					document.body
				) : null,
				pickOpen ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }, role: "presentation" },
						h("div", { style: { position: "absolute", inset: 0, background: T.mask }, "aria-hidden": "true", onClick: cancelPick }),
						h("div", { style: { position: "relative", zIndex: 1, width: 480, maxWidth: "calc(100vw - 48px)", background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border, borderRadius: 14, padding: 18, color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))" }, role: "dialog", "aria-modal": "true", "aria-label": t("选择目录") },
							h("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, t("选择代码目录")),
							h("div", { style: { fontSize: 12, color: T.secondary, marginBottom: 8, lineHeight: 1.6 } },
								t("可手动输入/粘贴目录绝对路径，或点击「浏览…」弹出本地文件夹选择器。确认后将添加到下方下拉并记住，下次打开无需重新选择。")),
							h("input", {
								type: "text", value: pickPath, disabled: picking,
								placeholder: t("C:\\Users\\你的用户名\\项目目录"),
								onChange: (e) => setPickPath(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") void confirmPick(); },
								style: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: "8px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none" },
							}),
							pickErr ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + pickErr) : null,
							h("div", { style: { display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" } },
								h(Btn, { label: t("浏览…"), onClick: browseDir, disabled: picking, noBg: true }),
								h(Btn, { label: t("取消"), onClick: cancelPick, disabled: picking }),
								h(Btn, { label: t("确定"), onClick: confirmPick, tone: "primary", noBg: true, disabled: picking || !String(pickPath || "").trim() })
							)
						)
					),
					document.body
				) : null,
				copiedTip ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", top: 16, left: "50%", transform: "translateX(-50%)", zIndex: 2147483000, padding: "6px 14px", borderRadius: 8, fontSize: 13, color: "#fff", background: "var(--dsw-alias-state-success-primary, #22c55e)", boxShadow: "var(--dsw-overlay-shadow, 0 4px 12px rgba(0,0,0,.3))" } }, "✅ " + copiedTip),
					document.body
				) : null
			);
		}

		function fmtMB(bytes) {
			return (bytes / (1024 * 1024)).toFixed(1) + " MB";
		}

		/** Inline "查看" button style (small, quiet). */
		function changeBtnStyle() {
			return {
				appearance: "none", font: "inherit", cursor: "pointer",
				border: "1px solid " + T.border, borderRadius: 6,
				padding: "1px 8px", fontSize: 12, lineHeight: 1.6,
				background: "transparent", color: T.brand,
			};
		}

		/** Shared text input style for the new sections (④⑤). */
		function inputStyle() {
			return {
				flex: 1, minWidth: 0, font: "inherit", fontSize: 12,
				padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8,
				background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))",
				color: T.label, outline: "none",
			};
		}

		/** 提交行「更多操作」下拉面板样式（右对齐、向上弹出，避免在弹窗底部被裁）。 */
		function menuPanelStyle() {
			return {
				position: "absolute", right: 0, bottom: "calc(100% + 4px)", zIndex: 5,
				width: 180, padding: "4px 0",
				background: "var(--dsw-alias-bg-layer-3, #fff)",
				border: "1px solid " + T.border, borderRadius: 10,
				boxShadow: "var(--dsw-overlay-shadow, 0 8px 24px rgba(0,0,0,.3))",
			};
		}
		/** 下拉菜单单项样式。 */
		function menuItemStyle({ danger } = {}) {
			return {
				display: "flex", alignItems: "center", gap: 8,
				padding: "7px 12px", fontSize: 13, cursor: "pointer",
				color: danger ? T.danger : T.label,
			};
		}

		/** 复制文本到剪贴板（优先异步 Clipboard API，回退 execCommand）。 */
		function copyText(text) {
			const str = String(text == null ? "" : text);
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					return navigator.clipboard.writeText(str).then(() => true).catch(() => fallbackCopy(str));
				}
			} catch {}
			return Promise.resolve(fallbackCopy(str));
		}
		function fallbackCopy(str) {
			try {
				const ta = document.createElement("textarea");
				ta.value = str;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand("copy");
				ta.remove();
				return ok;
			} catch { return false; }
		}

		/** Localized label for a changed-file status type. */
		function typeLabel(type) {
			return { untracked: t("新增"), added: t("新增"), deleted: t("删除"), renamed: t("重命名"), modified: t("修改") }[type] || t("修改");
		}
		/** Color for a changed-file status type. */
		function typeColor(type) {
			return { untracked: T.success, added: T.success, deleted: T.danger, renamed: T.warn, modified: T.brand }[type] || T.label;
		}

		/**
		 * Render a unified git diff as colored lines: 删除行红色带 -，新增行绿色带 +，
		 * 其余（上下文/文件头/@@ 行）为灰色。逐行解析，保持 monospace 等宽。
		 */
		function renderDiff(diff) {
			if (!diff || typeof diff !== "string") return null;
			const lines = diff.replace(/\r\n/g, "\n").split("\n");
			if (lines.length && lines[lines.length - 1] === "") lines.pop();
			const out = [];
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				let color = T.secondary;
				if (line.startsWith("+") && !line.startsWith("+++")) color = T.success;
				else if (line.startsWith("-") && !line.startsWith("---")) color = T.danger;
				out.push(h("pre", { key: i, style: { margin: 0, padding: "0 6px", fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 12, lineHeight: 1.6, color, whiteSpace: "pre-wrap", wordBreak: "break-all", background: color === T.success ? "rgba(34,197,94,.10)" : color === T.danger ? "rgba(239,68,68,.10)" : "transparent" } }, line));
			}
			return h("div", { style: { background: "rgba(0,0,0,.06)", borderRadius: 8, padding: "6px 2px", margin: "4px 0 8px", maxHeight: 260, overflow: "auto" } }, out);
		}

		/**
		 * 把 unified diff 文本解析成「并排」行对（左=旧/删除，右=新/新增）。
		 * 按 `@@` 块 + `+`/`-`/` ` 前缀配对：删除行与新增行在同一行左右并排显示，
		 * 上下文行左右相同；`\ No newline at end of file` 与文件头（---/+++ /diff）跳过。
		 * @returns {Array<{ left: string|null, right: string|null, oldNo?: string, newNo?: string, type: 'del'|'add'|'ctx' }>}
		 */
		function parseUnifiedDiff(diff) {
			if (!diff || typeof diff !== "string") return [];
			const lines = diff.replace(/\r\n/g, "\n").split("\n");
			const rows = [];
			let oldNo = 0, newNo = 0;
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				// 跳过文件头 / 块头。
				if (line.startsWith("@@")) {
					const m = /-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?/.exec(line);
					if (m) { oldNo = parseInt(m[1], 10) || 1; newNo = parseInt(m[2], 10) || 1; }
					continue;
				}
				if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index ")) continue;
				if (line.startsWith("\\")) continue; // "\ No newline at end of file"
				const c = line.charAt(0);
				if (c === "-") {
					rows.push({ left: line.slice(1), right: "", type: "del", oldNo: oldNo++, newNo: "" });
				} else if (c === "+") {
					rows.push({ left: "", right: line.slice(1), type: "add", oldNo: "", newNo: newNo++ });
				} else if (c === " ") {
					rows.push({ left: line.slice(1), right: line.slice(1), type: "ctx", oldNo: oldNo++, newNo: newNo++ });
				} else {
					// 非 diff 行（如无前缀段）：当上下文处理。
					rows.push({ left: line, right: line, type: "ctx", oldNo: oldNo++, newNo: newNo++ });
				}
			}
			return rows;
		}

		/** 并排 diff 渲染器：删除行红底居左、新增行绿底居右，上下文两列相同。
		 *  没有删除行的 diff（新增/untracked 文件等，无旧版本）只显示「新版本」一列。 */
		function renderSideBySideDiff(diff) {
			const rows = parseUnifiedDiff(diff);
			if (rows.length === 0) return renderDiff(diff);
			const mono = { fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 12, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-all" };
			const cellBg = { del: "rgba(239,68,68,.12)", add: "rgba(34,197,94,.12)", ctx: "transparent" };
			const gutter = { ...mono, fontSize: 10, lineHeight: 1.55, color: T.secondary, textAlign: "right", padding: "0 6px", whiteSpace: "nowrap", wordBreak: "normal", opacity: 0.7 };
			// 新增文件没有旧版本：diff 中没有任何删除行时，隐藏「旧版本」列。
			const newOnly = !rows.some((r) => r.type === "del");
			return h("div", { style: { border: "1px solid " + T.border, borderRadius: 8, overflow: "hidden", margin: "4px 0 8px", maxHeight: 280, overflowY: "auto", background: "rgba(0,0,0,.04)" } },
				h("div", { style: { display: "flex", borderBottom: "1px solid " + T.border, position: "sticky", top: 0, background: "var(--dsw-alias-bg-layer-3, #fff)", zIndex: 1 } },
					newOnly ? null : h("div", { style: { flex: 1, padding: "3px 8px", fontSize: 12, fontWeight: 600, color: T.danger } }, t("旧版本")),
					h("div", { style: { flex: 1, padding: "3px 8px", fontSize: 12, fontWeight: 600, color: T.success } }, t("新版本"))
				),
				rows.map((r, i) =>
					h("div", { key: i, style: { display: "flex", background: cellBg[r.type] || "transparent", borderBottom: r.type === "ctx" ? "none" : "1px solid rgba(128,128,128,.1)" } },
						newOnly ? null : h("div", { style: { width: 34, flexShrink: 0, ...gutter } }, r.oldNo || ""),
						newOnly ? null : h("div", { style: { flex: 1, padding: "0 0 0 2px", color: r.type === "del" ? T.danger : T.label } }, h("pre", { style: { margin: 0, ...mono } }, r.left || " ")),
						h("div", { style: { width: 34, flexShrink: 0, ...gutter } }, r.newNo || ""),
						h("div", { style: { flex: 1, padding: "0 0 0 2px", color: r.type === "add" ? T.success : r.type === "del" ? "rgba(128,128,128,.6)" : T.label } }, h("pre", { style: { margin: 0, ...mono } }, r.right || " "))
					)
				)
			);
		}

		// ---------- section 4: 克隆远程仓库 ----------
		function CloneSection({ provider, setProvider, giteeTokenTick }) {
			// 跟随 ② 的平台（GitHub / Gitee），标题行也能切。
			const prov = provider || "github";
			const setProv = setProvider || (() => {});
			const [dir, setDir] = useState("");
			const [dirs, setDirs] = useState([]);       // 可选克隆目标目录（home + 工作区 + 自定义）
			const [repos, setRepos] = useState([]);     // 远程仓库列表
			const [loading, setLoading] = useState(false);
			const [busyName, setBusyName] = useState(null); // 正在克隆的仓库名
			const [msg, setMsg] = useState(null);
			const [err, setErr] = useState(null);
			// 按仓库地址克隆：地址输入 + 目标目录（默认空，用户选择）
			const [cloneUrl, setCloneUrl] = useState("");
			const [cloneBusy, setCloneBusy] = useState(false);
			// 目录选择器（同 ③：输入 / 浏览… 原生选择器 / 记住到自定义目录）
			const [pickOpen, setPickOpen] = useState(false);
			const [pickPath, setPickPath] = useState("");
			const [pickErr, setPickErr] = useState(null);
			const [picking, setPicking] = useState(false);

			// 初始：默认克隆目录（home）+ 工作区 + 自定义目录，回填 dir。
			const refreshDirs = useCallback(async () => {
				try {
					const [def, ws] = await Promise.all([
						jget("/clone/home").catch(() => null),
						jget("/workspaces").catch(() => null),
					]);
					const list = [];
					if (def && def.dir) { list.push(def.dir); if (!dir) setDir(def.dir); }
					if (ws) {
						if (Array.isArray(ws.workspaces)) for (const w of ws.workspaces) if (!list.includes(w)) list.push(w);
						if (Array.isArray(ws.customDirs)) for (const c of ws.customDirs) if (!list.includes(c)) list.push(c);
					}
					setDirs(list);
				} catch {}
			}, [dir]);
			useEffect(() => { void refreshDirs(); }, [refreshDirs]);

			// 拉取远程仓库列表（含本地存在标记）。
			// giteeTokenTick：③ 里保存/导入/清除 Gitee 令牌后 +1，触发重新加载——
			// 否则令牌配置前后 prov/dir 不变，列表会一直显示配置前的旧错误。
			const load = useCallback(async () => {
				setLoading(true); setErr(null);
				try {
					const r = await jget("/clone/repos?provider=" + encodeURIComponent(prov) + "&dir=" + encodeURIComponent(dir || ""));
					if (r && r.ok) { setRepos(r.repos || []); if (r.error) setErr(r.error); }
					else setErr((r && r.error) || t("加载失败"));
				} catch (e) { setErr(t("加载失败：") + e); }
				finally { setLoading(false); }
			}, [prov, dir, giteeTokenTick]);
			useEffect(() => { void load(); }, [load]);

			// 克隆单个仓库。
			const doClone = useCallback(async (repo) => {
				setBusyName(repo.name); setMsg(null); setErr(null);
				try {
					const r = await jpost("/clone/run", { url: repo.sshUrl || repo.htmlUrl || "", dest: dir, name: repo.name });
					if (r && r.ok) { setMsg(t("已克隆到 ") + r.dir); void load(); }
					else setErr((r && r.error) || t("克隆失败"));
				} catch (e) { setErr(t("克隆失败：") + e); }
				finally { setBusyName(null); }
			}, [dir, load]);

			// 按仓库地址克隆：从 URL 末段推导仓库名（去 .git 后缀），POST /clone/run。
			// 复用了顶部「克隆到目录」的 dir（含 选择目录… 记忆到自定义目录）。
			// cloneFlow 成功后会把目标目录记录到本地自定义目录，因此「目标位置已有」
			// 的知识会自动持久化，下次列表会标记本地已有。
			const doCloneUrl = useCallback(async () => {
				const u = String(cloneUrl || "").trim();
				if (!u) { setErr(t("请输入仓库地址")); return; }
				const dest = String(dir || "").trim();
				if (!dest) { setErr(t("请选择克隆到目录")); return; }
				// 提取仓库名：取 URL 末段，去掉尾部 .git
				const seg = u.replace(/\/+$/, "").split("/").pop() || "";
				const name = seg.replace(/\.git$/i, "").trim();
				if (!name) { setErr(t("无法从地址识别仓库名称")); return; }
				setCloneBusy(true); setMsg(null); setErr(null);
				try {
					const r = await jpost("/clone/run", { url: u, dest, name });
					if (r && r.ok) { setMsg(t("已克隆到 ") + r.dir); setCloneUrl(""); }
					else setErr((r && r.error) || t("克隆失败"));
				} catch (e) { setErr(t("克隆失败：") + e); }
				finally { setCloneBusy(false); }
			}, [cloneUrl, dir]);

			// 目录选择器交互（同 ③）：
			const openPick = useCallback(() => { setPickPath(dir || ""); setPickErr(null); setPickOpen(true); }, [dir]);
			const browseDir = useCallback(async () => {
				setPicking(true); setPickErr(null);
				try {
					const r = await jpost("/pick-dir", { initial: pickPath || dir || undefined });
					if (r.ok && r.dir) setPickPath(r.dir);
					else setPickErr(r.error || t("未选择目录"));
				} catch (e) { setPickErr(t("选择失败：") + e); }
				finally { setPicking(false); }
			}, [pickPath, dir]);
			const confirmPick = useCallback(async () => {
				const path = String(pickPath || "").trim();
				if (!path) { setPickErr(t("请输入或选择目录路径")); return; }
				setPicking(true); setPickErr(null);
				try {
					const r = await jpost("/add-workspace", { dir: path });
					if (r.ok) {
						setDir(path);
						if (Array.isArray(r.workspaces) || Array.isArray(r.customDirs)) {
							const list = [path];
							if (Array.isArray(r.workspaces)) for (const w of r.workspaces) if (!list.includes(w)) list.push(w);
							if (Array.isArray(r.customDirs)) for (const c of r.customDirs) if (!list.includes(c)) list.push(c);
							setDirs(list);
						}
						setPickOpen(false); setPickErr(null);
						setMsg(t("已记住目录") + "：" + path);
					} else {
						setPickErr(r.error || t("添加目录失败"));
					}
				} catch (e) { setPickErr(t("添加目录失败：") + e); }
				finally { setPicking(false); }
			}, [pickPath]);
			const cancelPick = useCallback(() => { setPickOpen(false); setPickErr(null); }, []);

			const titleExtra = h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 } },
				h("span", { style: { fontSize: 12, color: T.secondary } }, t("平台")),
				h("select", {
					value: prov,
					onChange: (e) => { setProv(e.target.value); },
					title: t("选择代码托管平台：GitHub 或 Gitee（默认 GitHub），③代码管理会跟随切换"),
					style: { font: "inherit", fontSize: 12, padding: "3px 6px", border: "1px solid " + T.border, borderRadius: 6, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
				},
					h("option", { value: "github" }, t("GitHub（默认）")),
					h("option", { value: "gitee" }, "Gitee"),
				)
			);

			return h(Box, { title: t("④ 克隆仓库"), defaultCollapsed: true, titleExtra },
				h("div", { style: { display: "flex", gap: 8, marginBottom: 8, alignItems: "center" } },
					h("span", { style: { color: T.secondary, fontSize: 12, whiteSpace: "nowrap" } }, t("克隆到目录")),
					h("select", {
						value: dir,
						onChange: (e) => setDir(e.target.value),
						style: { flex: 1, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
					},
						dirs.length === 0 ? h("option", { value: "" }, "…")
							: dirs.map((d) => h("option", { key: d, value: d }, d))
					),
					h(Btn, { label: t("选择目录…"), onClick: openPick, disabled: picking, noBg: true }),
					h(Btn, { label: loading ? t("加载中…") : t("刷新仓库列表"), onClick: load, disabled: loading, noBg: true, tone: "primary" }),
				),
				h("div", { style: { fontSize: 11, color: T.secondary, marginBottom: 8 } }, t("远程仓库列表") + "（" + (prov === "gitee" ? "Gitee" : "GitHub") + "）："),
				repos.length === 0
					? h("div", { style: { color: T.secondary, fontSize: 12, marginBottom: 8 } }, loading ? t("加载中…") : t("（暂无仓库）"))
					: h("div", { style: { maxHeight: 240, overflow: "auto", border: "1px solid " + T.border, borderRadius: 8, padding: 6, marginBottom: 8 } },
						repos.map((repo) =>
							h("div", { key: repo.fullName || repo.name, style: { display: "flex", alignItems: "center", gap: 8, padding: "5px 4px", borderBottom: "1px solid " + T.border } },
								h("div", { style: { flex: 1, minWidth: 0 } },
									h("div", { style: { display: "flex", alignItems: "center", gap: 6 } },
										h("span", { style: { color: T.label, fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, repo.name),
										repo.visibility === "public"
											? h("span", { style: { fontSize: 11, color: T.success, flexShrink: 0 } }, t("公开"))
											: h("span", { style: { fontSize: 11, color: T.warn, flexShrink: 0 } }, t("私有")),
									),
									repo.description ? h("div", { style: { color: T.secondary, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, repo.description) : null,
								),
								repo.local
									? h("span", { style: { fontSize: 12, color: T.success, flexShrink: 0 } }, t("本地已有"))
									: h(Btn, { label: busyName === repo.name ? t("克隆中…") : t("克隆"), onClick: () => doClone(repo), disabled: !!busyName || !dir, tone: "primary", noBg: true }),
							)
						)
					),
				// 按仓库地址克隆（支持任意 git 仓库地址，克隆到选择的位置）
				h("div", { style: { border: "1px solid " + T.border, borderRadius: 8, padding: 8, marginBottom: 8 } },
					h("div", { style: { fontSize: 11, color: T.secondary, marginBottom: 6 } }, t("也可以按仓库地址克隆到任意位置")),
					h("input", {
						type: "text", value: cloneUrl, disabled: cloneBusy,
						placeholder: t("仓库地址") + "（https://github.com/owner/repo 或 git@gitee.com:owner/repo.git）",
						onChange: (e) => setCloneUrl(e.target.value),
						onKeyDown: (e) => { if (e.key === "Enter") void doCloneUrl(); },
						style: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", marginBottom: 6 },
					}),
					h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
						h("div", { style: { fontSize: 11, color: T.secondary, whiteSpace: "nowrap" } }, t("克隆到")),
						h("input", { type: "text", value: dir, disabled: cloneBusy, placeholder: t("选择目录…"), onChange: (e) => setDir(e.target.value), style: { flex: 1, font: "inherit", fontSize: 12, padding: "5px 8px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none" } }),
						h(Btn, { label: t("选择目录…"), onClick: openPick, disabled: picking, noBg: true }),
						h(Btn, { label: cloneBusy ? t("克隆中…") : t("克隆"), onClick: () => void doCloneUrl(), disabled: cloneBusy || !String(dir || "").trim(), tone: "primary", noBg: true }),
					),
				),
				msg ? h("div", { style: { color: T.success, fontSize: 12 } }, "✅ " + msg) : null,
				err ? h("div", { style: { color: T.warn, fontSize: 12 } }, err) : null,
				pickOpen ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }, role: "presentation" },
						h("div", { style: { position: "absolute", inset: 0, background: T.mask }, "aria-hidden": "true", onClick: cancelPick }),
						h("div", { style: { position: "relative", zIndex: 1, width: 480, maxWidth: "calc(100vw - 48px)", background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border, borderRadius: 14, padding: 18, color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))" }, role: "dialog", "aria-modal": "true", "aria-label": t("选择目录") },
							h("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, t("选择代码目录")),
							h("div", { style: { fontSize: 12, color: T.secondary, marginBottom: 8, lineHeight: 1.6 } },
								t("可手动输入/粘贴目录绝对路径，或点击「浏览…」弹出本地文件夹选择器。确认后将添加到常用目录并记住，下次打开无需重新选择。")),
							h("input", {
								type: "text", value: pickPath, disabled: picking,
								placeholder: t("C:\\Users\\你的用户名\\项目目录"),
								onChange: (e) => setPickPath(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") void confirmPick(); },
								style: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: "8px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none" },
							}),
							pickErr ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + pickErr) : null,
							h("div", { style: { display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" } },
								h(Btn, { label: t("浏览…"), onClick: browseDir, disabled: picking, noBg: true }),
								h(Btn, { label: t("取消"), onClick: cancelPick, disabled: picking }),
								h(Btn, { label: t("确定"), onClick: confirmPick, tone: "primary", noBg: true, disabled: picking || !String(pickPath || "").trim() })
							)
						)
					),
					document.body
				) : null,
			);
		}

		

		// ---------- section 5: 发布 npm 包 ----------
		function NpmSection() {
			const [dir, setDir] = useState("");
			const [dirs, setDirs] = useState([]);
			const [status, setStatus] = useState(null);
			const [busyStep, setBusyStep] = useState(null);
			const [out, setOut] = useState({});
			const [confirmPublish, setConfirmPublish] = useState(false);
			const [loginBusy, setLoginBusy] = useState(false);
			const [msg, setMsg] = useState(null);
			const [err, setErr] = useState(null);
			// 目录选择器（同 ③/④：输入 / 浏览… / 记住到自定义目录）
			const [pickOpen, setPickOpen] = useState(false);
			const [pickPath, setPickPath] = useState("");
			const [pickErr, setPickErr] = useState(null);
			const [picking, setPicking] = useState(false);

			const refreshDirs = useCallback(async () => {
				try {
					const [def, ws] = await Promise.all([
						jget("/clone/default-dir").catch(() => null),
						jget("/workspaces").catch(() => null),
					]);
					const list = [];
					// ⑤ 目标目录默认留空，由用户手动选择（不复选默认目录）。
					if (def && def.dir) { if (!list.includes(def.dir)) list.push(def.dir); }
					if (ws) {
						if (Array.isArray(ws.workspaces)) for (const w of ws.workspaces) if (!list.includes(w)) list.push(w);
						if (Array.isArray(ws.customDirs)) for (const c of ws.customDirs) if (!list.includes(c)) list.push(c);
					}
					setDirs(list);
				} catch {}
			}, [dir]);
			useEffect(() => { void refreshDirs(); }, [refreshDirs]);

			const loadStatus = useCallback(async () => {
				try {
					if (!String(dir || "").trim()) { setStatus(null); return; }
					const r = await jget("/npm/status?dir=" + encodeURIComponent(dir || "")); if (r && r.ok) setStatus(r);
				}
				catch (e) { setErr(t("读取 npm 状态失败：") + e); }
			}, [dir]);
			useEffect(() => { void loadStatus(); }, [loadStatus]);

			const openLogin = useCallback(async () => {
				if (!String(dir || "").trim()) { setErr(t("请先选择目标目录")); return; }
				setLoginBusy(true); setErr(null); setMsg(null);
				try {
					const r = await jpost("/npm/login", { dir });
					if (r && r.ok) setMsg(r.detail || t("登录窗口已打开，请在弹出的终端完成登录后点「重新检查」"));
					else { setMsg(r && r.command ? t("请手动在终端运行：") + r.command : (r && r.detail) || t("打开终端失败")); }
				} catch (e) { setErr(t("发布失败：") + e); }
				finally { setLoginBusy(false); }
			}, [dir]);

			const runStep = useCallback(async (step) => {
				if (!String(dir || "").trim()) { setErr(t("请先选择目标目录")); return; }
				setBusyStep(step); setErr(null); setMsg(null);
				try {
					const r = await jpost("/npm/step", { dir, step });
					setOut((p) => ({ ...p, [step]: (r && r.output) || "" }));
					if (step === "publish") {
						if (r && r.ok) setMsg(t("发布完成"));
						else setErr((r && r.error) || t("发布失败"));
					}
				} catch (e) { setErr(t("发布失败：") + e); }
				finally { setBusyStep(null); }
			}, [dir]);

			// 目录选择器交互（同 ④）：
			const openPick = useCallback(() => { setPickPath(dir || ""); setPickErr(null); setPickOpen(true); }, [dir]);
			const browseDir = useCallback(async () => {
				setPicking(true); setPickErr(null);
				try {
					const r = await jpost("/pick-dir", { initial: pickPath || dir || undefined });
					if (r.ok && r.dir) setPickPath(r.dir);
					else setPickErr(r.error || t("未选择目录"));
				} catch (e) { setPickErr(t("选择失败：") + e); }
				finally { setPicking(false); }
			}, [pickPath, dir]);
			const confirmPick = useCallback(async () => {
				const path = String(pickPath || "").trim();
				if (!path) { setPickErr(t("请输入或选择目录路径")); return; }
				setPicking(true); setPickErr(null);
				try {
					const r = await jpost("/add-workspace", { dir: path });
					if (r.ok) {
						setDir(path);
						if (Array.isArray(r.workspaces) || Array.isArray(r.customDirs)) {
							const list = [path];
							if (Array.isArray(r.workspaces)) for (const w of r.workspaces) if (!list.includes(w)) list.push(w);
							if (Array.isArray(r.customDirs)) for (const c of r.customDirs) if (!list.includes(c)) list.push(c);
							setDirs(list);
						}
						setPickOpen(false); setPickErr(null);
						setMsg(t("已记住目录") + "：" + path);
					} else {
						setPickErr(r.error || t("添加目录失败"));
					}
				} catch (e) { setPickErr(t("添加目录失败：") + e); }
				finally { setPicking(false); }
			}, [pickPath]);
			const cancelPick = useCallback(() => { setPickOpen(false); setPickErr(null); }, []);

			const steps = [
				{ key: "registry", label: t("① 确认源（registry）") },
				{ key: "list", label: t("② 查看认证配置（config list）") },
				{ key: "whoami", label: t("③ 验证身份（whoami）") },
				{ key: "pack", label: t("④ 预览打包文件（pack --dry-run）") },
				{ key: "publish", label: t("⑤ 发布（publish）") },
			];

			return h(Box, { title: t("⑤ 发布 npm 包"), defaultCollapsed: true },
				h("div", { style: { fontSize: 11, color: T.secondary, marginBottom: 8 } }, t("发布 npm 包五步向导：确认源 → 认证配置 → 身份 → 打包预览 → 发布")),
				h("div", { style: { display: "flex", gap: 8, marginBottom: 8, alignItems: "center" } },
					h("span", { style: { color: T.secondary, fontSize: 12, whiteSpace: "nowrap" } }, t("目标目录（含 package.json）")),
					h("select", {
						value: dir,
						onChange: (e) => setDir(e.target.value),
						style: { flex: 1, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
					},
						dirs.length === 0 ? h("option", { value: "" }, "…")
							: dirs.map((d) => h("option", { key: d, value: d }, d))
					),
					h(Btn, { label: t("选择目录…"), onClick: openPick, disabled: picking, noBg: true }),
					h(Btn, { label: t("重新检查"), onClick: loadStatus, noBg: true, disabled: !String(dir || "").trim() }),
				),
				!String(dir || "").trim()
					? h("div", { style: { fontSize: 12, color: T.warn, marginBottom: 8 } }, "⚠️ " + t("请先选择目标目录（当前留空，不会自动使用默认目录）"))
					: null,
				status ? h("div", { style: { fontSize: 12, color: T.secondary, marginBottom: 8, lineHeight: 1.6 } },
					status.dirExists === false
						? h("div", { style: { color: T.danger } }, "❌ " + t("目录不存在：") + (status.dir || ""))
						: null,
					status.hasPackageJson === false
						? h("div", { style: { color: T.warn } }, "⚠️ " + t("该目录没有 package.json（请选择含 package.json 的包目录）"))
						: null,
					h("div", null, (status.installed ? "" : t("npm 未安装（请先在 ① 环境检查安装）") + " ") + (status.npmPath || "npm")),
					status.registry ? h("div", null, t("registry：") + status.registry) : null,
					status.publishRegistry ? h("div", { style: status.mirrorConfigured ? { color: T.warn } : { color: T.secondary } }, (status.mirrorConfigured ? "⚠️ " : "") + t("发布将使用官方源：") + status.publishRegistry) : null,
					status.whoami
						? h("div", { style: { color: T.success } }, t("已登录：") + status.whoami)
						: h("div", { style: { color: T.warn } }, "⚠️ " + (status.whoamiError || t("未登录 npm"))),
				) : null,
				status && status.installed && !status.whoami
					? h("div", { style: { border: "1px dashed " + T.border, borderRadius: 8, padding: 8, marginBottom: 8, background: T.layer1 } },
						h("div", { style: { fontSize: 12, color: T.warn, marginBottom: 6 } }, t("未登录 npm，发布前需先登录")),
						h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
							h(Btn, { label: loginBusy ? t("执行中…") : t("打开终端执行 npm login"), onClick: openLogin, disabled: loginBusy || !String(dir || "").trim(), tone: "primary", noBg: true }),
							h(Btn, { label: t("复制登录命令"), onClick: () => { void copyText("npm login --registry=https://registry.npmjs.org"); setMsg(t("已复制：") + "npm login --registry=https://registry.npmjs.org"); }, noBg: true }),
						),
					) : null,
				steps.map((s) =>
					h("div", { key: s.key, style: { marginBottom: 6 } },
						h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
							h(Btn, {
								label: busyStep === s.key ? t("执行中…") : t("执行"),
								onClick: () => runStep(s.key),
								disabled: !!busyStep || !dir || (s.key === "publish" && !confirmPublish),
								noBg: true, tone: s.key === "publish" ? "danger" : undefined,
							}),
							h("span", { style: { flex: 1, color: T.label, fontSize: 12 } }, s.label),
						),
						out[s.key] ? h("pre", { style: { marginTop: 4, whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 11, lineHeight: 1.5, color: T.secondary, background: T.layer1, borderRadius: 8, padding: 8, maxHeight: 160, overflow: "auto" } }, out[s.key]) : null,
					)
				),
				h("label", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6, fontSize: 12, color: T.label, cursor: "pointer" } },
					h("input", { type: "checkbox", checked: confirmPublish, onChange: (e) => setConfirmPublish(e.target.checked) }),
					t("我已核对以上内容，确认发布到 npm registry")
				),
				msg ? h("div", { style: { color: T.success, fontSize: 12, marginTop: 6 } }, "✅ " + msg) : null,
				err ? h("div", { style: { color: T.danger, fontSize: 12, marginTop: 6 } }, "❌ " + err) : null,
				pickOpen ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }, role: "presentation" },
						h("div", { style: { position: "absolute", inset: 0, background: T.mask }, "aria-hidden": "true", onClick: cancelPick }),
						h("div", { style: { position: "relative", zIndex: 1, width: 480, maxWidth: "calc(100vw - 48px)", background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border, borderRadius: 14, padding: 18, color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))" }, role: "dialog", "aria-modal": "true", "aria-label": t("选择目录") },
							h("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, t("选择代码目录")),
							h("div", { style: { fontSize: 12, color: T.secondary, marginBottom: 8, lineHeight: 1.6 } },
								t("可手动输入/粘贴目录绝对路径，或点击「浏览…」弹出本地文件夹选择器。确认后将添加到常用目录并记住，下次打开无需重新选择。")),
							h("input", {
								type: "text", value: pickPath, disabled: picking,
								placeholder: t("C:\\Users\\你的用户名\\项目目录"),
								onChange: (e) => setPickPath(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") void confirmPick(); },
								style: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: "8px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none" },
							}),
							pickErr ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + pickErr) : null,
							h("div", { style: { display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" } },
								h(Btn, { label: t("浏览…"), onClick: browseDir, disabled: picking, noBg: true }),
								h(Btn, { label: t("取消"), onClick: cancelPick, disabled: picking }),
								h(Btn, { label: t("确定"), onClick: confirmPick, tone: "primary", noBg: true, disabled: picking || !String(pickPath || "").trim() })
							)
						)
					),
					document.body
				) : null,
			);
		}

		// ---------- the main panel ----------
		// `variant` 决定布局：'drawer'（右侧栏集成面板，显示关闭按钮、填充容器）与 'tab'
		// （作为 dsh-better-sidebar 侧边栏 Tab 内容，填充容器、隐藏关闭按钮）。
		function ScmPanel({ onClose, variant }) {
			// 跟随 DSH 语言设置：切换语言时整个面板（①②③）实时重渲染。
			useLocale();
			// 代码托管平台选择在②里操作、在③里跟随：lift 到面板级别共享。
			const [provider, setProvider] = useState("github");
			// Gitee 令牌版本号：③ 保存/导入/清除令牌后 +1，④ 克隆据此重新加载远程列表
			// （否则令牌配置前后 prov/dir 都没变，④ 会一直显示配置前的旧错误）。
			const [giteeTokenTick, setGiteeTokenTick] = useState(0);
			const embedded = variant === "tab" || variant === "drawer";
			return h("div", { style: panelStyle(variant), role: "dialog", "aria-modal": embedded ? undefined : "true", "aria-label": t("源代码管理") },
				h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12 } },
					h("h2", { style: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.4, flex: 1 } }, t("源代码管理")),
					variant === "tab" ? null : h("button", { type: "button", style: closeBtnStyle(T), "aria-label": t("关闭"), onClick: onClose }, "✕")
				),
				h("p", { style: { margin: "6px 0 14px", color: T.secondary, fontSize: 12, lineHeight: 1.6 } },
					t("按顺序完成：①环境检查 → ②SSH 密钥与连接 → ③代码管理，以及 ④克隆仓库 / ⑤发布 npm 包。推送会自动忽略 >100MB 的文件（") + (provider === "gitee" ? "Gitee" : "GitHub") + t(" 限制）并说明原因。")),
				h(EnvSection, { provider }),
				h("div", { style: { height: 12 } }),
				h(SshSection, { provider, setProvider }),
				h("div", { style: { height: 12 } }),
				h(RepoSection, { provider, onGiteeTokenChange: () => setGiteeTokenTick((t) => t + 1) }),
				h("div", { style: { height: 12 } }),
				h(CloneSection, { provider, setProvider, giteeTokenTick }),
				h("div", { style: { height: 12 } }),
				h(NpmSection, null)
			);
		}

		function panelStyle(variant) {
			// 'tab' / 'drawer'：填充宿主容器（不设固定宽高、无边框阴影圆角），
			// 由外层（dsh-better-sidebar 的 Tab 区或本插件的右侧面板）负责尺寸与表面。
			if (variant === "tab" || variant === "drawer") {
				return {
					position: "relative", display: "flex", flexDirection: "column", gap: 4,
					width: "100%", maxWidth: "100%", height: "100%", maxHeight: "100%",
					boxSizing: "border-box", overflow: "auto",
					padding: variant === "tab" ? 16 : 20, borderRadius: 0,
					background: "transparent", border: "none", color: T.label,
				};
			}
			return {
				position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 4,
				width: 620, maxWidth: "calc(100vw - 48px)",
				maxHeight: "calc(100vh - 48px)", overflow: "auto",
				boxSizing: "border-box", padding: 24, borderRadius: 20,
				background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border,
				color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))",
			};
		}
		function closeBtnStyle() {
			return { appearance: "none", border: "none", background: "transparent", color: T.secondary, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 6px", borderRadius: 6 };
		}

		/** 注入的布局推挤样式（仅一次）：右侧面板展开时把 #root 往左推，形成「集成侧边栏」，
		 *  与 dsh-better-sidebar 右侧面板同一机制（margin + width calc）。 */
		const LAYOUT_CSS_ID = "source-code-mgmt-layout";
		let layoutCssInjected = false;
		function ensureLayoutCss() {
			if (layoutCssInjected) return;
			layoutCssInjected = true;
			const tag = document.createElement("style");
			tag.id = LAYOUT_CSS_ID;
			tag.setAttribute("data-source-code-mgmt-css", "");
			tag.textContent =
				// 推挤 #root：右侧面板占据布局而非浮在内容上方（VSCode 侧边栏手感），
				// 用 calc(100% - var) 避免桌面壳把 #root 设成 width:100% 时的加性溢出。
				"#root {" +
				" margin-right: var(--scm-push, 0px);" +
				" width: calc(100% - var(--scm-push, 0px));" +
				" transition: margin-right var(--ds-transition-duration-slow, .25s) var(--ds-ease-in-out, ease)," +
				" width var(--ds-transition-duration-slow, .25s) var(--ds-ease-in-out, ease);" +
				" }\n" +
				"body[data-source-code-mgmt-dragging] #root { transition: none; }\n" +
				"body[data-source-code-mgmt-dragging] { cursor: col-resize; user-select: none; }\n";
			document.head.appendChild(tag);
		}

		/** 共享的「仓库 / 分支」小图标：既用于左轨按钮，也用作侧边栏 Tab 图标。 */
		function repoIcon(size) {
			const s = size || 18;
			return h("svg", {
				viewBox: "0 0 16 16", width: s, height: s,
				fill: "none", stroke: "currentColor", strokeWidth: 1.5,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			},
				// a simplified "repo / branch" glyph: a small box with a branch
				h("rect", { x: "1.5", y: "2.5", width: "9", height: "11", rx: "1.5" }),
				h("path", { d: "M14 6.5v3.5a2 2 0 0 1-2 2H5.5" })
			);
		}

		// ---------- branch B:右上角 header 入口 + 右侧集成面板 ----------
		// 未安装 dsh-better-sidebar 时使用：把「代码管理」按钮注册进 DSH 的
		// conversation.session.header.utilities 槽位（Session log 所在的右对齐列表），
		// 因此它天然出现在 Session log 旁、样式一致的胶囊按钮、间距 8px 不挤在一起；
		// 点击后在右侧展开一个 dsh-better-sidebar 外观的固定面板（推挤 #root），复用 ScmPanel。
		const SCM_PANEL_W = 620;

		/** Session log 同款胶囊按钮样式（描边、圆角 18、透明底），放在 header utilities 列表里。 */
		function headerBtnStyle() {
			return {
				display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 4,
				height: 32, padding: "6px 12px",
				border: "1px solid " + T.border, borderRadius: 18,
				color: T.label, background: "transparent",
				font: "inherit", fontSize: 13, fontWeight: 400, lineHeight: 1,
				cursor: "pointer", whiteSpace: "nowrap",
			};
		}

		/** 右侧面板的最小 / 最大宽度（拖拽改宽时钳制，防止拖得过窄或超出视口）。 */
		const SCM_PANEL_MIN = 360;
		const SCM_PANEL_MAX_FRAC = 0.92; // 拖拽上限：视口宽度的 92%

		/** 右侧集成面板拖拽改宽：拖动面板左边缘调整宽度（像 dsh-better-sidebar）。要点：
		 *  拖拽期间逐帧直接写 DOM（面板 style.width + --scm-push CSS 变量），避免每帧触发
		 *  React 重渲染造成卡顿；在 pointerup 时把最终宽度提交进 state，重开面板仍保持。 */
		function makeResizeHandler(getPanelEl, getW, onCommit) {
			return (e) => {
				e.preventDefault();
				const startX = e.clientX;
				const startW = getW();
				let lastW = startW;
				const body = document.body;
				body.setAttribute("data-source-code-mgmt-dragging", "");
				const onMove = (ev) => {
					// 面板贴右（right:0），往左拖 = 变宽；增量 = 起点X - 当前X。
					let w = startW + (startX - ev.clientX);
					const max = Math.round(window.innerWidth * SCM_PANEL_MAX_FRAC);
					w = Math.round(Math.max(SCM_PANEL_MIN, Math.min(max, w)));
					lastW = w;
					const el = getPanelEl();
					if (el) el.style.width = w + "px";
					document.documentElement.style.setProperty("--scm-push", w + "px");
				};
				const onUp = () => {
					body.removeAttribute("data-source-code-mgmt-dragging");
					window.removeEventListener("pointermove", onMove);
					window.removeEventListener("pointerup", onUp);
					if (lastW !== startW) onCommit(lastW);
				};
				window.addEventListener("pointermove", onMove);
				window.addEventListener("pointerup", onUp);
			};
		}

		/** 右上角「代码管理」按钮 + 点击后打开的右侧集成面板（dsh-better-sidebar 外观，
		 *  可拖拽左边缘调整宽度）。 */
		function HeaderScmAction() {
			// 跟随 DSH 语言设置：按钮文字（代码管理）实时切换。
			useLocale();
			const [open, setOpen] = useState(false);
			const [panelW, setPanelW] = useState(SCM_PANEL_W);
			const panelRef = useRef(null);
			useEffect(() => { ensureLayoutCss(); }, []);
			// 右侧面板打开时推挤 #root（margin-right），关闭时归零。宽度跟随 panelW。
			useEffect(() => {
				document.documentElement.style.setProperty("--scm-push", open ? panelW + "px" : "0px");
				return () => { document.documentElement.style.removeProperty("--scm-push"); };
			}, [open, panelW]);
			// 拖拽改宽处理器（面板左边缘的拖拽条）。
			const onResize = makeResizeHandler(
				() => panelRef.current,
				() => panelW,
				(w) => setPanelW(w),
			);
			return h(React.Fragment, null,
				h("button", { type: "button", style: headerBtnStyle(), title: t("源代码管理"), "aria-label": t("源代码管理"), onClick: () => setOpen(true) },
					repoIcon(14), h("span", { style: { fontSize: 13 } }, t("代码管理"))),
				open ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", inset: 0, zIndex: 1000, pointerEvents: "none" }, role: "presentation" },
						h("div", { ref: panelRef, style: {
							position: "absolute", top: 0, right: 0, bottom: 0, width: panelW + "px",
							boxSizing: "border-box", overflow: "visible", pointerEvents: "auto",
							background: "var(--dsw-alias-bg-layer-1, rgba(128,128,128,.08))",
							borderLeft: "1px solid " + T.border,
							boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))",
						} },
							// 左边缘拖拽条（改宽）
							h("div", {
								onPointerDown: onResize,
								title: t("拖动调整面板宽度"),
								"aria-label": t("拖动调整面板宽度"),
								style: {
									position: "absolute", top: 0, bottom: 0, left: -3, width: 7,
									cursor: "col-resize", pointerEvents: "auto", zIndex: 1,
								},
							}),
							h(ScmPanel, { variant: "drawer", onClose: () => setOpen(false) })
						)
					),
					document.body
				) : null
			);
		}

		/** 空态（无会话）时的常驻右上角入口：注册进常驻的 shell.overlay 槽，用 fixed 钉在
		 *  视口右上角。仅当「当前没有会话」（sessionList.current === undefined）时显示——
		 *  有会话时交给 header utilities 按钮，避免两处重复。点击复用 HeaderScmAction 打开面板。 */
		function EmptyStateScmAction() {
			useSession();
			const snap = scmSessionList && typeof scmSessionList.getSnapshot === "function" ? scmSessionList.getSnapshot() : undefined;
			// 尚未捕获到 sessions 时先不渲染：避免刷新瞬间（captureSessions 的 1.2s 延迟窗口内）
			// 因 scmSessionList 为 null 而错误点亮常驻按钮、与「Session 日志」重叠。
			if (!snap) return null;
			const current = snap.current;
			const cur = current !== undefined ? (snap.byId ? snap.byId[current] : undefined) : undefined;
			// 活跃（非空白）会话 → header 里已有「代码管理」按钮（会话内）；这里隐藏常驻按钮。
			// 空白（新对话/欢迎）或根本没有会话 → header 被 hideChrome 隐藏/不存在，显示常驻右上角按钮。
			const hasActiveSession = current !== undefined && cur && cur.blank === false;
			if (hasActiveSession) return null;
			return h("div", { style: { position: "fixed", top: 8, right: 12, zIndex: 40, pointerEvents: "auto" } },
				h(HeaderScmAction));
		}

		/** 挂载一个经典脚本 React 根（React 18 用 createRoot，老版本回退 render）。 */
		function mountClientRoot(container, element) {
			try {
				if (ReactDOM.createRoot) {
					const root = ReactDOM.createRoot(container);
					root.render(element);
					return root;
				}
				if (ReactDOM.render) {
					ReactDOM.render(element, container);
					return { unmount: () => ReactDOM.unmountComponentAtNode(container) };
				}
			} catch (e) { console.error("[source-code-mgmt] mount failed:", e); }
			return null;
		}

		// ---------- cordis plugin body ----------
		// 声明 'locale'：DSH 的客户端插件都靠 inject 声明保证服务先于 apply 就绪（loader
		// 依赖图排序）。client-locale 是 web-app 核心服务（与 slots/connection 同级），
		// 必在 loader 树里；better-sidebar 仍是可选集成（不入 inject），照旧用
		// ctx.get('betterSidebar') 判空 + 延迟重试，未安装时绝不会因为缺服务而报错。
		const inject = ['locale'];

		// 是否已安装（并激活）dsh-better-sidebar：决定「③代码管理」是否隐藏本插件自带的
		// 本地 Git 工作流（暂存/提交/分支/历史/并排 diff）——这些能力 better-sidebar 的
		// Git 面板已覆盖，装了它就不重复展示。React 组件通过这个模块级标记读取。
		let hasBetterSidebar = false;

		function apply(ctx) {
			// 接管 DSH 的语言设置：client-locale 插件提供 ctx.locale（LocaleRuntime），
			// t() 实时读它；语言切换经 subscribe 触发 useLocale 重渲染。
			// 注意：client-locale 可能比本插件晚激活（和 better-sidebar 同样的顺序问题），
			// 因此捕获要带重试；重试窗口内组件先以浏览器语言渲染，捕获后立即切到 DSH 设置。
			const captureLocale = () => {
				try {
					if (scmLocaleFace) return true;
					const lf = (ctx && ctx.locale) || (typeof ctx.get === "function" ? ctx.get("locale") : undefined);
					if (lf && typeof lf.getLocale === "function") {
						scmLocaleFace = lf;
						try { scmLang = lf.getLocale().active || scmLang } catch {}
						return true;
					}
					return false;
				} catch { return false }
			};
			if (!captureLocale()) {
				// 兜底：等 client-locale 激活后再补抓（单次延迟，零轮询、零 I/O）。
				window.setTimeout(() => {
					const ok = captureLocale();
					if (!ok && typeof console !== "undefined") {
						console.warn("[source-code-mgmt] DSH locale service not found — UI follows the browser language. Install/enable @deepseek-ai/dsh-client-locale for live language switching.");
					}
				}, 1200);
			}

			// 捕获 `sessions.list`（用于「是否无会话」判断）。sessions 是核心服务、通常早于本插件
			// 就绪；若还没就绪，单次延迟补抓一次（组件经 useSession 订阅后会自动重渲染）。
			const captureSessions = () => {
				try {
					if (scmSessionList) return true;
					const s = ctx && typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
					if (s && typeof s.list === "object" && s.list) {
						scmSessionList = s.list;
						return true;
					}
					return false;
				} catch { return false }
			};
			if (!captureSessions()) {
				window.setTimeout(() => { captureSessions(); }, 1200);
			}

			// DSH 打开（插件激活）时就预取环境/SSH/默认工作区/仓库状态，
			// 点开「代码管理」面板时直接使用缓存，无需重新加载。
			void preload();

			// better-sidebar 是可选集成：若本插件先于它激活，第一次读取会拿到 undefined；
			// 这里用一次性重试保证无论激活顺序如何，最终都能正确落到分支 A（注册 Tab）。
			let entryUnmount = null;
			hasBetterSidebar = false;

			const tryRegisterTab = () => {
				const bs = typeof ctx.get === "function" ? ctx.get("betterSidebar") : undefined;
				if (!bs || typeof bs.registerTab !== "function") {
					return false;
				}
				// 分支 A：已安装 dsh-better-sidebar —— 把「代码管理」注册成它的侧边栏新 Tab
				// 页面。ctx.effect 保证 HMR / 插件卸载时自动注销该 Tab。
				hasBetterSidebar = true;
				// 语言切换时实时更新 Tab 标题（title 变了才重注册，避免注册抖动）。
				let lastTabTitle = null;
				let tabDisposer = null;
				const registerTabNow = () => {
					const title = t("代码管理");
					if (title === lastTabTitle) return;
					if (typeof tabDisposer === "function") { try { tabDisposer() } catch {} }
					lastTabTitle = title;
					tabDisposer = bs.registerTab({
						id: PLUGIN_ID,
						title,
						icon: (size) => repoIcon(size),
						order: 50,
						single: true,
						component: () => h(ScmPanel, { variant: "tab" }),
					});
				};
				ctx.effect(() => {
					registerTabNow();
					return () => { if (typeof tabDisposer === "function") { try { tabDisposer() } catch {} } };
				});
				if (scmLocaleFace && typeof scmLocaleFace.subscribe === "function") {
					ctx.effect(() => scmLocaleFace.subscribe(() => { try { registerTabNow(); } catch {} }),
						'source-code-mgmt: tab title locale sync');
				}
				// 若此前已挂载了分支 B 的 header 入口（降级路径），立即拆除它。
				if (entryUnmount) { entryUnmount(); entryUnmount = null; }
				return true;
			};

			if (tryRegisterTab()) return;

			// 分支 B：此刻未检测到 dsh-better-sidebar —— 注册两处「代码管理」入口，保证右上角常驻可见：
			//   ① 有会话时：放进 conversation.session.header.utilities（Session 日志旁的右对齐列表）；
			//   ② 无会话空态时：放进常驻的 shell.overlay 槽、用 fixed 钉在右上角（EmptyStateScmAction
			//      内部按「是否有当前会话」决定显隐，有会话时返回 null，避免与 ① 重复）。
			// 点击都复用 HeaderScmAction 打开右侧 dsh-better-sidebar 外观的集成面板（推挤 #root）。
			const slots = typeof ctx.get === "function" ? ctx.get("slots") : undefined;
			if (slots && typeof slots.inject === "function") {
				ctx.effect(() => {
					const teardowns = [];
					// ① 会话内：Session 日志旁
					teardowns.push(slots.inject('conversation.session.header.utilities', () => slots.register({
						name: 'conversation.session.header.utilities',
						id: 'source-code-mgmt',
						order: 200,
					}, HeaderScmAction)));
					// ② 空态：常驻右上角（仅无会话时显示）
					teardowns.push(slots.inject('shell.overlay', () => slots.register({
						name: 'shell.overlay',
						id: 'source-code-mgmt-empty',
						order: 300,
					}, EmptyStateScmAction)));
					// entryUnmount 一次性拆掉两处：这样当之后探测到 better-sidebar、切到分支 A
					// （注册 Tab）时，tryRegisterTab 里的 entryUnmount() 能把两处入口都移除。
					// （旧代码只给 ReactDOM 降级路径设了 entryUnmount，slots 路径漏了 —— 这正是
					//  「better-sidebar 已出来、代码管理按钮却仍在」的早期根因。）
					entryUnmount = () => {
						for (const td of teardowns) { try { if (typeof td === "function") td() } catch {} }
						teardowns.length = 0;
						entryUnmount = null;
					};
					return entryUnmount;
				}, 'source-code-mgmt: entry (session header + empty overlay)');
			} else if (ReactDOM) {
				// slots 服务不可用（极少数环境）——降级：右上角浮动按钮 + 右侧面板。
				ctx.effect(() => {
					const hostEl = document.createElement("div");
					hostEl.setAttribute("data-source-code-mgmt-entry", "");
					document.body.appendChild(hostEl);
					const root = mountClientRoot(hostEl, h(HeaderScmAction));
					entryUnmount = () => {
						try { if (root && typeof root.unmount === "function") root.unmount(); } catch {}
						hostEl.remove();
					};
					return () => { if (entryUnmount) { entryUnmount(); entryUnmount = null; } };
				});
			}

			// 有界重试：作为安全网，兜住 better-sidebar 的客户端服务晚于本插件挂载的情况
			// （两插件互不注入、加载器不保证顺序；其客户端 bundle 是重插件，偶发冷启动慢）。
			// 单次 1.5s 窗口不够，这里先用快节奏起步、再放慢，覆盖到约 44s；一旦拿到服务
			// （tryRegisterTab 返回 true）立即注册 Tab、拆除 header 入口并清空所有定时器；
			// 全程零 I/O（纯内存 ctx.get）。窗口耗尽仍无服务则停留分支 B（此时才是真正未安装）。
			const retryTimers = new Set();
			const retryTicks = [500, 500, 750, 1000, 1500, 2000, 3000, 5000, 5000, 5000, 5000, 5000, 5000, 5000];
			const clearRetry = () => {
				for (const timerId of retryTimers) { try { window.clearTimeout(timerId); } catch {} }
				retryTimers.clear();
			};
			for (const d of retryTicks) {
				const handle = window.setTimeout(() => {
					retryTimers.delete(handle);
					if (hasBetterSidebar) return;
					if (tryRegisterTab()) clearRetry();
				}, d);
				retryTimers.add(handle);
			}
			ctx.effect(() => clearRetry);
		}

		exports.name = PLUGIN_ID;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
