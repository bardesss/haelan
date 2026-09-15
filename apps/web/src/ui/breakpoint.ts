import { useEffect, useState } from 'react'

// 620 rather than the grid's 900: a 768px tablet keeps the 186px rail and still has 582px for a
// single column of cards, and always-visible navigation is worth more there than the 186px.
export const PHONE_MAX_WIDTH = 620

// The width at which the twelve column grid stacks to one column. A different question from
// navigation, which is why it is a different number, and why both are named here rather than one
// being derived from the other.
export const GRID_STACK_WIDTH = 900

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
