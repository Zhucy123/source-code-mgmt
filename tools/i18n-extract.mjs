// Extract all CJK-containing string literals from code (comments & regexes skipped).
// Usage: node i18n-extract.mjs <file> [out.json]
import { readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync(process.argv[2], 'utf8')
const out = process.argv[3] || 'i18n-catalog.json'

const EXPR_POS = new Set('([{=,:;!&|?+-*%^~<>'.split(''))
const KEYWORD_RE = /(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await|=>)\s*$/i

/** Tokenize: 'str' (quoted), 'tpl' (backtick), 'regex', 'comment', 'code'. */
function tokenize(code) {
  const tokens = []
  let i = 0
  const n = code.length
  // last non-whitespace code char seen (for regex detection)
  let lastCode = ''
  while (i < n) {
    const c = code[i]
    if (c === '/' && code[i + 1] === '/') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? n : end
      tokens.push({ type: 'comment', value: code.slice(i, stop), start: i, end: stop })
      i = stop
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      tokens.push({ type: 'comment', value: code.slice(i, stop), start: i, end: stop })
      i = stop
    } else if (c === '/' && (EXPR_POS.has(lastCode.trimEnd().slice(-1)) || KEYWORD_RE.test(lastCode))) {
      // regex literal: scan with char-class and escape awareness
      let j = i + 1
      let inClass = false
      while (j < n) {
        const ch = code[j]
        if (ch === '\\') { j += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        j++
      }
      const end = Math.min(j + 1, n)
      tokens.push({ type: 'regex', value: code.slice(i, end), start: i, end })
      lastCode = code.slice(i, end) + ' '
      i = end
    } else if (c === '/') {
      // division operator (or stray slash): single code char
      tokens.push({ type: 'code', value: '/', start: i, end: i + 1 })
      lastCode = '/'
      i = i + 1
    } else if (c === "'" || c === '"') {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === quote) break
        j++
      }
      const end = Math.min(j + 1, n)
      tokens.push({ type: 'str', value: code.slice(i, end), start: i, end })
      lastCode = code.slice(i, end)
      i = end
    } else if (c === '`') {
      let j = i + 1
      let depth = 0
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue }
        if (code[j] === '`' && depth === 0) break
        if (code[j] === '$' && code[j + 1] === '{') { depth++; j += 2; continue }
        if (depth > 0) {
          if (code[j] === '{') depth++
          else if (code[j] === '}') depth--
          j++
          continue
        }
        j++
      }
      const end = Math.min(j + 1, n)
      tokens.push({ type: 'tpl', value: code.slice(i, end), start: i, end })
      lastCode = code.slice(i, end)
      i = end
    } else {
      let j = i
      while (j < n && !"'\"`/".includes(code[j]) && !(code[j] === '/' && (code[j + 1] === '/' || code[j + 1] === '*'))) j++
      const chunk = code.slice(i, j)
      tokens.push({ type: 'code', value: chunk, start: i, end: j })
      lastCode = chunk
      i = j
    }
  }
  return tokens
}

const HAS_CJK = /[\u4e00-\u9fff]/
const tokens = tokenize(src)

const catalog = new Map()

function lineOf(pos) { return src.slice(0, pos).split('\n').length }

for (const t of tokens) {
  if (t.type !== 'str' && t.type !== 'tpl') continue
  const body = t.value
  if (!HAS_CJK.test(body)) continue
  let literal, exprs = []
  if (t.type === 'tpl') {
    const inner = body.slice(1, -1)
    const re = /\$\{([\s\S]*?)\}/g
    let m
    const outInner = []
    let last = 0
    while ((m = re.exec(inner))) {
      outInner.push(inner.slice(last, m.index))
      exprs.push(m[1].trim())
      outInner.push('${}')
      last = m.index + m[0].length
    }
    outInner.push(inner.slice(last))
    literal = outInner.join('')
  } else {
    literal = body.slice(1, -1)
  }
  if (!HAS_CJK.test(literal)) continue
  const line = lineOf(t.start)
  const ctx = src.slice(Math.max(0, t.start - 40), Math.min(src.length, t.end + 40)).replace(/\r?\n/g, '⏎')
  if (!catalog.has(literal)) catalog.set(literal, { count: 0, samples: [] })
  const rec = catalog.get(literal)
  rec.count++
  if (rec.samples.length < 3) rec.samples.push({ line, tpl: t.type === 'tpl', exprs, ctx })
}

const rows = [...catalog.entries()]
  .sort((a, b) => a[1].samples[0].line - b[1].samples[0].line)
  .map(([literal, rec]) => ({ literal, ...rec }))

writeFileSync(out, JSON.stringify(rows, null, 1))
console.log(`tokens: ${tokens.length}, unique CJK literals: ${rows.length}, total occurrences: ${rows.reduce((s, r) => s + r.count, 0)}`)
console.log('catalog ->', out)
