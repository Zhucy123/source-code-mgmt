/**
 * source-code-mgmt — browser half (client.js).
 *
 * Classic-script plugin bundle (no build step). On activation it detects
 * whether dsh-better-sidebar is installed (a single in-memory `ctx.get`,
 * zero I/O — does not slow DSH startup):
 *
 *   - branch A: dsh-better-sidebar installed → register「代码管理」as a new
 *     sidebar Tab page through `ctx.betterSidebar.registerTab`.
 *   - branch B: not installed → render a floating button pinned to the top
 *     right; clicking expands a right-side drawer (like better-sidebar's
 *     right rail) holding the existing panel.
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
		async function jget(path) {
			const res = await fetch(API + path);
			if (!res.ok) throw new Error("HTTP " + String(res.status));
			return await res.json();
		}
		async function jpost(path, body) {
			const res = await fetch(API + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body || {}),
			});
			if (!res.ok) throw new Error("HTTP " + String(res.status));
			return await res.json();
		}

		// ---------- preload cache ----------
		// DSH 打开（插件激活）时就预先检测并缓存，点开「代码管理」面板直接秒显，
		// 不再每次点击重新加载。
		const cache = {
			env: null,
			ssh: null,
			defDir: null,
			repo: null,
			// 各工作区的 full 同步结果（dir -> repo 状态），打开 DSH 时预取，切换工作区可秒显。
			reposByDir: {},
			workspaces: [],
			customDirs: [],
			ready: false,
		};
		let preloadPromise = null;

		/** 预取 env / ssh / default-dir / repo / workspaces，结果写入 cache。可并发安全。 */
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
						// 打开 DSH 时即对所有工作区做一次完整同步（full=1 会 git fetch 联网），
						// 这样点开「代码管理」或切换任意工作区都直接显示已同步的最新状态，无需再等。
						// 用并发上限 5 控制，避免一次性对大量仓库同时打满网络。
						const dirs = Array.from(new Set([
							...(cache.workspaces || []),
							...(cache.customDirs || []),
							...(def && def.dir ? [def.dir] : []),
						].filter(Boolean)))
						await syncAllRepos(dirs, 5)
						// 默认工作区的同步结果作为面板首次秒显内容。
						if (def && def.dir && cache.reposByDir[def.dir]) {
							cache.repo = cache.reposByDir[def.dir];
						}
						cache.ready = true;
					} catch {
						/* 保持部分缓存 */
					}
				})();
			}
			return preloadPromise;
		}

		/** 并发上限 N 地对所有目录做 full 同步，结果写入 cache.reposByDir[dir]。 */
		async function syncAllRepos(dirs, limit) {
			let i = 0
			const worker = async () => {
				while (i < dirs.length) {
					const d = dirs[i++]
					try {
						const r = await jget("/repo?dir=" + encodeURIComponent(d) + "&full=1").catch(() => null)
						if (r) cache.reposByDir[d] = r
					} catch { /* 单个失败不影响其他 */ }
				}
			}
			const workers = []
			const n = Math.max(1, Math.min(limit || 5, dirs.length || 1))
			for (let k = 0; k < n; k++) workers.push(worker())
			await Promise.all(workers)
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

		function Dot({ color }) {
			return h("span", { style: { color, marginRight: 4 } }, "●");
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
		function Box({ title, badge, defaultCollapsed, collapsible, children }) {
			// 每个部分默认可折叠：标题行右侧一个「折叠/展开」按钮，点击收起只显示标题。
			// defaultCollapsed 控制初始是否收起（如①环境检查全就绪时默认折叠）。
			const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
			const canCollapse = collapsible !== false;
			return h("div", { style: { border: "1px solid " + T.border, borderRadius: 12, padding: 14 } },
				h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
					h("span", { style: { fontSize: 13, fontWeight: 600, color: T.label, flex: 1, minWidth: 0 } }, title),
					badge ? h("span", { style: { fontSize: 12, color: T.success, flexShrink: 0, whiteSpace: "nowrap" } }, badge) : null,
					canCollapse ? h("button", {
						type: "button",
						title: collapsed ? "展开" : "折叠",
						"aria-label": collapsed ? "展开该部分" : "折叠该部分",
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
		function EnvSection() {
			const [env, setEnv] = useState(() => cache.env);
			const [err, setErr] = useState(null);
			const load = useCallback(async () => {
				setErr(null);
				// 先读缓存（DSH 打开时已预取），再后台刷新保持最新
				if (cache.env) setEnv(cache.env);
				try { setEnv(await refreshCache("env")); }
				catch (e) { setErr(String(e)); }
			}, []);
			useEffect(() => { void preload().then(load); }, [load]);

			// 是否所有工具都就绪（git / gh / ssh 均已安装）——就绪时该部分默认折叠，
			// 只显示「① 环境检查」标题 + 「均存在」提示；否则默认展开让用户看到缺什么。
			// 用预取缓存判定初始状态（DSH 打开时已拉好 env），无需等网络。
			const allPresent = !!(cache.env && cache.env.git && cache.env.git.installed
				&& cache.env.gh && cache.env.gh.installed
				&& cache.env.ssh && cache.env.ssh.installed);

			return h(Box, { title: "① 环境检查", badge: allPresent ? "✅ 均存在" : null, defaultCollapsed: !!allPresent },
				h(Field, { label: "操作系统" }, h("span", { style: { color: T.label, fontSize: 13 } }, env ? (env.platformLabel || env.platform) : "...")),
				env ? h(React.Fragment, null,
					h(Field, { label: "Git", value: env.git.installed ? "✅ " + env.git.version : "❌ 未安装" }),
					h(Field, { label: "GitHub CLI", value: env.gh.installed ? "✅ " + env.gh.version : "❌ 未安装" }),
					h(Field, { label: "SSH", value: env.ssh && env.ssh.installed ? "✅ 已找到" : "❌ 未找到" })
				) : h(Field, { label: "检测中", value: err ? "失败: " + err : "…" }),
				(!env || !env.git.installed || !env.gh.installed) ? h("div", { style: { marginTop: 8 } },
					h("span", { style: { color: T.warn, fontSize: 12 } },
						"未安装工具请先安装 Git for Windows 和 GitHub CLI，然后重启。" + (err ? "（" + err + "）" : ""))
				) : h(Btn, { label: "重新检查", onClick: load, tone: "ghost" })
			);
		}

		// ---------- section 2: SSH ----------
		function SshSection({ provider, setProvider }) {
			const [ssh, setSsh] = useState(() => cache.ssh);
			const [busy, setBusy] = useState(false);
			const [msg, setMsg] = useState(null);
			const [err, setErr] = useState(null);
			// 平台状态由 ScmPanel 共享（②里选择，③跟随）
			const prov = provider || "github";
			const setProv = setProvider || (() => {});

			const load = useCallback(async () => {
				setErr(null);
				if (cache.ssh) setSsh(cache.ssh);
				try { setSsh(await refreshCache("ssh")); }
				catch (e) { setErr(String(e)); }
			}, []);
			useEffect(() => { void preload().then(load); }, [load]);

			const act = useCallback(async (path, label, payload) => {
				setBusy(true); setMsg(null); setErr(null);
				try {
					const r = await jpost(path, payload);
					if (r.alreadyExists || r.alreadyConfigured) setMsg(label + "：已存在，无需重复操作");
					else if (r.ok) setMsg(label + "成功");
					else setErr(r.error || label + "失败");
					void load();
				} catch (e) { setErr(label + "失败：" + e); }
				finally { setBusy(false); }
			}, [load]);

			// 依据所选平台判断各自的 SSH config 是否已配置
			const providerConfigured = prov === "gitee"
				? !!(ssh && ssh.sshGiteeConfigured)
				: !!(ssh && ssh.sshGitHubConfigured);
			const providerHost = prov === "gitee" ? "gitee.com" : "github.com";

			return h(Box, { title: "② SSH 密钥与连接" },
				// 平台选择（默认 GitHub），③代码管理跟随
				h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 } },
					h("span", { style: { color: T.secondary, fontSize: 13, width: 84, flexShrink: 0 } }, "平台"),
					h("select", {
						value: prov,
						onChange: (e) => setProv(e.target.value),
						title: "选择代码托管平台：GitHub 或 Gitee（默认 GitHub），③代码管理会跟随切换",
						style: { font: "inherit", fontSize: 13, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
					},
						h("option", { value: "github" }, "GitHub（默认）"),
						h("option", { value: "gitee" }, "Gitee"),
					)
				),
				// key status
				h(Field, { label: "密钥" }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (ssh.hasKey ? "✅ id_ed25519 已生成" : "⚠️ 未生成") : "…")
				),
				h(Field, { label: "GH 登录" }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (ssh.ghLoggedIn ? "✅ " + (ssh.ghAccount || "已登录") : "⚠️ 未登录") : "…")
				),
				h(Field, { label: "SSH 配置" }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (providerConfigured ? "✅ " + providerHost + " 已配置(443)" : "⚠️ 未配置/限制 22 端口需配置") : "…")
				),

				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 } },
					h(Btn, { label: "生成密钥", onClick: () => act("/gen-key", "生成密钥"), disabled: busy }),
					h(Btn, { label: "配置 SSH(config)", onClick: () => act("/write-config", "配置 SSH", { provider: prov }), disabled: busy }),
					h(Btn, { label: "测试连接", onClick: async () => {
						setBusy(true); setErr(null); setMsg(null);
						try {
							const r = await jpost("/ssh-test", { provider: prov });
							if (r.connected) setMsg("SSH 连接成功（" + (prov === "gitee" ? "Gitee" : "GitHub") + "）：" + (r.account ? "Hi " + r.account : "已认证"));
							else setErr("连接失败，请确认密钥已上传到 " + (prov === "gitee" ? "Gitee" : "GitHub") + " 或已登录 gh");
							void load();
						} catch (e) { setErr("测试失败：" + e); }
						finally { setBusy(false); }
					}, tone: "primary", noBg: true, disabled: busy }),
				),
				ssh && ssh.pubContent ? h("div", { style: { marginTop: 10 } },
					h("div", { style: { color: T.secondary, fontSize: 12, marginBottom: 4 } }, "公钥（复制上传到 " + (prov === "gitee" ? "Gitee → 设置 → SSH 公钥" : "GitHub → Settings → SSH keys") + "，或运行 gh auth login 自动上传）："),
					h("code", { style: { display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, lineHeight: 1.5, color: T.secondary, background: T.layer1, padding: 10, borderRadius: 8 } }, ssh.pubContent)
				) : null,
				msg ? h("div", { style: { marginTop: 10, color: T.success, fontSize: 13 } }, "✅ " + msg) : null,
				err ? h("div", { style: { marginTop: 10, color: T.danger, fontSize: 13 } }, "❌ " + err) : null,
				(!ssh || ssh.gitHubNotConfigured) ? null : null
			);
		}

		// ---------- section 3: 代码管理 ----------
		function RepoSection({ provider }) {
			// 平台（来自②，默认 GitHub），③随其切换检测/创建等逻辑
			const prov = provider || "github";
			const [dir, setDir] = useState(() => cache.defDir ?? "");
			const [dirDraft, setDirDraft] = useState(() => cache.defDir ?? "");
			const [repo, setRepo] = useState(() => cache.repo);
			const [busy, setBusy] = useState(false);
			// 刷新状态（联网同步）进行中的提示状态，避免刷新时界面闪成「未加载文件夹」。
			const [refreshing, setRefreshing] = useState(false);
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
			// 详情弹窗：'changes'（改动文件列表）| 'sync'（同步差异）| null（关闭）
			const [detail, setDetail] = useState(null);
			// 改动详情里被展开显示 diff 的文件下标集合（点击文件名展开/收起内容）
			const [expandedDiffs, setExpandedDiffs] = useState(() => new Set());
			// 按需加载的 diff：{ [index]: { loading, diff, error } }，点开文件行时才请求 /repo-diff
			const [diffs, setDiffs] = useState({});
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
				// 推送/拉取/对齐等操作后的刷新）；默认 false（快速模式）：跳过 fetch，
				// 秒出本地状态。full 模式自动显示「刷新中…」提示，提示只在最新一次调用归来时关闭。
				const doFull = full === true;
				const mySeq = ++loadSeq.current;
				if (doFull) setRefreshing(true);
				const dirty = !keepRepo;
				if (dirty) setRepo(null);
				// 快速模式且预取已同步过该目录：直接秒显缓存，不再等网络（打开 DSH 时已全部 full 同步）。
				if (!doFull && cache.reposByDir[d]) {
					const cached = cache.reposByDir[d];
					if (mySeq === loadSeq.current) {
						setRepo(cached);
						if (cached.dir) { setDirDraft(cached.dir); setDir(cached.dir); }
						syncVisibility(cached);
					}
					return;
				}
				try {
					const p = provRef.current || "github";
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
					// 缓存最新 repo 状态
					cache.repo = r;
					// 默认可见性：优先当前仓库实际状态；无远程（即将新建的仓库）默认「公开」。
					syncVisibility(r);
					if (r && !r.isGitRepo) setErr(r.error || "该目录不是 git 仓库");
				} catch (e) { setErr(String(e)); }
				finally {
					// 只有本次是最新调用时才收起「刷新中…」提示，避免旧请求失败把提示提前关掉。
					if (doFull && mySeq === loadSeq.current) setRefreshing(false);
				}
			}, []);

			useEffect(() => {
				// 首次加载：优先用 DSH 打开时已 full 同步好的 cache.repo 秒显；
				// 无论预加载是否已在此时完成，都走 preload()（幂等），在 .then 里
				// 直接用预取结果，避免「先显示（未加载文件夹）空白再等一会儿」。
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
					if (cache.repo) {
						// 预加载已做 full 同步，直接秒显，不再发重复请求。
						setRepo(cache.repo);
						syncVisibility(cache.repo);
					} else {
						// 兜底：预加载未拿到（如请求失败），发一次 full 同步刷新。
						loadRepo(d, true, true);
					}
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
				} catch (e) { setGiteeConfigured(false); setGiteeTokenErr("读取令牌状态失败：" + e); }
			}, []);

			const saveGiteeToken = useCallback(async () => {
				setGiteeTokenBusy(true); setGiteeTokenErr(null); setGiteeTokenMsg(null);
				try {
					const r = await jpost("/gitee-token", { token: giteeToken });
					if (r.ok) {
						setGiteeConfigured(true);
						setGiteeOwnerName(r.owner || "");
						setGiteeToken("");
						setGiteeTokenMsg("已保存 Gitee 令牌（账号：" + (r.owner || "？") + "）");
						// 令牌就绪后刷新仓库，让同名检测等按 Gitee 生效
						loadRepo(dir || cache.defDir || "", true);
					} else {
						setGiteeConfigured(false);
						setGiteeTokenErr(r.error || "保存令牌失败");
					}
				} catch (e) { setGiteeConfigured(false); setGiteeTokenErr("保存令牌失败：" + e); }
				finally { setGiteeTokenBusy(false); }
			}, [giteeToken, dir, loadRepo]);

			const clearGiteeToken = useCallback(async () => {
				setGiteeTokenBusy(true); setGiteeTokenErr(null); setGiteeTokenMsg(null);
				try {
					const r = await jpost("/gitee-token", { clear: true });
					setGiteeConfigured(false);
					setGiteeOwnerName("");
					setGiteeToken("");
					setGiteeTokenMsg(r.ok ? "已清除 Gitee 令牌" : "清除失败");
					loadRepo(dir || cache.defDir || "", true);
				} catch (e) { setGiteeTokenErr("清除令牌失败：" + e); }
				finally { setGiteeTokenBusy(false); }
			}, [dir, loadRepo]);

			// 平台切换：gitee 时读取令牌状态；无论切到哪都刷新仓库（跟随平台检测/显示）
			useEffect(() => {
				if (prov === "gitee") void loadGiteeTokenStatus();
				// 切换平台等同切换检测目标，清掉旧的错误提示，避免残留上一个平台的报错。
				setErr(null);
				if (dir || cache.defDir) loadRepo(dir || cache.defDir || "", true);
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [prov]);

			const push = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/push", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg("已推送");
					else setErr(r.error || r.pushError || "推送失败");
					void loadRepo(dir, true, true);
				} catch (e) { setErr("推送失败：" + e); }
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
					if (r.ok) setMsg("已拉取远程更新（本地已对齐到远程最新状态）");
					else setErr(r.error || "拉取失败");
					void loadRepo(dir, true, true);
				} catch (e) { setErr("拉取失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const mergePush = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/merge-push", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg("已拉取远程更新并推送更改");
					else setErr(r.error || "合并推送失败");
					void loadRepo(dir, true, true);
				} catch (e) { setErr("合并推送失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const forcePush = useCallback(async () => {
				if (!window.confirm("强制推送会用本地版本覆盖远程仓库，远程上非本地的更改将被丢弃。确定继续？")) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/force-push", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg("已强制推送，远程已更新为本地状态");
					else setErr(r.error || "强制推送失败");
					void loadRepo(dir, true, true);
				} catch (e) { setErr("强制推送失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const forcePull = useCallback(async () => {
				if (!window.confirm("强制拉取会把远程更新并入本地。如果本地有不想保留的内容，将按冲突处理或遗失。确定继续？")) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/force-pull", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg("已强制拉取远程更新");
					else setErr(r.error || "强制拉取失败");
					void loadRepo(dir, true, true);
				} catch (e) { setErr("强制拉取失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const changeVisibility = useCallback(async () => {
				const name = (repo && repo.defaultRepoName) || "";
				if (!name) { setErr("请先加载一个有效的文件夹"); return; }
				const target = visibility === "public" ? "public" : "private";
				if (!window.confirm("确定把仓库 " + name + " 改为「" + (target === "public" ? "公开" : "私有") + "」？修改可见性可能影响 Star、关注者等。")) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/set-visibility", { dir: dir || undefined, name, visibility: target, provider: provRef.current || "github" });
					setResult(r);
					if (r.ok) setMsg("已把仓库设置为「" + (target === "public" ? "公开" : "私有") + "」");
					else setErr(r.error || "修改可见性失败");
					void loadRepo(dir, true, true);
				} catch (e) { setErr("修改可见性失败：" + e); }
				finally { setBusy(false); }
			}, [dir, repo, visibility, loadRepo]);

			const create = useCallback(async () => {
				const name = (repo && repo.defaultRepoName) || "";
				if (!name) { setErr("请先加载一个有效的文件夹"); return; }
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/create", { dir: dir || undefined, name, visibility, provider: provRef.current || "github" });
					setResult(r);
					if (r.ok) setMsg("仓库已创建并推送：" + (r.url || name) + (r.provider === "gitee" ? "（Gitee）" : ""));
					else setErr(r.error || "创建失败");
					void loadRepo(dir, true, true);
				} catch (e) { setErr("创建失败：" + e); }
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
					else setPickErr(r.error || "未选择目录");
				} catch (e) { setPickErr("选择失败：" + e); }
				finally { setPicking(false); }
			}, [pickPath]);

			// 确认：持久化加入列表 + 加载
			const confirmPick = useCallback(async () => {
				const path = String(pickPath || "").trim();
				if (!path) { setPickErr("请输入或选择目录路径"); return; }
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
						loadRepo(r.dir);
					} else {
						setPickErr(r.error || "添加目录失败");
					}
				} catch (e) { setPickErr("添加目录失败：" + e); }
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
							if (next) loadRepo(next); else setRepo(null);
						}
					} else {
						setErr(r.error || "删除失败");
					}
				} catch (e) { setErr("删除失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			// 强制对齐：本地完全重置为远程分支状态（丢弃本地差异）
			const align = useCallback(async () => {
				if (!window.confirm("强制对齐会用远程分支覆盖本地（丢弃本地未推送的更改与提交），确定继续？")) return;
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/align", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg("已强制对齐到远程分支");
					else setErr(r.error || "强制对齐失败");
					void loadRepo(dir);
				} catch (e) { setErr("强制对齐失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			// 只创建 git 仓库（不拉取不推送），由用户自行决定下一步
			const initGit = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/init-git", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(r.alreadyRepo ? "已是 git 仓库" : "已创建 git 仓库，请自行拉取或推送");
					else setErr(r.error || "创建 git 失败");
					void loadRepo(dir);
				} catch (e) { setErr("创建 git 失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			return h(Box, { title: "③ 代码管理" },
				// 平台提示 + Gitee 令牌（仅 gitee 模式）
				prov === "gitee" ? h("div", { style: { border: "1px solid " + T.border, borderRadius: 10, padding: 10, marginBottom: 10, background: T.layer1 } },
					h("div", { style: { fontSize: 12, fontWeight: 600, color: T.label, marginBottom: 6 } },
						"Gitee 私人令牌（OpenAPI，需 projects 权限）"),
					giteeConfigured === true
						? h("div", { style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" } },
							h("span", { style: { color: T.success, fontSize: 12 } }, "✅ 已配置" + (giteeOwnerName ? "（账号 " + giteeOwnerName + "）" : "")),
							h(Btn, { label: "清除令牌", onClick: clearGiteeToken, disabled: giteeTokenBusy, noBg: true, tone: "danger" })
						)
						: h("div", null,
							h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
								h("input", {
									type: "password", value: giteeToken, disabled: giteeTokenBusy,
									placeholder: "粘贴 Gitee 私人令牌（https://gitee.com/personal_access_tokens）",
									onChange: (e) => setGiteeToken(e.target.value),
									onKeyDown: (e) => { if (e.key === "Enter") void saveGiteeToken(); },
									style: { flex: 1, minWidth: 200, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14))", color: T.label, outline: "none" },
								}),
								h(Btn, { label: "保存令牌", onClick: saveGiteeToken, tone: "primary", noBg: true, disabled: giteeTokenBusy || !String(giteeToken || "").trim() }),
							),
							h("div", { style: { fontSize: 11, color: T.secondary, marginTop: 6, lineHeight: 1.6 } },
								"令牌只保存在本机 ~/.dsh/storages（0600），不会写进插件目录；需勾选个人令牌的 projects 权限。公钥需已上传到 Gitee（② 里检查）。")
						),
					giteeTokenMsg ? h("div", { style: { marginTop: 6, color: T.success, fontSize: 12 } }, "✅ " + giteeTokenMsg) : null,
					giteeTokenErr ? h("div", { style: { marginTop: 6, color: T.danger, fontSize: 12 } }, "❌ " + giteeTokenErr) : null
				) : null,
				h("div", { style: { display: "flex", gap: 8, marginBottom: 10, alignItems: "center" } },
					h("span", { style: { color: T.secondary, fontSize: 13, whiteSpace: "nowrap" } }, "选择工作区"),
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
							loadRepo(v);
						},
						title: "选择 DSH 已登记的工作区文件夹",
						style: { flex: 1, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
					},
						workspaces.length === 0 ? h("option", { key: "__empty", value: "" }, "（暂无可选工作区）")
							: h("option", { key: "__none", value: "" }, "— 请选择 —"),
						workspaces.map((w) =>
							h("option", { key: w, value: w }, String(w).split(/[\\/]/).filter(Boolean).pop() || w)
						)
					),
					h(Btn, { label: "选择目录", onClick: openPicker, disabled: picking, noBg: true, tone: "primary" }),
				),
				dir && customDirs && customDirs.includes(dir) ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10, alignItems: "center" } },
					h("span", { style: { color: T.secondary, fontSize: 12, whiteSpace: "nowrap" } }, "自定义目录："),
					h("span", { key: dir, style: { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", border: "1px solid " + T.border, borderRadius: 12, fontSize: 12, background: T.layer1, color: T.label, cursor: "pointer" }, title: dir, onClick: () => { setResult(null); setMsg(null); setErr(null); setDir(dir); setDirDraft(dir); loadRepo(dir); } },
						String(dir).split(/[\\/]/).filter(Boolean).pop() || dir,
						h("span", {
							role: "button", "aria-label": "删除该目录记录",
							title: "删除该目录记录（不删除实际文件夹）",
							onClick: (e) => { e.stopPropagation(); void removeWorkspace(dir); },
							style: { color: T.danger, fontWeight: 700, padding: "0 2px", cursor: "pointer" },
						}, "✕")
					)
				) : null,
				repo && repo.isGitRepo ? h("div", { style: { marginBottom: 10 } },
					h(Field, { label: "目录", value: repo.dir }),
					h(Field, { label: "分支", value: repo.branch }),
					h(Field, { label: "远程", value: repo.remoteUrl || "（无）" }),
					h(Field, { label: "改动" }, h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
						h("span", { style: { color: T.label, fontSize: 13 } }, repo.dirty ? repo.dirtyCount + " 个文件" : "无"),
						repo.changedFiles && repo.changedFiles.length > 0 ? h("button", {
							type: "button",
							onClick: () => setDetail("changes"),
							title: "查看改动的文件列表",
							style: changeBtnStyle(),
						}, "查看")
							: null
					)),
					h(Field, { label: "同步" }, h("span", { style: { display: "inline-flex", alignItems: "center", gap: 8 } },
						h("span", { style: { color: T.label, fontSize: 13 } },
							// 没有（属于当前账号/平台的）远程时不做同步判断，避免误显示「与远程一致」
							!repo.hasRemote
								? "（无）"
								: (repo.ahead > 0 ? "本地领先 " + repo.ahead + " 提交" : "") +
								  (repo.ahead > 0 && repo.behind > 0 ? "、落后 " + repo.behind + " 提交" : (repo.behind > 0 ? "落后 " + repo.behind + " 提交" : "")) +
								  ((repo.ahead === 0 && repo.behind === 0) ? "与远程一致" : "")
						),
						(repo.ahead > 0 || repo.behind > 0) ? h("button", {
							type: "button",
							onClick: () => setDetail("sync"),
							title: "查看本地与远程的提交差异",
							style: changeBtnStyle(),
						}, "查看")
							: null
					)),
					repo.ignoredLarge && repo.ignoredLarge.length > 0 ? h("div", { style: { marginTop: 8 } },
						h("div", { style: { color: T.warn, fontSize: 12, marginBottom: 4 } },
							"⚠️ 以下 " + repo.ignoredLarge.length + " 项 >100MB（超过 GitHub 限制，推送时将自动忽略不上传）："),
						h("div", { style: { maxHeight: 120, overflow: "auto", background: T.layer1, borderRadius: 8, padding: 8 } },
							repo.ignoredLarge.slice(0, 30).map((f, i) =>
								h("div", { key: i, style: { fontSize: 11, color: T.secondary, lineHeight: 1.5 } },
									(f.kind === "dir" ? "📁 " + f.path + "/（整个文件夹）" : "📄 " + f.path) +
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
						btns.push(h(Btn, { key: "init", label: "创建 Git", onClick: initGit, tone: "primary", noBg: true, disabled: isBlocked, title: "仅初始化 git 仓库，不拉取不推送，由你决定下一步" }));
					} else if (hasRemote) {
						if (localChanges && remoteUpdates) {
							// 本地和远程都有更新：原名展示「拉取更新并推送更改 / 强制推送 /
							// 强制拉取」三按钮，但这三种操作在此场景下容易因未提交改动、
							// 分支保护等原因失败且行为难预测，故不再展示——该状态唯一的
							// 操作按钮是「强制对齐」（fetch + reset --hard，本地完全重置为远程）。
							btns.push(h("span", { key: "both-note", style: { color: T.warn, fontSize: 12 } },
								"本地有改动且远程有更新，可直接用「强制对齐」将本地重置为远程状态"));
							if (repo && repo.isGitRepo) {
								btns.push(h(Btn, { key: "align", label: "强制对齐", onClick: align, disabled: isBlocked, title: "本地完全重置为远程分支（丢弃本地差异），解决“文件相同仍显示同步差异”的情况" }));
							}
						} else if (localChanges) {
							// 只有本地有更改 -> 只显示推送（正常 push）
							btns.push(h(Btn, { key: "push", label: "推送更改", onClick: push, tone: "primary", noBg: true, disabled: isBlocked || repo?.repoExists === false }));
						} else if (remoteUpdates) {
							// 只有远程有更新（本地干净）-> 只显示「拉取更新」。
							// 实现复用「强制对齐」逻辑（fetch + reset --hard）：本地干净
							// 无改动可丢，reset 等同快速前进到远程最新，直接执行不弹确认。
							btns.push(h(Btn, { key: "pull", label: "拉取更新", onClick: pull, disabled: isBlocked || repo?.repoExists !== true }));
						} else {
							// 完全同步 -> 无按钮，显示已是最新
							btns.push(h("span", { key: "synced", style: { color: T.success, fontSize: 13 } }, "✓ 已是最新"));
						}
					}
					// 刷新进行中给出明确提示，让用户知道正在联网同步。
					const refreshingTip = refreshing
						? h("div", { style: { color: T.brand, fontSize: 12, marginTop: 8 } }, "⟳ 正在刷新状态，联网同步 GitHub/Gitee 最新数据…")
						: null
					return h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
						btns,
						// keepRepo=true 保留旧内容避免闪烁；full=true 触发 loadRepo 的「刷新中…」提示 + 联网同步。
						h(Btn, {
							label: refreshing ? "刷新中…" : "刷新状态",
							onClick: () => { setResult(null); setMsg(null); setErr(null); loadRepo(dir, true, true); },
							disabled: busy || refreshing,
						}),
						refreshingTip,
					);
				})(),
				h("div", { style: { display: "flex", gap: 8, marginTop: 10, alignItems: "center" } },
					h("input", {
						type: "text", value: repoName, readOnly: true,
						title: "仓库名称自动取文件夹名（不可修改）",
						placeholder: "（未加载文件夹）",
						style: { flex: 1, font: "inherit", fontSize: 12, padding: "6px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "not-allowed", opacity: 0.85 },
					}),
					h("select", {
						value: visibility,
						onChange: (e) => setVisibility(e.target.value),
						title: "仓库可见性：私有 / 公开" + (repo && repo.repoExists === true ? "（修改当前仓库的可见性）" : ""),
						style: { font: "inherit", fontSize: 12, padding: "6px 8px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none", cursor: "pointer" },
					},
						h("option", { value: "private" }, "私有"),
						h("option", { value: "public" }, "公开")
					),
					repo && repo.repoExists === true ? (
						// 仓库已存在：根据所选值与当前实际可见性决定按钮 / 提示
						repo.visibility === visibility ? h(Btn, {
							key: "create", label: "新建仓库并推送", onClick: create, tone: "success",
							disabled: true,
						}) : h(Btn, {
							key: "setvis", label: "修改仓库状态", onClick: changeVisibility, tone: "success",
							disabled: busy || !repoName,
						})
					) : h(Btn, {
						key: "create", label: "新建仓库并推送", onClick: create, tone: "success",
						disabled: busy || !repoName,
					})
				),
				repo && repo.repoExists === true ? h("div", { style: { marginTop: 8, fontSize: 12 } },
					repo.visibility
						? (repo.visibility === visibility
							? h("span", { style: { color: T.success } }, "✓ 仓库已是「" + (repo.visibility === "public" ? "公开" : "私有") + "」状态，如需修改请调整左侧可见性选择。")
							: h("span", { style: { color: T.warn } }, "将把仓库从「" + (repo.visibility === "public" ? "公开" : "私有") + "」改为「" + (visibility === "public" ? "公开" : "私有") + "」，点击「修改仓库状态」执行。"))
						: h("span", { style: { color: T.secondary } }, "⚠️ 同名仓库已经创建（无法读取当前可见性，可能未" + (prov === "gitee" ? "配置 Gitee 令牌" : "登录 gh") + "）")
				) : repo && repo.repoExists === false ? h("div", { style: { marginTop: 8, color: T.success, fontSize: 12 } },
					"✓ 同名仓库 " + repoName + " 不存在，可在 " + (prov === "gitee" ? "Gitee" : "GitHub") + "「新建仓库并推送」创建（可选私有/公开）。"
				) : null,

				result ? h("div", { style: { marginTop: 12, borderTop: "1px solid " + T.border, paddingTop: 10 } },
					msg ? h("div", { style: { color: T.success, fontSize: 13 } }, "✅ " + msg) : null,
					result.skipped && result.skipped.length > 0 ? h("div", { style: { marginTop: 8 } },
						h("div", { style: { color: T.warn, fontSize: 12, marginBottom: 4 } },
							"已忽略未上传（" + result.skipped.length + " 项 >100MB）："),
						result.skipped.map((s, i) => h("div", { key: i, style: { fontSize: 11, color: T.warn, lineHeight: 1.5 } }, "· " + s.path + " — " + s.reason)))
					: result.ok ? h("div", { style: { color: T.success, fontSize: 12, marginTop: 6 } },
						"已提交" + (result.commitHash ? " " + result.commitHash : "") + (result.pushed ? " 并推送" : "（推送省略）"))
					: err ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + err)
					: result.pushError ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + result.pushError)
					: null
				) : err ? h("div", { style: { marginTop: 10, color: T.danger, fontSize: 13 } }, "❌ " + err) : null,
				detail ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", inset: 0, zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }, role: "presentation" },
						h("div", { style: { position: "absolute", inset: 0, background: T.mask }, "aria-hidden": "true", onClick: () => setDetail(null) }),
						h("div", { style: { position: "relative", zIndex: 1, width: 520, maxWidth: "calc(100vw - 48px)", maxHeight: "calc(100vh - 100px)", display: "flex", flexDirection: "column", background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border, borderRadius: 14, padding: 18, color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))" }, role: "dialog", "aria-modal": "true", "aria-label": "查看详情" },
							h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 } },
								h("div", { style: { fontSize: 15, fontWeight: 600, flex: 1 } },
									detail === "changes" ? "改动文件" : "与远程同步差异"),
								h("button", { type: "button", style: closeBtnStyle(), "aria-label": "关闭", onClick: () => setDetail(null) }, "✕")
							),
							h("div", { style: { flex: 1, overflow: "auto" } },
								detail === "changes" ? (
									repo && repo.changedFiles && repo.changedFiles.length > 0
										? repo.changedFiles.map((f, i) => {
											// untracked 新文件 git 不跟踪，没有 diff，不可展开。
											const canHaveDiff = f.type !== 'untracked'
											const open = expandedDiffs.has(i)
											const d = diffs[i] || {}
											const onClick = canHaveDiff ? async () => {
												const next = new Set(expandedDiffs)
												if (next.has(i)) { next.delete(i); setExpandedDiffs(next); return }
												next.add(i); setExpandedDiffs(next)
												// 首次展开才按需请求该文件的 diff（避免 /repo 时批量生成）。
												if (!diffs[i]) {
													setDiffs(prev => ({ ...prev, [i]: { loading: true, diff: '' } }))
													try {
														const r = await jget("/repo-diff?dir=" + encodeURIComponent(repo.dir || "") + "&path=" + encodeURIComponent(f.path))
														setDiffs(prev => ({ ...prev, [i]: { loading: false, diff: (r && r.diff) || '' } }))
													} catch (e) {
														setDiffs(prev => ({ ...prev, [i]: { loading: false, diff: '', error: String(e) } }))
													}
												}
											} : undefined
											return h("div", { key: i },
												h("div", {
													style: {
														display: "flex", gap: 8, alignItems: "baseline",
														fontSize: 13, lineHeight: 1.8,
														borderBottom: "1px solid " + T.border, padding: "3px 2px",
														cursor: canHaveDiff ? "pointer" : "default",
													},
													title: canHaveDiff ? (open ? "点击收起" : "点击查看改动内容") : "新文件（untracked）暂无内容 diff",
													onClick: onClick,
												},
													h("span", { style: { color: typeColor(f.type), fontSize: 11, flexShrink: 0, width: 52 } }, typeLabel(f.type)),
													h("span", { style: { color: T.label, wordBreak: "break-all", flex: 1 } }, f.path),
													canHaveDiff ? h("span", { style: { color: T.brand, fontSize: 11, flexShrink: 0 } },
														d.loading ? "加载中…" : (open ? "▾ 收起" : "▸ 查看"))
														: null
												),
												open && canHaveDiff ? (
													d.loading ? h("div", { style: { fontSize: 12, color: T.secondary, padding: "4px 8px" } }, "正在加载改动内容…")
														: d.error ? h("div", { style: { fontSize: 12, color: T.danger, padding: "4px 8px" } }, "❌ " + d.error)
														: d.diff ? renderDiff(d.diff) : h("div", { style: { fontSize: 12, color: T.secondary, padding: "4px 8px" } }, "（无内容差异）")
												) : null
											);
										})
										: h("div", { style: { color: T.secondary, fontSize: 13 } }, "当前没有改动。")
								) : (
									h("div", null,
										repo && (repo.ahead > 0 || repo.behind > 0) ? h("div", null,
											repo.behind > 0 ? h("div", { style: { marginBottom: 10 } },
												h("div", { style: { color: T.warn, fontSize: 12, fontWeight: 600, marginBottom: 4 } }, "本地落后 " + repo.behind + " 个提交（远程有而本地没有）："),
												repo.behindCommits && repo.behindCommits.length > 0
													? repo.behindCommits.map((c, i) => h("div", { key: i, style: { fontSize: 12, color: T.secondary, lineHeight: 1.7, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)" } }, c))
													: null
											) : null,
											repo.ahead > 0 ? h("div", null,
												h("div", { style: { color: T.brand, fontSize: 12, fontWeight: 600, marginBottom: 4 } }, "本地领先 " + repo.ahead + " 个提交（本地有而远程没有）："),
												repo.aheadCommits && repo.aheadCommits.length > 0
													? repo.aheadCommits.map((c, i) => h("div", { key: i, style: { fontSize: 12, color: T.secondary, lineHeight: 1.7, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)" } }, c))
													: null
											) : null
										) : h("div", { style: { color: T.success, fontSize: 13 } }, "✓ 已与远程同步，无差异。")
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
						h("div", { style: { position: "relative", zIndex: 1, width: 480, maxWidth: "calc(100vw - 48px)", background: "var(--dsw-alias-bg-layer-3, #fff)", border: "1px solid " + T.border, borderRadius: 14, padding: 18, color: T.label, boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))" }, role: "dialog", "aria-modal": "true", "aria-label": "选择目录" },
							h("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 10 } }, "选择代码目录"),
							h("div", { style: { fontSize: 12, color: T.secondary, marginBottom: 8, lineHeight: 1.6 } },
								"可手动输入/粘贴目录绝对路径，或点击「浏览…」弹出本地文件夹选择器。确认后将添加到下方下拉并记住，下次打开无需重新选择。"),
							h("input", {
								type: "text", value: pickPath, disabled: picking,
								placeholder: "C:\\Users\\你的用户名\\项目目录",
								onChange: (e) => setPickPath(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") void confirmPick(); },
								style: { width: "100%", boxSizing: "border-box", font: "inherit", fontSize: 13, padding: "8px 10px", border: "1px solid " + T.border, borderRadius: 8, background: T.layer1, color: T.label, outline: "none" },
							}),
							pickErr ? h("div", { style: { marginTop: 8, color: T.danger, fontSize: 12 } }, "❌ " + pickErr) : null,
							h("div", { style: { display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" } },
								h(Btn, { label: "浏览…", onClick: browseDir, disabled: picking, noBg: true }),
								h(Btn, { label: "取消", onClick: cancelPick, disabled: picking }),
								h(Btn, { label: "确定", onClick: confirmPick, tone: "primary", noBg: true, disabled: picking || !String(pickPath || "").trim() })
							)
						)
					),
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

		/** Chinese label for a changed-file status type. */
		function typeLabel(t) {
			return { untracked: "新增", added: "新增", deleted: "删除", renamed: "重命名", modified: "修改" }[t] || "修改";
		}
		/** Color for a changed-file status type. */
		function typeColor(t) {
			return { untracked: T.success, added: T.success, deleted: T.danger, renamed: T.warn, modified: T.brand }[t] || T.label;
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

		// ---------- the main panel ----------
		// `variant` 决定布局：'drawer'（右侧栏抽屉，显示关闭按钮）与 'tab'
		// （作为 dsh-better-sidebar 侧边栏 Tab 内容，填充容器、隐藏关闭按钮）。
		function ScmPanel({ onClose, variant }) {
			// 代码托管平台选择在②里操作、在③里跟随：lift 到面板级别共享。
			const [provider, setProvider] = useState("github");
			const embedded = variant === "tab" || variant === "drawer";
			return h("div", { style: panelStyle(variant), role: "dialog", "aria-modal": embedded ? undefined : "true", "aria-label": "源代码管理" },
				h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12 } },
					h("h2", { style: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.4, flex: 1 } }, "源代码管理"),
					embedded ? null : h("button", { type: "button", style: closeBtnStyle(T), "aria-label": "关闭", onClick: onClose }, "✕")
				),
				h("p", { style: { margin: "6px 0 14px", color: T.secondary, fontSize: 12, lineHeight: 1.6 } },
					"按顺序完成：①环境检查 → ②SSH 密钥与连接 → ③代码管理。推送会自动忽略 >100MB 的文件（" + (provider === "gitee" ? "Gitee" : "GitHub") + " 限制）并说明原因。"),
				h(EnvSection, null),
				h("div", { style: { height: 12 } }),
				h(SshSection, { provider, setProvider }),
				h("div", { style: { height: 12 } }),
				h(RepoSection, { provider })
			);
		}

		function panelStyle(variant) {
			// 'tab' / 'drawer'：填充宿主容器（不设固定宽高、无边框阴影圆角），由外层
			// （dsh-better-sidebar 的 Tab 区或右侧抽屉）负责尺寸与表面。
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

		function maskStyle() {
			return { position: "absolute", inset: 0, background: T.mask, backdropFilter: "var(--dsw-mask-blur, blur(4px))" };
		}

		/** 共享的「仓库 / 分支」小图标：既用于右上角浮动按钮，也用作侧边栏 Tab 图标。 */
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

		/** 右上角浮动按钮样式（未安装 dsh-better-sidebar 时的入口）。 */
		function floatBtnStyle() {
			return {
				position: "fixed", top: 12, right: 16, zIndex: 2147483000,
				display: "inline-flex", alignItems: "center", gap: 6,
				height: 32, padding: "0 12px", border: "none", borderRadius: 16,
				background: T.brand, color: "#fff", cursor: "pointer",
				fontSize: 13, lineHeight: 1,
				boxShadow: "var(--dsw-overlay-shadow, 0 4px 12px rgba(0,0,0,.3))",
			};
		}

		/** 右侧栏抽屉外层样式：右对齐、全高、固定宽度。 */
		function drawerStyle() {
			return {
				position: "relative", zIndex: 1, height: "100%", width: 640, maxWidth: "100vw",
				marginLeft: "auto", display: "flex", flexDirection: "column",
				boxSizing: "border-box", padding: 0,
				background: "var(--dsw-alias-bg-layer-3, #fff)", color: T.label,
				borderLeft: "1px solid " + T.border,
				boxShadow: "var(--dsw-overlay-shadow, 0 12px 32px rgba(0,0,0,.35))",
			};
		}

		// ---------- branch B:右上角浮动按钮 + 右侧抽屉入口 ----------
		// 未安装 dsh-better-sidebar 时使用：一个紧贴右上角的浮动按钮，点击后展开
		// 一个右侧栏抽屉（形态类似 dsh-better-sidebar 的右栏），内容放现有 ScmPanel。
		function ScmFloatingEntry() {
			const [open, setOpen] = useState(false);
			return h(React.Fragment, null,
				h("button", {
					type: "button",
					style: floatBtnStyle(),
					title: "源代码管理",
					"aria-label": "源代码管理",
					onClick: () => setOpen(true),
				}, repoIcon(16), h("span", { style: { fontSize: 13 } }, "代码管理")),
				open ? ReactDOM.createPortal(
					h("div", { style: { position: "fixed", inset: 0, zIndex: 1000 }, role: "presentation" },
						h("div", { style: maskStyle(), "aria-hidden": "true", onClick: () => setOpen(false) }),
						h("div", { style: drawerStyle() },
							h(ScmPanel, { variant: "drawer", onClose: () => setOpen(false) })
						)
					),
					document.body
				) : null
			);
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
		// 不写死 inject：better-sidebar 是可选集成，未安装时绝不能因为缺服务而让本
		// 插件报错。改在 apply 里用 ctx.get('betterSidebar') 判空——一次性属性读取，
		// 零 I/O、零网络，毫秒级，不影响 DSH 启动速度。
		const inject = [];

		function apply(ctx) {
			// DSH 打开（插件激活）时就预取环境/SSH/默认工作区/仓库状态，
			// 点开「代码管理」面板时直接使用缓存，无需重新加载。
			void preload();

			// better-sidebar 是可选集成：若本插件先于它激活，第一次读取会拿到 undefined；
			// 这里用一次性重试保证无论激活顺序如何，最终都能正确落到分支 A（注册 Tab）。
			let entryUnmount = null;

			const tryRegisterTab = () => {
				const bs = typeof ctx.get === "function" ? ctx.get("betterSidebar") : undefined;
				if (!bs || typeof bs.registerTab !== "function") return false;
				// 分支 A：已安装 dsh-better-sidebar —— 把「代码管理」注册成它的侧边栏新 Tab
				// 页面。ctx.effect 保证 HMR / 插件卸载时自动注销该 Tab。
				ctx.effect(() => bs.registerTab({
					id: PLUGIN_ID,
					title: "代码管理",
					icon: (size) => repoIcon(size),
					order: 50,
					single: true,
					component: () => h(ScmPanel, { variant: "tab" }),
				}));
				// 若此前已挂载了分支 B 的浮动按钮，立即拆除它。
				if (entryUnmount) { entryUnmount(); entryUnmount = null; }
				return true;
			};

			if (tryRegisterTab()) return;

			// 分支 B：此刻未检测到 dsh-better-sidebar —— 右上角浮动按钮 + 右侧栏抽屉。
			if (!ReactDOM) return;
			ctx.effect(() => {
				const hostEl = document.createElement("div");
				hostEl.setAttribute("data-source-code-mgmt-entry", "");
				document.body.appendChild(hostEl);
				const root = mountClientRoot(hostEl, h(ScmFloatingEntry));
				entryUnmount = () => {
					try { if (root && typeof root.unmount === "function") root.unmount(); } catch {}
					hostEl.remove();
				};
				return () => { if (entryUnmount) { entryUnmount(); entryUnmount = null; } };
			});

			// 兜底重试一次：better-sidebar 若在本插件之后激活，延迟补注册 Tab 并拆除浮动按钮。
			// 单次 setTimeout，无轮询、零 I/O，几乎不耗资源；插件卸载时清除。
			const retryTimer = window.setTimeout(() => { tryRegisterTab(); }, 1500);
			ctx.effect(() => () => window.clearTimeout(retryTimer));
		}

		exports.name = PLUGIN_ID;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
