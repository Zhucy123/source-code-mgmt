// i18n-apply.mjs — replace CJK literals with t()/tr() calls and inline the EN dict.
// Usage: node i18n-apply.mjs <mode: client|host>
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2]
if (mode !== 'client' && mode !== 'host') { console.error('mode must be client|host'); process.exit(1) }

const ROOT = join(here, '..')
const file = join(ROOT, 'lib', mode === 'client' ? 'client.js' : 'index.js')
const dict = JSON.parse(readFileSync(join(here, mode + '-en.json'), 'utf8'))
const src = readFileSync(file, 'utf8')
const FN = mode === 'client' ? 't' : 'tr'

const EXPR_POS = new Set('([{=,:;!&|?+-*%^~<>)}'.split(''))
const KEYWORD_RE = /(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await|=>)\s*$/i

function tokenize(code) {
  const tokens = []
  let i = 0
  const n = code.length
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

/** Unescape a JS double/single-quoted string literal body to its runtime value (basic). */
function unescapeStr(body) {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') { out += ch; continue }
    const nx = body[++i]
    if (nx === 'n') out += '\n'
    else if (nx === 'r') out += '\r'
    else if (nx === 't') out += '\t'
    else if (nx === 'b') out += '\b'
    else if (nx === 'f') out += '\f'
    else if (nx === 'v') out += '\v'
    else if (nx === 'u') { out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16) || 0); i += 4 }
    else if (nx >= '0' && nx <= '7') { out += nx; }
    else out += nx
  }
  return out
}

/** Extract ${...} expressions from a template inner; returns {normalized, exprs}. */
function splitTemplate(inner) {
  const exprs = []
  const re = /\$\{([\s\S]*?)\}/g
  let m
  const parts = []
  let last = 0
  while ((m = re.exec(inner))) {
    parts.push(inner.slice(last, m.index))
    exprs.push(m[1].trim())
    parts.push('${}')
    last = m.index + m[0].length
  }
  parts.push(inner.slice(last))
  return { normalized: parts.join(''), exprs }
}

/** Recursively translate CJK literals inside a template expression (host only). */
function processExpr(expr) {
  const toks = tokenize(expr)
  let out = ''
  for (const t of toks) {
    if (t.type === 'str' && /[\u4e00-\u9fff]/.test(unescapeStr(t.value.slice(1, -1)))) {
      out += FN + '(' + t.value + ')'
    } else {
      out += t.value
    }
  }
  return out
}

const HAS_CJK = /[\u4e00-\u9fff]/
const tokens = tokenize(src)
let replaced = 0
const missing = new Set()

const chunks = []
for (const t of tokens) {
  if (t.type === 'str') {
    const body = t.value.slice(1, -1)
    const runtime = unescapeStr(body)
    if (HAS_CJK.test(runtime)) {
      if (dict[runtime] === undefined) missing.add(runtime)
      chunks.push(FN + '(' + t.value + ')')
      replaced++
      continue
    }
    chunks.push(t.value)
  } else if (t.type === 'tpl') {
    const inner = t.value.slice(1, -1)
    if (HAS_CJK.test(inner)) {
      const { normalized, exprs } = splitTemplate(inner)
      if (dict[normalized] === undefined) missing.add(normalized)
      const args = JSON.stringify(normalized) + (exprs.length ? ', [' + exprs.map(processExpr).join(', ') + ']' : '')
      chunks.push(FN + '(' + args + ')')
      replaced++
      continue
    }
    chunks.push(t.value)
  } else {
    chunks.push(t.value)
  }
}

if (missing.size > 0) {
  console.error('MISSING EN TRANSLATIONS (' + missing.size + '):')
  for (const m of missing) console.error('  ' + JSON.stringify(m))
  process.exit(1)
}

// --- inline the dict + helpers ---
const dictBlock = 'const ' + (mode === 'client' ? 'EN_DICT' : 'HOST_EN') + ' = ' + JSON.stringify(dict, null, 0) + ';'

let out = chunks.join('')
if (mode === 'client') {
  const anchor = 'const h = React.createElement;'
  if (!out.includes(anchor)) { console.error('anchor missing: ' + anchor); process.exit(1) }
  const infra = [
    '',
    '// ---------- i18n: follows DSH\u2019s language setting (Settings \u2192 General \u2192 Language), live ----------',
    dictBlock,
    'let scmLang = (() => { try { return String(navigator.language || "zh").toLowerCase().split("-")[0] === "en" ? "en" : "zh" } catch { return "zh" } })();',
    'let scmLocaleFace = null; // ctx.locale (the DSH LocaleRuntime), set in apply()',
    'function currentLang() { try { if (scmLocaleFace && typeof scmLocaleFace.getLocale === "function") return scmLocaleFace.getLocale().active } catch {} return scmLang }',
    'function t(key, params) {',
    '  let s = key;',
    '  try { if (currentLang() === "en") s = EN_DICT[key] ?? key } catch {}',
    '  if (params && params.length) { let i = 0; s = String(s).replace(/\\$\\{\\}/g, () => String(params[i++] ?? "")) }',
    '  return s',
    '}',
    '/** Re-render the subtree when DSH switches language (subscribe to the LocaleRuntime). */',
    'function useLocale() {',
    '  const [, force] = useState(0);',
    '  useEffect(() => {',
    '    if (!scmLocaleFace || typeof scmLocaleFace.subscribe !== "function") return;',
    '    return scmLocaleFace.subscribe(() => force((n) => n + 1));',
    '  }, []);',
    '}',
    '',
  ].join('\n')
  out = out.replace(anchor, anchor + '\n' + infra)
} else {
  const anchor = "import { homedir } from 'node:os'"
  if (!out.includes(anchor)) { console.error('anchor missing: ' + anchor); process.exit(1) }
  const infra = [
    '',
    "import { AsyncLocalStorage } from 'node:async_hooks'",
    '',
    '// ---------- i18n: host messages follow the client\u2019s language (?lang= query param, per request) ----------',
    dictBlock,
    "const requestLangStore = new AsyncLocalStorage();",
    'function langOf(req) { try { const l = new URL(req.url ?? "", "http://localhost").searchParams.get("lang"); return l === "en" ? "en" : "zh" } catch { return "zh" } }',
    'function lang() { return requestLangStore.getStore() ?? "zh" }',
    'function tr(key, params) {',
    '  let s = lang() === "en" ? (HOST_EN[key] ?? key) : key;',
    '  if (params && params.length) { let i = 0; s = String(s).replace(/\\$\\{\\}/g, () => String(params[i++] ?? "")) }',
    '  return s',
    '}',
    '',
  ].join('\n')
  out = out.replace(anchor, anchor + '\n' + infra)
}

writeFileSync(file, out)
console.log(`[${mode}] replaced ${replaced} literals; dict entries: ${Object.keys(dict).length}; wrote ${file}`)
