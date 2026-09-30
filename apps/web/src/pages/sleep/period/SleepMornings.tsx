import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import type { PeriodFigure, PeriodRange } from '../../../data/periodTypes.js'
import { PeriodFigureRows } from '../../period/PeriodFigureRows.js'
import { thisPeriod } from '../../detail/periodText.js'
import { drawsNights } from './SleepScheduleCard.js'
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
 * temperature, those the server sent), their day counts counted in mornings, and a caption under
 * the rows saying what the strips' points are. Skin temperature reads as a deviation from its usual.
 *
 * Two across in a half card, as the mockup draws it: three came out ~98px each at a 960px window,
 * narrower than one Dutch label ("Huidtemperatuur"), and the page ran past the viewport. Alone
 * across the row it keeps side's three.
 */
export function SleepMornings({ figures, range, span }: { figures: PeriodFigure[], range: PeriodRange, span: number }) {
  const { t } = useTranslation()
  const labelOf = useSleepLabel()
  return (
    <Card span={span} label={t('sleep.period.mornings')}>
      <PeriodFigureRows figures={figures} labelOf={labelOf} noun="morning" side max={span === 6 ? 2 : undefined} deviation={DEVIATION} />
      {/* Week and Month draw each morning; 3 months and Year each week's average. */}
      <p className="dash-caption">
        {drawsNights(range) ? t('sleep.period.lines.mornings', { period: thisPeriod(range, t) }) : t('sleep.period.lines.weeklyMornings')}
      </p>
    </Card>
  )
}
