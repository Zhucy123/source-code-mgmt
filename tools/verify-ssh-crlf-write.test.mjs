// Verify that switching the SSH port preserves the config file's own line
// endings. Windows users frequently have a CRLF ~/.ssh/config; writing LF-only
// lines into it would flip parts of the file and show as a whole-file diff.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const src = readFileSync('lib/index.js', 'utf8')

/** Extract a top-level `function NAME(...) {...}` body by brace matching. */
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

// Standalone harness: inject the real writeSshConfig + helpers with stubbed IO.
const harness = `
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
const CFG = process.env.TEST_CFG
function sshDir() { return 'unused' }
function configPath() { return CFG }
function resolveKeyBase() { return 'id_ed25519' }
const IS_WIN = false
${extract('normalizePort')}
${extract('providerCfg')}
${extract('hostBlockSpan')}
${extract('writeSshConfig')}
export { writeSshConfig, hostBlockSpan }
`

const dir = mkdtempSync(join(tmpdir(), 'scm-crlf-'))
const cfg = join(dir, 'config')
process.env.TEST_CFG = cfg

const mod = await import('data:text/javascript,' + encodeURIComponent(harness))

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

console.log('writeSshConfig preserves line endings')

const CRLF_SAMPLE =
  'Host github.com\r\n  Hostname ssh.github.com\r\n  Port 443\r\n  User git\r\n  IdentityFile ~/.ssh/id_ed25519\r\n\r\n' +
  'Host gitee.com\r\n  Hostname gitee.com\r\n  Port 22\r\n  User git\r\n  IdentityFile ~/.ssh/id_ed25519\r\n'

check('CRLF config: switching github to 22 keeps every line CRLF', () => {
  writeFileSync(cfg, CRLF_SAMPLE, 'utf8')
  mod.writeSshConfig('github', 22)
  const out = readFileSync(cfg, 'utf8')

  const lfOnly = (out.match(/(?<!\r)\n/g) || []).length
  assert.equal(lfOnly, 0, `found ${lfOnly} bare-LF line(s); file became mixed CRLF/LF`)
  assert.match(out, /Host github\.com\r\n  Hostname github\.com\r\n  Port 22\r\n/)
  assert.match(out, /Host gitee\.com\r\n/, 'the gitee block must keep its CRLF too')
})

check('CRLF config: switching back to 443 stays all-CRLF', () => {
  mod.writeSshConfig('github', 443)
  const out = readFileSync(cfg, 'utf8')
  assert.equal((out.match(/(?<!\r)\n/g) || []).length, 0, 'no bare LF may appear')
  assert.match(out, /Port 443\r\n/)
})

check('LF config stays LF (no CR introduced)', () => {
  const lfSample = CRLF_SAMPLE.replace(/\r\n/g, '\n')
  writeFileSync(cfg, lfSample, 'utf8')
  mod.writeSshConfig('github', 22)
  const out = readFileSync(cfg, 'utf8')
  assert.equal((out.match(/\r/g) || []).length, 0, 'CR must not be introduced into an LF file')
  assert.match(out, /Port 22\n/)
})

check('writing into an empty/new file produces a clean block', () => {
  writeFileSync(cfg, '', 'utf8')
  const r = mod.writeSshConfig('github', 443)
  assert.equal(r.ok, true)
  const out = readFileSync(cfg, 'utf8')
  assert.ok(out.startsWith('Host github.com'), `must start with the Host line, got: ${JSON.stringify(out.slice(0, 30))}`)
  assert.match(out, /Port 443/)
})

check('appending gitee into a CRLF file uses CRLF for the new block too', () => {
  writeFileSync(cfg, 'Host github.com\r\n  Hostname ssh.github.com\r\n  Port 443\r\n  User git\r\n', 'utf8')
  mod.writeSshConfig('gitee', 22)
  const out = readFileSync(cfg, 'utf8')
  assert.match(out, /Host gitee\.com\r\n/)
  assert.equal((out.match(/(?<!\r)\n/g) || []).length, 0, 'appended block must not be LF-only')
})

rmSync(dir, { recursive: true, force: true })

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
if (failed) process.exitCode = 1
