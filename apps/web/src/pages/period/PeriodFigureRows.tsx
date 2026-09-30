import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { FigureRow, FigureRows } from '../../components/FigureRow.js'
import type { FigureRowStrip } from '../../components/FigureRow.js'
import type { PeriodFigure } from '../../data/periodTypes.js'
import { formatFigureValue } from '../detail/figureText.js'
import { dayCountsLine, periodDeviationLine, periodStripOf, periodValueLine, periodVerdictLine } from '../detail/periodText.js'
import type { CountNoun } from '../detail/periodText.js'

const SEPARATOR = ' · '
const NONE: readonly string[] = []

/**
 * An overview page's figures as FigureRows, NightMinis's rows over the period read: each figure's
 * value (the period total, for a total), the verdict against the usual for a period of that length
 * (its range alone: the window that usual comes from is named once, in the hero), and under it, plain, a total's per-day average and the day counts, over a strip of its
 * points each against its own usual, or with `bars` (a `more` figure, sent with no points) the bar.
 *
 * A figure with no value is left out, and with none left the rows are null, so the caller's card
 * can go too. Memoised on the figures: each strip's arrays and formatter reach the chart, and a
 * fresh one every render would rebuild it. `labelOf` is a dependency, so a caller keeps it stable,
 * and `deviation` too (a module constant): the metrics read as a deviation from their usual, skin
 * temperature on Sleep (periodDeviationLine), whose strip still plots the readings themselves.
 * `noteOf` (stable too) gives a figure a note of its own in place of its per-day line and counts,
 * the nap count's "3 naps, 0h 52m together"; null keeps the usual note. A total's usual note is its
 * per-day line alone, without the day counts. `children` are rows of the caller's own after these.
 */
export function PeriodFigureRows({ figures, labelOf, noun, max, side = false, bars = false, deviation = NONE, noteOf, children }: {
  figures: PeriodFigure[]
  labelOf: (metric: string) => string
  /** What the day counts count ("nights", "mornings"), or 'none' where the card says it once. */
  noun: CountNoun
  max?: 1 | 2 | 3 | 4
  side?: boolean
  bars?: boolean
  deviation?: readonly string[]
  noteOf?: (figure: PeriodFigure) => string | null
  /** Rows of the caller's own after these, in the same grid (the Activity page's VO₂max). */
  children?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const rows = useMemo(() => figures.flatMap((figure) => {
    if (figure.value === null) return []
    const label = labelOf(figure.metric)
    const drawn = bars ? null : periodStripOf(figure)
    const strip: FigureRowStrip | undefined = drawn === null ? undefined : {
      values: drawn.values, labels: drawn.labels, bands: drawn.bands,
      pointStandings: drawn.pointStandings, pointJudged: drawn.pointJudged, metric: figure.metric, unit: label,
      formatValue: (value, absent) => (value === null ? absent : formatFigureValue(figure, value, language, t)),
    }
    const deviated = deviation.includes(figure.metric) ? periodDeviationLine(figure, language, t) : null
    const { value, under } = deviated === null ? periodValueLine(figure, language, t) : { value: deviated.value, under: null }
    const verdict = (deviated === null ? periodVerdictLine(figure, language, t) : deviated.verdict) ?? t('glance.usual.none')
    // What is not a verdict goes under it, plain, so only the verdict's words take its tone.
    // A total's note is its average per day alone, the approved Activity mockup's ("6.1 km per day
    // on average"): its day counts would count the days of an average the row does not print.
    const own = noteOf?.(figure) ?? null
    const parts = own !== null ? [own] : under !== null ? [under] : [dayCountsLine(figure, noun, t)].filter((part) => part !== null)
    const note = parts.length === 0 ? undefined : parts.join(SEPARATOR)
    return [{ key: figure.metric, label, value, verdict, note, figure, strip }]
  }), [figures, labelOf, noun, bars, deviation, noteOf, language, t])
  if (rows.length === 0 && (children === undefined || children === null || children === false)) return null

  return (
    <FigureRows max={max} side={side}>
      {rows.map(({ key, label, value, verdict, note, figure, strip }) => (
        <FigureRow key={key} label={label} value={value} verdict={verdict} note={note} judged={figure.judged} standing={figure.standing}
          band={figure.usual} mark={figure.value} strip={strip} />
      ))}
      {children}
    </FigureRows>
  )
}
