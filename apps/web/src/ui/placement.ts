/**
 * Where a layer that floats out of the rail's foot goes: the status popover (StatusControl.tsx)
 * and the person menu beside it (Sidebar.tsx).
 *
 * A module of its own, with no React and no hooks, because both of those need it and they are not
 * equals. Sidebar is rendered on every page; StatusControl reads the status queries, runs syncs and
 * knows the session. When this lived in StatusControl.tsx, the rail had to import all of that just
 * to get one pure function, so every page loaded the status control's module graph through the
 * rail, whether or not the rail ever showed a status icon.
 */

/** The gap between the trigger and the layer, and the layer's least distance from a viewport edge. */
const GAP_PX = 6

export interface Placement { left: number, bottom: number }

/**
 * Where the fixed layer goes, as a left edge and a distance from the viewport's bottom.
 *
 * Bottom rather than top, because the layer opens upward and its height is its content's: pinned
 * by its bottom edge it grows away from the trigger. An expanded rail puts it above the trigger,
 * its left edge on the rail foot's so it lines up with the name there. A collapsed rail is a 60px
 * strip with no room above for anything 20rem wide, so it opens past the strip's right edge - the
 * rail's, not the trigger's, which sits inside the strip's padding and would leave the layer lying
 * over the strip's last 16px - its bottom level with the trigger's.
 *
 * Clamped both ways into the viewport by GAP_PX: pulled left when a narrow window would push it
 * off the right edge, and pinned below the top when it is taller than the room above the trigger
 * (the popover's max-height: 70vh caps it, but a short window can still make 70vh more than there
 * is).
 */
export function placementFor({ trigger, anchorLeft, stripRight, collapsed, size, viewport }: {
  trigger: { left: number, top: number, right: number, bottom: number }
  /** Where an expanded rail's layer starts: the rail foot's left edge, or the wrapper's. */
  anchorLeft: number
  /** Where a collapsed rail's strip ends: the rail's right edge. */
  stripRight: number
  collapsed: boolean
  size: { width: number, height: number }
  viewport: { width: number, height: number }
}): Placement {
  const left = collapsed ? stripRight + GAP_PX : anchorLeft
  const bottom = collapsed ? viewport.height - trigger.bottom : viewport.height - trigger.top + GAP_PX
  return {
    // Near edge first, then the far one, so when both cannot hold the far one wins: the right
    // edge over the left, the top over the bottom. A layer cut at the top loses its first line,
    // the one a reader opened it to see.
    left: Math.min(Math.max(GAP_PX, left), viewport.width - size.width - GAP_PX),
    bottom: Math.min(Math.max(GAP_PX, bottom), viewport.height - size.height - GAP_PX),
  }
}
