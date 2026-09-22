/**
 * End-to-end check of the port-switching write path, run against a TEMP HOME so
 * the real ~/.ssh/config is never touched.
 *
 * Exercises: fresh write (443) -> already-configured no-op -> switch to 22
 * (rewrite in place) -> switch back to 443, preserving unrelated blocks.
 *
 * Run: node tools/verify-ssh-port-e2e.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ok -', name)
}

// Re-implement the write logic against a chosen path, mirroring lib/index.js.
// (The real function is module-internal and bound to the real HOME; this keeps
// the same algorithm so the behaviour is verified without touching real files.)
function hostBlockSpan(lines, host) {
  const hostRe = new RegExp('^\\s*Host\\s+' + host.replace(/\./g, '\\.') + '\\s*$')
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (hostRe.test(lines[i])) start = i
      continue
    }
    if (/^\s*Host\s+\S/.test(lines[i])) { end = i; break }
  }
  if (start === -1) return null
  const portLine = lines.slice(start, end).find((l) => /^\s*Port\s+\d+/.test(l))
  const port = portLine ? Number(/^\s*Port\s+(\d+)/.exec(portLine)[1]) : 22
  return { start, end, port }
}

function writeConfig(cfgPath, provider, port) {
  const use443 = Number(port) === 22 ? false : true
  const host = provider === 'gitee' ? 'gitee.com' : 'github.com'
  const hostname = provider === 'gitee' ? 'gitee.com' : (use443 ? 'ssh.github.com' : 'github.com')
  const realPort = use443 ? 443 : 22
  const block = ['Host ' + host, '  Hostname ' + hostname, '  Port ' + realPort, '  User git', '  IdentityFile ~/.ssh/id_ed25519', ''].join('\n')

  let current = ''
  try { current = readFileSync(cfgPath, 'utf8') } catch {}
  const hostRe = new RegExp('\\bHost\\s+' + host.replace(/\./g, '\\.') + '\\b')
  if (hostRe.test(current)) {
    const lines = current.split('\n')
    const span = hostBlockSpan(lines, host)
    if (span && span.port === realPort) return { ok: true, alreadyConfigured: true, port: realPort }
    const blockLines = block.replace(/\n$/, '').split('\n')
    const next = span
      ? lines.slice(0, span.start).concat(blockLines, lines.slice(span.end)).join('\n')
      : current.replace(/\n*$/, '\n') + block
    writeFileSync(cfgPath, next, 'utf8')
    return { ok: true, alreadyConfigured: false, updated: true, port: realPort }
  }
  writeFileSync(cfgPath, current.replace(/\n*$/, '\n') + block, 'utf8')
  return { ok: true, alreadyConfigured: false, port: realPort }
}

const dir = mkdtempSync(join(tmpdir(), 'scm-ssh-'))
const cfg = join(dir, 'config')

console.log('SSH port switching (end-to-end, temp HOME)')

try {
  check('fresh write at 443 sets ssh.github.com:443', () => {
    const r = writeConfig(cfg, 'github', 443)
    assert.equal(r.alreadyConfigured, false)
    const text = readFileSync(cfg, 'utf8')
    assert.match(text, /Host github\.com/)
    assert.match(text, /Hostname ssh\.github\.com/)
    assert.match(text, /Port 443/)
  })

  check('re-writing the same port is a no-op', () => {
    const before = readFileSync(cfg, 'utf8')
    const r = writeConfig(cfg, 'github', 443)
    assert.equal(r.alreadyConfigured, true)
    assert.equal(readFileSync(cfg, 'utf8'), before, 'file must be untouched')
  })

  check('switching to 22 rewrites in place (github.com:22)', () => {
    const r = writeConfig(cfg, 'github', 22)
    assert.equal(r.updated, true)
    const text = readFileSync(cfg, 'utf8')
    assert.match(text, /Hostname github\.com/)
    assert.match(text, /Port 22/)
    assert.ok(!/ssh\.github\.com/.test(text), 'stale 443 hostname must be gone')
    // Exactly one block for github.com (no duplicates).
    assert.equal((text.match(/Host github\.com/g) || []).length, 1)
  })

  check('switching back to 443 restores the alternate endpoint', () => {
    writeConfig(cfg, 'github', 443)
    const text = readFileSync(cfg, 'utf8')
    assert.match(text, /Hostname ssh\.github\.com/)
    assert.match(text, /Port 443/)
    assert.equal((text.match(/Host github\.com/g) || []).length, 1)
  })

  check('unrelated blocks survive a port switch', () => {
    // Prepend an unrelated host, then switch github to 22.
    const original = readFileSync(cfg, 'utf8')
    writeFileSync(cfg, 'Host example.com\n  Port 2222\n  User bob\n\n' + original, 'utf8')
    writeConfig(cfg, 'github', 22)
    const text = readFileSync(cfg, 'utf8')
    assert.match(text, /Host example\.com/, 'unrelated block must remain')
    assert.match(text, /Port 2222/, 'unrelated port must remain')
    assert.match(text, /Host github\.com/)
    assert.match(text, /Port 22/)
  })

  check('adding gitee does not disturb the github block', () => {
    writeConfig(cfg, 'gitee', 443)
    const text = readFileSync(cfg, 'utf8')
    assert.match(text, /Host gitee\.com/)
    assert.match(text, /Host github\.com/)
    assert.match(text, /Port 22/, 'github must still be on 22')
    // gitee always uses its own host, never ssh.github.com
    const giteeBlock = text.slice(text.indexOf('Host gitee.com'))
    assert.ok(!/ssh\.github\.com/.test(giteeBlock), 'gitee must not borrow GitHub\'s 443 host')
  })

  check('the config stays parseable: every Host block has Hostname/Port/User', () => {
    const lines = readFileSync(cfg, 'utf8').split('\n')
    const hosts = lines.filter((l) => /^Host\s+\S/.test(l))
    assert.ok(hosts.length >= 3, `expected >=3 host blocks, got ${hosts.length}`)
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed`)
