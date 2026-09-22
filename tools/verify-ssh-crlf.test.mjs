// Verify hostBlockSpan handles CRLF (Windows) config files — a real-world case,
// since ~/.ssh/config is frequently CRLF on Windows.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('lib/index.js', 'utf8')
const start = src.indexOf('function hostBlockSpan(')
assert.ok(start > 0, 'hostBlockSpan not found')
const open = src.indexOf('{', start)
let depth = 0
let end = -1
for (let i = open; i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
}
const fnSrc = src.slice(start, end)
const mod = await import('data:text/javascript,' + encodeURIComponent(fnSrc + '\nexport { hostBlockSpan };'))
const { hostBlockSpan } = mod

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ok -', name)
}

console.log('hostBlockSpan line-ending robustness')

check('LF config parses', () => {
  const lines = 'Host github.com\n  Hostname ssh.github.com\n  Port 443\n  User git\n'.split('\n')
  assert.equal(hostBlockSpan(lines, 'github.com').port, 443)
})

check('CRLF config parses (Windows)', () => {
  const lines = 'Host github.com\r\n  Hostname ssh.github.com\r\n  Port 443\r\n  User git\r\n'.split('\n')
  const span = hostBlockSpan(lines, 'github.com')
  assert.ok(span, 'block must be found with CRLF endings')
  assert.equal(span.port, 443, 'port must be read despite the trailing \\r')
})

check('CRLF: two adjacent blocks are separated correctly', () => {
  const lines = 'Host github.com\r\n  Port 443\r\nHost gitee.com\r\n  Port 22\r\n'.split('\n')
  assert.equal(hostBlockSpan(lines, 'github.com').port, 443)
  assert.equal(hostBlockSpan(lines, 'gitee.com').port, 22)
})

check('CRLF: the Host line itself matches (trailing \\r tolerated)', () => {
  const lines = ['Host github.com\r', '  Port 22\r', '']
  const span = hostBlockSpan(lines, 'github.com')
  assert.ok(span, 'Host line with trailing \\r must match')
  assert.equal(span.port, 22)
})

console.log(`\n${passed} checks passed`)
