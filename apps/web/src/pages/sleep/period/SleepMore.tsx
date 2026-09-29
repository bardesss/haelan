import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodFigure } from '../../../data/periodTypes.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { useSleepLabel } from './labels.js'

/**
 * "Meer over de slaap": the figures that fit no section above (light sleep, awake in bed, time in
 * bed, wake time, time to fall asleep, times woken, minutes after waking, naps), each its average
 * against its usual as a bar with its day counts: the server sends these with no points to draw.
 */
export function SleepMore({ figures }: { figures: PeriodFigure[] }) {
  const { t } = useTranslation()
  const labelOf = useSleepLabel()
  return (
    <Card span={12} label={t('sleep.night.more.label')}>
      <PeriodFigureRows figures={figures} labelOf={labelOf} noun="night" bars />
    </Card>
  )
}
