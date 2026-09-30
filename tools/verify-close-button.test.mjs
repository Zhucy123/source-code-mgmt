/**
 * Close-button reachability regression test (desktop shell).
 *
 * Bug found by the user: after switching to the official DSH desktop build, the
 *「代码管理」panel opened but could not be closed.
 *
 * Root cause: the desktop shell sets `--dsh-windows-titlebar-height: 40px` on
 * `document.documentElement` and the native window controls (─ □ ✕) are painted
 * by the OS **above** all web content. The panel was `position: fixed; inset: 0`,
 * so its own ✕ landed at y≈20..42 — exactly underneath the native ✕. The button
 * was rendered but unclickable: z-index cannot win against an OS overlay.
 *
 * Three contracts are guarded here:
 *   1. the panel body starts BELOW the window chrome strip;
 *   2. the ✕ stays reachable while the long panel content is scrolled (sticky);
 *   3. Escape closes the panel, and the opener button toggles it shut too.
 *
 * Run: node tools/verify-close-button.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Strip comments so assertions target CODE, not the prose that documents the
 *  removed approaches (this file legitimately describes the old `inset: 0`). */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '')
}

const code = stripComments(src)

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ok -', name)
}

console.log('close-button reachability / desktop shell')

// --- 1. the panel clears the native window-control strip -------------------
check('the panel starts below the window chrome, not at the viewport top', () => {
  // DSH publishes `--dsh-frame-chrome-top` (the Windows caption height, 0 in
  // native fullscreen). The old variable is kept as a fallback for shells that
  // only publish it; a plain browser resolves the whole chain to 0px.
  assert.match(
    code,
    /const SCM_CHROME_TOP = "var\(--dsh-frame-chrome-top, var\(--dsh-windows-titlebar-height, 0px\)\)"/,
    'SCM_CHROME_TOP must resolve --dsh-frame-chrome-top, falling back to the titlebar height then 0px',
  )

  // The overlay wrapper must consume it as `top`.
  assert.match(
    code,
    /position:\s*"fixed",\s*top:\s*SCM_CHROME_TOP,/,
    'the portal overlay must be pinned at top: SCM_CHROME_TOP',
  )
})

check('the old full-viewport drawer overlay (inset: 0) is gone from the code', () => {
  // `inset: 0` put the panel's own ✕ under the OS-painted window controls.
  // Scope this to the drawer overlay itself: the plugin's centred modals
  // (install dialog, diff viewer, directory picker) legitimately use a
  // full-viewport mask, and their buttons sit mid-screen where no OS chrome
  // can cover them.
  const start = code.indexOf('function HeaderScmAction()')
  const end = code.indexOf('function HeaderScmEntry()')
  assert.ok(start > 0 && end > start, 'HeaderScmAction not found')
  const drawer = code.slice(start, end)
  assert.ok(
    !/inset:\s*0/.test(drawer),
    'stale `inset: 0` drawer overlay left behind — it hides the close button under the native ✕',
  )
})

// --- 2. the ✕ survives scrolling -------------------------------------------
check('the drawer header is sticky so the ✕ cannot scroll out of reach', () => {
  assert.match(code, /position:\s*"sticky",\s*top:\s*0,\s*zIndex:\s*2/, 'drawer header must be position: sticky; top: 0')

  // Sticky only works if the header is a direct child of the scrolling box.
  // The panel's own scroll container is the `panelStyle` root, so the header
  // must be its first child — assert the ordering rather than trusting it.
  const panelIdx = code.indexOf('function panelStyle(')
  const scroller = code.slice(panelIdx, panelIdx + 900)
  assert.match(scroller, /overflow:\s*"auto"/, 'the drawer panel must remain the scroll container')

  const renderIdx = code.indexOf('h("div", { style: panelStyle(variant)')
  assert.ok(renderIdx > 0, 'panel root render call not found')
  const headIdx = code.indexOf('h("div", { style: headStyle }', renderIdx)
  assert.ok(headIdx > renderIdx, 'the sticky header must be rendered inside the panel root')
})

check('the tab variant keeps no close button (the host owns closing)', () => {
  // dsh-better-sidebar renders its own tab chrome; a second ✕ there is wrong.
  assert.match(
    code,
    /variant === "tab" \? null : h\("button",[\s\S]{0,120}?onClick: onClose/,
    'the close button must be omitted for variant "tab"',
  )
})

check('the sticky header does not cover the resize handle', () => {
  // The handle sits at left: -3 with width 7, so its inner 4px overlaps the
  // panel content. A sticky header at zIndex 2 would paint over that sliver in
  // the header's vertical band, leaving a dead strip at the top of the handle.
  const handle = code.match(/position:\s*"absolute",\s*top:\s*0,\s*bottom:\s*0,\s*left:\s*-3,\s*width:\s*7,[\s\S]{0,160}?zIndex:\s*(\d+)/)
  assert.ok(handle, 'resize handle style not found')
  const handleZ = Number(handle[1])
  const headZ = Number(code.match(/position:\s*"sticky",\s*top:\s*0,\s*zIndex:\s*(\d+)/)[1])
  assert.ok(
    handleZ > headZ,
    `resize handle zIndex (${handleZ}) must exceed the sticky header's (${headZ}), or its top sliver is unclickable`,
  )
})

// --- 3. Escape closes the panel --------------------------------------------
check('Escape closes the open panel', () => {
  assert.match(code, /e\.key === "Escape"/, 'no Escape handler found')
  assert.match(code, /window\.addEventListener\("keydown", onKey\)/, 'Escape listener must be attached')
  assert.match(code, /window\.removeEventListener\("keydown", onKey\)/, 'Escape listener must be cleaned up')
  // It must only be armed while the panel is open.
  assert.match(code, /if \(!open\) return undefined;/, 'Escape handler must be gated on the open state')
})

// --- 4. the opener doubles as a toggle -------------------------------------
check('the「代码管理」button toggles the panel shut as well as open', () => {
  // The button lives in the header, not in the edge strip the OS controls
  // cover, so it is the most reliable close affordance of all.
  assert.match(code, /const toggleOpen = useCallback\(\(\) => setOpen\(\(v\) => !v\), \[\]\)/, 'toggleOpen must flip the open state')
  assert.match(code, /onClick: toggleOpen/, 'the header button must use toggleOpen, not a one-way setOpen(true)')
  assert.ok(
    !/onClick:\s*\(\)\s*=>\s*setOpen\(true\)/.test(code),
    'one-way opener left behind — the button could only open, never close',
  )
  assert.match(code, /"aria-expanded": open \? "true" : "false"/, 'the toggle must expose its state via aria-expanded')
})

console.log(`\n${passed} checks passed`)
