import { useId, useMemo } from 'react'
import { useTranslation } from '../../../i18n/index.js'
import { Card } from '../../../components/Card.js'
import { BasisContext } from '../../../components/basis.js'
import { Hypnogram, stageTotals } from '../../../charts/Hypnogram.js'
import { STAGE_LABEL_KEY } from '../../../charts/stage.js'
import { stageOf } from '../../../data/nights.js'
import type { Stage } from '../../../fixtures/july.js'
import { formatClock, formatDuration, formatNumber, formatRecordedClock } from '../../../format.js'
import { localMinutesOf, inWindow, WIDE_WINDOW } from '../../../charts/schedule.js'
import type { NightPageData } from '../../../data/useNightPage.js'
import { NightTraces } from '../NightTraces.js'
import { FigureRow, FigureRows } from '../../../components/FigureRow.js'
import { formatFigureValue, verdictLine } from '../../detail/figureText.js'
import type { NightTracesFigures } from '../NightTraces.js'

// When the first deep and REM sleep began, and how many REM episodes there were: the server's
// stageTiming, in this order.
const TIMING = ['firstDeep', 'firstRem', 'cycles'] as const

// The legend's reading order, deep to awake, the order Hypnogram's own totals row reads in.
const LEGEND: Stage[] = ['deep', 'light', 'rem', 'awake']

/**
 * The night itself: its stages across the night, each stage's time and share of it, then the heart
 * rate, HRV and blood oxygen traces over the same span, each against its usual range. One card, the
 * approved mockup's "The night". Naps are the "More about the sleep" card's to say, not this one's.
 *
 * The segments are raw milliseconds from the night's start, rounded once by stageTotals rather than
 * per boundary: rounding each boundary first compounds into minutes of drift against
 * derive/sleep.ts's own single-rounded figure (Hypnogram's comment on its `segments` prop). The
 * shares are the server's (`stagePercent`), never divided out here; awake has none, since the
 * server gives the three sleep stages a share of the sleep and awake is not part of it. A stage the
 * server sent no share for reads its minutes alone.
 *
 * The hypnogram is absent, not an empty chart, on a night with no staged segments, which would read
 * as a night with no deep, light or REM sleep at all; the card stays for the traces, and goes too
 * when the server found no trace readings either (every trace's `stat` empty). The legend doubles
 * as the hypnogram's accessible description: it is the chart's content in words.
 *
 * Under the legend, when the first deep and REM sleep began and how many cycles the night held,
 * three across, each against its own usual. A row the server sent no value for is left out, and the
 * block with it when all three are: a night recorded without deep and REM stages (a classic night)
 * has no timing at all. First deep and first REM each note the clock time they began, at the night's
 * own offset (the clock the hypnogram reads); cycles notes what one cycle is.
 *
 * The heart-rate trace's row adds how far the heart rate dipped below the resting rate, the
 * morning card's dip figure, when the server sent one.
 *
 * The excluded-sessions notice that used to close this card moved to NightAbout.tsx (M10a-2 task 7),
 * next to the session list it explains; this card no longer reads `night.excludedSessions` at all.
 */
export function NightThrough({ page, chosenSource }: { page: NightPageData, chosenSource: string | null }) {
  const { t, i18n } = useTranslation()
  const { night, stagePercent, traces, stageTiming, figures: { awake }, morning: { heartRateDip } } = page
  const language = i18n.language
  const legendId = useId()

  const segments = useMemo(() => night.segments
    .map((s) => ({ stage: stageOf(s.stage), startMs: s.startMs - night.startMs, endMs: s.endMs - night.startMs }))
    .filter((s): s is { stage: Stage, startMs: number, endMs: number } => s.stage !== null),
  [night])

  // Keyed by metric id, the spelling NightTraces keys its rows by. Memoised on the payload: each
  // trace's baseline object reaches its chart's band, which rebuilds on a new reference.
  const figures = useMemo<NightTracesFigures>(
    () => ({ heart_rate: traces.heartRate, hrv: traces.hrv, spo2: traces.spo2 }), [traces])

  const timing = useMemo(() => TIMING.flatMap((key) => {
    const figure = stageTiming[key]
    if (figure.value === null) return []
    const atMs = key === 'firstDeep' ? stageTiming.firstDeepAtMs : key === 'firstRem' ? stageTiming.firstRemAtMs : null
    const note = key === 'cycles'
      ? t('sleep.night.through.cycleNote')
      : atMs === null ? undefined : t('sleep.night.through.afterOnset', { clock: formatRecordedClock(atMs, night.startOffsetMinutes) })
    return [{
      key, label: t(`sleep.night.through.${key}`), figure, note,
      value: formatFigureValue(figure, figure.value, language, t),
      verdict: verdictLine(figure, language, t) ?? t('glance.usual.none'),
    }]
  }), [stageTiming, night.startOffsetMinutes, language, t])

  // Under the trace only while the night's lowest sat below the resting rate: "below" would contradict a dip of 0 or less.
  const dipText = heartRateDip.value === null || heartRateDip.value <= 0 ? null : formatFigureValue(heartRateDip, heartRateDip.value, language, t)

  const minutesByStage = new Map(stageTotals(segments).map((total) => [total.stage, total.minutes]))
  const legend = LEGEND.filter((stage) => minutesByStage.has(stage)).map((stage) => {
    // A value never wraps inside itself (figureText's rule): the duration's halves stay together.
    const duration = formatDuration(minutesByStage.get(stage)!, i18n.language).replace(' ', '\u00a0')
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
          <ul className="detail-legend" id={legendId}>
            {legend.map(({ stage, text }) => (
              <li key={stage}><span className="detail-legend-key" data-stage={stage} aria-hidden="true" />{text}</li>
            ))}
          </ul>
          {timing.length > 0 && (
            <FigureRows max={3}>
              {timing.map(({ key, label: rowLabel, value, verdict, figure, note }) => (
                <FigureRow key={key} label={rowLabel} value={value} verdict={verdict} judged={figure.judged} standing={figure.standing}
                  band={figure.baseline} mark={figure.value} note={note} />
              ))}
            </FigureRows>
          )}
          {awakeDiffers && <p className="hypnogram-totals">{t('charts.hypnogram.awakeNote')}</p>}
        </>
      )}
      <NightTraces night={night} chosenSource={chosenSource} traces={figures} heartRateDip={dipText} />
    </Card>
  )
}
