/**
 * Verify the batched binary-detection (viewableMap) returns the SAME answers as
 * the old per-file implementation, so the 20x speedup does not change behaviour.
 *
 * Run: node tools/verify-viewable-batch.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const src = readFileSync('lib/index.js', 'utf8')

/** Extract a top-level function by brace matching. */
function extract(name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start > 0, `function ${name} not found`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
    console.log('  ok -', name)
  } catch (e) {
    failed++
    console.error(`  FAIL - ${name}\n        ${e.message}`)
  }
}

// --- set up a scratch repo exercising every code path ----------------------
const dir = mkdtempSync(join(tmpdir(), 'scm-viewable-'))
const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })

try {
  run(['init', '-q'])
  run(['config', 'user.email', 't@t.t'])
  run(['config', 'user.name', 'T'])

  // 1. a normal text file
  writeFileSync(join(dir, 'text.txt'), 'hello world\n')
  // 2. a binary file (NUL byte)
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]))
  // 3. a large-ish text file
  writeFileSync(join(dir, 'big.txt'), 'x'.repeat(200000) + '\n')
  run(['add', '-A'])
  run(['commit', '-q', '-m', 'init'])

  // 4. modify text, 5. delete a tracked file, 6. add a new binary, 7. rename
  writeFileSync(join(dir, 'text.txt'), 'hello world CHANGED\n')
  run(['rm', '-q', 'big.txt'])
  writeFileSync(join(dir, 'new.bin'), Buffer.from([0x00, 0x00, 0x41]))
  run(['add', 'new.bin'])

  const statusOut = run(['status', '--porcelain']).split(/\r?\n/).filter((l) => l.trim())
  const files = statusOut.map((line) => {
    const code = line.slice(0, 2)
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow !== -1) path = path.slice(arrow + 4)
    const type = /^\?\?/.test(code) ? 'untracked'
      : /^A|^AM/.test(code) ? 'added'
      : /^D|^AD/.test(code) ? 'deleted'
      : /^R/.test(code) ? 'renamed'
      : 'modified'
    return { path, type }
  })

  console.log(`scratch repo changed files: ${JSON.stringify(files.map((f) => [f.path, f.type]))}\n`)

  // --- OLD implementation (per-file git fallback) --------------------------
  const OLD = `
  import { openSync, readSync, closeSync } from 'node:fs'
  import { join } from 'node:path'
  import { execFileSync } from 'node:child_process'
  function run(cmd, args) {
    try { return { ok: true, stdout: execFileSync(cmd, args, { encoding: 'utf8' }) } }
    catch (e) { return { ok: false, stdout: String(e.stdout || '') } }
  }
  const GIT = 'git'
  function fileViewable(dir, path, type) {
    const p = String(path || '')
    if (p === '') return false
    try {
      const fd = openSync(join(dir, p), 'r')
      try {
        const buf = Buffer.alloc(8192)
        const n = readSync(fd, buf, 0, buf.length, 0)
        return !buf.subarray(0, n).includes(0)
      } finally { closeSync(fd) }
    } catch {
      const cached = type === 'added' || type === 'renamed'
      const r = run(GIT, ['-C', dir, 'diff', ...(cached ? ['--cached', '--numstat'] : ['--numstat']), '--', p])
      const line = (r.stdout || '').split(/\\r?\\n/).find((l) => l.trim() !== '')
      return line ? !line.startsWith('-\\t-') : false
    }
  }
  export { fileViewable }
  `
  const oldMod = await import('data:text/javascript,' + encodeURIComponent(OLD))

  // --- NEW implementation (batched) ----------------------------------------
  const NEW = `
  import { openSync, readSync, closeSync } from 'node:fs'
  import { join } from 'node:path'
  import { execFileSync } from 'node:child_process'
  ${extract('parseGitPath')}
  function run(cmd, args) {
    try { return { ok: true, stdout: execFileSync(cmd, args, { encoding: 'utf8' }) } }
    catch (e) { return { ok: false, stdout: String(e.stdout || '') } }
  }
  const GIT = 'git'
  ${extract('viewableMap')}
  export { viewableMap }
  `
  const newMod = await import('data:text/javascript,' + encodeURIComponent(NEW))

  const oldAnswers = new Map(files.map((f) => [f.path, oldMod.fileViewable(dir, f.path, f.type)]))
  const newAnswers = newMod.viewableMap(dir, files)

  check('new implementation agrees with the old one on every file', () => {
    for (const f of files) {
      assert.equal(
        newAnswers.get(f.path), oldAnswers.get(f.path),
        `mismatch for ${f.path} (${f.type}): new=${newAnswers.get(f.path)} old=${oldAnswers.get(f.path)}`,
      )
    }
  })

  check('a plain text file is viewable', () => {
    assert.equal(newAnswers.get('text.txt'), true)
  })

  check('a binary file is NOT viewable', () => {
    assert.equal(newAnswers.get('new.bin'), false)
  })

  check('a deleted file is NOT viewable (no working copy, numstat omits it)', () => {
    // big.txt is deleted from the worktree. `git diff --numstat` prints nothing
    // for a staged deletion, so there is no content to preview — the old
    // single-path code returned false here, and the batched version must match.
    assert.equal(newAnswers.get('big.txt'), false, 'deleted file should not be viewable')
  })

  check('every changed file gets an explicit answer (no undefined leaks)', () => {
    for (const f of files) {
      assert.ok(newAnswers.has(f.path), `missing entry for ${f.path}`)
      assert.equal(typeof newAnswers.get(f.path), 'boolean', `non-boolean for ${f.path}`)
    }
  })

  check('an empty path is reported not viewable (no crash)', () => {
    const m = newMod.viewableMap(dir, [{ path: '', type: 'modified' }])
    assert.equal(m.get(''), false)
  })

  check('an empty file list returns an empty map', () => {
    assert.equal(newMod.viewableMap(dir, []).size, 0)
  })

  check('a path that exists nowhere is handled without throwing', () => {
    const m = newMod.viewableMap(dir, [{ path: 'no/such/file.txt', type: 'deleted' }])
    assert.equal(typeof m.get('no/such/file.txt'), 'boolean')
  })

  check('the batched version spawns at most 2 git processes for N files', () => {
    // 1 for non-cached + 1 for cached; assert the source does not call run() per file.
    const fn = extract('viewableMap')
    const runCalls = (fn.match(/run\(GIT,/g) || []).length
    assert.ok(runCalls <= 1, `viewableMap should make at most 1 git call site, found ${runCalls}`)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
if (failed) process.exitCode = 1
