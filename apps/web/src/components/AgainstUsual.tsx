import { zScoreOf, BASELINE_WINDOW_DAYS } from '@haelan/core/baseline-window'
import { useTranslation } from '../i18n/index.js'
import { formatMetricValue } from '../format.js'
import { useBaseline } from '../data/useBaseline.js'
import type { Baseline } from '../data/useBaseline.js'

/**
 * How far a day has to sit from the usual before this says anything.
 *
 * Two, and it is a threshold for speaking rather than for judging. `probe/scripts/
 * anomaly-thresholds.mjs` measures what each threshold flags against a real archive, and what it
 * showed is that two is far too talkative for anything that arrives unasked, while being fine
 * here: this line appears only on a day somebody opened, and asks nothing of them when they do
 * not. Run the probe against an instance to see the rates for that household; they are not
 * written down here, because they are measurements about one home and this repository is public.
 *
 * One number for every metric, deliberately, even though the same probe showed the metrics are
 * shaped differently - sleep efficiency has a ceiling and no high tail at all, steps has almost no
 * low tail. A per metric threshold would be tuning a notification budget, and this has no budget
 * to tune: nothing is interrupted, so a metric that remarks more often than another is simply a
 * metric that varies more, which is true and worth seeing.
 */
export const NOTABLE_Z = 2

export interface UsualComparison {
  direction: 'above' | 'below'
  /** The distance from the centre, in the metric's own stored unit, always positive. */
  amount: number
}

/**
 * What to say about one day against the person's own recent history, or nothing.
 *
 * Nothing is the ordinary answer and has four separate causes, all of them normal: the day sits
 * inside the usual spread, there is no baseline, the baseline is too thin to stand on (about one
 * day in five, measured), or nothing varied at all so the distance has no units to be measured in.
 * None of those is an error, and none should render differently from the others - a reader must
 * not be able to tell a quiet day from a day this cannot judge, because the difference would be a
 * claim it has not earned.
 */
export function usualComparison(
  value: number | null, baseline: Baseline | null, _metric: string,
): UsualComparison | null {
  if (value === null || baseline === null || baseline.thin) return null
  const z = zScoreOf(value, baseline)
  // Null is a zero spread: a distance in units of nothing. Reading it as 0 would call every day
  // ordinary and reading it as infinite would call every day remarkable; it is neither.
  if (z === null || Math.abs(z) < NOTABLE_Z) return null
  return { direction: z > 0 ? 'above' : 'below', amount: Math.abs(value - baseline.center) }
}

/**
 * The line itself, given a value and a baseline. Presentational: it fetches nothing, so a test can
 * put it in any state without a network.
 *
 * The copy carries no sigma and no verdict. The z-score decided whether to speak; what gets said
 * is the plain difference in the metric's own unit, because "2.3 standard deviations below" is
 * jargon in a household app and "80 min below your 60-day average" is the same fact. No colour
 * either, for the reason TrainingLoadCard gives about its own figure: a personal archive is not
 * licensed to tell somebody that a low number is bad.
 */
export function AgainstUsualNote({ value, baseline, metric, unit }: {
  value: number | null
  baseline: Baseline | null
  metric: string
  unit?: string
}) {
  const { t, i18n } = useTranslation()
  const comparison = usualComparison(value, baseline, metric)
  if (comparison === null) return null
  const amount = formatMetricValue(comparison.amount, metric, i18n.language, '')
  return (
    <p className="against-usual">
      {t(`againstUsual.${comparison.direction}`, {
        amount: unit === undefined ? amount : `${amount} ${unit}`,
        days: BASELINE_WINDOW_DAYS,
      })}
    </p>
  )
}

/**
 * The same note, fetching the baseline it needs.
 *
 * Split from the presentational half above so a test can render every state without a network, and
 * so the request is made only where the line can appear: a caller mounts this on a single day
 * range and nowhere else, which is the one range where "how did this day compare" is a question
 * the reader has already asked by choosing the day.
 *
 * `agg` is the caller's, resolved through the group its card reads from, never guessed here. A
 * baseline computed over a different aggregate than the value beside it would be two different
 * numbers held up as a comparison.
 */
export function AgainstUsual({ metric, agg, on, source, value, unit }: {
  metric: string
  agg: string
  on: string
  source: string
  value: number | null
  unit?: string
}) {
  const { data } = useBaseline(metric, on, source, agg)
  // No loading state and no error state, deliberately. This line is an aside on a card that has
  // already said its piece; a spinner or a failure notice for it would be louder than the thing
  // itself, and its absence already reads as "nothing to remark on" in four other cases.
  return <AgainstUsualNote value={value} baseline={data?.baseline ?? null} metric={metric} unit={unit} />
}
