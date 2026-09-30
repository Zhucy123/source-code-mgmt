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

// --- 2. the ✕ survives scrolling, WITHOUT floating over content ------------
check('the drawer keeps the ✕ visible by structure, not by a floating header', () => {
  // An earlier attempt made the header `position: sticky` with a background.
  // That was wrong: a sticky row floats ABOVE the content, so its fill covered
  // the text scrolling underneath (user report: "标题下方那条灰带把说明文字盖住了").
  // The header must therefore be a plain fixed row and only the body scrolls.
  // Scoped to ScmPanel: the diff viewer's own tab strip uses sticky legitimately.
  const panelStart = code.indexOf('function ScmPanel(')
  const panelEnd = code.indexOf('function panelStyle(')
  assert.ok(panelStart > 0 && panelEnd > panelStart, 'ScmPanel not found')
  const scmPanel = code.slice(panelStart, panelEnd)
  assert.ok(
    !/position:\s*"sticky"/.test(scmPanel),
    'the drawer header must not be sticky again — a sticky row floats over the content and hides it',
  )
  assert.match(scmPanel, /const drawer = variant === "drawer"/, 'ScmPanel must branch on the drawer variant')

  // The drawer panel itself must NOT scroll; the body must.
  const panelIdx = code.indexOf('function panelStyle(')
  const drawerStyle = code.slice(panelIdx, panelIdx + 1400)
  assert.match(drawerStyle, /overflow:\s*"hidden"/, 'the drawer panel must not be its own scroll container')

  // The scrolling body must be a child of the panel root, after the header.
  const renderIdx = code.indexOf('h("div", { style: panelStyle(variant)')
  assert.ok(renderIdx > 0, 'panel root render call not found')
  const headIdx = code.indexOf('h("div", { style: headStyle }', renderIdx)
  const bodyIdx = code.indexOf('overflow: "auto", padding: "0 " + pad', renderIdx)
  assert.ok(headIdx > renderIdx, 'the header must be rendered inside the panel root')
  assert.ok(bodyIdx > headIdx, 'the scrolling body must follow the header inside the panel root')
})

check('the header carries no background fill that could hide content', () => {
  // The header sits above the body in normal flow, so it needs no fill at all.
  const headStyle = code.match(/const headStyle = \{[\s\S]*?\n\t\t\t\};/)
  assert.ok(headStyle, 'headStyle not found')
  assert.ok(
    !/background/.test(headStyle[0]),
    'headStyle must not paint a background — that is what covered the description text',
  )
})

// --- 2b. the titlebar strip stays continuous across the panel ---------------
check('the panel repaints the window titlebar strip that --scm-push narrowed', () => {
  // `--scm-push` narrows #root, and the desktop frame (which paints the 40px
  // strip) lives inside #root — so the strip stopped at the panel's left edge
  // and the band above the panel showed the white page background instead.
  // The portal must repaint that band with the shell's own token.
  const start = code.indexOf('open ? ReactDOM.createPortal(')
  const end = code.indexOf('function HeaderScmEntry()')
  assert.ok(start > 0 && end > start, 'the drawer portal not found')
  const portal = code.slice(start, end)

  assert.match(
    portal,
    /background:\s*"var\(--dsw-specific-sidebar-fill,\s*transparent\)"/,
    "the band above the panel must be repainted with --dsw-specific-sidebar-fill (the shell's own titlebar colour)",
  )
  assert.match(portal, /height:\s*SCM_CHROME_TOP/, 'the repainted band must be exactly the chrome height')
  assert.match(portal, /pointerEvents:\s*"none"/, 'the band must not steal pointer events from the native drag region')

  // It has to track the panel width, or dragging leaves a gap in the strip.
  assert.match(portal, /ref:\s*chromeRef/, 'the band needs a ref so the resize drag can keep it in sync')
  assert.ok(
    /\(\)\s*=>\s*chromeRef\.current/.test(code),
    'makeResizeHandler must be given the band element as well as the panel',
  )
})

check('the tab variant keeps no close button (the host owns closing)', () => {
  // dsh-better-sidebar renders its own tab chrome; a second ✕ there is wrong.
  assert.match(
    code,
    /variant === "tab" \? null : h\("button",[\s\S]{0,120}?onClick: onClose/,
    'the close button must be omitted for variant "tab"',
  )
})

check('the resize handle stays above the panel content', () => {
  // The handle sits at left: -3 with width 7, so its inner 4px overlaps the
  // panel content. With the header no longer floating this is only a guard
  // against a future overlay inside the panel claiming that sliver.
  const handle = code.match(/position:\s*"absolute",\s*top:\s*0,\s*bottom:\s*0,\s*left:\s*-3,\s*width:\s*7,[\s\S]{0,160}?zIndex:\s*(\d+)/)
  assert.ok(handle, 'resize handle style not found')
  assert.ok(
    Number(handle[1]) >= 1,
    'the resize handle must carry a z-index so panel content cannot swallow its inner sliver',
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
