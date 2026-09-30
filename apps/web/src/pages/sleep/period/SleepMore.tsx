import { useCallback, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodFigure } from '../../../data/periodTypes.js'
import { formatFigureValue } from '../../detail/figureText.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { useSleepLabel } from './labels.js'

const NAP_COUNT = 'sleep_nap_count'
const NAP_MINUTES = 'sleep_nap_minutes'

/**
 * "Meer over de slaap": the figures that fit no section above (light sleep, awake in bed, time in
 * bed, wake time, time to fall asleep, times woken, minutes after waking, naps), each its average
 * against its usual as a bar with its day counts: the server sends these with no points to draw.
 * The counts drop their noun ("26 of 30 usual"): every row in the card counts the same nights.
 *
 * Naps are one row, the approved mockup's: the period's count (a per-period figure, its usual a
 * period's worth), and under it the naps and their minutes together ("3 naps, 0h 52m together")
 * from the nap minutes' total, which draws no row of its own beside the count.
 */
export function SleepMore({ figures }: { figures: PeriodFigure[] }) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const labelOf = useSleepLabel()
  const minutes = figures.find((figure) => figure.metric === NAP_MINUTES) ?? null
  const hasCount = figures.some((figure) => figure.metric === NAP_COUNT)
  const rows = useMemo(() => (hasCount ? figures.filter((figure) => figure.metric !== NAP_MINUTES) : figures), [figures, hasCount])
  const noteOf = useCallback((figure: PeriodFigure) => {
    if (figure.metric !== NAP_COUNT || figure.total === null) return null
    if (figure.total === 0) return t('sleep.night.about.napsNone')
    const together = minutes?.total ?? null
    return together === null ? null
      : t('sleep.period.naps', { count: figure.total, minutes: formatFigureValue(minutes!, together, language, t) })
  }, [minutes, language, t])
  return (
    <Card span={12} label={t('sleep.night.more.label')}>
      <PeriodFigureRows figures={rows} labelOf={labelOf} noun="none" bars noteOf={noteOf} />
    </Card>
  )
}
