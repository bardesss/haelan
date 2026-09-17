import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionRow } from '../src/pages/activity/SessionRow.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { WorkoutSession } from '../src/data/useSessions.js'

const run = (attrs: unknown, over: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id: 's1', sourceId: 'watch', startMs: Date.UTC(2026, 8, 3, 8, 0), endMs: Date.UTC(2026, 8, 3, 8, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-09-03', attrs,
  excluded: false, excludeReason: null, ...over,
})

const render = (session: WorkoutSession, lng = 'nl') =>
  renderToStaticMarkup(<I18nProvider lng={lng}><SessionRow session={session} /></I18nProvider>)

describe('SessionRow', () => {
  it('puts the type and the duration on the first line', () => {
    const html = render(run({ exerciseType: 'RUNNING', metricsSummary: { caloriesKcal: 874 } }))
    expect(html).toContain('Hardlopen')
    expect(html).toContain('54')
  })

  // The date used to be the first word on the visible line; SessionList now prints it once as a
  // heading above a run of same-day rows instead, which took it out of each row's own accessible
  // name. A screen reader user who lands on one row (arrow-key browsing, not just Tab, since a
  // plain div carries no stop of its own) must still be able to tell which day it is on without
  // relying on having heard the heading first, so the row keeps naming its own date, just not
  // where sighted readers see it. `sr-only` is the project's own convention for exactly this split
  // (Sidebar.tsx's collapsed rail labels, ControlRow's "Filter by source"), reused rather than a
  // second hidden-text mechanism invented here.
  it('keeps the date in the row for assistive technology even though it no longer shows it', () => {
    const html = render(run({ exerciseType: 'RUNNING', metricsSummary: {} }, { localDate: '2026-08-27' }))
    expect(html).toContain('sr-only')
    expect(html, 'the full weekday and date, the same shape the heading above it prints')
      .toContain('donderdag 27 augustus')
  })

  // The visible line must not double what the sr-only span above already says: a sighted reader
  // scanning the row should see the type and duration only, with the date living in the heading.
  it('does not print the date on the visible line', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="nl"><SessionRow session={run({ exerciseType: 'RUNNING', metricsSummary: {} }, { localDate: '2026-08-27' })} /></I18nProvider>,
    )
    const visible = html.replace(/<span class="sr-only">.*?<\/span>/, '')
    expect(visible).not.toContain('27 aug')
  })

  // Change 3: the type is the prominent element now that the date is gone, the duration secondary
  // beside it. Pinned on the class each carries rather than on font-size or colour directly, since
  // those live in app.css and a passing test here should not depend on reading that file too.
  it('gives the type and the duration their own elements', () => {
    const html = render(run({ exerciseType: 'RUNNING', metricsSummary: {} }))
    expect(html).toContain('class="session-row-type"')
    expect(html).toContain('class="session-row-duration"')
  })

  // The reason this is two lines rather than a table: 95 of 192 sessions have no distance, and a
  // Distance column would be blank for half of them. Absence is expressed by omission.
  it('leaves out a field the session never recorded, rather than printing a zero for it', () => {
    const html = render(run({
      exerciseType: 'WEIGHTLIFTING',
      metricsSummary: { caloriesKcal: 169, averageHeartRateBeatsPerMinute: '116' },
    }))
    expect(html).toContain('169')
    expect(html).not.toContain('km')
    expect(html, 'a missing distance must not become a zero').not.toContain('0,0')
  })

  // A recorded zero is a measurement and must still print. This is the other half of the guard in
  // workoutSummary, asserted here at the surface a reader actually sees.
  it('prints a recorded zero', () => {
    const html = render(run({ exerciseType: 'WORKOUT', metricsSummary: { caloriesKcal: 0 } }))
    expect(html).toContain('0')
  })

  it('renders one line, not an empty second one, when only the first line has content', () => {
    const html = render(run({ exerciseType: 'WORKOUT', metricsSummary: {} }))
    expect(html).not.toContain('session-row-detail')
  })

  // Dutch uses a comma decimal separator. Formatting through Intl in the page locale is what makes
  // this work; a template string with toFixed would read 8.5 on a Dutch page.
  it('formats numbers in the page locale', () => {
    const html = render(run({ exerciseType: 'RUNNING', metricsSummary: { distanceMillimeters: 8488286 } }))
    expect(html).toContain('8,5')
    expect(html).not.toContain('8.5')
  })

  // 170 of the 182 declared types are unseeded, and a row must stay readable for all of them.
  it('humanises a type nobody translated', () => {
    const html = render(run({ exerciseType: 'SNOWBOARDING', metricsSummary: {} }))
    expect(html).toContain('Snowboarding')
    expect(html).not.toContain('SNOWBOARDING')
  })

  // The neighbouring case to "no fields renders no line" (above): one field is still enough to
  // render the line, not just two or three. Elevation gain is used because it is the rarest of
  // the three detail fields (69 of 192 sessions), so a session carrying it alone is the realistic
  // shape of this case, not a fixture invented to hit a branch.
  it('renders the detail line for a session with only one of its fields', () => {
    const html = render(run({ exerciseType: 'HIKING', metricsSummary: { elevationGainMillimeters: 169906 } }))
    expect(html).toContain('session-row-detail')
    expect(html).toContain('170')
  })
})

describe('how a row separates its figures', () => {
  // A hyphen between two numbers reads as a minus sign: "445 kcal - 151 bpm" invites the eye to
  // subtract before it parses. A middot carries no arithmetic meaning.
  //
  // Asserted on the whole cell rather than with toContain, because a substring check passes on
  // every half-applied version of this - including one where the first line was converted and the
  // second was not, which is the mistake this pair of tests exists to catch.
  // The whole element, not a substring of the page: this file renders to a string and has no DOM
  // to query, and the exact markup is what pins the separator between BOTH figures rather than
  // just the presence of one middot somewhere.
  it('separates the figures on the first line with a middot', () => {
    const html = render(run({
      exerciseType: 'RUNNING',
      metricsSummary: { caloriesKcal: 445, averageHeartRateBeatsPerMinute: '151' },
    }))
    expect(html).toContain('<span class="session-row-stats">445 kcal · 151 bpm</span>')
  })

  it('separates the figures on the second line with a middot', () => {
    const html = render(run({
      exerciseType: 'RUNNING',
      metricsSummary: { distanceMillimeters: 4_000_000, elevationGainMillimeters: 30_000 },
    }))
    expect(html).toContain('<div class="session-row-detail">4,0 km · 30 m omhoog</div>')
  })
})

/**
 * What a row shows besides its figures.
 *
 * The list was readable and completely flat: a run, a walk and an hour of housework were the same
 * shape in the same weight, so finding the runs in a month meant reading every line. A glyph per
 * category is what makes it scannable, and a mark at the end is what says the row opens something
 * - it has linked to the workout page since M8b with nothing at rest to suggest it.
 */
describe('what a row carries besides its numbers', () => {
  it('marks a row with its category, not its exact type', () => {
    // Two different types, one category: a reader scanning for runs does not care which.
    const running = render(run({ exerciseType: 'RUNNING', metricsSummary: {} }))
    const treadmill = render(run({ exerciseType: 'TREADMILL', metricsSummary: {} }))
    expect(running).toContain('data-category="run"')
    expect(treadmill).toContain('data-category="run"')
  })

  // The failure this avoids is the one the Records device column had: an absent cell left some
  // rows with art and some without, and the list read as broken rather than as varied.
  it('marks a row whose type nobody mapped, rather than leaving it bare', () => {
    const html = render(run({ exerciseType: 'CROSS_COUNTRY_SKI', metricsSummary: {} }))
    expect(html).toContain('data-category="other"')
    expect(html).toContain('<svg')
  })

  it('marks a row whose device recorded no type at all', () => {
    const html = render(run({ metricsSummary: {} }))
    expect(html).toContain('data-category="other"')
  })

  it('says the row opens something', () => {
    const html = render(run({ exerciseType: 'RUNNING', metricsSummary: {} }))
    expect(html).toContain('session-row-go')
  })

  // Decoration, not content: it repeats what the link already means, so it must not reach a
  // screen reader as a separate thing to hear.
  it('hides that mark from assistive technology', () => {
    const html = render(run({ exerciseType: 'RUNNING', metricsSummary: {} }))
    expect(html).toMatch(/class="session-row-go" aria-hidden="true"|aria-hidden="true" class="session-row-go"/)
  })
})
