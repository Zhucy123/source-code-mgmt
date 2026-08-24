// Integration test: load the plugin host, hit safe routes, assert zh/en messages.
import { EventEmitter } from 'node:events'
import { apply } from '../lib/index.js'

const routes = new Map()
const ctx = {
  webServer: { register({ kind, path, handler }) { routes.set(path, handler) } },
  effect: (fn) => { fn() }, // run immediately
}
apply(ctx)

function fakeReq(url, method = 'GET', body) {
  const req = new EventEmitter()
  req.url = url
  req.method = method
  req.headers = { host: 'localhost', origin: 'http://localhost' }
  if (body !== undefined) {
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  }
  return req
}

function call(path, method, body) {
  return new Promise((resolve, reject) => {
    const handler = routes.get(path.replace(/\?.*$/, ''))
    if (!handler) return reject(new Error('no route for ' + path))
    const res = {
      _status: 0, _body: '',
      writeHead(s) { this._status = s },
      end(b) { this._body = b },
    }
    const orig = res.end.bind(res)
    res.end = (b) => { orig(b); resolve({ status: res._status, json: JSON.parse(b) }) }
    const req = fakeReq('http://localhost' + path, method, body)
    const p = handler(req, res)
    if (p && typeof p.catch === 'function') p.catch((e) => reject(e))
    // Some handlers resolve via res.end after async readBody; some never settle —
    // guard with a timeout for those that read a body we didn't provide.
    setTimeout(() => { if (!res._body) reject(new Error('timeout: ' + path)) }, 3000).unref()
  })
}

let pass = 0, fail = 0
function eq(label, actual, expected) {
  const ok = actual === expected
  if (ok) { pass++; console.log('  PASS ' + label) }
  else { fail++; console.log('  FAIL ' + label + ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)) }
}

const GITDIR = 'C:/Users/27775/workspace/source-code-mgmt' // a real git repo for /repo-diff
const A = '/api/source-code-mgmt'

// 1. remove-workspace: missing dir
let r = await call(A + '/remove-workspace?lang=zh', 'POST', { dir: '' })
eq('zh: remove-workspace missing dir', r.json.error, '缺少目录路径')
r = await call(A + '/remove-workspace?lang=en', 'POST', { dir: '' })
eq('en: remove-workspace missing dir', r.json.error, 'Folder path required')
r = await call(A + '/remove-workspace', 'POST', { dir: '' })
eq('default (no lang) = zh', r.json.error, '缺少目录路径')

// 2. gitee-token: empty token
r = await call(A + '/gitee-token?lang=en', 'POST', { token: '' })
eq('en: gitee empty token', r.json.error, 'Token cannot be empty')
r = await call(A + '/gitee-token?lang=zh', 'POST', { token: '' })
eq('zh: gitee empty token', r.json.error, '令牌不能为空')

// 3. add-workspace: nonexistent dir
r = await call(A + '/add-workspace?lang=en', 'POST', { dir: 'Z:/definitely/not/here' })
eq('en: add-workspace bad dir', r.json.error, 'Folder does not exist or is not a directory: Z:/definitely/not/here')
r = await call(A + '/add-workspace?lang=zh', 'POST', { dir: 'Z:/definitely/not/here' })
eq('zh: add-workspace bad dir', r.json.error, '目录不存在或不是文件夹：Z:/definitely/not/here')

// 4. repo-diff: git repo dir, empty path
r = await call(A + '/repo-diff?dir=' + encodeURIComponent(GITDIR) + '&path=&lang=en')
eq('en: repo-diff empty path', r.json.error, 'File path required')
r = await call(A + '/repo-diff?dir=' + encodeURIComponent(GITDIR) + '&path=&lang=zh')
eq('zh: repo-diff empty path', r.json.error, '缺少文件路径')

// 5. commit: nothing staged in a real git repo -> staged-empty message (zh/en)
r = await call(A + '/commit?lang=en', 'POST', { dir: GITDIR, message: 'x' })
eq('en: commit nothing staged', r.json.error, 'Nothing staged to commit')
r = await call(A + '/commit?lang=zh', 'POST', { dir: GITDIR, message: 'x' })
eq('zh: commit nothing staged', r.json.error, '没有已暂存（staged）的改动可提交')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
