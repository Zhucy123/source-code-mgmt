/**
 * Host-side test for the selectable SSH port (443 vs 22).
 *
 * Why: 443 is a workaround for networks that BLOCK outbound port 22 — it is NOT
 * related to HTTP proxies (plain ssh ignores HTTP_PROXY/HTTPS_PROXY). Users on
 * unrestricted networks should be able to pick the standard port 22.
 *
 * Exercises the pure helpers by importing them through a small shim, so the real
 * write/read logic is tested rather than a copy.
 *
 * Run: node tools/verify-ssh-port.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

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

// Extract the pure helpers from the host bundle and evaluate them standalone.
// (The file is an ESM module with cordis wiring; these three functions have no
// dependencies beyond nothing at all, so a text extraction is faithful.)
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start > 0, `function ${name} not found in lib/index.js`)
  // Walk braces from the first '{' after the signature.
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces for ${name}`)
}

const helpersSrc = [
  extractFn('normalizePort'),
  extractFn('hostBlockSpan'),
].join('\n')

const mod = await import(
  'data:text/javascript,' + encodeURIComponent(helpersSrc + '\nexport { normalizePort, hostBlockSpan };')
)
const { normalizePort, hostBlockSpan } = mod

console.log('SSH port selection (443 穿墙 / 22 标准)')

// --- normalizePort ---------------------------------------------------------
check('normalizePort defaults to 443', () => {
  assert.equal(normalizePort(undefined), 443)
  assert.equal(normalizePort(null), 443)
  assert.equal(normalizePort(''), 443)
})

check('normalizePort accepts 22 and 443', () => {
  assert.equal(normalizePort(22), 22)
  assert.equal(normalizePort('22'), 22)
  assert.equal(normalizePort(443), 443)
  assert.equal(normalizePort('443'), 443)
})

check('normalizePort rejects anything else (defaults to 443)', () => {
  for (const bad of [0, 21, 80, 2222, 'abc', {}, [], NaN]) {
    assert.equal(normalizePort(bad), 443, `expected 443 for ${JSON.stringify(bad)}`)
  }
})

// --- hostBlockSpan: reading the existing port ------------------------------
check('reads Port 443 from a 443 block', () => {
  const lines = [
    'Host github.com',
    '  Hostname ssh.github.com',
    '  Port 443',
    '  User git',
    '  IdentityFile ~/.ssh/id_ed25519',
    '',
  ]
  const span = hostBlockSpan(lines, 'github.com')
  assert.ok(span, 'block not found')
  assert.equal(span.port, 443)
})

check('reads Port 22 from a 22 block', () => {
  const lines = ['Host github.com', '  Hostname github.com', '  Port 22', '  User git']
  assert.equal(hostBlockSpan(lines, 'github.com').port, 22)
})

check('defaults to port 22 when the block omits Port (ssh default)', () => {
  const lines = ['Host github.com', '  Hostname github.com', '  User git']
  assert.equal(hostBlockSpan(lines, 'github.com').port, 22)
})

check('stops at the NEXT Host line (does not swallow a following block)', () => {
  const lines = [
    'Host github.com',
    '  Port 443',
    'Host gitee.com',
    '  Port 22',
  ]
  const gh = hostBlockSpan(lines, 'github.com')
  const gt = hostBlockSpan(lines, 'gitee.com')
  assert.deepEqual({ start: gh.start, end: gh.end }, { start: 0, end: 2 }, 'github span must end at the gitee Host line')
  assert.equal(gh.port, 443)
  assert.equal(gt.port, 22)
})

check('finds the real block when an unrelated Host comes first', () => {
  const lines = [
    'Host example.com',
    '  Port 2222',
    '',
    'Host github.com',
    '  Hostname ssh.github.com',
    '  Port 443',
  ]
  const span = hostBlockSpan(lines, 'github.com')
  assert.equal(span.start, 3)
  assert.equal(span.port, 443)
})

check('returns null when the host is absent', () => {
  assert.equal(hostBlockSpan(['Host example.com', '  Port 22'], 'github.com'), null)
})

check('does not match a lookalike host (github.com.evil / notgithub.com)', () => {
  // The regex is anchored to the whole Host line, so lookalikes must not match.
  assert.equal(hostBlockSpan(['Host notgithub.com', '  Port 22'], 'github.com'), null)
  assert.equal(hostBlockSpan(['Host github.com.evil'], 'github.com'), null)
})

// --- write-config source shape --------------------------------------------
check('writeSshConfig derives Hostname from the chosen port', () => {
  // 443 -> ssh.github.com ; 22 -> github.com ; gitee always gitee.com
  assert.match(src, /hostname: name === 'gitee' \? 'gitee\.com' : \(use443 \? 'ssh\.github\.com' : 'github\.com'\)/)
})

check('writeSshConfig takes a port argument and normalizes it', () => {
  assert.match(src, /function writeSshConfig\(provider, port\)/)
  assert.match(src, /const cfg = providerCfg\(provider, port\)/)
})

check('the routes pass the port through', () => {
  assert.match(src, /writeSshConfig\(body\.provider, normalizePort\(body\.port\)\)/)
  assert.match(src, /sshTest\(body\.provider, normalizePort\(body\.port\)\)/)
})

check('sshTest applies the port explicitly', () => {
  assert.match(src, /function sshTest\(provider, port\)/)
  // The 443 path must target the alternate endpoint explicitly rather than
  // relying on ~/.ssh/config being present.
  assert.match(src, /ssh\.github\.com' \? 'git@ssh\.github\.com'/)
  assert.match(src, /args\.push\('-p', String\(cfg\.port\)/)
})

check('checkSsh reports the port actually configured', () => {
  assert.match(src, /sshGitHubPort:/)
  assert.match(src, /sshGiteePort:/)
})

check('no longer hardcodes a 443-only ssh config block', () => {
  assert.ok(!/Write the SSH config block \(Host <host> on port 443\) only/.test(src))
})

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`)
if (failed) process.exitCode = 1
