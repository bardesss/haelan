import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { BasisContext } from '../../../components/basis.js'
import { StackedDailyBars } from '../../../charts/StackedDailyBars.js'
import type { BandSeries } from '../../../charts/StackedDailyBars.js'
import { periodAxisLabels } from '../../../charts/barAxis.js'
import type { ChartTokens } from '../../../charts/tokens.js'
import type { PeriodFigure } from '../../../data/periodTypes.js'
import type { PeriodRange } from '../../../data/periodTypes.js'

/** One band of a stacked bar: its key (the legend swatch's), token, name, figure and legend text. */
export interface StackedBand { band: string, token: keyof ChartTokens, name: string, figure: PeriodFigure, legend: string }

// A band's points: its weeks on 3 months and Year, its days otherwise.
const pointsOf = (figure: PeriodFigure) => figure.weekly ?? figure.daily

/** The bands among `specs` whose figure has a value, in order; a card with none is left out. */
export function presentBands<S extends { figure: PeriodFigure | null }>(specs: readonly S[]): (S & { figure: PeriodFigure })[] {
  return specs.flatMap((spec) => (spec.figure === null || spec.figure.value === null ? [] : [spec as S & { figure: PeriodFigure }]))
}

/**
 * The stacked bars the Activity page's intensity and zone-minutes cards share: each point's bands
 * as one stacked bar (the server's days, or its weeks on 3 months and Year), the x axis in the
 * range's own words, and under it a legend naming each band with its own text, its swatch keyed by
 * `swatch` (`data-activity`, `data-azm`) so each card keeps its own colours. Whether the points are
 * weeks is the caller's caption to say.
 */
export function PeriodStackedBars({ bands, range, label, unit, axisUnit, metric, swatch }: {
  bands: readonly StackedBand[]
  range: PeriodRange
  label: string
  unit: string
  axisUnit: string
  /** The metric the chart's tooltip formats by. */
  metric: string
  swatch: 'activity' | 'azm'
}) {
  const { i18n } = useTranslation()
  const language = i18n.language
  const legendId = useId()
  const labels = useMemo(() => (bands[0] === undefined ? [] : pointsOf(bands[0].figure).map((point) => point.from)), [bands])
  const axis = useMemo(() => periodAxisLabels(labels, range, language), [labels, range, language])
  const series = useMemo<BandSeries[]>(() => bands.map(({ token, name, figure }) => ({
    key: figure.metric, name, token, values: pointsOf(figure).map((point) => point.value),
  })), [bands])
  return (
    <>
      <BasisContext.Provider value={legendId}>
        <StackedDailyBars series={series} labels={labels} label={label} unit={unit} axisUnit={axisUnit} metric={metric} axis={axis} />
      </BasisContext.Provider>
      <ul className="detail-legend" id={legendId}>
        {bands.map(({ band, name, legend }) => (
          <li key={band}><span className="detail-legend-key" {...{ [`data-${swatch}`]: band }} aria-hidden="true" />{name} {legend}</li>
        ))}
      </ul>
    </>
  )
}
