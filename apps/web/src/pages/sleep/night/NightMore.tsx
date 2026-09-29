import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { FigureRow } from '../../../components/FigureRow.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { formatFigureValue, verdictLine } from '../../detail/figureText.js'

// The mockup's own seven figures, in its own order, each drawn plainly against its band. Naps
// (figures.napCount, with figures.napMinutes as its value once there was one) is appended after
// these rather than folded in, since it alone reads a different figure for its label than for its
// value.
const MORE = ['light', 'awake', 'inBed', 'waketime', 'minutesToFallAsleep', 'awakenings', 'minutesAfterWakeUp'] as const

/**
 * Everything about the night that fits none of the sections above it: light sleep, time spent
 * awake in bed, total time in bed, the moment of waking, how long it took to fall asleep, how many
 * times its owner woke, the minutes spent awake after the final waking, and any naps. The mockup's
 * "Meer over de slaap" - one card, one grid, bars rather than strips, since a trend over the week
 * is already NightWeek's own job one card up.
 *
 * Naps read as a count everywhere else on this page (figures.napCount, judged and banded like any
 * other figure); this card's value line reads the minutes instead once there was at least one,
 * because "1" alone answers "how many" and not "how much", and reads `sleep.night.more.napsNone`
 * rather than a bare "0" on a night with none, so a reader is never shown a zero-minute nap.
 *
 * Rows with no reading hide, and the whole card hides once none of the eight has one - the same
 * closing-up rule NightMinis and NightMorning both keep.
 */
export function NightMore({ figures }: { figures: NightPageData['figures'] }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language

  const rows = useMemo(() => {
    const plain = MORE.flatMap((key) => {
      const figure = figures[key]
      if (figure.value === null) return []
      return [{
        key: key as string, label: t(`sleep.night.more.${key}`), figure,
        value: formatFigureValue(figure, figure.value, language, t),
        verdict: verdictLine(figure, language, t) ?? t('glance.usual.none'),
      }]
    })
    const { napCount, napMinutes } = figures
    if (napCount.value === null) return plain
    const naps = {
      key: 'naps', label: t('sleep.night.more.naps'), figure: napCount,
      value: napCount.value > 0 ? formatFigureValue(napMinutes, napMinutes.value, language, t) : t('sleep.night.more.napsNone'),
      verdict: verdictLine(napCount, language, t) ?? t('glance.usual.none'),
    }
    return [...plain, naps]
  }, [figures, language, t])

  if (rows.length === 0) return null

  return (
    <Card span={12} label={t('sleep.night.more.label')}>
      <div className="detail-rows">
        {rows.map(({ key, label, value, verdict, figure }) => (
          <FigureRow key={key} label={label} value={value} verdict={verdict} judged={figure.judged} standing={figure.standing}
            band={figure.baseline} mark={figure.value} />
        ))}
      </div>
    </Card>
  )
}
