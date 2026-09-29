import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodFigure } from '../../../data/periodTypes.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { useSleepLabel } from './labels.js'

// Read as a deviation from its usual, as the night page reads it (NightMorning).
const DEVIATION: readonly string[] = ['sleep_temperature']

/** Whether any figure has a value to show; the rows leave out the rest. */
export function hasFigures(figures: readonly PeriodFigure[]): boolean {
  return figures.some((figure) => figure.value !== null)
}

/**
 * "De ochtenden": the mornings after the period's nights, each an average against its usual with
 * its strip (the recovery index, resting heart rate, HRV, breathing in sleep, oxygen and skin
 * temperature, those the server sent). Skin temperature reads as a deviation from its usual.
 *
 * Two across in a half card, as the mockup draws it: three came out ~98px each at a 960px window,
 * narrower than one Dutch label ("Huidtemperatuur"), and the page ran past the viewport. Alone
 * across the row it keeps side's three.
 */
export function SleepMornings({ figures, span }: { figures: PeriodFigure[], span: number }) {
  const { t } = useTranslation()
  const labelOf = useSleepLabel()
  return (
    <Card span={span} label={t('sleep.period.mornings')}>
      <PeriodFigureRows figures={figures} labelOf={labelOf} noun="day" side max={span === 6 ? 2 : undefined} deviation={DEVIATION} />
    </Card>
  )
}
