import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodFigure } from '../../../data/periodTypes.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { useSleepLabel } from './labels.js'

/**
 * "Meer over de slaap": the figures that fit no section above (light sleep, awake in bed, time in
 * bed, wake time, time to fall asleep, times woken, minutes after waking, naps), each its average
 * against its usual as a bar with its day counts: the server sends these with no points to draw.
 * The counts drop their noun ("26 of 30 usual"): every row in the card counts the same nights.
 *
 * Naps are their minutes: the period read carries no nap count (sleep_nap_count is not among its
 * figures), so the approved mockup's "3 naps, 0h 52m together" waits on the server sending one.
 */
export function SleepMore({ figures }: { figures: PeriodFigure[] }) {
  const { t } = useTranslation()
  const labelOf = useSleepLabel()
  return (
    <Card span={12} label={t('sleep.night.more.label')}>
      <PeriodFigureRows figures={figures} labelOf={labelOf} noun="none" bars />
    </Card>
  )
}
