import type { DbOrTx } from '../db/open.ts'
import { readIntradayWindow } from './intraday.ts'
import type { MinuteBpm } from '../api/cardioLoad.ts'

/**
 * A workout's heart rate over its own span, at full stored resolution.
 *
 * **Unthinned, and that is the whole point of this module.** `readIntradayWindow` thins to a
 * caller-supplied point budget with `thinBand`, whose `minmax` bucketing keeps each bucket's
 * extremes - so a mean taken over those points is biased, and worse, biased by an argument about
 * display. The same kilometre would answer a different BPM at `points: 50` than at `points: 300`,
 * and the same workout a different Banister sum. A derived number may not move when a chart's
 * budget moves, so this reader asks for a budget nothing can exceed and gets the stored series
 * back untouched.
 *
 * Pinned to the device that recorded the workout, with one retry across every source when that
 * device logged nothing in the span. That rule is measured rather than assumed: across 198
 * archived exercise sessions on 2026-09-12, 189 had heart rate from the recording device only, 2
 * from that device and another, 5 from ANOTHER DEVICE ONLY, and 2 from nobody. Both naive options
 * are wrong - never pinning blends two devices into one unlabelled average for the 2, always
 * pinning answers empty for the 5, and an empty answer reads as "no heart rate was recorded",
 * which is false. `useSourceTrace.ts` and `get_workout` state and implement the same four cases;
 * this is the third surface and it must not become a fourth opinion.
 *
 * A caller that named a source never falls back. An empty answer to a specific question is honest,
 * and silently answering a different question is the failure the rule exists to prevent.
 */
export interface SessionHeartRate {
  minutes: MinuteBpm[]
  traceSource: 'pinnedSource' | 'otherSources'
  /** Which source the minutes came from, or null when there were none. `otherSources` can blend
   *  several, in which case this is null too - the blend has no single source to name. */
  sourceId: string | null
}

// Larger than any archive can hold for one session, so `thin` takes its "nothing to do" branch
// (`points.length <= target`) and hands back the stored series unchanged. A literal rather than
// Number.MAX_SAFE_INTEGER: readWindow divides this by the number of sources present, and dividing
// MAX_SAFE_INTEGER loses precision for no reason. A 48 hour window (personQuery's own cap) holds
// 2,880 minutes.
const NO_THINNING = 1_000_000

export function readSessionHeartRateMinutes(db: DbOrTx, input: {
  personId: string
  startMs: number
  endMs: number
  /** The device that recorded the workout: `sessions.source_id`. */
  sessionSourceId: string
  /** A source the caller named. Present means never fall back. */
  chosenSourceId?: string
}): SessionHeartRate {
  const pinnedSourceId = input.chosenSourceId ?? input.sessionSourceId
  const read = (sourceId: string | undefined) => readIntradayWindow(db, {
    personId: input.personId,
    metric: 'heart_rate',
    startMs: input.startMs,
    endMs: input.endMs,
    points: NO_THINNING,
    sourceId,
  })

  let result = read(pinnedSourceId)
  let traceSource: SessionHeartRate['traceSource'] = 'pinnedSource'
  if (result.points.length === 0 && input.chosenSourceId === undefined) {
    const blended = read(undefined)
    if (blended.points.length > 0) {
      result = blended
      traceSource = 'otherSources'
    }
  }

  // `mean` rather than min or max: heart rate is the one metric stored downsampled to the minute
  // (api/catalogue.ts, `downsampleToMinute`), so a point's mean is that minute's own average and
  // the three together describe one minute rather than three readings.
  const minutes: MinuteBpm[] = result.points
    .filter((point) => point.mean !== null)
    // readIntradayWindow marks a sample-scope exclusion on the point (`excluded: true`) rather
    // than dropping it, because a chart needs the point to anchor a marker on - that is a display
    // decision, stated on IntradayPoint itself. A correction already flows through correctly by
    // the time a point reaches here: readIntradayWindow substitutes the corrected value before
    // this reader ever sees it, so nothing further is needed for that action. But this reader
    // feeds a *number* - a Banister sum, a split's filled mean - and a number gets one answer, not
    // one for the chart and a different one for the tile beside it (derive/cardioLoad.ts's own
    // comment on not producing a second answer to the same question). A reading the person
    // excluded is not corrected, it is disowned, so it is dropped here rather than merely flagged.
    .filter((point) => !point.excluded)
    .map((point) => ({ utcMs: point.utcMs, bpm: point.mean! }))
    // Belt and braces, not a fix for anything broken today: readWindow's own final line already
    // sorts by utcMs before returning (query/intraday.ts, the `.sort` on `perSourcePoints.flat()`).
    // Every consumer here reads the series as a strict timeline - a split's window, a running sum
    // over a session - and this module would rather state that requirement once, itself, than have
    // it hold only because another module's internal pivot-then-concatenate happens to sort its
    // own output today. If readWindow's ordering guarantee ever changed, this line is what keeps
    // that change from becoming a silent bug here.
    .sort((a, b) => a.utcMs - b.utcMs)

  const sources = new Set(result.points.map((point) => point.sourceId))
  return {
    minutes,
    traceSource,
    sourceId: sources.size === 1 ? [...sources][0]! : null,
  }
}
