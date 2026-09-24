import { useMemo } from 'react'
import { useTranslation } from '../../i18n/index.js'
import { Hypnogram } from '../../charts/Hypnogram.js'
import { Sparkline } from '../../charts/Sparkline.js'
import { localMinutesOf, inWindow, DEFAULT_WINDOW } from '../../charts/schedule.js'
import { stageOf } from '../../data/nights.js'
import { formatClock } from '../../format.js'
import type { GlanceSleep } from '../../data/useGlance.js'
import { DashCard, Described } from './cardShared.js'
import { formatFigure, usualLine } from './glanceText.js'

// Hypnogram's own Stage type lives in the July fixtures module, which this page cannot import
// (see the "does not import the fixtures" test): a local, structurally identical union avoids
// that import for the one type this file needs from it.
type Stage = 'deep' | 'light' | 'rem' | 'awake'
type Segment = { stage: Stage, startMs: number, endMs: number }

// One frozen empty list for the no-night case, so the memo below hands the chart the same identity
// on every render rather than a fresh `[]`, which useChart reads as a reason to rebuild.
const NO_SEGMENTS: Segment[] = Object.freeze([]) as never[]

// The night's segments made relative to its own start, which is the frame Hypnogram draws in.
// startMs/endMs stay raw milliseconds rather than minutes: Hypnogram's stageTotals sums them for the
// totals row, and rounding each boundary first let two roundings compound into minutes of drift
// against derive/sleep.ts's own single-rounded figure (see Hypnogram.tsx's comment on `segments`).
function hypnogramSegments(sleep: GlanceSleep | null): Segment[] {
  if (sleep === null) return NO_SEGMENTS
  return sleep.segments
    .map((s) => ({ stage: stageOf(s.stage), startMs: s.startMs - sleep.startMs, endMs: s.endMs - sleep.startMs }))
    .filter((s): s is Segment => s.stage !== null)
}

// The night's dates as the column's subtitle ("Sat 5 – Sun 6 Sep"), read in the person's zone.
// formatRange rather than two formatted dates joined by hand: the language decides how a range
// collapses a shared month, and a night that starts after midnight comes out as one date.
function nightSpan(sleep: GlanceSleep, language: string, timeZone: string): string {
  const format = new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', month: 'short', timeZone })
  return format.formatRange(new Date(sleep.startMs), new Date(sleep.endMs))
}

/**
 * Last night as the page's lead: the time asleep in display type, efficiency, bed and wake in one
 * compact row, the seven-night strip with the usual shaded behind it and a dot per night, and the
 * hypnogram full width in its compact form (stage blocks, then one faint line of stage totals), as
 * the approved T2 mockup draws it. The awake note the Sleep page prints under its hypnogram stays
 * there.
 *
 * The grey "within your usual range" line under every figure is gone from sight on purpose (the
 * redesign's point) and kept for a screen reader: the strip's description is usualLine's sentence.
 * A secondary figure outside its usual takes the warning colour and says which way in words, so the
 * colour is never the only signal.
 */
// `today` is part of every dashboard card's shared shape (the other redesigned cards read it to
// decide "today" vs "yesterday" wording) but this card has none of that: a night is always named
// by the date it ended on and the strip's usual line never mentions the calendar day it was read.
// Kept in the signature anyway so every card in the row takes the same props.
export function NightCard({ sleep, span, timezone }: {
  sleep: GlanceSleep, span: 8 | 12, today: string, timezone: string,
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const segments = useMemo(() => hypnogramSegments(sleep), [sleep])
  const { values, labels, standings } = useMemo(() => ({
    values: sleep.asleep.strip.map((d) => d.value), labels: sleep.asleep.strip.map((d) => d.localDate),
    standings: sleep.asleep.strip.map((d) => d.standing),
  }), [sleep.asleep.strip])
  const band = sleep.asleep.baseline !== null && !sleep.asleep.baseline.thin ? sleep.asleep.baseline : undefined
  // R3: the band is shaded behind the strip AND its two edges are labelled, so a reader is never
  // left to guess what the shading means from colour alone. Memoised on band/language rather than
  // built inline in the JSX below: a fresh object identity every render would fold into Sparkline's
  // own `build` dependency array (bandLabels is now one of them) and rebuild the chart for a reason
  // that has nothing to do with what it draws, the same defect chart-lifecycle.test.tsx guards.
  const bandLabels = useMemo(() => band === undefined ? undefined : {
    low: formatFigure({ ...sleep.asleep, value: band.low }, language) ?? '',
    high: formatFigure({ ...sleep.asleep, value: band.high }, language) ?? '',
  }, [band, language])
  const bedMinutes = inWindow(localMinutesOf(sleep.localDate, sleep.startMs, sleep.startOffsetMinutes), DEFAULT_WINDOW)
  const startLabel = bedMinutes !== null ? t('common.bedLabel', { time: formatClock(bedMinutes) }) : t('common.bedTimeNotRecorded')
  const minis = [
    { key: 'efficiency', label: t('glance.sleep.efficiency'), figure: sleep.efficiency, unit: t('charts.units.percent') },
    { key: 'bed', label: t('glance.sleep.bed'), figure: sleep.bedtime },
    { key: 'woke', label: t('glance.sleep.woke'), figure: sleep.waketime },
  ]
  return (
    <DashCard span={span} title={t('glance.sleep.title')} subtitle={nightSpan(sleep, language, timezone)}
      link={{ to: `/sleep/night/${sleep.localDate}`, text: t('glance.sleep.link') }}>
      <div className="dash-lead">
        <div>
          <div className="dash-headline">{formatFigure(sleep.asleep, language) ?? t('glance.noReading')}</div>
          <div className="dash-minis">
            {minis.map(({ key, label, figure, unit }) => {
              const value = formatFigure(figure, language)
              const out = figure.standing === 'above' || figure.standing === 'below'
              return (
                <span key={key} className="dash-mini">
                  <span className="dash-mini-label">{label}</span>{' '}
                  <b className={out ? 'dash-mini-value is-out' : 'dash-mini-value'}>
                    {value === null ? t('glance.noReading') : unit ? `${value} ${unit}` : value}
                  </b>
                  {out && <span className="dash-mini-note">{' '}{t(`glance.sleep.${key}Standing.${figure.standing}`)}</span>}
                </span>
              )
            })}
          </div>
        </div>
        {values.filter((v) => v !== null).length > 1 && (
          <div className="dash-lead-strip">
            <Described text={usualLine(sleep.asleep, t, language) ?? t('glance.sleep.caption')} hidden>
              <Sparkline values={values} labels={labels} label={t('glance.sleep.strip')} unit={t('glance.sleep.asleep')}
                metric={sleep.asleep.metric} baseline={band} bandLabels={bandLabels} height={64}
                dots pointStandings={standings} tableToggle={false}
                formatValue={(v, absent) => (v === null ? absent : formatFigure({ ...sleep.asleep, value: v }, language) ?? absent)} />
            </Described>
            <p className="dash-caption">{t('glance.sleep.caption')}</p>
          </div>
        )}
      </div>
      <Described hidden text={t('sleep.sleepStages.basis', { date: sleep.localDate })}>
        <Hypnogram segments={segments} startLabel={startLabel} startClock={bedMinutes} compact
          label={t('sleep.sleepStages.chartLabel', { date: sleep.localDate })} />
      </Described>
    </DashCard>
  )
}
