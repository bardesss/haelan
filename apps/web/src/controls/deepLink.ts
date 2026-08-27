import { withQuery } from '../router.js'
import type { RangeKey } from './range.js'
import { ALL_SOURCES } from './source.js'

/**
 * A Dashboard card's link to its detail page, carrying the period the reader is looking at.
 * Without this a card drops them on today and makes them navigate back to where they already
 * were, which is what turns a dashboard into a terminus rather than a set of entry points.
 */
export function deepLink(
  path: string, controls: { tab: RangeKey, anchor: string, source: string },
): string {
  return withQuery(path, {
    range: controls.tab,
    on: controls.anchor,
    // Omitted rather than written out, so a link says all sources by not saying anything.
    // Pinning the default would make every link carry a parameter that changes nothing.
    source: controls.source === ALL_SOURCES ? null : controls.source,
  })
}
