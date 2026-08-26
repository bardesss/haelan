import type { ReactNode } from 'react'
import { useTranslation } from '../i18n/index.js'
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
 */
export function MetricCard({ metric, query, points, baseline, basisKey, basisWornKey, basisValues, children }: {
  metric: string
  query: { isError: boolean, isPending: boolean, refetch: () => unknown }
  points: SeriesPoint[]
  baseline?: Baseline | null
  basisKey: string
  basisWornKey: string
  basisValues?: Record<string, unknown>
  children: (basis: string) => ReactNode
}): ReactNode {
  const { t } = useTranslation()

  // A failed request is not an empty period, and it outranks the pending check: an errored query
  // has isPending false and data undefined, which is exactly the shape emptyStateFor reads as "no
  // data yet".
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />
  // Nothing has been asked yet, so there is nothing to state. format() over an empty array is a
  // claim ("0 bpm"), and a basis line counting against a total nobody has checked is another.
  if (query.isPending) return <Loading />

  const empty = emptyStateFor(metric, points, baseline)
  if (empty !== null) {
    return <EmptyState title={t(`emptyState.${empty}.title`)} detail={t(`emptyState.${empty}.detail`)} />
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
  const basis = coverageIsWearSignal(metric)
    ? t(basisWornKey, { worn, count, reported, ...basisValues })
    : t(basisKey, { reported, ...basisValues })

  return <>{children(basis)}</>
}
