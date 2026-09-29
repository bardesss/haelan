import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { Hypnogram, stageTotals } from '../../../charts/Hypnogram.js'
import { STAGE_LABEL_KEY } from '../../../charts/stage.js'
import { stageOf } from '../../../data/nights.js'
import type { Stage } from '../../../fixtures/july.js'
import { formatClock, formatDuration, formatNumber } from '../../../format.js'
import { localMinutesOf, inWindow, WIDE_WINDOW } from '../../../charts/schedule.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { NightTraces } from '../NightTraces.js'
import type { NightTracesFigures } from '../NightTraces.js'

// The legend's reading order, deep to awake, the order Hypnogram's own totals row reads in.
const LEGEND: Stage[] = ['deep', 'light', 'rem', 'awake']

/**
 * The night itself: its stages across the night, each stage's time and share of it, then the heart
 * rate, HRV and blood oxygen traces over the same span, each against its usual range. One card, the
 * approved mockup's "The night". Naps are the "More about the sleep" card's to say, not this one's.
 *
 * The segments are raw milliseconds from the night's start, rounded once by stageTotals rather than
 * per boundary: rounding each boundary first compounds into minutes of drift against
 * derive/sleep.ts's own single-rounded figure (Sleep.tsx's comment on the same conversion). The
 * shares are the server's (`stagePercent`), never divided out here; awake has none, since the
 * server gives the three sleep stages a share of the sleep and awake is not part of it. A stage the
 * server sent no share for reads its minutes alone.
 *
 * The hypnogram is absent, not an empty chart, on a night with no staged segments, which would read
 * as a night with no deep, light or REM sleep at all; the card stays for the traces, and goes too
 * when the server found no trace readings either (every trace's `stat` empty). The legend doubles
 * as the hypnogram's accessible description: it is the chart's content in words.
 *
 * The excluded-sessions notice that used to close this card moved to NightAbout.tsx (M10a-2 task 7),
 * next to the session list it explains; this card no longer reads `night.excludedSessions` at all.
 */
export function NightThrough({ page, chosenSource }: { page: NightPageData, chosenSource: string | null }) {
  const { t, i18n } = useTranslation()
  const { night, stagePercent, traces, figures: { awake } } = page
  const legendId = useId()

  const segments = useMemo(() => night.segments
    .map((s) => ({ stage: stageOf(s.stage), startMs: s.startMs - night.startMs, endMs: s.endMs - night.startMs }))
    .filter((s): s is { stage: Stage, startMs: number, endMs: number } => s.stage !== null),
  [night])

  // Keyed by metric id, the spelling NightTraces keys its rows by. Memoised on the payload: each
  // trace's baseline object reaches its chart's band, which rebuilds on a new reference.
  const figures = useMemo<NightTracesFigures>(
    () => ({ heart_rate: traces.heartRate, hrv: traces.hrv, spo2: traces.spo2 }), [traces])

  const minutesByStage = new Map(stageTotals(segments).map((total) => [total.stage, total.minutes]))
  const legend = LEGEND.filter((stage) => minutesByStage.has(stage)).map((stage) => {
    const duration = formatDuration(minutesByStage.get(stage)!)
    const percent = stage === 'awake' ? null : stagePercent[stage]
    // The stage's name joined in plain JS, the value half through the catalogue: the same split
    // Hypnogram's own totals row uses for a stage label beside its duration.
    const figure = percent === null
      ? duration
      : t('sleep.night.through.share', { duration, percent: formatNumber(percent, 0, i18n.language, t('common.absent')) })
    return { stage, text: `${t(STAGE_LABEL_KEY[stage])} ${figure}` }
  })

  // The awake lane counts AWAKE segments only; the night's awake figure also counts restless time and
  // the gaps between its pieces (derive/sleep.ts). When the two read differently, the note says why,
  // so the legend and the figure elsewhere on the page do not simply disagree. A comparison of two
  // displayed minutes, not a judgement of either.
  const awakeLane = minutesByStage.get('awake')
  const awakeDiffers = awakeLane !== undefined && awake.value !== null && Math.round(awake.value) !== awakeLane

  const bedMinutes = inWindow(
    localMinutesOf(night.localDate, night.startMs, night.startOffsetMinutes), WIDE_WINDOW)
  const label = t('sleep.night.through.label')
  const anyTrace = [traces.heartRate, traces.hrv, traces.spo2].some((trace) => trace.stat.mean !== null)
  if (segments.length === 0 && !anyTrace) return null

  return (
    <Card span={12} label={label}>
      {segments.length > 0 && (
        <>
          <BasisContext.Provider value={legendId}>
            <Hypnogram segments={segments} startLabel={t('common.bedLabel', { time: formatClock(bedMinutes) })}
              startClock={bedMinutes} label={label} totals={false} />
          </BasisContext.Provider>
          <ul className="night-legend" id={legendId}>
            {legend.map(({ stage, text }) => (
              <li key={stage}><span className="night-legend-key" data-stage={stage} aria-hidden="true" />{text}</li>
            ))}
          </ul>
          {awakeDiffers && <p className="hypnogram-totals">{t('charts.hypnogram.awakeNote')}</p>}
        </>
      )}
      <NightTraces night={night} chosenSource={chosenSource} traces={figures} />
    </Card>
  )
}
