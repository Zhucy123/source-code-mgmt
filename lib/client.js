/**
 * source-code-mgmt — browser half (client.js).
 *
 * Classic-script plugin bundle (no build step): registers into the sidebar
 * footer via the official `sidebar.footer.action` list slot with a negative
 * order so the trigger renders at the bottom of the left rail (above other
 * footer entries). Clicking the trigger opens a "源代码管理" panel with:
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
							cache.repo = await jget("/repo?dir=" + encodeURIComponent(def.dir)).catch(() => null);
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
		function Box({ title, children }) {
			return h("div", { style: { border: "1px solid " + T.border, borderRadius: 12, padding: 14 } },
				h("div", { style: { fontSize: 13, fontWeight: 600, color: T.label, marginBottom: 10 } }, title),
				children
			);
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

			return h(Box, { title: "① 环境检查" },
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
		function SshSection() {
			const [ssh, setSsh] = useState(() => cache.ssh);
			const [busy, setBusy] = useState(false);
			const [msg, setMsg] = useState(null);
			const [err, setErr] = useState(null);

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

			return h(Box, { title: "② SSH 密钥与连接" },
				// key status
				h(Field, { label: "密钥" }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (ssh.hasKey ? "✅ id_ed25519 已生成" : "⚠️ 未生成") : "…")
				),
				h(Field, { label: "GH 登录" }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (ssh.ghLoggedIn ? "✅ " + (ssh.ghAccount || "已登录") : "⚠️ 未登录") : "…")
				),
				h(Field, { label: "SSH 配置" }, h("span", { style: { color: T.label, fontSize: 13 } },
					ssh ? (ssh.sshGitHubConfigured ? "✅ github.com 已配置(443)" : "⚠️ 未配置/限制 22 端口需配置") : "…")
				),

				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 } },
					h(Btn, { label: "生成密钥", onClick: () => act("/gen-key", "生成密钥"), disabled: busy }),
					h(Btn, { label: "配置 SSH(config)", onClick: () => act("/write-config", "配置 SSH"), disabled: busy }),
					h(Btn, { label: "测试连接", onClick: async () => {
						setBusy(true); setErr(null); setMsg(null);
						try {
							const r = await jpost("/ssh-test");
							if (r.connected) setMsg("SSH 连接成功：" + (r.account ? "Hi " + r.account : "已认证"));
							else setErr("连接失败，请确认密钥已上传到 GitHub 或已登录 gh");
							void load();
						} catch (e) { setErr("测试失败：" + e); }
						finally { setBusy(false); }
					}, tone: "primary", noBg: true, disabled: busy }),
				),
				ssh && ssh.pubContent ? h("div", { style: { marginTop: 10 } },
					h("div", { style: { color: T.secondary, fontSize: 12, marginBottom: 4 } }, "公钥（复制上传到 GitHub → Settings → SSH keys，或运行 gh auth login 自动上传）："),
					h("code", { style: { display: "block", whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, lineHeight: 1.5, color: T.secondary, background: T.layer1, padding: 10, borderRadius: 8 } }, ssh.pubContent)
				) : null,
				msg ? h("div", { style: { marginTop: 10, color: T.success, fontSize: 13 } }, "✅ " + msg) : null,
				err ? h("div", { style: { marginTop: 10, color: T.danger, fontSize: 13 } }, "❌ " + err) : null,
				(!ssh || ssh.gitHubNotConfigured) ? null : null
			);
		}

		// ---------- section 3: 代码管理 ----------
		function RepoSection() {
			const [dir, setDir] = useState(() => cache.defDir ?? "");
			const [dirDraft, setDirDraft] = useState(() => cache.defDir ?? "");
			const [repo, setRepo] = useState(() => cache.repo);
			const [busy, setBusy] = useState(false);
			const [result, setResult] = useState(null);
			const [msg, setMsg] = useState(null);
			const [err, setErr] = useState(null);
			const [visibility, setVisibility] = useState("private");
			const [workspaces, setWorkspaces] = useState(() => cache.workspaces || []);
			// 自定义目录（用户手动选择的非 DSH 工作区，持久化于插件本地），用于给下拉项加 X 删除
			const [customDirs, setCustomDirs] = useState(() => cache.customDirs || []);
			// 详情弹窗：'changes'（改动文件列表）| 'sync'（同步差异）| null（关闭）
			const [detail, setDetail] = useState(null);
			// 仓库名称强制 = 文件夹名（不允许手动填写）
			const repoName = (repo && repo.defaultRepoName) || "";
			// 目录选择器状态
			const [pickOpen, setPickOpen] = useState(false);
			const [pickPath, setPickPath] = useState("");
			const [pickErr, setPickErr] = useState(null);
			const [picking, setPicking] = useState(false);

			const loadRepo = useCallback(async (d, keepRepo) => {
				setErr(null);
				if (!keepRepo) setRepo(null);
				try {
					const r = await jget("/repo?dir=" + encodeURIComponent(d));
					setRepo(r);
					// 默认选中当前工作区：/repo 在未传 dir 时返回当前工作区路径，
					// 把返回的实际目录同步到输入框和当前选中目录。
					if (r && r.dir) {
						setDirDraft(r.dir);
						setDir(r.dir);
						cache.defDir = r.dir;
					}
					// 缓存最新 repo 状态
					cache.repo = r;
					// 仓库已存在且能读到实际可见性时，让下拉框默认选中实际状态，
					// 这样「修改仓库状态」按钮只在用户主动切换时出现。
					if (r && r.repoExists === true && (r.visibility === "public" || r.visibility === "private")) {
						setVisibility(r.visibility);
					}
					if (r && !r.isGitRepo) setErr(r.error || "该目录不是 git 仓库");
				} catch (e) { setErr(String(e)); }
			}, []);

			useEffect(() => {
				// 首次加载：先看缓存（DSH 打开时已预取当前工作区），秒显；
				// 无缓存则 preload（取默认工作区）后加载。
				if (cache.repo) {
					setRepo(cache.repo);
					if (cache.defDir) { setDir(cache.defDir); setDirDraft(cache.defDir); }
				}
				if (cache.workspaces && cache.workspaces.length) setWorkspaces(cache.workspaces);
				if (cache.customDirs && cache.customDirs.length) setCustomDirs(cache.customDirs);
				void preload().then(() => {
					if (cache.workspaces && cache.workspaces.length) setWorkspaces(cache.workspaces);
					if (cache.customDirs && cache.customDirs.length) setCustomDirs(cache.customDirs);
					// 默认工作区：优先 defDir，否则第一个工作区
					const d = cache.defDir
						|| (cache.workspaces && cache.workspaces[0])
						|| dir || "";
					if (d) { setDir(d); setDirDraft(d); loadRepo(d); }
				});
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, []);

			const push = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/push", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg("已推送");
					else setErr(r.error || r.pushError || "推送失败");
					void loadRepo(dir, true);
				} catch (e) { setErr("推送失败：" + e); }
				finally { setBusy(false); }
			}, [dir, loadRepo]);

			const pull = useCallback(async () => {
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/pull", { dir: dir || undefined });
					setResult(r);
					if (r.ok) setMsg(r.upToDate ? "已是最新，无需拉取" : "拉取成功，已更新到最新");
					else setErr(r.error || "拉取失败");
					void loadRepo(dir, true);
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
					void loadRepo(dir, true);
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
					void loadRepo(dir, true);
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
					void loadRepo(dir, true);
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
					const r = await jpost("/set-visibility", { dir: dir || undefined, name, visibility: target });
					setResult(r);
					if (r.ok) setMsg("已把仓库设置为「" + (target === "public" ? "公开" : "私有") + "」");
					else setErr(r.error || "修改可见性失败");
					void loadRepo(dir, true);
				} catch (e) { setErr("修改可见性失败：" + e); }
				finally { setBusy(false); }
			}, [dir, repo, visibility, loadRepo]);

			const create = useCallback(async () => {
				const name = (repo && repo.defaultRepoName) || "";
				if (!name) { setErr("请先加载一个有效的文件夹"); return; }
				setBusy(true); setMsg(null); setErr(null); setResult(null);
				try {
					const r = await jpost("/create", { dir: dir || undefined, name, visibility });
					setResult(r);
					if (r.ok) setMsg("仓库已创建并推送：" + (r.url || name));
					else setErr(r.error || "创建失败");
					void loadRepo(dir, true);
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
				customDirs && customDirs.length > 0 ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10, alignItems: "center" } },
					h("span", { style: { color: T.secondary, fontSize: 12, whiteSpace: "nowrap" } }, "自定义目录："),
					customDirs.map((cd) => h("span", { key: cd, style: { display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", border: "1px solid " + T.border, borderRadius: 12, fontSize: 12, background: T.layer1, color: T.label, cursor: "pointer" }, title: cd, onClick: () => { setResult(null); setMsg(null); setErr(null); setDir(cd); setDirDraft(cd); loadRepo(cd); } },
						String(cd).split(/[\\/]/).filter(Boolean).pop() || cd,
						h("span", {
							role: "button", "aria-label": "删除该目录记录",
							title: "删除该目录记录（不删除实际文件夹）",
							onClick: (e) => { e.stopPropagation(); void removeWorkspace(cd); },
							style: { color: T.danger, fontWeight: 700, padding: "0 2px", cursor: "pointer" },
						}, "✕")
					))
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
							(repo.ahead > 0 ? "本地领先 " + repo.ahead + " 提交" : "") +
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
							// 本地和远程都有更新 -> 三按钮：合并推送 / 强制推送 / 强制拉取
							btns.push(h(Btn, { key: "mp", label: "拉取更新并推送更改", onClick: mergePush, tone: "primary", noBg: true, disabled: isBlocked }));
							btns.push(h(Btn, { key: "fp", label: "强制推送", onClick: forcePush, disabled: isBlocked, title: "用本地版本覆盖远程（远程非本地更改被丢弃）" }));
							btns.push(h(Btn, { key: "fpl", label: "强制拉取", onClick: forcePull, disabled: isBlocked, title: "强制并入远程更新" }));
						} else if (localChanges) {
							// 只有本地有更改 -> 只显示推送（正常 push）
							btns.push(h(Btn, { key: "push", label: "推送更改", onClick: push, tone: "primary", noBg: true, disabled: isBlocked || repo?.repoExists === false }));
						} else if (remoteUpdates) {
							// 只有远程有更新 -> 只显示拉取（正常 pull）
							btns.push(h(Btn, { key: "pull", label: "拉取更新", onClick: pull, disabled: isBlocked || repo?.repoExists !== true }));
						} else {
							// 完全同步 -> 无按钮，显示已是最新
							btns.push(h("span", { key: "synced", style: { color: T.success, fontSize: 13 } }, "✓ 已是最新"));
						}
						// 有远程时总是提供「强制对齐」作为兜底（本地完全重置为远程状态）
						if (repo && repo.isGitRepo) {
							btns.push(h(Btn, { key: "align", label: "强制对齐", onClick: align, disabled: isBlocked, title: "本地完全重置为远程分支（丢弃本地差异），解决“文件相同仍显示同步差异”的情况" }));
						}
					}
					return h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
						btns,
						h(Btn, { label: "刷新状态", onClick: () => { setResult(null); setMsg(null); setErr(null); loadRepo(dir); }, disabled: busy })
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
						: h("span", { style: { color: T.secondary } }, "⚠️ 同名仓库已经创建（无法读取当前可见性，可能未登录 gh）")
				) : repo && repo.repoExists === false ? h("div", { style: { marginTop: 8, color: T.success, fontSize: 12 } },
					"✓ 同名仓库 " + repoName + " 不存在，可「新建仓库并推送」创建（可选私有/公开）。"
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
										? repo.changedFiles.map((f, i) => h("div", { key: i, style: { display: "flex", gap: 8, alignItems: "baseline", fontSize: 13, lineHeight: 1.8, borderBottom: "1px solid " + T.border, padding: "3px 2px" } },
											h("span", { style: { color: typeColor(f.type), fontSize: 11, flexShrink: 0, width: 52 } }, typeLabel(f.type)),
											h("span", { style: { color: T.label, wordBreak: "break-all", flex: 1 } }, f.path)
										))
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

		// ---------- the main panel ----------
		function ScmPanel({ onClose }) {
			return h("div", { style: panelStyle(T), role: "dialog", "aria-modal": "true", "aria-label": "源代码管理" },
				h("div", { style: { display: "flex", alignItems: "flex-start", gap: 12 } },
					h("h2", { style: { margin: 0, fontSize: 16, fontWeight: 600, lineHeight: 1.4, flex: 1 } }, "源代码管理"),
					h("button", { type: "button", style: closeBtnStyle(T), "aria-label": "关闭", onClick: onClose }, "✕")
				),
				h("p", { style: { margin: "6px 0 14px", color: T.secondary, fontSize: 12, lineHeight: 1.6 } },
					"按顺序完成：①环境检查 → ②SSH 密钥与连接 → ③代码管理。推送会自动忽略 >100MB 的文件（GitHub 限制）并说明原因。"),
				h(EnvSection, null),
				h("div", { style: { height: 12 } }),
				h(SshSection, null),
				h("div", { style: { height: 12 } }),
				h(RepoSection, null)
			);
		}

		function panelStyle() {
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

		function overlayStyle() {
			return { position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" };
		}
		function maskStyle() {
			return { position: "absolute", inset: 0, background: T.mask, backdropFilter: "var(--dsw-mask-blur, blur(4px))" };
		}

		// ---------- the sidebar footer trigger ----------
		function ScmTrigger({ wide }) {
			const [open, setOpen] = useState(false);

			const icon = h("svg", {
				viewBox: "0 0 16 16", width: wide ? 16 : 18, height: wide ? 16 : 18,
				fill: "none", stroke: "currentColor", strokeWidth: 1.5,
				strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
			},
				// a simplified "repo / branch" glyph: a small box with a branch
				h("rect", { x: "1.5", y: "2.5", width: "9", height: "11", rx: "1.5" }),
				h("path", { d: "M14 6.5v3.5a2 2 0 0 1-2 2H5.5" })
			);

			const wideStyle = {
				display: "inline-flex", alignItems: "center", gap: 6,
				height: 30, padding: "0 12px", border: "none", borderRadius: 15,
				background: "transparent", color: T.secondary, cursor: "pointer",
				fontSize: 13, lineHeight: 1,
			};
			const railStyle = {
				display: "inline-flex", alignItems: "center", justifyContent: "center",
				width: 36, height: 36, border: "none", borderRadius: "50%", padding: 0,
				background: "transparent", color: T.secondary, cursor: "pointer",
			};

			return h(React.Fragment, null,
				h("button", {
					type: "button",
					style: wide ? wideStyle : railStyle,
					title: "源代码管理",
					"aria-label": "源代码管理",
					onClick: () => setOpen(true),
					onMouseEnter: (e) => { e.currentTarget.style.background = T.hover; e.currentTarget.style.color = T.label; },
					onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = T.secondary; },
				},
					icon,
					wide ? h("span", { style: { fontSize: 13 } }, "代码管理") : null
				),
				open ? ReactDOM.createPortal(
					h("div", { style: overlayStyle(), role: "presentation" },
						h("div", { style: maskStyle(), "aria-hidden": "true", onClick: () => setOpen(false) }),
						h(ScmPanel, { onClose: () => setOpen(false) })
					),
					document.body
				) : null
			);
		}

		// ---------- cordis plugin body ----------
		const inject = ["slots"];

		function apply(ctx) {
			// DSH 打开（插件激活）时就预取环境/SSH/默认工作区/仓库状态，
			// 点开「代码管理」面板时直接使用缓存，无需重新加载。
			void preload();
			if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: PLUGIN_ID,
				order: -100,
			}, ScmTrigger));
		}

		exports.name = PLUGIN_ID;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
