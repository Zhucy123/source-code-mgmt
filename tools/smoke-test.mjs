// 冒烟测试：纯逻辑（不依赖 cordis ctx）——URL 解析 / YAML 默认模型解析 / JSON 宽松解析 /
// ⑤ 的条目路径与重生成命令安全校验。这些函数在 lib/index.js 与这里各有一份拷贝，
// 需保持逻辑同步（host 端模块未导出，故在测试脚本内复制验证）。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---- 与 lib/index.js 保持一致的纯逻辑拷贝 ----

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

function parseDefaultModelFromYaml(file) {
  const raw = readFileSync(file, 'utf8')
  const m = /^\s*agent-default-model\s*:\s*\n((?:[ \t]+[^\n]*(?:\n|$))*)/m.exec(raw)
  if (!m) return null
  const block = m[1]
  const prov = /^\s*provider\s*:\s*"?([^\s"#]+)"?/m.exec(block)
  const mod = /^\s*model\s*:\s*"?([^\s"#]+)"?/m.exec(block)
  return prov && mod ? { provider: prov[1], model: mod[1] } : null
}

function parseJsonLoose(s) {
  s = String(s || '').trim()
  try { return JSON.parse(s) } catch { /* continue */ }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

// 条目路径安全校验（与 lib/index.js safeEntryPath 一致）。
function safeEntryPath(cloneDir, p) {
  if (typeof p !== 'string' || p === '') return false
  if (/^([a-zA-Z]:[\\/]|\/|\\)/.test(p)) return false
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return false
  const root = join(cloneDir, p)
  const base = cloneDir.replace(/[\\/]+$/, '')
  return root === base || root.startsWith(base + '\\') || root.startsWith(base + '/')
}

// 重生成命令安全校验（与 lib/index.js safeRegenerateCommand 一致）。
const SAFE_REGENERATE_BINS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun',
  'python', 'python3', 'py',
  'make', 'cmake',
  'sh', 'bash', 'zsh',
  'ruby', 'perl', 'php',
  'dotnet', 'go', 'cargo', 'rustc',
  'git', 'awk', 'sed', 'grep', 'cat',
])
const SHELL_META_PATTERN = /[|&;<>`$]/
function safeRegenerateCommand(cmds) {
  if (!Array.isArray(cmds) || cmds.length === 0) return false
  const bin = String(cmds[0] || '').trim()
  if (bin === '') return false
  if (/[\\/]/.test(bin)) return false
  if (!SAFE_REGENERATE_BINS.has(bin)) return false
  for (let i = 1; i < cmds.length; i++) {
    const a = String(cmds[i] ?? '')
    if (SHELL_META_PATTERN.test(a)) return false
  }
  return true
}

let failures = 0
function eq(label, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) { console.log('✅', label) }
  else { console.log('❌', label, 'got', g, 'want', w); failures++ }
}

// URL 解析
eq('gh https', parseRepoUrl('https://github.com/Zhucy123/source-code-mgmt'), { provider: 'github', owner: 'Zhucy123', repo: 'source-code-mgmt' })
eq('gh ssh', parseRepoUrl('git@github.com:awesome-dsh-plugin/awesome-dsh-plugin.git'), { provider: 'github', owner: 'awesome-dsh-plugin', repo: 'awesome-dsh-plugin' })
eq('bare owner/repo', parseRepoUrl('owner/repo'), { provider: 'github', owner: 'owner', repo: 'repo' })
eq('gitee https', parseRepoUrl('https://gitee.com/zhucy2100/myrepo'), { provider: 'gitee', owner: 'zhucy2100', repo: 'myrepo' })
eq('gitee ssh', parseRepoUrl('git@gitee.com:zhucy2100/myrepo.git'), { provider: 'gitee', owner: 'zhucy2100', repo: 'myrepo' })
eq('dot in repo name', parseRepoUrl('https://github.com/owner/my.repo'), { provider: 'github', owner: 'owner', repo: 'my.repo' })
eq('dot in bare', parseRepoUrl('owner/my.repo'), { provider: 'github', owner: 'owner', repo: 'my.repo' })
eq('empty', parseRepoUrl(''), {})
eq('invalid no owner', parseRepoUrl('not-a-url'), {})
eq('emoji repo raw', parseRepoUrl('https://github.com/owner/%E2%9A%99'), { provider: 'github', owner: 'owner', repo: '%E2%9A%99' })

// JSON 宽松解析（AI 可能包裹 markdown）
eq('loose json in fence', parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 })
eq('loose plain', parseJsonLoose('{"steps":[]}'), { steps: [] })
eq('loose invalid', parseJsonLoose('no json here'), null)

// safeEntryPath
const cd = join(homedir(), '.dsh-staging', 'repo-fork')
eq('safe normal', safeEntryPath(cd, join('data', 'plugins', 'owner__repo.yml')), true)
eq('safe root file', safeEntryPath(cd, 'entry.yml'), true)
eq('traversal ../', safeEntryPath(cd, '..' + '\\' + 'evil.yml'), false)
eq('traversal nested ../../', safeEntryPath(cd, 'a\\..\\..\\evil.yml'), false)
eq('traversal backslash', safeEntryPath(cd, 'data\\..\\evil.yml'), false)
eq('absolute root', safeEntryPath(cd, join('/', 'tmp', 'evil.yml')), false)
eq('win drive abs', safeEntryPath(cd, 'C:' + '\\' + 'evil.yml'), false)
eq('empty path', safeEntryPath(cd, ''), false)

// safeRegenerateCommand
eq('node ok', safeRegenerateCommand(['node', 'scripts/gen.mjs']), true)
eq('npx ok', safeRegenerateCommand(['npx', 'prettier', '--write', 'README.md']), true)
eq('absent bin', safeRegenerateCommand(['rm', '-rf', '/']), false)
eq('wrong case rm', safeRegenerateCommand(['rm']), false)
eq('shell pipe', safeRegenerateCommand(['node', 'a.js', '|', 'sh']), false)
eq('only bin no args', safeRegenerateCommand(['node']), true)
eq('empty list', safeRegenerateCommand([]), false)
eq('abs bin path', safeRegenerateCommand(['/usr/bin/node', 'x.js']), false)
eq('cmd substitution', safeRegenerateCommand(['node', '$(rm -rf)']), false)
eq('semicolon', safeRegenerateCommand(['node', 'a.js;evil']), false)

// 真实 settings.yaml 的默认模型解析
try {
  const m = parseDefaultModelFromYaml(join(homedir(), '.dsh', 'settings.yaml'))
  console.log('ℹ️  ~/.dsh/settings.yaml agent-default-model =', JSON.stringify(m))
  if (m) eq('yaml default-model provider', typeof m.provider === 'string' && m.provider.length > 0, true)
  else { console.log('⚠️ 未能从 settings.yaml 解析默认模型（settings 服务可用时会走服务路径，此项可忽略）') }
} catch (e) {
  console.log('⚠️ settings.yaml 读取失败（可忽略）:', e.message)
}

process.exit(failures ? 1 : 0)