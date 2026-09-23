import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { GlanceCard } from '../src/pages/dashboard/GlanceCard.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { GlanceFigure, GlanceStaleSource } from '../src/data/useGlance.js'

const TODAY = '2026-09-23'

function figure(over: Partial<GlanceFigure> = {}): GlanceFigure {
  return {
    metric: 'steps', value: 4820, unit: 'count', baseline: { center: 8700, low: 8000, high: 9500, thin: false },
    asOfDate: TODAY, asOfMs: Date.UTC(2026, 8, 23, 9, 32), partial: false, staleSources: [],
    strip: [
      { localDate: '2026-09-17', value: 8900 }, { localDate: '2026-09-18', value: 7400 },
      { localDate: '2026-09-19', value: 10100 }, { localDate: '2026-09-20', value: 8300 },
      { localDate: '2026-09-21', value: 9700 }, { localDate: '2026-09-22', value: 8800 },
      { localDate: '2026-09-23', value: 4820 },
    ],
    ...over,
  }
}

const WATCH: GlanceStaleSource = { sourceId: 's1', name: 'My watch', lastReportedDate: '2026-09-10', medianGapDays: 1 }

type Props = ComponentProps<typeof GlanceCard>

function props(over: Partial<Props> = {}): Props {
  return {
    title: 'Today', subtitle: 'so far',
    headline: { label: 'Steps', figure: figure() },
    emptyLine: 'Nothing recorded yet today.',
    secondary: [],
    stripLabel: 'Steps, last 7 days', stripCaption: 'last 7 days',
    link: { to: '/activity', text: 'View activity' },
    today: TODAY, timezone: 'Europe/Amsterdam',
    ...over,
  }
}

function render(over: Partial<Props> = {}): string {
  return renderToStaticMarkup(<I18nProvider lng="en"><GlanceCard {...props(over)} /></I18nProvider>)
}

describe('GlanceCard', () => {
  it('prints the headline label, its formatted value, the usual line and the as-of line', () => {
    const html = render()
    expect(html).toContain('<h2 class="glance-card-title"><strong>Today</strong> <span>so far</span></h2>')
    expect(html).toContain('<span class="label">Steps</span>')
    expect(html).toContain('<div class="value">4,820</div>')
    expect(html).toContain('<p class="basis">below your usual 8,000 – 9,500</p>')
    // 09:32 UTC is 11:32 in Amsterdam: the as-of line reads the person's zone, not the machine's.
    expect(html).toContain('<p class="glance-asof">as of 11:32</p>')
  })

  it('prints the unit the page hands it beside the value', () => {
    const html = render({ headline: { label: 'Resting HR', unit: 'bpm', figure: figure({ metric: 'resting_heart_rate', value: 62 }) } })
    expect(html).toContain('<div class="value">62<span class="glance-unit"> bpm</span></div>')
  })

  it('prints the strip with its label and caption under a headline', () => {
    const html = render()
    expect(html).toContain('aria-label="Steps, last 7 days"')
    expect(html).toContain('<p class="glance-asof">last 7 days</p>')
  })

  it('prints the empty line and no strip for a null headline', () => {
    const html = render({ headline: null })
    expect(html).toContain('<p class="glance-empty">Nothing recorded yet today.</p>')
    expect(html).not.toContain('Steps, last 7 days')
    expect(html).not.toContain('last 7 days')
    expect(html).not.toContain('class="value"')
  })

  it('says there is no reading yet for a headline whose value is still null', () => {
    const html = render({ headline: { label: 'Steps', figure: figure({ value: null, asOfDate: null, asOfMs: null }) } })
    expect(html).toContain('<p class="glance-empty">No reading yet</p>')
    expect(html).not.toContain('class="value"')
  })

  it('prints the secondary pairs in the order given, each with its usual line', () => {
    const html = render({
      secondary: [
        { label: 'Resting HR', unit: 'bpm', figure: figure({ metric: 'resting_heart_rate', value: 62,
          baseline: { center: 56, low: 52, high: 60, thin: false } }) },
        { label: 'HRV', unit: 'ms', figure: figure({ metric: 'daily_hrv', value: 51, baseline: null }) },
        { label: 'Efficiency', figure: figure({ metric: 'sleep_efficiency', value: null }) },
      ],
    })
    expect(html).toContain(
      '<div class="glance-mini">'
      + '<div><span class="label">Resting HR</span><b>62 bpm</b><em>above your usual 52 – 60</em></div>'
      + '<div><span class="label">HRV</span><b>51 ms</b></div>'
      + '<div><span class="label">Efficiency</span><b>No reading yet</b></div>'
      + '</div>',
    )
  })

  it('puts one source warning beside the title for a stale source on any shown figure, deduplicated', () => {
    const html = render({
      headline: { label: 'Steps', figure: figure({ staleSources: [WATCH] }) },
      secondary: [{ label: 'Active minutes', figure: figure({ metric: 'active_minutes', value: 18, staleSources: [WATCH] }) }],
    })
    expect(html.match(/class="source-warning"/g)).toHaveLength(1)
    const sentence = 'My watch has not reported since Sep 10, 2026; it usually reports daily.'
    expect(html).toContain(`<span class="source-warning" title="${sentence}">`)
    // Inside the title, so the mark sits beside the column's name rather than floating in the card.
    expect(html).toMatch(/<h2 class="glance-card-title"><strong>Today<\/strong> <span>so far<\/span><span class="source-warning"/)
  })

  it('counts the chart\'s own stale sources toward the warning', () => {
    const html = render({ chartStaleSources: [WATCH] })
    expect(html.match(/class="source-warning"/g)).toHaveLength(1)
  })

  it('draws no warning when nothing shown is stale', () => {
    expect(render()).not.toContain('source-warning')
  })

  it('links to the given page with the given text', () => {
    expect(render()).toContain('<a href="/activity" class="card-link">View activity</a>')
  })

  it('prints the note and the chart slot when given', () => {
    const html = render({ note: 'Breathing rate 17.2, above your usual', chart: <div id="the-chart" /> })
    expect(html).toContain('<p class="glance-note">Breathing rate 17.2, above your usual</p>')
    expect(html).toContain('<div id="the-chart"></div>')
  })

  it('never says a partial figure is below its usual', () => {
    const html = render({ headline: { label: 'Steps', figure: figure({ value: 2100, partial: true }) } })
    expect(html).toContain('so far; your usual day 8,700')
    expect(html).not.toContain('below')
  })
})
