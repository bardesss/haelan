import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
import { Card } from './Card.js'
import { ErrorState } from './ErrorState.js'
import { Loading } from './Loading.js'
import { EmptyState } from './EmptyState.js'
import { emptyStateFor, wornOn, coverageIsWearSignal } from '../data/emptyState.js'
import type { SeriesPoint } from '../data/useSeries.js'
import type { Baseline } from '../data/useBaseline.js'

/**
 * Resolves a query's state and, once there is data, the basis line that goes with it, in one
 * place rather than two.
 *
 * This is the component M3d-1's review kept finding the absence of: a card naming a baseline band
 * it was not drawing, a heatmap reading "20 of 20 days worn" beside a grid drawing eleven absence
 * dots, a sleep stages card naming a night that did not exist, four tiles printing a confident
 * zero while their queries were still pending. Four different files, four different authors, one
 * missing component, because gating and the basis line were two decisions made in two places and
 * nothing forced them to agree. `children` is handed the basis string it must render alongside,
 * so a caller cannot compute its own and let the two drift apart again.
 *
 * Moved out of Dashboard.tsx's `tile()`, comments included, because those comments are the record
 * of what went wrong and why the order below is the order it is.
 *
 * Owns the `Card` shell too, not just the content inside it. The first version left `span`/`label`/
 * `basis` to the caller's own `<Card>`, which put the basis on a prop this component never touched:
 * a caller wanting the basis in the header, rather than inside `children`, could not use this
 * component without either losing the card chrome in the error/pending/empty branches (by putting
 * `MetricCard` outside `Card`) or hand rolling a second copy of `Card`'s own basis paragraph and
 * `BasisContext` wiring inside `children` (by putting it inside). Neither is the fix; the fix is
 * that `Card` renders here, in every branch, so the chrome survives regardless of what is drawn and
 * the header basis comes from the exact place that decided what to draw.
 *
 * `basisPlacement` has no default because one is the exact bug this component then shipped: giving
 * `Card` the basis unconditionally, on top of a tile card that already renders it through
 * `StatTile`, printed the same sentence twice, the second copy carrying the delta clause the first
 * lacked. There is no placement that is right for every caller, so there is no placement that is
 * right for a caller that says nothing, the same reasoning `worn` and `reported` are typed `never`
 * on `basisValues` rather than merely documented as reserved.
 */
export function MetricCard({ metric, query, points, baseline, span, label, basisPlacement, basisKey, basisWornKey, basisValues, after, children }: {
  metric: string
  query: { isError: boolean, isPending: boolean, refetch: () => unknown }
  points: SeriesPoint[]
  baseline?: Baseline | null
  span: number
  label?: string
  // 'header' hands the basis to Card, which renders it above children the way the heart rate range
  // and sleep schedule cards want it. 'body' withholds it from Card and leaves it to `children`,
  // which is what a tile card needs: StatTile renders its own basis paragraph directly beneath the
  // value, and Card would otherwise print a second one above the label.
  basisPlacement: 'header' | 'body'
  basisKey: string
  basisWornKey: string
  // worn and reported stay reserved: MetricCard always overwrites them after the spread (reported
  // in both branches, worn only in the wear branch, but a value a caller passed for it would just
  // sit there unused, which is its own kind of trap), so a caller's own copy could only ever be
  // silently discarded or silently ignored, never actually used. count is not reserved the same
  // way any more: it is only ever overwritten in the wear branch below, and a caller routed through
  // the plain key (a card whose metric carries no wear signal, such as a night count) owns that
  // clause outright and needs its own count to fill a plural i18next reads no other name for. See
  // the wear/plain split lower in this file for which branch actually applies it.
  basisValues?: Record<string, unknown> & { worn?: never, reported?: never }
  // Rendered inside the Card shell in every branch, error, pending, empty and data alike: a card
  // link ("View activity") sits beside the metric content today and stayed visible through every
  // state before this component owned the shell, so folding the shell in must not make it vanish
  // the moment a request fails or a period comes back empty.
  after?: ReactNode
  children: (basis: string) => ReactNode
}): ReactNode {
  const { t } = useTranslation()

  // A failed request is not an empty period, and it outranks the pending check even when both
  // flags are true at once: a composite query built by OR-ing several requests together (the
  // heart rate range card ORs three isError flags and three isPending flags into one query of
  // this same shape) can have one series still pending while another has already failed, and an
  // errored query has isPending false and data undefined, which is exactly the shape emptyStateFor
  // reads as "no data yet".
  if (query.isError) {
    return <Card span={span} label={label}><ErrorState onRetry={() => void query.refetch()} />{after}</Card>
  }
  // Nothing has been asked yet, so there is nothing to state. format() over an empty array is a
  // claim ("0 bpm"), and a basis line counting against a total nobody has checked is another.
  if (query.isPending) return <Card span={span} label={label}><Loading />{after}</Card>

  const empty = emptyStateFor(metric, points, baseline)
  if (empty !== null) {
    return (
      <Card span={span} label={label}>
        <EmptyState title={t(`emptyState.${empty}.title`)} detail={t(`emptyState.${empty}.detail`)} />
        {after}
      </Card>
    )
  }

  // worn and unworn count only the points that can answer the wear question (see wornOn): a day
  // with no row is neither, since a gap has no cause this data can name, and a metric whose
  // coverage says nothing about wear contributes to neither. That is why the caller picks between
  // a basis line carrying the wear clause and one without it, rather than printing a zero over a
  // metric that could never have produced anything else.
  //
  // The unworn figure is named `count` because i18next reads that one name and no other when it
  // picks between a key's _one and _other forms. It was `unworn` while the number was
  // structurally always zero, which read as "0 days not worn" in every language and hid the
  // missing plural; the coverage fix made one reachable, and one is where a missing plural shows.
  const answers = points.map((point) => wornOn(metric, point))
  const worn = answers.filter((w) => w === true).length
  const count = answers.filter((w) => w === false).length
  const reported = points.length

  // basisKey and basisWornKey both arrive as literal strings, and which of the two renders is
  // decided here from the metric rather than at the call site: a card whose metric changed to one
  // whose coverage cannot speak to wear would otherwise keep a wear clause that can only ever
  // print zeroes, which is the Critical this page already fixed once.
  //
  // Only the wear clause carries `count`, and it is handed over only to the key that has an _one
  // and an _other to choose between: passing it to a key with neither would ask i18next to
  // pluralise a string nobody wrote a plural for.
  //
  // basisValues spreads first, not last, in the wear branch: worn, count and reported are computed
  // above from the same metric and points that gated the states above them, and a caller's own copy
  // of those figures landing after them in the spread would silently overwrite a truthful
  // computation with a second, independently derived one, the very split this component exists to
  // make impossible. The plain branch only owns `reported` the same way, so a caller's own `count`
  // (a night count, a workout count, anything the wear clause never speaks to) survives there.
  const basis = coverageIsWearSignal(metric)
    ? t(basisWornKey, { ...basisValues, worn, count, reported })
    : t(basisKey, { ...basisValues, reported })

  // children always receives the real basis string regardless of placement, since a 'body' caller
  // still needs it to hand to its own StatTile; only Card's own copy is conditional.
  return (
    <Card span={span} label={label} basis={basisPlacement === 'header' ? basis : undefined}>
      {children(basis)}{after}
    </Card>
  )
}
