import { formatLocalDateRange } from '../../format.js'

/**
 * An overview page's header line (PATTERNS.md's "Overview pages"): the period as one date range in
 * the reader's locale, then the source it reads ("1 – 30 sep 2026 · Alle bronnen"). The caller names
 * the source, since the control row's own words for it (controlRow.sourceAll, or the source's name
 * through useSourceNames) are what this has to agree with.
 *
 * A dash the locale closes up is spaced: Dutch prints a range inside one month as "1–30 sep", and
 * PATTERNS.md's range is a spaced dash, as English and a range across months already print it (with
 * the locale's own spaces, which are left alone).
 */
export function periodLine(from: string, to: string, sourceName: string, language: string): string {
  return `${formatLocalDateRange(from, to, language).replace(/(\S)–(\S)/, '$1 – $2')} · ${sourceName}`
}
