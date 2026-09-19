import { RANGE_KEYS } from '../controls/range.js'
import type { RangeKey } from '../controls/range.js'

/**
 * Which range a reader last chose, remembered across visits.
 *
 * This is deliberately NOT a second copy of the control row's state. usePageControls.ts says
 * outright that the URL is the only copy, because two effects mirroring each other is the shape
 * that produced M3a's session expiry loop, and that still holds: nothing here is ever read back
 * into the URL, and nothing in the URL is ever written here by an effect. What this module is
 * instead is a *default provider*. One write, in the click handler that already changes the URL;
 * one read, where parseControls would otherwise have reached for its hardcoded 'month'. The URL
 * still wins whenever it carries a range of its own, which is what keeps a shared link, a deep
 * link and the demo's canonical URLs meaning exactly what they say.
 *
 * It lives beside railState.ts rather than in controls/ for the reason railState's own comment
 * gives: a preference that is allowed to differ per device for one person has no home in the URL
 * (a fact about the current document) or on the server (a fact about the household).
 */
export const RANGE_STORAGE_KEY = 'haelan.range'

/**
 * The remembered range, or null when there is no usable one.
 *
 * Validated against RANGE_KEYS rather than cast: a value written under an older set of keys, or
 * edited by hand, is a string this app has no case for, and datesFor switches exhaustively on a
 * RangeKey. Null for anything unrecognised puts such a reader back on the ordinary default.
 *
 * Every access is guarded the way railState.ts guards its own: localStorage throws in some
 * privacy modes and is missing entirely in a sandboxed iframe, and a preference that cannot be
 * remembered must cost the reader their preference, not their page.
 */
export function readRange(): RangeKey | null {
  try {
    const stored = localStorage.getItem(RANGE_STORAGE_KEY)
    return (RANGE_KEYS as readonly string[]).includes(stored ?? '') ? stored as RangeKey : null
  } catch {
    return null
  }
}

export function writeRange(tab: RangeKey): void {
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, tab)
  } catch {
    // A write that cannot happen just leaves the preference unremembered for this reader; it must
    // not throw back into the click handler that caused it.
  }
}
