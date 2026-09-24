import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ComponentProps } from 'react'
import { DashCard } from '../src/pages/dashboard/cardShared.js'
import { NightCard } from '../src/pages/dashboard/NightCard.js'
import { RecoveryCard } from '../src/pages/dashboard/RecoveryCard.js'
import { TodayCard } from '../src/pages/dashboard/TodayCard.js'
import { WeekCard } from '../src/pages/dashboard/WeekCard.js'
import { formatFigure } from '../src/pages/dashboard/glanceText.js'
import { I18nextProvider } from 'react-i18next'
import { I18nProvider, initI18n } from '../src/i18n/index.js'
import type { GlanceFigure, GlanceSleep, GlanceRecovery, GlanceDay } from '../src/data/useGlance.js'
import { glanceBody, GLANCE_TODAY } from './glanceFixture.js'
import type { Sparkline } from '../src/charts/Sparkline.js'

// Sparkline itself never renders to static markup (its chart lives behind a useEffect, which
// renderToStaticMarkup never runs) - the echarts option a card hands it, band labels included, is
// invisible to every other test in this file the same way it always has been. Mocked to a spy
// component rather than driving a real chart mount (sparkline-lifecycle.test.tsx's own device):
// this file's other cases render to static markup with no DOM at all, and this is the one test that
// needs to see a prop rather than a rendered string.
let sparklineProps: ComponentProps<typeof Sparkline> | null = null
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: ComponentProps<typeof Sparkline>) => {
    sparklineProps = props
    return null
  },
}))

// The markup's chart hosts and their accessible tables, counted the way pages.test.tsx's chart
// rule counts them: one sr-only table per role="img" host.
function chartHosts(html: string): number {
  return [...html.matchAll(/<div[^>]*role="img"[^>]*>/g)].length
}
function srTables(html: string): number {
  return [...html.matchAll(/<table class="sr-only">/g)].length
}

function render(props: Partial<Parameters<typeof DashCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en">
      <DashCard span={4} title="Today" subtitle="so far" {...props}>
        <div>content</div>
      </DashCard>
    </I18nProvider>,
  )
}

describe('DashCard', () => {
  it('renders the link only when given', () => {
    expect(render()).not.toContain('card-link')
    expect(render({ link: { to: '/activity', text: 'View activity' } }))
      .toContain('<a href="/activity" class="card-link">View activity</a>')
  })
})

const TODAY = GLANCE_TODAY

// glanceBody().sleep is typed GlanceSleep | null on the payload; every case here supplies a night,
// so the assertion is made once here rather than at every call site below.
function sleepFixture(over: {
  asleep?: Partial<GlanceFigure>, efficiency?: Partial<GlanceFigure>,
  bedtime?: Partial<GlanceFigure>, waketime?: Partial<GlanceFigure>,
} = {}): GlanceSleep {
  const sleep = glanceBody().sleep as GlanceSleep
  return {
    ...sleep,
    asleep: { ...sleep.asleep, ...over.asleep },
    efficiency: { ...sleep.efficiency, ...over.efficiency },
    bedtime: { ...sleep.bedtime, ...over.bedtime },
    waketime: { ...sleep.waketime, ...over.waketime },
  }
}

function renderNight(props: Partial<Parameters<typeof NightCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en">
      <NightCard sleep={sleepFixture()} span={8} today={TODAY} timezone="Europe/Amsterdam" {...props} />
    </I18nProvider>,
  )
}

describe('NightCard', () => {
  beforeEach(() => {
    sparklineProps = null
  })

  it('leads with the time asleep in display type, and links to the night', () => {
    const html = renderNight()
    expect(html).toContain('class="dash-headline"')
    expect(html).toContain('href="/sleep/night/2026-09-23"')
  })

  it('says a secondary figure outside its usual in words as well as colour', () => {
    const sleep = sleepFixture({ bedtime: { metric: 'sleep_bedtime_minutes', value: 14, standing: 'above' } })
    const html = renderNight({ sleep })
    expect(html).toMatch(/class="dash-mini-value is-out"[^>]*>00:14</)
    expect(html).toContain('later than usual')
  })

  it('keeps the usual sentence for a screen reader on the strip', () => {
    const html = renderNight()
    expect(html).toContain('within your usual')
  })

  // R3: "the usual range is drawn as a shaded band behind each seven-day strip, with its two edges
  // labelled" - the shading alone (baseline={band}) is the first half of that sentence; this pins
  // the second. Asserted on the prop the strip's own Sparkline is actually given, not on rendered
  // text: bandLabels never reaches static markup (Sparkline's chart lives behind a useEffect that
  // renderToStaticMarkup does not run), so a substring check here would pass whether or not the
  // wiring existed.
  it('gives the strip its band edges as text, matching the usual line\'s own low and high', () => {
    const sleep = sleepFixture()
    renderNight({ sleep })
    const baseline = sleep.asleep.baseline!
    expect(sparklineProps?.bandLabels).toEqual({
      low: formatFigure({ ...sleep.asleep, value: baseline.low }, 'en'),
      high: formatFigure({ ...sleep.asleep, value: baseline.high }, 'en'),
    })
  })

  it('gives the strip no band labels when the baseline is too thin to show at all', () => {
    const sleep = sleepFixture({ asleep: { baseline: { center: 400, low: 360, high: 440, thin: true } } })
    renderNight({ sleep })
    expect(sparklineProps?.bandLabels).toBeUndefined()
  })

  // Spec amendment 2026-09-24 (T2): the hypnogram's compact form ends in one faint line of stage
  // totals, and the awake explanation the Sleep page prints under it does not come along. A night
  // with an awake segment, since that is the only night the full form prints the note on.
  it('ends the hypnogram in one faint line of stage totals, without the awake paragraph', () => {
    const base = sleepFixture()
    const start = base.startMs
    const sleep: GlanceSleep = {
      ...base,
      segments: [
        { stage: 'LIGHT', startMs: start, endMs: start + 60 * 60_000 },
        { stage: 'AWAKE', startMs: start + 60 * 60_000, endMs: start + 67 * 60_000 },
        { stage: 'DEEP', startMs: start + 67 * 60_000, endMs: start + 167 * 60_000 },
        { stage: 'REM', startMs: start + 167 * 60_000, endMs: start + 214 * 60_000 },
      ],
    }
    const html = renderNight({ sleep })
    expect(html).toContain('<p class="hypnogram-totals is-compact">Deep 1h 40m · Light 1h 00m · REM 0h 47m · Awake 0h 07m</p>')
    expect(html).not.toContain('class="hypnogram-totals"')
    expect(html).not.toContain('Awake counts the awake stages')
  })

  it('draws no visible show-numbers control, and keeps each chart\'s table for assistive tech', () => {
    const html = renderNight()
    expect(html).not.toContain('chart-table-toggle')
    expect(chartHosts(html)).toBe(1)
    expect(srTables(html)).toBe(1)
    expect(sparklineProps?.tableToggle).toBe(false)
  })

  // Task 19b: the compact hypnogram grows to 112px when the night card has the row to itself (span
  // 12), and stays at the compact default 96px otherwise (span 8, or phone).
  it('draws its compact hypnogram taller when it has the row to itself', () => {
    // Sparkline is the mocked spy in this file (returns null), so the strip never reaches static
    // markup and the hypnogram is the only chart host either render produces.
    expect(renderNight({ span: 8 })).toMatch(/role="img"[^>]*style="[^"]*height:96px/)
    expect(renderNight({ span: 12 })).toMatch(/role="img"[^>]*style="[^"]*height:112px/)
  })

  it('hands the strip a dot per night and the server\'s verdict for each', () => {
    const base = sleepFixture()
    const sleep = sleepFixture({
      asleep: { strip: base.asleep.strip.map((d, i) => ({ ...d, standing: i === 2 ? 'above' as const : null })) },
    })
    renderNight({ sleep })
    expect(sparklineProps?.dots).toBe(true)
    expect(sparklineProps?.pointStandings).toEqual([null, null, 'above', null, null, null, null])
  })
})

function recoveryFixture(over: {
  index?: Partial<GlanceFigure>, restingHeartRate?: Partial<GlanceFigure>, hrv?: Partial<GlanceFigure>,
  band?: GlanceRecovery['band'], respiratoryRate?: Partial<GlanceFigure> | null,
} = {}): GlanceRecovery {
  const recovery = glanceBody().recovery
  return {
    ...recovery,
    index: { ...recovery.index, ...over.index },
    restingHeartRate: { ...recovery.restingHeartRate, ...over.restingHeartRate },
    hrv: { ...recovery.hrv, ...over.hrv },
    band: 'band' in over ? over.band! : recovery.band,
    respiratoryRate: 'respiratoryRate' in over
      ? (over.respiratoryRate === null ? null : { ...recovery.restingHeartRate, ...over.respiratoryRate })
      : recovery.respiratoryRate,
  }
}

function renderRecovery(props: Partial<Parameters<typeof RecoveryCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en">
      <RecoveryCard recovery={recoveryFixture()} span={4} wide={false} today={TODAY} timezone="UTC" {...props} />
    </I18nProvider>,
  )
}

describe('RecoveryCard', () => {
  beforeEach(() => {
    sparklineProps = null
  })

  it('draws the score between the two gauges, each named by its usual sentence', () => {
    const html = renderRecovery()
    expect(html.indexOf('usual-gauge')).toBeLessThan(html.indexOf('score-ring'))
    expect(html.lastIndexOf('usual-gauge')).toBeGreaterThan(html.indexOf('score-ring'))
    expect(html).toMatch(/aria-label="Resting HR 62 bpm, above your usual/)
  })

  it('unscored: an empty ring, the reason once, and the gauges labelled yesterday', () => {
    const recovery = recoveryFixture({
      index: { value: null, asOfDate: null },
      restingHeartRate: { asOfDate: '2026-09-22' },
      hrv: { asOfDate: '2026-09-22' },
    })
    const html = renderRecovery({ recovery })
    expect(html).toContain('>Not scored<')
    expect(html.match(/Not enough readings to score yet\./g)).toHaveLength(1)
    expect(html.match(/>yesterday</g)).toHaveLength(2)
    // The ring's own accessible name, not just "Score": a screen reader on an unscored day has
    // nothing else on the ring itself saying there is no score, unlike a sighted reader who sees
    // the empty ring and "Not scored" beside it.
    expect(html).toContain('aria-label="Score, not scored"')
  })

  it('wide: the card carries is-wide, which is what shows the seven-day strip', () => {
    const html = renderRecovery({ span: 12, wide: true })
    expect(html).toContain('dash-recovery is-wide')
    expect(html).toContain('class="dash-recovery-strip"')
  })

  it('narrow: the strip is in the markup for the mid band, hidden by CSS otherwise', () => {
    const html = renderRecovery()
    expect(html).not.toContain('is-wide')
    expect(html).toContain('class="dash-recovery-strip"')
  })

  // A thin baseline is not the person's usual yet, so no gauge shades one. The default fixture's
  // two gauges both draw a band, which is what makes the absence here mean something.
  it('draws no usual band on a gauge whose baseline is thin', () => {
    expect(renderRecovery().match(/class="usual-gauge-band"/g)).toHaveLength(2)
    const recovery = recoveryFixture({
      restingHeartRate: { baseline: { center: 56, low: 52, high: 60, thin: true } },
      hrv: { baseline: { center: 50, low: 44, high: 56, thin: true } },
    })
    expect(renderRecovery({ recovery })).not.toContain('usual-gauge-band')
  })

  it('gives the score strip dots, the server\'s verdicts, and no visible show-numbers control', () => {
    const base = recoveryFixture()
    const recovery = recoveryFixture({ index: { strip: base.index.strip.map((d, i) => ({ ...d, standing: i === 0 ? 'below' as const : null })) } })
    renderRecovery({ recovery, span: 12, wide: true })
    expect(sparklineProps?.dots).toBe(true)
    expect(sparklineProps?.pointStandings).toEqual(['below', null, null, null, null, null, null])
    expect(sparklineProps?.tableToggle).toBe(false)
  })
})

function dayFixture(over: { steps?: Partial<GlanceFigure>, stepsPace?: GlanceDay['stepsPace'] } = {}): GlanceDay {
  const day = glanceBody().day
  return {
    ...day,
    steps: { ...day.steps, ...over.steps },
    stepsPace: 'stepsPace' in over ? over.stepsPace! : day.stepsPace,
  }
}

// IntradayHeartRate reads useSession (a useQuery) even though this file never lets that query
// resolve: a QueryClientProvider is enough for renderToStaticMarkup, which never runs the effects
// that would actually fetch. The same device heart-rate-card.test.tsx and glance-page.test.tsx use.
function renderToday(props: Partial<Parameters<typeof TodayCard>[0]> = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider lng="en">
        <TodayCard day={dayFixture()} span={8} today={TODAY} timezone="UTC" {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  )
}

describe('TodayCard', () => {
  it('says the pace against the usual by the last reading\'s time', () => {
    const day = dayFixture({ stepsPace: { center: 5900, low: 5000, high: 6800, thin: false, value: 5900, atMs: Date.UTC(2026, 8, 23, 11, 52), standing: 'ahead' } })
    const html = renderToday({ day, timezone: 'Europe/Amsterdam' })
    expect(html).toContain('Ahead of your usual pace')
    expect(html).toContain('usual by 13:52 is 5,900')
    expect(html).toContain('class="dash-pace is-ahead"')
  })

  it('behind is plain text, never the warning colour', () => {
    const day = dayFixture({ stepsPace: { center: 5900, low: 5000, high: 6800, thin: false, value: 5900, atMs: 0, standing: 'behind' } })
    expect(renderToday({ day })).not.toContain('is-out')
  })

  it('falls back to the so-far line without a pace', () => {
    const html = renderToday({ day: dayFixture({ stepsPace: null }) })
    expect(html).toContain('so far; your usual day')
  })

  it('says behind in plain words, exactly, at the last reading\'s time', () => {
    const day = dayFixture({ stepsPace: { center: 5900, low: 5000, high: 6800, thin: false, value: 5900, atMs: Date.UTC(2026, 8, 23, 11, 52), standing: 'behind' } })
    const html = renderToday({ day, timezone: 'Europe/Amsterdam' })
    expect(html).toContain('<p class="dash-pace"><span class="dash-pace-word">Behind your usual pace</span> · usual by 13:52 is 5,900</p>')
  })

  // T2: steps and active minutes side by side on one line, each a label over its figure, then the
  // pace line directly under them.
  it('puts steps and active minutes in one row, the pace line under it', () => {
    expect(renderToday()).toContain(
      '<div class="dash-today-figures">'
      + '<div><span class="label">Steps</span><div class="dash-headline-sm">4,820</div></div>'
      + '<div><span class="label">Active minutes</span><div class="dash-headline-sm">18 <span class="glance-unit">min</span></div></div>'
      + '</div><p class="dash-pace">',
    )
  })

  it('labels the heart rate trace from midnight to now, and draws it compact', () => {
    const html = renderToday()
    expect(html).toContain('<span class="label">Heart rate · 00:00 → now</span>')
    // Only the heart rate trace reaches static markup here (the strip's Sparkline is the spy); its
    // host is the compact form's 84px rather than the full chart's 170.
    expect(chartHosts(html)).toBe(1)
    expect(html).toMatch(/<div role="img" aria-label="Heart rate today" aria-describedby="[^"]+" style="[^"]*height:84px/)
  })

  it('draws no visible show-numbers control, and keeps each chart\'s table for assistive tech', () => {
    const html = renderToday()
    expect(html).not.toContain('chart-table-toggle')
    expect(chartHosts(html)).toBe(1)
    expect(srTables(html)).toBe(1)
    expect(sparklineProps?.tableToggle).toBe(false)
  })

  it('hands the steps strip its band, band labels, dots and the server\'s verdicts', () => {
    const base = dayFixture()
    const day = dayFixture({ steps: { strip: base.steps.strip.map((d, i) => ({ ...d, standing: i === 1 ? 'below' as const : null })) } })
    renderToday({ day })
    expect(sparklineProps?.baseline).toEqual(day.steps.baseline)
    expect(sparklineProps?.bandLabels).toEqual({ low: '8,000', high: '9,500' })
    expect(sparklineProps?.dots).toBe(true)
    expect(sparklineProps?.pointStandings).toEqual([null, 'below', null, null, null, null, null])
  })

  // Task 19b: with no pace verdict AND no usual line to fall back to (no baseline at all), there is
  // nothing to print - render no <p class="dash-pace"> at all, rather than an empty paragraph.
  it('renders no pace line at all when there is neither a verdict nor a usual to fall back to', () => {
    const day = dayFixture({ stepsPace: null, steps: { baseline: null } })
    expect(renderToday({ day })).not.toContain('dash-pace')
  })

  // Task 19a: `stepsPace.standing` can be null while the band is still present (no verdict before
  // 5% of the usual day has passed). That is not "no pace object" - the so-far fallback still has
  // to speak, exactly as it does with `stepsPace` null outright.
  it('falls back to the so-far line when the pace has a band but no verdict yet', () => {
    const day = dayFixture({ stepsPace: { center: 900, low: 700, high: 1100, thin: false, value: 200, atMs: 0, standing: null } })
    const html = renderToday({ day })
    expect(html).toContain('so far; your usual day')
    expect(html).not.toContain('dash-pace-word')
  })

  it('hands the steps strip neither band nor labels on a thin baseline', () => {
    renderToday({ day: dayFixture({ steps: { baseline: { center: 8700, low: 8000, high: 9500, thin: true } } }) })
    expect(sparklineProps).not.toBeNull()
    expect(sparklineProps?.baseline).toBeUndefined()
    expect(sparklineProps?.bandLabels).toBeUndefined()
  })
})

function renderWeek(props: Partial<Parameters<typeof WeekCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en">
      <WeekCard glance={glanceBody()} span={4} {...props} />
    </I18nProvider>,
  )
}

describe('WeekCard', () => {
  it('shows each row\'s per-day average with its bars, and leaves out a row with no data', () => {
    const g = { ...glanceBody(), week: { steps: { perDay: 8205.4, days: 6, total: 49232 }, activeMinutes: { perDay: 36, days: 6, total: 216 }, asleep: null } }
    const html = renderWeek({ glance: g })
    expect(html).toContain('8,205')
    expect(html).toContain('36 min')
    expect(html).not.toContain('week-bars is-sleep')
  })

  it('names the average\'s basis for a screen reader: finished days only', () => {
    const html = renderWeek()
    expect(html).toContain('today not counted')
  })

  it('labels the sleep row\'s bars as including last night, distinct from the steps row\'s days label', () => {
    const g = { ...glanceBody(), week: { steps: { perDay: 8000, days: 6, total: 48000 }, activeMinutes: null, asleep: { perDay: 393, days: 7, total: 2751 } } }
    const html = renderWeek({ glance: g })
    expect(html).toContain('aria-label="Asleep, last 7 nights; the average includes last night"')
    expect(html).toContain('aria-label="Steps, last 7 days; the average counts finished days only, today not counted"')
  })

  // T2: steps and active time lead with the week's total, the per-day average after it; sleep keeps
  // the per-night average alone.
  it('shows the seven-day total with the per-day average after it, and sleep per night only', () => {
    const g = { ...glanceBody(), week: {
      steps: { perDay: 8205.4, days: 6, total: 57432 },
      activeMinutes: { perDay: 36.2, days: 6, total: 252 },
      asleep: { perDay: 418, days: 7, total: 2926 },
    } }
    const html = renderWeek({ glance: g })
    expect(html).toContain('<div class="dash-week-figure"><span class="dash-week-value">57,432</span> <span class="dash-week-per">· 8,205 a day</span></div>')
    expect(html).toContain('<div class="dash-week-figure"><span class="dash-week-value">4h 12m</span> <span class="dash-week-per">· 36 min a day</span></div>')
    expect(html).toContain('<div class="dash-week-figure"><span class="dash-week-value">6h 58m</span> <span class="dash-week-per">a night</span></div>')
  })

  // The dot between the total and the per-day average has to come from the catalogue, not a
  // literal in the component, so a translator can change or drop it: overriding the key here and
  // seeing the override land is what a hardcoded `· ${row.per}` in WeekCard.tsx could never pass.
  // Task 19b: a screen reader gets each bar's own day and value, not just the row's one label -
  // the steps strip's first day (Thu 17 Sep, 8,900) and last (today, Wed 23 Sep, 4,820), formatted
  // the same way the row's own figures print (a plain count, no unit).
  it('gives the steps strip\'s bars their day and value in words', () => {
    const html = renderWeek()
    expect(html).toContain('<title>Thu 8,900</title>')
    expect(html).toContain('<title>Wed 4,820</title>')
  })

  // The active minutes row formats each bar's value the way its own per-day figure prints
  // ("36 min a day"), not the plain count the steps row uses.
  it('gives the active minutes strip\'s bars a minutes unit, not a bare count', () => {
    const g = { ...glanceBody(), week: { steps: null, activeMinutes: { perDay: 30, days: 6, total: 180 }, asleep: null },
      day: { ...glanceBody().day, activeMinutes: { ...glanceBody().day.activeMinutes, strip: glanceBody().day.steps.strip.map((d) => ({ ...d, value: d.value === null ? null : 30 })) } } }
    const html = renderWeek({ glance: g })
    expect(html).toContain('<title>Thu 30 min</title>')
  })

  it('reads the total/per-day separator from the translation, not a literal', () => {
    const i18n = initI18n('en')
    i18n.addResourceBundle('en', 'translation', { glance: { week: { totalPer: '~ {{per}}' } } }, true, true)
    const g = { ...glanceBody(), week: { steps: { perDay: 8205.4, days: 6, total: 57432 }, activeMinutes: null, asleep: null } }
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}><WeekCard glance={g} span={4} /></I18nextProvider>,
    )
    expect(html).toContain('<span class="dash-week-per">~ 8,205 a day</span>')
  })
})
