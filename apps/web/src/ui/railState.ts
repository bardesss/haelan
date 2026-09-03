// Whether the rail is collapsed is this app's first client side preference. Everything else so
// far lives in the URL, a fact about the current document (the control row's range and source), or
// on the server, a fact about the household (instance settings). A collapsed rail is neither: it is
// a fact about the screen in front of a reader right now, and the same reader wants a different
// answer on a phone than on a wide monitor. Neither existing home can hold a value that is allowed
// to differ per device for one person, so this gets a module and localStorage of its own rather
// than joining one of them.
const KEY = 'haelan.rail.collapsed'

// localStorage throws in some privacy modes and can be missing entirely (a sandboxed iframe, for
// instance), so every access here is guarded. A rail that cannot remember its own state falls back
// to expanded rather than taking the shell down.
export function readCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch {
    return false
  }
}

export function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(KEY, collapsed ? 'true' : 'false')
  } catch {
    // A write that cannot happen just leaves the preference unremembered for this reader; it must
    // not throw back into the click handler that caused it.
  }
}
