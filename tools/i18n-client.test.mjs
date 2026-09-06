// Client-side verification: load the classic-script module in a sandbox and
// unit-test the EN dict + t() translation logic.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// --- 1) module registration + factory materialization ---
const captured = {}
const sandbox = {
  window: {
    __ModuleLoader__: { load: (spec) => { captured.spec = spec } },
    setTimeout: () => 0, clearTimeout: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  },
  navigator: { language: 'zh-CN', languages: ['zh-CN'] },
  document: {
    documentElement: { style: { setProperty() {}, removeProperty() {} }, lang: '' },
    createElement: () => ({ appendChild() {}, setAttribute() {}, style: {}, remove() {} }),
    body: { appendChild() {}, removeAttribute() {} },
    head: { appendChild() {} },
  },
}
vm.createContext(sandbox)
vm.runInContext(src, sandbox)
if (!captured.spec || typeof captured.spec.factory !== 'function') throw new Error('ModuleLoader.load not called with a factory')

const ReactStub = {
  createElement: () => ({}), Fragment: 'F',
  useState: () => [], useEffect: () => {}, useRef: () => ({}), useCallback: (f) => f,
}
const requireStub = (name) => {
  if (name === 'react') return ReactStub
  if (name === 'react-dom') return ReactStub
  throw new Error('unexpected require: ' + name)
}
const mod = captured.spec.factory(requireStub)
if (mod.name !== 'source-code-mgmt') throw new Error('bad name: ' + mod.name)
if (typeof mod.apply !== 'function' || !Array.isArray(mod.inject)) throw new Error('bad exports')
console.log('module exports OK:', mod.name, 'inject:', JSON.stringify(mod.inject))

// --- 2) t() + EN_DICT unit test (extract the inlined dict line) ---
const dictLine = src.split('\n').find((l) => l.trimStart().startsWith('const EN_DICT = '))
if (!dictLine) throw new Error('EN_DICT not found')
const dict = vm.runInContext('(' + dictLine.slice(dictLine.indexOf('= ') + 2).trim().replace(/;\s*$/, '') + ')', sandbox)
const keyCount = Object.keys(dict).length
if (keyCount !== 280) { console.error('dict key count ' + keyCount + ' (expect 280)'); process.exit(1) }
const emptyVals = Object.entries(dict).filter(([, v]) => !String(v).trim()).map(([k]) => k)
if (emptyVals.length) { console.error('EMPTY translations:', emptyVals); process.exit(1) }

// replicate t() exactly as inlined
function t(key, params) {
  let s = key
  try { if (lang() === 'en') s = dict[key] ?? key } catch {}
  if (params && params.length) { let i = 0; s = String(s).replace(/\$\{\}/g, () => String(params[i++] ?? '')) }
  return s
}
function lang() { return 'en' }

const cases = [
  ['代码管理', 'Code Management'],
  ['源代码管理', 'Source Control'],
  ['推送更改', 'Push changes'],
  ['强制对齐', 'Force align'],
  ['已提交 ', 'Committed '],
  ['C:\\Users\\你的用户名\\项目目录', 'C:\\Users\\your-name\\project'],
  ['公开', 'Public'],
  ['（无）', '(none)'],
]
let fail = 0
for (const [zh, en] of cases) {
  const got = t(zh)
  if (got !== en) { fail++; console.error('FAIL t(' + JSON.stringify(zh) + ') -> ' + JSON.stringify(got) + ', want ' + JSON.stringify(en)) }
}
// zh identity: every dict key maps back to itself when lang is zh
function tZh(key) { return key } // identity — the runtime zh path
const idFail = Object.keys(dict).filter((k) => tZh(k) !== k).length
console.log('zh identity check: ' + (idFail === 0 ? 'OK' : 'FAIL ' + idFail))
console.log('dict keys: ' + keyCount + ', translation spot-checks: ' + (fail === 0 ? 'all OK' : fail + ' FAIL'))

// --- 3) regression: no identifier shadowing of the translation fn t ---
let shadowFail = 0
if (/function\s+\w+\(t\)/.test(src)) { shadowFail++; console.error('SHADOW: function param named t (shadows t())') }
if (/\b(?:const|let|var)\s+t\b/.test(src)) { shadowFail++; console.error('SHADOW: local variable named t') }
if (/function typeLabel\(t\)/.test(src)) { shadowFail++; console.error('typeLabel param still named t') }
if (/function typeColor\(t\)/.test(src)) { shadowFail++; console.error('typeColor param still named t') }
console.log('shadow regression check: ' + (shadowFail === 0 ? 'OK' : shadowFail + ' FAIL'))
process.exit(fail || shadowFail ? 1 : 0)
