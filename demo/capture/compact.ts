// The capture's size is almost all /series: every page asks for its metrics over every range,
// source and anchor the demo offers, and each daily point arrives carrying fields the app never
// reads. Measured 2026-09-29 at 371 days, series responses were 9.1 MB of a 14.3 MB capture, and a
// point was about 190 bytes where the date, value, coverage and filled flag the pages draw from take
// about 75.
//
// Trimmed per point, not per recording: every url the sweep records is one the demo's controls can
// reach, so dropping a recording would leave a page answering "not in the demo". What goes is only
// what no reader of a series point in apps/web/src looks at:
//
// - `updatedAtMs` and `source`: SeriesPoint (data/useSeries.ts) types them, and nothing reads them.
//   A daily point's `source` is "merged" or the source the url already names.
// - `sourceMix` after its first and last appearance in a series: its one reader is distinctSources
//   (data/pageShell.ts), which collects the set of sources across every point of every query. A
//   mix repeated on each day adds nothing to that set. The last appearance is kept as well as the
//   first so a demo visitor excluding the first day (overlay.ts deletes that point) still leaves
//   the source in the picker.
//
// `coverage` (data/emptyState.ts) and `filled` (data/chartAnnotations.ts, pages/Recovery.tsx) are
// read, and stay. Should a page start reading one of the dropped fields, it has to come off this
// list, or the demo will draw that field as missing while the tests of the real app stay green.

const SERIES = /^\/api\/v1\/p\/[^/]+\/series$/

interface WirePoint { sourceMix?: string | null, updatedAtMs?: unknown, source?: unknown }

/** One /series body with its points trimmed as above. A copy. */
export function compactSeries(body: Record<string, { points: WirePoint[] }>): Record<string, { points: WirePoint[] }> {
  const out = structuredClone(body)
  for (const series of Object.values(out)) {
    const last = new Map<string, number>()
    series.points.forEach((point, i) => { if (typeof point.sourceMix === 'string') last.set(point.sourceMix, i) })
    const seen = new Set<string>()
    series.points.forEach((point, i) => {
      delete point.updatedAtMs
      delete point.source
      const mix = point.sourceMix
      if (typeof mix !== 'string') return
      if (seen.has(mix) && last.get(mix) !== i) delete point.sourceMix
      seen.add(mix)
    })
  }
  return out
}

/** Rewrites every recorded /series response in place with compactSeries. */
export function compactRecorded(recorded: Map<string, unknown>): void {
  for (const [url, body] of recorded) {
    if (SERIES.test(url.split('?')[0] ?? '')) {
      recorded.set(url, compactSeries(body as Record<string, { points: WirePoint[] }>))
    }
  }
}
