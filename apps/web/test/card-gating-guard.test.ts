import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

// The defect class this milestone exists to close: eleven cards written by six people, four
// different conventions for pending, empty and error, and each divergence found in a separate
// review round. A page that hand rolls its own gating is how it comes back, so make that visible
// at review time rather than three rounds later.
//
// Keyed on ErrorState/Loading usage and a literal emptyState.<kind>.title/detail key rather than
// on the name emptyStateFor: a card can gate on isError, isPending and its own emptiness test and
// render ErrorState, Loading and a hardcoded empty state kind without ever calling emptyStateFor,
// which is exactly what the old Dashboard.tsx's sleep stages card did. The first version of this file was
// keyed on that one name, so a page that hand rolled every part of the pattern except that one
// call passed it without the trigger ever firing. The \w+ requires a literal kind (no_data,
// not_worn, not_synced), not the templated `emptyState.${empty}.title` MetricCard itself renders
// internally, which is what keeps a page that only reaches empty state text through MetricCard
// from tripping its own guard.
const HAND_ROLLED_GATING = /<ErrorState[\s>]|<Loading[\s/>]|emptyState\.\w+\.(?:title|detail)/

// A JSX tag, not a bare substring: toContain('MetricCard') would have matched a comment that only
// names the component, proving nothing about whether the page actually renders one.
const USES_METRIC_CARD = /<MetricCard[\s>]/

// Pages with a real reason to hand roll every bit of gating and never mention MetricCard: each
// wraps exactly one query over a resource that carries no metric and no points, so there is
// nothing for MetricCard's own `metric`/`points` contract to gate. SessionList.tsx is in the same
// position and is simply never seen here, since it lives one directory down in pages/activity/ and
// this guard only reads pages/ itself; WorkoutDetail.tsx (M8b) and NightDetail.tsx (M8c, gated on
// useNights rather than a metric and its points, the same shape) cannot borrow that same exemption
// Records.tsx (M6c) joins them for the reason the paragraph above states rather than a new one:
// it wraps exactly one query over a payload that carries no metric and no points - a span, a
// record per metric, an integer and a list of dated milestones - so MetricCard's own
// metric/points contract has nothing to gate. It gates the page once, not a card at a time.
//
// by address, because each is a route's own top-level page - routes.tsx names it directly, the same
// as every other entry in pages/ - so it sits exactly where this guard looks and needs to be
// excused by name instead.
//
// Dashboard.tsx joined them in M9b, when it became the glance: its figures come from one payload,
// not from series points, so there is no MetricCard to gate, and its gating is the page-level
// error/loading branch around that one read.
const NO_METRIC_TO_GATE = new Set(['WorkoutDetail.tsx', 'NightDetail.tsx', 'Records.tsx', 'Dashboard.tsx'])

// What this actually checks, read honestly: not "no card hand rolls gating" (it is file
// granularity, so a page hand rolling two of its eight cards and routing the other six through
// MetricCard still passes), but "no page hand rolls every card and says nothing about the shared
// component existing." Sleep.tsx and Activity.tsx pass because most of their cards route through
// MetricCard; the hand rolled cards beside those are not individually checked against it. A true
// per card guard needs to attribute a given
// ErrorState/Loading/emptyState occurrence to the JSX block it sits in, which needs more than a
// whole file regex; this is the cheap version, and its name and this comment describe what it is.
describe('pages are not entirely hand rolled and silent about MetricCard', () => {
  const pages = readdirSync('apps/web/src/pages').filter((f) => f.endsWith('.tsx'))
  const sources = new Map(pages.map((page) => [page, readFileSync(`apps/web/src/pages/${page}`, 'utf8')]))
  const withGating = pages.filter((page) => HAND_ROLLED_GATING.test(sources.get(page)!))

  it.each(pages.filter((page) => !NO_METRIC_TO_GATE.has(page)))(
    '%s does not hand roll every card without using MetricCard anywhere', (page) => {
      const source = sources.get(page)!
      if (!HAND_ROLLED_GATING.test(source)) return
      expect(source).toMatch(USES_METRIC_CARD)
    },
  )

  it('finds the pages it claims to check', () => {
    expect(pages.length).toBeGreaterThan(0)
  })

  // The failure `it.each` cannot surface by itself: a case that hits the early return above
  // reports as passed without its own expect ever running, so a version of this file where the
  // trigger matched nothing on any real page would still show every case green. This is what
  // actually proves HAND_ROLLED_GATING fires on a real page rather than only in a regex someone
  // wrote and never ran. The old Dashboard's sleep stages card was that page until M9b; Sleep.tsx
  // and Activity.tsx, both checked above rather than excused, are it now.
  it('the gating trigger actually fires on at least one real page', () => {
    expect(withGating.length).toBeGreaterThan(0)
  })
})
