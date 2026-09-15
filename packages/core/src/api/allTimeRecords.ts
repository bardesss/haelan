export interface DatedValue { localDate: string, value: number }
export interface DailyRecord { localDate: string, value: number }

/**
 * The best day on record, with the date it happened.
 *
 * **No eligibility filter, deliberately, and the reason is a fact about the data rather than a
 * preference.** A day the reader excluded has no `daily` row at all - `applyToDay` in
 * `derive/overrides.ts` removes an excluded metric's rows before they are written - and a
 * correction's value is already in the row. A filter here would be dead code today and a rule
 * applied twice the moment somebody made it live.
 *
 * Coverage does not gate either, which was measured rather than assumed: across every metric in
 * the household archive that carries a coverage number, the record holder survives every
 * threshold swept, because a big day is a worn day. Nobody sets a step record wearing the watch
 * for four hours.
 *
 * Pure, in `api/` beside `trainingLoad.ts`.
 */
export function recordOf(days: readonly DatedValue[]): DailyRecord | null {
  let best: DailyRecord | null = null
  for (const day of days) {
    // Strictly greater keeps the first day seen at a given value, and the date comparison below
    // keeps the EARLIEST rather than merely the first in the input: a record is when you first
    // did it, and a caller handing these over in some other order must not change who holds it.
    const better = best === null
      || day.value > best.value
      || (day.value === best.value && day.localDate < best.localDate)
    if (better) best = { localDate: day.localDate, value: day.value }
  }
  return best
}
