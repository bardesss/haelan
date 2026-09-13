import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import { Hypnogram } from '../../charts/Hypnogram.js'
import { NightExcludedSessions } from '../../components/NightExcludedSessions.js'
import { stageOf } from '../../data/nights.js'
import type { Stage } from '../../fixtures/july.js'
import { formatClock } from '../../format.js'
import { localMinutesOf, inWindow, WIDE_WINDOW } from '../../charts/schedule.js'
import type { Night } from '../../data/useNights.js'

/**
 * The night's own segments, drawn by the same Hypnogram the Sleep page uses, plus the two things
 * that belong beside it: the naps this night's grouping put outside its span, and the sessions a
 * person excluded from it.
 *
 * Boundaries stay raw milliseconds relative to the night's start, not rounded to a minute first:
 * Hypnogram's own stageTotals sums them, and rounding each boundary before that sum compounds into
 * minutes of drift against derive/sleep.ts's own single-rounded figure. Sleep.tsx's own comment on
 * the same conversion explains the mechanism at length.
 *
 * The hypnogram itself is absent, not an empty chart, when the night carries no staged segments:
 * an empty chart would read as a night containing no deep, light or REM sleep at all. But the card
 * around it stays, and so do the nap line and the excluded-session note - neither depends on there
 * being a segment to draw, and a source can record a real span with real naps and never stage a
 * single one of it (stageOf's own comment names exactly this case: ASLEEP and RESTLESS are
 * recognised by the derive layer and staged by nobody). Dropping the whole card for that source
 * would throw its nap times away along with the chart that legitimately has nothing to draw.
 */
export function NightStages({ night }: { night: Night }) {
  const { t } = useTranslation()

  const segments = useMemo(() => night.segments
    .map((s) => ({ stage: stageOf(s.stage), startMs: s.startMs - night.startMs, endMs: s.endMs - night.startMs }))
    .filter((s): s is { stage: Stage, startMs: number, endMs: number } => s.stage !== null),
  [night])

  const bedMinutes = inWindow(
    localMinutesOf(night.localDate, night.startMs, night.startOffsetMinutes), WIDE_WINDOW)

  // Nap clock times, through the night's own offset, not the browser's zone: this is the same
  // conversion Sleep.tsx's schedule table applies before handing a nap to formatClock
  // (localMinutesOf keyed on the night's own local date, using endOffsetMinutes because a nap
  // shares its date with the night's wake, not its bedtime - see schedule.ts's own comment on
  // napInWindow for why the wake-side offset is the one in force when a nap started). formatClock
  // wraps every 1440 minutes on its own, so no window placement is needed here the way
  // napInWindow provides it for an axis: this card only ever prints the clock, never plots it.
  const napTimes = night.naps.map((at) => formatClock(localMinutesOf(night.localDate, at, night.endOffsetMinutes)))

  return (
    <Card span={12} label={t('sleep.night.stages.label')}>
      {segments.length > 0 && (
        <Hypnogram
          segments={segments}
          startLabel={t('common.bedLabel', { time: formatClock(bedMinutes) })}
          label={t('sleep.night.stages.label')}
        />
      )}
      {/* The label comes from the catalogue; the times themselves are appended in plain JS rather
          than handed to t() as an interpolation option, the same split Hypnogram's own totals row
          uses for stage label plus formatDuration (Hypnogram.tsx, stageTotals' own render). A
          catalogue placeholder substituted through i18next's own interpolation never resolves
          without a real i18next instance mounted, which this app's own no-provider test
          convention (see hypnogram-totals.test.tsx's header comment) relies on to assert a
          rendered value at all. */}
      <p className="night-naps">
        {night.naps.length === 0
          ? t('sleep.night.naps.none')
          : `${t('sleep.night.naps.list')} ${napTimes.join(', ')}`}
      </p>
      <NightExcludedSessions count={night.excludedSessions.length} />
    </Card>
  )
}
