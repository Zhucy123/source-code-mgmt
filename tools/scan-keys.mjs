import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const dict = new Set()
const start = src.indexOf('const EN_DICT = {')
const end = src.indexOf('let scmLang')
for (const m of src.slice(start, end).matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) dict.add(m[1])

// Only the new sections (CloneSection..NpmSection) — slice from first section-4 marker to main panel.
const from = src.indexOf('// ---------- section 4:')
const to = src.indexOf('// ---------- the main panel ----------')
const newCode = src.slice(from, to)
const used = new Set()
for (const m of newCode.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) used.add(m[1])
const missing = [...used].filter((k) => !dict.has(k))
console.log('new-section t() keys used:', used.size)
if (missing.length) {
  console.log('MISSING:')
  for (const k of missing) console.log(' -', k)
} else {
  console.log('✅ all new-section t() keys present')
}
