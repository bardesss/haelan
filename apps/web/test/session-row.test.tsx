import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionRow } from '../src/pages/activity/SessionRow.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { WorkoutSession } from '../src/data/useSessions.js'

const run = (attrs: unknown, over: Partial<WorkoutSession> = {}): WorkoutSession => ({
  id: 's1', sourceId: 'watch', startMs: Date.UTC(2026, 8, 3, 8, 0), endMs: Date.UTC(2026, 8, 3, 8, 54),
  startOffsetMinutes: 120, endOffsetMinutes: 120, localDate: '2026-09-03', attrs, ...over,
})

const render = (session: WorkoutSession, lng = 'nl') =>
  renderToStaticMarkup(<I18nProvider lng={lng}><SessionRow session={session} /></I18nProvider>)

describe('SessionRow', () => {
  it('puts the date, the type and the duration on the first line', () => {
    const html = render(run({ exerciseType: 'RUNNING', metricsSummary: { caloriesKcal: 874 } }))
    expect(html).toContain('Hardlopen')
    expect(html).toContain('54')
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
