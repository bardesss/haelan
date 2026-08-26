/**
 * The source a page should actually query and show, given what this person has.
 *
 * A link can name a source this person does not have, and a source can be removed after a link
 * was made. Both land here, and both should read as the merged view. This is state, not
 * presentation: the fix used to live in the control row, where it corrected the select and left
 * the page building its requests from the raw value, so a stale or foreign link showed "All
 * sources" above cards querying source=someone-elses. Resolving once, here, is what keeps the
 * label and the query from disagreeing, because they are then the same value.
 *
 * Kept as a standalone function rather than inlined at the call site: a real browser select
 * silently defaults an unmatched controlled value to whichever option renders first, which is
 * always merged, so a test that only reads the mounted select back cannot tell that fallback
 * apart from having none at all. This is what a direct test can.
 *
 * `options` grows as the enumeration query answers. Before it does, the only known option is
 * merged, so an unrecognised source resolves to merged and the page queries the merged rows; when
 * the enumeration confirms the device exists, the source resolves to itself and the queries
 * follow. Never the other way round, so no request is ever sent under a source nothing has
 * confirmed.
 */
export function resolveSource(source: string, options: readonly string[]): string {
  return options.includes(source) ? source : 'merged'
}
