import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow } from '../../../components/FigureRow.js'
import type { FigureRowStrip } from '../../../components/FigureRow.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { formatFigureValue, stripOf, verdictLine } from '../../detail/figureText.js'

// The four figures under the hero, in the mockup's order.
const MINIS = ['efficiency', 'deep', 'rem', 'bedtime'] as const

/**
 * Efficiency, deep sleep, REM and bedtime, each with its value, a line of this night and the six
 * before it over each night's usual, and the server's verdict in words.
 *
 * A figure the night has no reading for is left out rather than shown as a dash: a row that says
 * nothing takes a quarter of the card. With none of the four the card goes too, so the grid
 * closes up. The rows are memoised on the payload's figures, since each strip's arrays and its
 * formatter reach the chart it draws, and a fresh one every render would rebuild it.
 */
export function NightMinis({ figures }: { figures: NightPageData['figures'] }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const rows = useMemo(() => MINIS.flatMap((key) => {
    const figure = figures[key]
    if (figure.value === null) return []
    const label = t(`sleep.night.minis.${key}`)
    const drawn = stripOf(figure)
    const strip: FigureRowStrip | undefined = drawn === null ? undefined : {
      ...drawn, metric: figure.metric, unit: label,
      formatValue: (value, absent) => (value === null ? absent : formatFigureValue(figure, value, language, t)),
    }
    return [{
      key, label, strip, figure,
      value: formatFigureValue(figure, figure.value, language, t),
      verdict: verdictLine(figure, language, t) ?? t('glance.usual.none'),
    }]
  }), [figures, language, t])
  if (rows.length === 0) return null

  return (
    <Card span={12}>
      <div className="night-minis">
        <div className="night-minis-rows">
          {rows.map(({ key, label, value, verdict, figure, strip }) => (
            <FigureRow key={key} label={label} value={value} verdict={verdict} judged={figure.judged}
              band={figure.baseline} mark={figure.value} strip={strip} />
          ))}
        </div>
        <p className="dash-caption">{t('sleep.night.minis.caption')}</p>
      </div>
    </Card>
  )
}
