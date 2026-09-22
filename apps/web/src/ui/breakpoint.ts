import { useEffect, useState } from 'react'

// 620 rather than the grid's 900: a 768px tablet keeps the 186px rail and still has 582px for a
// single column of cards, and always-visible navigation is worth more there than the 186px.
export const PHONE_MAX_WIDTH = 620

// The width at which the twelve column grid stacks to one column. A different question from
// navigation, which is why it is a different number, and why both are named here rather than one
// being derived from the other.
export const GRID_STACK_WIDTH = 900

// The top of the band where the grid is un-stacked but the window is still too narrow for twelve
// columns to divide into anything readable. Measured on the demo: at a 901px window a span-4 tile
// computed to 160px, and the delta badge beside its label wrapped onto a second line and crossed
// the card's right padding. Inside this band app.css halves every ordinary span, so a run of equal
// tiles lays out two to a row instead of three.
//
// A third named number rather than a second derived from GRID_STACK_WIDTH, for the same reason
// that constant is not derived from PHONE_MAX_WIDTH: where the grid stops stacking and where it
// has room for its full track count are different questions with different answers. The band's
// lower edge IS derived - it is exactly where the collapse stops - so app.css spells it as
// `width > GRID_STACK_WIDTH` rather than as the number one above it, which would put the same
// breakpoint in the stylesheet twice under two spellings.
export const MID_BAND_MAX_WIDTH = 1200

export const PHONE_MEDIA_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px)`

function phoneNow(): boolean {
  // Guarded rather than assumed: apps/web renders to static markup by default, where there is no
  // window at all, and a sandboxed iframe can have a window without matchMedia. Both answer
  // "not a phone", which keeps the rail as the server-rendered default.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(PHONE_MEDIA_QUERY).matches
}

/**
 * Whether the viewport is narrow enough that the rail becomes a drawer.
 *
 * Subscribed rather than read once, because the answer changes while the page is open: a rotated
 * phone and a resized window both cross the boundary without a reload.
 */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(phoneNow)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PHONE_MEDIA_QUERY)
    const update = () => setIsPhone(query.matches)
    // Read once on subscribe as well as on change: between the first render and this effect the
    // viewport may already have moved, and a listener alone would not notice.
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return isPhone
}
