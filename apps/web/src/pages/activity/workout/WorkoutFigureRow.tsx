import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { FigureRow } from '../../../components/FigureRow.js'
import type { FigureRowStrip } from '../../../components/FigureRow.js'
import type { PageFigure } from '../../../data/useNightPage.js'
import type { WorkoutFigure } from '../../../data/useWorkoutPage.js'
import { formatFigureValue, verdictLine, workoutStripOf } from '../../detail/figureText.js'

/**
 * One figure below the workout page's fold as a FigureRow: its value in its own unit, the server's
 * verdict in words (or "no usual yet"), and either its bar against the usual or, with `withStrip`,
 * the line of this workout and the nine of its type before it. Nothing when the figure has no
 * reading, so a section can list every key it might show and let the absent ones fall away.
 *
 * `verdict` replaces the usual's words where the row says something else under its value (elapsed
 * time's moving time and pauses); `bare` then drops the bar too, since a bar beside words that are
 * not about the usual would read as their picture, and neither `judged` nor `standing` colours
 * those words. The strip is memoised on the figure: its arrays
 * and formatter reach the chart, and fresh ones every render would rebuild it.
 */
export function WorkoutFigureRow({ figure, label, withStrip = false, verdict, bare = false, note }: {
  figure: WorkoutFigure | PageFigure | undefined
  label: string
  withStrip?: boolean
  verdict?: string
  bare?: boolean
  /** FigureRow's line under the verdict. */
  note?: string
}): ReactNode {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const strip = useMemo((): FigureRowStrip | undefined => {
    if (!withStrip || figure === undefined || !('key' in figure)) return undefined
    const drawn = workoutStripOf(figure)
    return drawn === null ? undefined : {
      ...drawn, metric: figure.metric, unit: label,
      formatValue: (value, absent) => (value === null ? absent : formatFigureValue(figure, value, language, t)),
    }
  }, [withStrip, figure, label, language, t])
  if (figure === undefined || figure.value === null) return null
  return (
    <FigureRow label={label} value={formatFigureValue(figure, figure.value, language, t)}
      verdict={verdict ?? verdictLine(figure, language, t) ?? t('glance.usual.none')}
      judged={verdict === undefined ? figure.judged : null} standing={verdict === undefined ? figure.standing : null}
      band={bare ? null : figure.baseline} mark={figure.value} strip={strip} {...(note !== undefined && { note })} />
  )
}
