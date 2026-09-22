/**
 * Loads lib/client.js in a simulated DSH classic-script runtime and asserts the
 * plugin's real activation behaviour in BOTH branches.
 *
 * This is stronger than a source grep: it actually runs `apply(ctx)` against a
 * fake cordis ctx and inspects which slots the plugin injects into.
 *
 * Run: node tools/verify-entry-runtime.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const code = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
function check(name, fn) {
  try {
    fn()
  } catch (e) {
    console.error(`  FAIL - ${name}\n        ${e.message}`)
    process.exitCode = 1
    return
  }
  passed++
  console.log('  ok -', name)
}

/** Build a fake React + DOM + cordis runtime and load the plugin into it. */
function loadPlugin({ withBetterSidebar, listSnapshot }) {
  const created = []
  const h = (type, props, ...children) => ({ type, props, children })

  const React = {
    createElement: h,
    Fragment: Symbol('Fragment'),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  const ReactDOM = { createRoot: () => ({ render() {}, unmount() {} }) }

  const injects = []      // slot names the plugin injected into
  const registrations = [] // { name, id, order }

  const slots = {
    inject(name, cb) {
      injects.push(name)
      // Mimic the real deferred semantics: run the callback now so we can
      // observe what the plugin would register once the slot goes live.
      try { cb() } catch { /* undeclared-slot throws are handled by the plugin */ }
      return () => {}
    },
    register(options) {
      registrations.push(options)
      // The real thing throws for an undeclared slot; emulate the subset that
      // matters here by allowing everything the plugin legitimately targets.
      return () => {}
    },
  }

  const KNOWN = new Set([
    'conversation.session.header.utilities',
    'shell.overlay',
    'sidebar.footer.action',
  ])
  const strictSlots = {
    inject(name, cb) {
      injects.push(name)
      try {
        cb()
      } catch (e) {
        // swallow: plugin is expected to guard its own registrations
      }
      return () => {}
    },
    register(options, component) {
      if (!KNOWN.has(options.name)) {
        throw new Error(`slot "${options.name}" is not declared`)
      }
      registrations.push({ ...options, component })
      return () => {}
    },
  }

  const betterSidebar = {
    registerTab(opts) { created.push({ kind: 'tab', opts }); return () => {} },
  }

  const sessionsService = {
    list: {
      getSnapshot: () => listSnapshot,
      subscribe: () => () => {},
    },
  }

  const ctx = {
    effect(fn) { try { fn() } catch {} return () => {} },
    get(name) {
      if (name === 'slots') return strictSlots
      if (name === 'betterSidebar') return withBetterSidebar ? betterSidebar : undefined
      if (name === 'sessions') return listSnapshot === undefined ? undefined : sessionsService
      if (name === 'locale') return undefined
      return undefined
    },
    locale: undefined,
  }

  const win = {
    __ModuleLoader__: { load(desc) { win.__desc = desc } },
    setTimeout: () => 0,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const doc = {
    head: { appendChild: () => {} },
    body: { appendChild: () => {}, setAttribute: () => {}, removeAttribute: () => {} },
    createElement: () => ({ setAttribute: () => {}, style: {} }),
    documentElement: { style: { setProperty: () => {}, removeProperty: () => {} } },
    querySelector: () => null,
  }
  const navigator = { language: 'zh-CN' }

  const sandbox = {
    window: win, document: doc, navigator,
    React, ReactDOM,
    module: { exports: {} }, exports: {},
    require: (id) => {
      if (id === 'react') return React
      if (id === 'react-dom' || id === 'react-dom/client') return ReactDOM
      throw new Error('unexpected require: ' + id)
    },
    console,
    fetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    queueMicrotask,
    Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, Error, Set, Map, URL,
    encodeURIComponent, decodeURIComponent,
  }
  sandbox.globalThis = sandbox

  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'client.js' })

  const desc = win.__desc
  assert.ok(desc, 'plugin did not call window.__ModuleLoader__.load')
  assert.equal(desc.id, 'source-code-mgmt')
  assert.equal(typeof desc.factory, 'function', 'bundle must expose a factory')
  const mod = desc.factory(sandbox.require)
  // Activate.
  mod.apply(ctx)

  return { mod, injects, registrations, created, slots }
}

console.log('runtime activation (no dsh-better-sidebar installed)')

check('plugin exposes the expected id and inject face', () => {
  const { mod } = loadPlugin({ withBetterSidebar: false })
  assert.equal(mod.name, 'source-code-mgmt')
  assert.deepEqual(Array.from(mod.inject), ['locale'])
})

check('branch B registers the header-utilities and overlay entries (and nothing else)', () => {
  const { injects, registrations } = loadPlugin({ withBetterSidebar: false })
  assert.deepEqual(
    [...new Set(injects)].sort(),
    ['conversation.session.header.utilities', 'shell.overlay'].sort(),
    `unexpected slot injections: ${JSON.stringify(injects)}`,
  )
  for (const name of [
    'conversation.session.header.utilities',
    'shell.overlay',
  ]) {
    const reg = registrations.find(r => r.name === name)
    assert.ok(reg, `did not register into ${name}`)
    assert.ok(reg.id, `${name} registration is missing an id`)
  }
})

check('branch B never registers into DSH\'s own left sidebar', () => {
  const { injects } = loadPlugin({ withBetterSidebar: false })
  assert.ok(!injects.includes('sidebar.footer.action'), 'must not touch the left sidebar')
})

check('branch B never touches DSH\'s single-occupancy header seats', () => {
  const { injects } = loadPlugin({ withBetterSidebar: false })
  assert.ok(!injects.includes('conversation.session.header.corner'), 'must not take header.corner')
  assert.ok(!injects.includes('conversation.session.header.leading'), 'must not take header.leading')
  assert.ok(!injects.includes('sidebar.panellist'), 'must not take sidebar.panellist')
})

check('branch B does not register better-sidebar tabs', () => {
  const { created } = loadPlugin({ withBetterSidebar: false })
  assert.equal(created.filter(c => c.kind === 'tab').length, 0, 'should not register a Tab without the plugin')
})

console.log('\nruntime activation (dsh-better-sidebar IS installed)')

check('branch A registers exactly one「代码管理」tab and no fallback entries', () => {
  const { created, injects } = loadPlugin({ withBetterSidebar: true })
  const tabs = created.filter(c => c.kind === 'tab')
  assert.equal(tabs.length, 1, `expected 1 tab, got ${tabs.length}`)
  assert.equal(tabs[0].opts.id, 'source-code-mgmt')
  assert.equal(tabs[0].opts.title, '代码管理')
  assert.ok(typeof tabs[0].opts.component === 'function', 'tab component must be a factory')
  assert.equal(injects.length, 0, 'must not register header/footer entries when the Tab path wins')
})

console.log('\nsession-entry mutual exclusion (the "two 代码管理" bug)')

// Render every registered component with a mocked session list and count how many
// actually produce a visible entry. Since the left-sidebar entry was removed, ALL
// entries live in the header — so exactly one may ever be visible at a time.
const HEADER_PAIR = ['conversation.session.header.utilities', 'shell.overlay']

function visibleEntries(listSnapshot) {
  const { registrations } = loadPlugin({ withBetterSidebar: false, listSnapshot })
  const rendered = []
  for (const reg of registrations) {
    if (typeof reg.component !== 'function') continue
    let node = null
    try {
      node = reg.component({ wide: true })
    } catch (e) {
      throw new Error(`rendering ${reg.name} threw: ${e.message}`)
    }
    rendered.push({ slot: reg.name, node })
  }
  const headerVisible = rendered.filter(r => HEADER_PAIR.includes(r.slot) && r.node).length
  const otherVisible = rendered.filter(r => !HEADER_PAIR.includes(r.slot) && r.node)
  return { headerVisible, otherVisible, rendered }
}

/** Compact diagnostic string for assertion messages. */
const diag = (rendered) => JSON.stringify(rendered.map(r => [r.slot, !!r.node]))

check('actively-used script reads retainedBy.mainView, not a `current` field', () => {
  // Match against CODE only — the file legitimately mentions `snap.current` in a
  // comment explaining the bug that was fixed here.
  const raw = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const codeOnly = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/^\s*\/\/.*$/gm, '')       // line comments
  assert.ok(!/\bsnap\.current\b/.test(codeOnly), 'code still reads the non-existent snap.current')
})

check('a non-blank main session shows exactly one header entry (not two)', () => {
  const { headerVisible, rendered } = visibleEntries({
    ids: ['s1'], phase: 'ready',
    byId: { s1: { id: 's1', blank: false, retainedBy: { mainView: 1 } } },
  })
  assert.equal(headerVisible, 1, `expected exactly 1 header entry, got ${headerVisible}; ${diag(rendered)}`)
})

check('a blank main session shows exactly one header entry (not two)', () => {
  const { headerVisible, rendered } = visibleEntries({
    ids: ['s1'], phase: 'ready',
    byId: { s1: { id: 's1', blank: true, retainedBy: { mainView: 1 } } },
  })
  assert.equal(headerVisible, 1, `expected exactly 1 header entry, got ${headerVisible}; ${diag(rendered)}`)
})

check('no sessions at all shows exactly one header entry', () => {
  const { headerVisible, rendered } = visibleEntries({ ids: [], phase: 'ready', byId: {} })
  assert.equal(headerVisible, 1, `expected exactly 1 header entry, got ${headerVisible}; ${diag(rendered)}`)
})

check('a non-main blank session does not suppress the header entry', () => {
  // A blank session retained only by the workspace browser (mainView: 0) must not
  // count as "the session on screen" — otherwise both entries would hide.
  const { headerVisible, rendered } = visibleEntries({
    ids: ['s1', 's2'], phase: 'ready',
    byId: {
      s1: { id: 's1', blank: true, retainedBy: { mainView: 0 } },
      s2: { id: 's2', blank: false, retainedBy: { mainView: 1 } },
    },
  })
  assert.equal(headerVisible, 1, `expected exactly 1 header entry, got ${headerVisible}; ${diag(rendered)}`)
})

check('falls back safely when retainedBy is absent (older/partial data)', () => {
  // No retainedBy anywhere: the helper must still pick a non-blank session so the
  // header entry shows and the pinned one hides — one button, never two.
  const { headerVisible, rendered } = visibleEntries({
    ids: ['s1'], phase: 'ready',
    byId: { s1: { id: 's1', blank: false, updatedAt: 5 } },
  })
  assert.equal(headerVisible, 1, `expected exactly 1 header entry, got ${headerVisible}; ${diag(rendered)}`)
})

check('no entry is ever rendered outside the conversation header', () => {
  for (const snapshot of [
    { ids: ['s1'], phase: 'ready', byId: { s1: { id: 's1', blank: false, retainedBy: { mainView: 1 } } } },
    { ids: ['s1'], phase: 'ready', byId: { s1: { id: 's1', blank: true, retainedBy: { mainView: 1 } } } },
    { ids: [], phase: 'ready', byId: {} },
  ]) {
    const { otherVisible } = visibleEntries(snapshot)
    assert.equal(
      otherVisible.length, 0,
      `expected no non-header entries, got ${JSON.stringify(otherVisible.map(r => r.slot))}`,
    )
  }
})

console.log(`\n${passed} checks passed`)
if (process.exitCode) console.error('SOME CHECKS FAILED')
