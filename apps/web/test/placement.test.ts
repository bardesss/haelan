import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { placementFor } from '../src/ui/placement.js'

// placementFor places both layers that float out of the rail's foot: the status popover and the
// person menu. Tested here, against the pure function, so neither component's tests have to
// fake a layout just to check where the layer lands.
describe('placementFor', () => {
  const viewport = { width: 1000, height: 800 }
  const trigger = { left: 150, top: 700, right: 180, bottom: 730 }
  const small = { width: 160, height: 80 }

  it('opens upward above the trigger on an expanded rail, its left edge on the anchor', () => {
    expect(placementFor({ trigger, anchorLeft: 12, stripRight: 186, collapsed: false, size: small, viewport }))
      .toEqual({ left: 12, bottom: 800 - 700 + 6 })
  })

  it('opens past the rail edge on a collapsed rail, its bottom level with the trigger', () => {
    // stripRight, not the trigger's own right edge: the trigger sits inside the strip's padding,
    // and opening from it would lay the layer over the strip's last pixels.
    expect(placementFor({ trigger, anchorLeft: 12, stripRight: 60, collapsed: true, size: small, viewport }))
      .toEqual({ left: 66, bottom: 800 - 730 })
  })

  it('keeps an expanded-rail layer inside the viewport on both axes', () => {
    // An anchor past where a 320px layer would fit is pulled back in from the right.
    expect(placementFor({ trigger, anchorLeft: 900, stripRight: 186, collapsed: false, size: { width: 320, height: 400 }, viewport }))
      .toEqual({ left: 1000 - 320 - 6, bottom: 800 - 700 + 6 })
    // Too tall to fit above the trigger: pinned so its top stays inside the viewport.
    expect(placementFor({ trigger, anchorLeft: 12, stripRight: 186, collapsed: false, size: { width: 320, height: 790 }, viewport }).bottom)
      .toBe(800 - 790 - 6)
  })

  it('opens downward under a trigger at the top of the page, below: true', () => {
    // The dashboard's calendar button sits in the header, with no room above it: the layer's top
    // goes GAP_PX under the trigger, expressed as a bottom through the layer's own height.
    const header = { left: 900, top: 20, right: 944, bottom: 56 }
    expect(placementFor({ trigger: header, anchorLeft: 944 - 300, stripRight: 944, collapsed: false, below: true, size: { width: 300, height: 420 }, viewport }))
      .toEqual({ left: 644, bottom: 800 - 56 - 6 - 420 })
    // Too tall for the room under it: its bottom is held GAP_PX off the viewport's.
    expect(placementFor({ trigger: header, anchorLeft: 644, stripRight: 944, collapsed: false, below: true, size: { width: 300, height: 760 }, viewport }).bottom)
      .toBe(6)
  })

  it('keeps a collapsed-rail layer from running off the top', () => {
    const high = { left: 15, top: 40, right: 45, bottom: 70 }
    expect(placementFor({ trigger: high, anchorLeft: 8, stripRight: 60, collapsed: true, size: { width: 320, height: 400 }, viewport }))
      .toEqual({ left: 66, bottom: 800 - 400 - 6 })
  })
})

// The reason the function has a module of its own. Sidebar renders on every page, and importing
// placementFor from StatusControl.tsx pulled the status control's whole module graph (its queries,
// the sync mutation, the session) into the rail along with it. Read as source, the way
// css-classes.test.ts reads app.css, because an import is a fact about the file, not about what
// it renders.
describe('the rail', () => {
  it('does not import the status control to place its menu', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/components/Sidebar.tsx', import.meta.url)), 'utf8',
    )
    expect(source).not.toMatch(/from '\.\/StatusControl\.js'/)
    expect(source).toMatch(/from '\.\.\/ui\/placement\.js'/)
  })
})
