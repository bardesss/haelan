import { useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { Hypnogram, stageTotals } from '../../../charts/Hypnogram.js'
import { STAGE_LABEL_KEY } from '../../../charts/stage.js'
import { NightExcludedSessions } from '../../../components/NightExcludedSessions.js'
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
 * The night itself: its stages across the night, each stage's time and share of it, the naps and
 * excluded sessions beside it, then the heart rate, HRV and blood oxygen traces over the same span,
 * each against its usual range.
 *
 * The segments are built the way NightStages built them: raw milliseconds from the night's start,
 * rounded once by stageTotals rather than per boundary (NightStages.tsx's own comment has why).
 * The shares are the server's (`stagePercent`), never divided out here; awake has none, since the
 * server gives the three sleep stages a share of the sleep and awake is not part of it. A stage the
 * server sent no share for reads its minutes alone.
 *
 * The traces sit after this card as cards of their own, full width in the same grid: each already
 * carries its own label, basis line and error state, and nesting three cards inside a fourth would
 * draw a frame inside a frame.
 */
export function NightThrough({ page, chosenSource }: { page: NightPageData, chosenSource: string | null }) {
  const { t, i18n } = useTranslation()
  const { night, stagePercent, traces } = page

  const segments = useMemo(() => night.segments
    .map((s) => ({ stage: stageOf(s.stage), startMs: s.startMs - night.startMs, endMs: s.endMs - night.startMs }))
    .filter((s): s is { stage: Stage, startMs: number, endMs: number } => s.stage !== null),
  [night])

  // Keyed by metric id, the spelling NightTraces keys its cards by. Memoised on the payload: each
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

  const bedMinutes = inWindow(
    localMinutesOf(night.localDate, night.startMs, night.startOffsetMinutes), WIDE_WINDOW)
  // At the wake-side offset, the one in force when a nap started (NightStages.tsx's own comment).
  const napTimes = night.naps.map((at) => formatClock(localMinutesOf(night.localDate, at, night.endOffsetMinutes)))
  const label = t('sleep.night.through.label')

  return (
    <>
      <Card span={12} label={label}>
        {segments.length > 0 && (
          <>
            <Hypnogram segments={segments} startLabel={t('common.bedLabel', { time: formatClock(bedMinutes) })}
              startClock={bedMinutes} label={label} totals={false} />
            <ul className="night-legend">
              {legend.map(({ stage, text }) => (
                <li key={stage}><span className="night-legend-key" data-stage={stage} aria-hidden="true" />{text}</li>
              ))}
            </ul>
          </>
        )}
        {/* An unstaged night still has its naps and its excluded sessions: the card stays, with
            Hypnogram's absence sentence left out along with the chart (NightStages.tsx's rule). */}
        <p className="night-naps">
          {night.naps.length === 0
            ? t('sleep.night.naps.none')
            : `${t('sleep.night.naps.list')} ${napTimes.join(', ')}`}
        </p>
        <NightExcludedSessions count={night.excludedSessions.length} />
      </Card>
      <NightTraces night={night} chosenSource={chosenSource} traces={figures} />
    </>
  )
}
