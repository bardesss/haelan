import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { DailyAgg } from '@haelan/core/metrics'
import { useTranslation } from '../../i18n/index.js'
import type { Translate } from '../../format.js'
import { navigate } from '../../router.js'
import { Card } from '../../components/Card.js'
import { Loading } from '../../components/Loading.js'
import { ErrorState } from '../../components/ErrorState.js'
import { ControlRow } from '../../components/ControlRow.js'
import { PageHeader } from '../../components/PageHeader.js'
import { usePageControls } from '../../controls/usePageControls.js'
import { ALL_SOURCES, resolveSource } from '../../controls/source.js'
import { useSession } from '../../auth/session.js'
import type { PeriodFigure, PeriodStripPoint } from '../../data/periodTypes.js'
import { useSourceNames } from '../../data/useSourceNames.js'
import { useLastYear } from '../../data/lastYear.js'
import type { MetricGroup } from '../../data/useMetricGroups.js'
import { exportPathFor } from '../../data/pageShell.js'
import { verdictTone } from '../../charts/base.js'
import { formatFigureValue } from '../detail/figureText.js'
import { pointVerdictWords } from '../detail/periodText.js'
import type { PointPanelRow } from './PointPanel.js'
import { periodLine } from './periodLine.js'

const NO_DATES: string[] = Object.freeze([]) as never[]

/**
 * The first half of an overview page's shell (Sleep, Activity; PATTERNS.md's "Overview pages"): the
 * controls, and the source resolved against the sources this person has before anything is asked
 * (the rule every page keeps: the server answers an unknown one with a 400, and a stale link should
 * read as all sources, not as an error). The Day tab is no period: it goes to `dayHref(anchor)`,
 * replacing the history entry. Called before the page's own period read, which takes `source`.
 */
export function usePeriodSource(dayHref: (anchor: string) => string) {
  const controls = usePageControls()
  const { sources: named, nameOf } = useSourceNames()
  const sources = useMemo(() => named.map((source) => source.id), [named])
  const source = resolveSource(controls.source, [ALL_SOURCES, ...sources])
  const isDay = controls.tab === 'day'
  const dayTarget = isDay ? dayHref(controls.anchor) : null
  useEffect(() => {
    if (dayTarget !== null) navigate(dayTarget, { replace: true })
  }, [dayTarget])
  return { controls, sources, source, nameOf, isDay }
}

type PeriodSource = ReturnType<typeof usePeriodSource>

/**
 * The second half, over the page's period read: the header (PageHeader with the period and source,
 * then the ControlRow with the year comparison and the export of `exportMetrics`' daily sums, or
 * their `exportAgg`), the comparison with last year (asked on Week and Month only, while it is on:
 * on 3 months and Year the strip is weekly and draws no overlay; ended at historicalTo, so a month
 * six days old is set against the same six days a year earlier), the list's expansion (it belongs
 * to the period it was opened in: a new period opens collapsed), and `gate`, the page to render
 * instead while there is no period to draw (the Day tab's header alone, an error, loading).
 * `alone` puts a body in a single card under the header, in the detail page's root (PATTERNS.md's
 * page shell), for any other state.
 */
export function usePeriodShell<D extends { hero: PeriodFigure }>(o: {
  title: string
  page: PeriodSource
  query: { data: D | undefined, isError: boolean, error: unknown, refetch: () => unknown }
  exportMetrics: readonly string[]
  /** The agg the export downloads `exportMetrics` at: their sums unless the page says otherwise
   *  (Recovery's once-a-day readings, which the catalogue keeps as 'last'). */
  exportAgg?: DailyAgg
  lastYearGroups: readonly MetricGroup[]
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const session = useSession()
  const { controls, sources, source, nameOf, isDay } = o.page
  const { data } = o.query
  const range = { from: controls.from, to: controls.to, source }

  const heroDates = useMemo(() => data?.hero.daily.map((point) => point.from) ?? NO_DATES, [data])
  const overlaid = controls.tab === 'week' || controls.tab === 'month'
  const lastYear = useLastYear(o.lastYearGroups, { ...range, to: controls.historicalTo }, heroDates, controls.compareYear === true && overlaid)

  const periodKey = `${controls.tab}:${controls.from}:${source}`
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const expanded = expandedFor === periodKey
  const toggle = useCallback(() => setExpandedFor((open) => (open === periodKey ? null : periodKey)), [periodKey])

  const personId = session.data?.personId
  const exportPath = personId !== undefined ? exportPathFor(personId, o.exportMetrics, o.exportAgg ?? 'sum', range) : undefined
  const sourceName = source === ALL_SOURCES ? t('controlRow.sourceAll') : nameOf(source)
  const resolved = { ...controls, source }
  const header = (
    <>
      <PageHeader title={o.title} line={periodLine(controls.from, controls.to, sourceName, language)} />
      <ControlRow controls={resolved} sources={sources} exportPath={exportPath} yearCompare />
    </>
  )
  const alone = (body: ReactNode): ReactElement => <div className="detail-page">{header}<div className="grid"><Card span={12}>{body}</Card></div></div>
  const { query } = o
  const gate: ReactElement | null = isDay ? <div className="detail-page">{header}</div>
    : query.isError ? alone(<ErrorState onRetry={() => void query.refetch()} error={query.error} />)
      : data === undefined ? alone(<Loading />)
        : null
  return { range, heroDates, lastYear, periodKey, expanded, toggle, header, alone, gate }
}

/** A point's row in a panel: its figure's value and that point's own verdict, in its tone (the server's). */
export function pointRow(figure: PeriodFigure, point: PeriodStripPoint, label: string, language: string, t: Translate): PointPanelRow {
  return {
    label, value: formatFigureValue(figure, point.value, language, t),
    verdict: pointVerdictWords(point.standing, figure.unit, t), tone: verdictTone(point.judged, point.standing),
  }
}
