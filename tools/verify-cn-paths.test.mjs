/**
 * Verify Chinese (non-ASCII) file names survive the plugin's git path parsing,
 * and that the new "viewable" / untracked-content logic works:
 *  - run() injects `-c core.quotepath=false` for git (raw UTF-8 paths);
 *  - parseGitPath() decodes any quoted octal-escaped path (fallback);
 *  - fileViewable() sniffs NUL bytes (text vs binary) and falls back to
 *    `git diff --numstat` for deleted files ("-\t-" = binary);
 *  - repoDiffFlow() returns untracked text files as an "all added" unified
 *    diff (renders as additions in the side-by-side view), and marks binary
 *    files viewable:false.
 * Run with:  node tools/verify-cn-paths.test.mjs
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const WORKSPACE = 'C:\\Users\\Administrator\\workspace'
const GIT = 'git'

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
      let v = 0, n = 0
      while (n < 3 && i + 1 + n < inner.length) {
        const d = inner.charCodeAt(i + 1 + n) - 48
        if (d < 0 || d > 7) break
        v = v * 8 + d
        n++
      }
      bytes.push(v); i += n; continue
    }
    const esc = { a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '"': 0x22, '\\': 0x5c }[nxt]
    if (esc !== undefined) { bytes.push(esc); i++; continue }
    bytes.push(inner.charCodeAt(i))
  }
  return Buffer.from(bytes).toString('utf8')
}

function run(cmd, args) {
  const finalArgs = cmd === GIT ? ['-c', 'core.quotepath=false', ...args] : args
  try {
    return { ok: true, stdout: execFileSync(cmd, finalArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e.message) }
  }
}

/** Mirrors lib/index.js fileViewable(). */
function fileViewable(dir, p, type) {
  try {
    const fd = fs.openSync(path.join(dir, p), 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      return !buf.subarray(0, n).includes(0)
    } finally { fs.closeSync(fd) }
  } catch {
    const cached = type === 'added' || type === 'renamed'
    const r = run(GIT, ['-C', dir, 'diff', ...(cached ? ['--cached', '--numstat'] : ['--numstat']), '--', p])
    const line = (r.stdout || '').split(/\r?\n/).find((l) => l.trim() !== '')
    return line ? !line.startsWith('-\t-') : false
  }
}

/** Mirrors lib/index.js repoDiffFlow() untracked branch. */
function untrackedDiff(dir, p) {
  const full = path.join(dir, p)
  let buf
  try { buf = fs.readFileSync(full) } catch { return { viewable: false, diff: '' } }
  if (buf.includes(0)) return { viewable: false, diff: '' }
  const content = buf.toString('utf8')
  const noFinalNl = !/[\r\n]$/.test(content)
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return { viewable: true, diff: '' }
  const shown = lines.slice(0, 2000)
  const truncated = lines.length > shown.length
  let body = shown.map((l) => '+' + l).join('\n')
  if (truncated) body += '\n+…（内容较长，仅显示前 ' + shown.length + ' 行）'
  if (noFinalNl) body += '\n\\ No newline at end of file'
  const head = 'diff --git a/' + p + ' b/' + p + '\n--- /dev/null\n+++ b/' + p + '\n@@ -0,0 +1,' + shown.length + ' @@\n'
  return { viewable: true, diff: head + body + '\n' }
}

/** Mirrors client.js parseUnifiedDiff() (additions detection only). */
function allLinesAdded(diff) {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const added = []
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('\\')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
  }
  return added
}

/** Mirrors client.js parseUnifiedDiff() — row types only (newOnly detection). */
function diffRowTypes(diff) {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const types = []
  for (const line of lines) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ') || line.startsWith('\\')) continue
    const c = line.charAt(0)
    if (c === '-') types.push('del')
    else if (c === '+') types.push('add')
    else if (c === ' ') types.push('ctx')
  }
  return types
}

let failures = 0
const check = (label, got, want) => {
  const ok = got === want
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + '  =>  ' + JSON.stringify(got))
  if (!ok) failures++
}

// ---- 1) real workspace: porcelain pipeline decodes Chinese name ----
const TARGET = WORKSPACE + '\\游戏模式Agent预设.md'
const original = fs.readFileSync(TARGET, 'utf8')
try {
  fs.appendFileSync(TARGET, '\n# cn-path-test\n')
  const st = run(GIT, ['-C', WORKSPACE, 'status', '--porcelain'])
  const parsed = st.stdout.split(/\r?\n/).filter(l => l.trim() !== '').map(line => {
    const code = line.slice(0, 2)
    let path = line.slice(3)
    if (/^(R|C)/.test(code)) { const a = path.indexOf(' -> '); if (a !== -1) path = path.slice(a + 4) }
    path = parseGitPath(path)
    return { type: /^\?\?/.test(code) ? 'untracked' : 'modified', path, viewable: fileViewable(WORKSPACE, path, /^\?\?/.test(code) ? 'untracked' : 'modified') }
  })
  const hit = parsed.find(f => f.path === '游戏模式Agent预设.md')
  check('porcelain decodes Chinese name', hit ? hit.path : '(not found)', '游戏模式Agent预设.md')
  check('modified text file is viewable', hit ? hit.viewable : false, true)
} finally {
  fs.writeFileSync(TARGET, original, 'utf8')
}

// ---- 2) scratch repo: untracked text/binary, deleted text/binary ----
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-cn-'))
try {
  run(GIT, ['-C', scratch, 'init', '-q'])
  run(GIT, ['-C', scratch, 'config', 'user.email', 't@t'])
  run(GIT, ['-C', scratch, 'config', 'user.name', 't'])
  // untracked text file with a Chinese name
  const newTxt = path.join(scratch, '新文件-说明.md')
  fs.writeFileSync(newTxt, '第一行\n第二行\n', 'utf8')
  // untracked binary file
  const newBin = path.join(scratch, '新图片.bin')
  fs.writeFileSync(newBin, Buffer.concat([Buffer.from('PNG'), Buffer.from([0, 0, 0, 1])]))

  check('untracked text is viewable', fileViewable(scratch, '新文件-说明.md', 'untracked'), true)
  check('untracked binary is NOT viewable', fileViewable(scratch, '新图片.bin', 'untracked'), false)

  const td = untrackedDiff(scratch, '新文件-说明.md')
  check('untracked text diff viewable', td.viewable, true)
  const addedLines = allLinesAdded(td.diff)
  check('untracked diff all lines added', addedLines.join('|'), '第一行|第二行')
  check('untracked diff has @@ header', /@@ -0,0 \+1,2 @@/.test(td.diff), true)
  // 客户端渲染：无删除行 => newOnly（不显示旧版本列）
  const tdTypes = diffRowTypes(td.diff)
  check('untracked diff has NO del rows (newOnly => hide 旧版本)', tdTypes.includes('del'), false)
  check('untracked diff has add rows', tdTypes.includes('add'), true)

  // 修改文件（有增有删）=> 保留双列
  fs.writeFileSync(path.join(scratch, '修改.md'), 'a\nb\n', 'utf8')
  run(GIT, ['-C', scratch, 'add', '-A'])
  run(GIT, ['-C', scratch, 'commit', '-q', '-m', 'c2'])
  fs.writeFileSync(path.join(scratch, '修改.md'), 'a\nc\n', 'utf8')
  const modDiff = run(GIT, ['-C', scratch, 'diff', '--', '修改.md']).stdout
  const modTypes = diffRowTypes(modDiff)
  check('modified diff HAS del rows (keeps both columns)', modTypes.includes('del'), true)
  check('modified diff HAS add rows', modTypes.includes('add'), true)

  const bd = untrackedDiff(scratch, '新图片.bin')
  check('untracked binary diff NOT viewable', bd.viewable, false)

  // tracked text + binary, then delete both: numstat-based viewability
  fs.writeFileSync(path.join(scratch, '已跟踪文本.txt'), 'a\nb\n', 'utf8')
  fs.writeFileSync(path.join(scratch, '已跟踪二进制.bin'), Buffer.from([1, 2, 0, 3]))
  run(GIT, ['-C', scratch, 'add', '-A'])
  run(GIT, ['-C', scratch, 'commit', '-q', '-m', 'init'])
  fs.unlinkSync(path.join(scratch, '已跟踪文本.txt'))
  fs.unlinkSync(path.join(scratch, '已跟踪二进制.bin'))
  check('deleted text still viewable', fileViewable(scratch, '已跟踪文本.txt', 'deleted'), true)
  check('deleted binary NOT viewable', fileViewable(scratch, '已跟踪二进制.bin', 'deleted'), false)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}

// ---- 3) defensive: default octal-quoted output still decodes ----
const raw = execFileSync(GIT, ['-C', WORKSPACE, 'status', '--porcelain'], { encoding: 'utf8' })
const rawLine = raw.split(/\r?\n/).find(l => l.includes('游戏') || l.includes('\\346'))
if (rawLine) {
  check('parseGitPath unquotes default octal-escaped output', parseGitPath(rawLine.slice(3)), '游戏模式Agent预设.md')
} else {
  console.log('SKIP  default-quoted line not present (quotepath already false)')
}
const renamed = parseGitPath('"\\346\\270\\270\\346\\210\\217.md"')
check('parseGitPath rename dest', renamed, '游戏.md')

process.exit(failures === 0 ? 0 : 1)
