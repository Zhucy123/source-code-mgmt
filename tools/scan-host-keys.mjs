import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

// collect tr("...") / tr('...') keys
const used = new Set()
for (const m of src.matchAll(/tr\(\s*"((?:[^"\\]|\\.)*)"/g)) used.add(m[1])
for (const m of src.matchAll(/tr\(\s*'((?:[^'\\]|\\.)*)'/g)) used.add(m[1])

// collect HOST_EN keys (original one-line object + Object.assign additions)
const dict = new Set()
const start = src.indexOf('const HOST_EN = {')
// include everything up to the requestLangStore + Object.assign block (before llmComplete section)
const end = src.indexOf('// ---------- ④ 克隆远程仓库 / ⑤ 提交 PR / ⑥ 发布 npm 包')
const objText = src.slice(start, end)
for (const m of objText.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) dict.add(m[1])

// keys with ${} placeholders are matched with the literal ${} in source too
const missing = [...used].filter((k) => !dict.has(k))
console.log('total used tr() keys:', used.size)
console.log('HOST_EN keys:', dict.size)
if (missing.length) {
  console.log('MISSING tr() keys:')
  for (const k of missing) console.log(' -', JSON.stringify(k))
} else {
  console.log('✅ all tr() keys present in HOST_EN')
}
