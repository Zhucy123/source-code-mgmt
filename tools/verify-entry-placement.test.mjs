/**
 * Placement regression test for the「代码管理」entry (no dsh-better-sidebar).
 *
 * Guards two bugs found by the user:
 *   1. the empty-state button overlapped DSH's own top-right controls;
 *   2. it sat at a different height from the button shown when a session exists
 *      (it must be the SAME height in both states).
 *
 * Run: node tools/verify-entry-placement.test.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** Strip block and whole-line comments, so assertions target CODE not prose
 *  (the file legitimately documents removed approaches in its comments). */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*\*.*$/gm, '') // jsdoc continuation lines
}

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log('  ok -', name)
}

console.log('entry placement / no-better-sidebar fallback')

// --- Geometry contract -----------------------------------------------------
// In the empty state the entry sits at the TOP-RIGHT, at the SAME HEIGHT as the
// button shown when a session IS active. Two separate constraints:
//
//  (a) VERTICAL — match the active-session utilities row exactly:
//        .header    padding-top: 10px
//        .titleRow  min-height: 30px, align-items: center
//        button     height 32  ->  top = 10 + (30 - 32)/2 = 9px
//      (plus --dsh-windows-titlebar-height on the desktop shell)
//
//  (b) HORIZONTAL — the empty-state header's `.headerBlank .headerCorner` gets
//      `margin-left: auto`, pushing ui-sidebar-right's ExpandButton (the
//      right-sidebar toggle, a 28x28 circle) to the far right. Its box is:
//        .header          padding-right: 28px
//        .headerCorner    margin-right: -16px
//        ExpandButton     width: 28px
//      -> it occupies the strip from 12px to 40px in from the viewport edge.
//      The plugin must start LEFT of 40px or it overlaps that button.
const HEADER_PAD_RIGHT = 28
const CORNER_NEGATIVE_MARGIN = 16
const EXPAND_BUTTON_W = 28
const EXPAND_RIGHT_EDGE = HEADER_PAD_RIGHT - CORNER_NEGATIVE_MARGIN // 12px
const EXPAND_LEFT_EDGE = EXPAND_RIGHT_EDGE + EXPAND_BUTTON_W // 40px
const MIN_CLEAR_OFFSET = EXPAND_LEFT_EDGE // our right offset must be >= this

check('the entry starts LEFT of the right-sidebar expand button (no overlap)', () => {
  // The bug: `right: 12` put our right edge exactly on the expand button's.
  const m = /const SCM_TOPRIGHT_OFFSET = (\d+)/.exec(src)
  assert.ok(m, 'missing SCM_TOPRIGHT_OFFSET constant')
  const offset = Number(m[1])
  assert.ok(
    offset >= MIN_CLEAR_OFFSET,
    `right offset ${offset} must be >= ${MIN_CLEAR_OFFSET}px (expand button's left edge at right:${EXPAND_LEFT_EDGE}px)`,
  )
  assert.match(src, /right:\s*SCM_TOPRIGHT_OFFSET,/, 'must apply SCM_TOPRIGHT_OFFSET')
  // And it must NOT still be the colliding value.
  assert.ok(!/right:\s*12,/.test(src), 'right: 12 still collides with the expand button')
})

check('the offset is the expand button edge plus the standard 8px gap', () => {
  const m = /const SCM_TOPRIGHT_OFFSET = (\d+)/.exec(src)
  const offset = Number(m[1])
  assert.equal(offset, EXPAND_LEFT_EDGE + 8, `expected ${EXPAND_LEFT_EDGE + 8}px (40 + 8px gap)`)
})

check('the empty-state button sits at the SAME height as the active-session one', () => {
  // The requirement: 没有会话时按钮要和「有会话时」一样高.
  // Active-session geometry (ConversationRoot.module.css):
  //   .header    padding-top: 10px
  //   .titleRow  min-height: 30px, align-items: center  -> centre = 25px
  //   button     height 32 -> top = 25 - 16 = 9px
  const HEADER_PAD_TOP = 10
  const TITLE_ROW_H = 30
  const BUTTON_H = 32
  const ACTIVE_TOP = HEADER_PAD_TOP + (TITLE_ROW_H - BUTTON_H) / 2
  assert.equal(ACTIVE_TOP, 9, 'sanity: active-session button top is 9px')

  // The source must derive its top from exactly those header metrics.
  const pad = /const SCM_HEADER_PAD_TOP = (\d+)/.exec(src)
  const row = /const SCM_TITLE_ROW_H = (\d+)/.exec(src)
  const btn = /const SCM_BUTTON_H = (\d+)/.exec(src)
  assert.ok(pad && row && btn, 'missing header-metric constants')
  const derived = Number(pad[1]) + (Number(row[1]) - Number(btn[1])) / 2
  assert.equal(derived, ACTIVE_TOP, `derived top ${derived} must equal the active-session top ${ACTIVE_TOP}`)

  // And the button height must match headerBtnStyle's, or the rows still differ.
  assert.equal(Number(btn[1]), BUTTON_H, 'SCM_BUTTON_H must match headerBtnStyle height')
  assert.match(src, /const SCM_BUTTON_TOP = SCM_HEADER_PAD_TOP \+ \(SCM_TITLE_ROW_H - SCM_BUTTON_H\) \/ 2/)
})

check('the empty state adds the desktop titlebar offset so both shells line up', () => {
  // The desktop shell pushes the header down by --dsh-windows-titlebar-height;
  // the pinned button must add the same amount (0px in a plain browser).
  assert.match(
    src,
    /top:\s*"calc\(var\(--dsh-windows-titlebar-height,\s*0px\)\s*\+\s*"\s*\+\s*SCM_BUTTON_TOP\s*\+\s*"px\)"/,
    'top must be `calc(var(--dsh-windows-titlebar-height, 0px) + <SCM_BUTTON_TOP>px)`',
  )
  // The old (rejected) toggle-row formula and its 6px result must be gone from
  // the CODE (comments may still describe the change history).
  const codeOnly = stripComments(src)
  assert.ok(
    !codeOnly.includes('--dsh-windows-titlebar-height, 40px'),
    'stale toggle-row formula (6px) must be gone — it sat 3px too high',
  )
})

check('the entry is no longer pinned below the header box', () => {
  // The previous (rejected) placement: below the whole header, ~84px down.
  assert.ok(
    !/HEADER_BOX_BOTTOM/.test(src),
    'stale HEADER_BOX_BOTTOM placement constant left behind',
  )
  assert.ok(
    !/top:\s*HEADER_BOX_BOTTOM/.test(src),
    'entry must not be pinned below the header box any more',
  )
})

// --- Registration wiring ---------------------------------------------------
check('does NOT register into DSH\'s own left sidebar', () => {
  // The user explicitly asked that the entry never appear in the left sidebar
  // (it crowded the rail's own rows beside "Settings").
  assert.ok(
    !/slots\.inject\('sidebar\.footer\.action'/.test(src),
    'must not register into sidebar.footer.action (left sidebar)',
  )
  assert.ok(!/SidebarFooterScmAction/.test(src), 'dead sidebar-footer component left behind')
})

check('does NOT grab a single-occupancy seat owned by DSH', () => {
  // header.corner  is `single` and owned by ui-sidebar-right's ExpandButton.
  // header.leading is `single` and owned by ui-sidebar's HeaderLeadingControls.
  // sidebar.panellist entries must be real main-panel ids (layout.selectPanel).
  for (const forbidden of [
    'conversation.session.header.corner',
    'conversation.session.header.leading',
    'sidebar.panellist',
  ]) {
    assert.ok(
      !src.includes(`slots.inject('${forbidden}'`),
      `must not register into ${forbidden} (single/owned seat or main-panel-id list)`,
    )
  }
})

check('registers exactly two entries, both in the conversation header', () => {
  const injected = [...src.matchAll(/slots\.inject\('([^']+)'/g)].map(m => m[1])
  assert.deepEqual(
    injected.sort(),
    ['conversation.session.header.utilities', 'shell.overlay'].sort(),
    `expected only the two header entries, got: ${JSON.stringify(injected)}`,
  )
})

check('still registers the active-session header utilities entry', () => {
  assert.match(src, /slots\.inject\('conversation\.session\.header\.utilities'/, 'header utilities entry lost')
  // It must register the SELF-GATED component, not the raw button, so the two
  // entries can never render at the same time (the "two 代码管理" bug).
  assert.match(
    src,
    /'conversation\.session\.header\.utilities',[\s\S]{0,220}?\}, HeaderScmEntry\)\)/,
    'header utilities must register HeaderScmEntry (self-gated), not HeaderScmAction',
  )
})

check('never reads the non-existent `current` field on the session list', () => {
  // SessionListState is { ids, byId, phase, subagentsByParent, jobsBySession } —
  // there is no `current`. Reading it made hasActiveSession always false, so the
  // pinned entry rendered alongside the header one (two「代码管理」buttons).
  // Match CODE only: the source legitimately mentions `snap.current` in a comment
  // documenting this very bug.
  const codeOnly = stripComments(src)
  assert.ok(
    !/\bsnap\.current\b/.test(codeOnly),
    'must not read snap.current (SessionListState has no such field)',
  )
  assert.match(src, /function activeMainSession\(/, 'missing activeMainSession() helper')
  assert.match(
    src,
    /s\.retainedBy\.mainView/,
    'activity must be derived from retainedBy.mainView (the DSH convention)',
  )
})

check('the two session-entry components are mutually exclusive by construction', () => {
  // HeaderScmEntry renders only for a non-blank main session; EmptyStateScmAction
  // renders only when that same condition is false.
  const entryIdx = src.indexOf('function HeaderScmEntry()')
  const emptyIdx = src.indexOf('function EmptyStateScmAction()')
  assert.ok(entryIdx > 0 && emptyIdx > 0, 'both entry components must exist')
  const entry = src.slice(entryIdx, emptyIdx)
  const empty = src.slice(emptyIdx, emptyIdx + 2200)
  assert.match(entry, /if \(!main \|\| main\.blank !== false\) return null/, 'HeaderScmEntry must bail unless a non-blank main session exists')
  assert.match(empty, /const hasActiveSession = !!main && main\.blank === false;\s*\n\s*if \(hasActiveSession\) return null/, 'EmptyStateScmAction must bail on an active session')
})

check('branch A (better-sidebar Tab) is untouched', () => {
  assert.match(src, /bs\.registerTab\(\{/, 'betterSidebar.registerTab call missing')
  assert.match(src, /id:\s*PLUGIN_ID/, 'tab id missing')
})

check('the cross-root opener was removed with the sidebar-footer entry', () => {
  // It existed only so the left-sidebar row could open the panel from another
  // React root; with that entry gone it is dead weight.
  assert.ok(!/scmOpenListeners/.test(src), 'dead opener bridge left behind')
  assert.ok(!/openScmPanel/.test(src), 'dead openScmPanel() left behind')
})

console.log(`\n${passed} checks passed`)
