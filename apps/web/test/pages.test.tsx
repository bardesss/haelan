import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Dashboard } from '../src/pages/Dashboard.js'
import { Sleep } from '../src/pages/Sleep.js'
import { july } from '../src/fixtures/july.js'
import { I18nProvider } from '../src/i18n/index.js'

// The chart hosts render on the server; ECharts only touches them in an effect,
// so this exercises every prop, every basis string and every table alternative
// without a browser. Pinned to English: both pages now read their copy from the
// catalogue, and an unpinned instance falls back to navigator.language, which on a
// Dutch machine would render Dutch and break every literal-text assertion below.
const pages = {
  Dashboard: renderToStaticMarkup(<I18nProvider lng="en"><Dashboard /></I18nProvider>),
  Sleep: renderToStaticMarkup(<I18nProvider lng="en"><Sleep /></I18nProvider>),
}

describe.each(Object.entries(pages))('%s', (_name, html) => {
  it('names every chart and points it at a description', () => {
    const hosts = [...html.matchAll(/<div[^>]*role="img"[^>]*>/g)].map((m) => m[0])
    expect(hosts.length).toBeGreaterThan(0)
    for (const host of hosts) {
      expect(host, host).toMatch(/aria-label="[^"]+"/)
      expect(host, host).toMatch(/aria-describedby="[^"]+"/)
    }
  })

  it('resolves every aria-describedby to an element that exists', () => {
    for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) {
      expect(html, `no element with id ${m[1]}`).toContain(`id="${m[1]}"`)
    }
  })

  it('gives every chart a table alternative', () => {
    const charts = [...html.matchAll(/role="img"/g)].length
    const tables = [...html.matchAll(/<table class="sr-only">/g)].length
    expect(tables).toBe(charts)
  })

  it('never renders a null, undefined or NaN into the page', () => {
    expect(html).not.toMatch(/>(null|undefined|NaN)</)
    expect(html).not.toContain('NaN')
  })

  it('never renders absence as a zero', () => {
    // Unworn days appear in the table alternatives as words, never as 0.
    expect(html).toMatch(/not worn|no reading/)
  })
})

describe('Dashboard specifics', () => {
  const html = pages.Dashboard

  it('states the heatmap colour domain rather than hiding a hardcoded maximum', () => {
    const maxSteps = Math.max(...july.days.map((d) => d.steps ?? 0))
    expect(html).toContain(`0 to ${maxSteps.toLocaleString('en-GB')} steps`)
    expect(html).toContain('stronger colour is more steps')
  })

  it('does not label two different cards with the same name', () => {
    const labels = [...html.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1])
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('states the window every delta compared', () => {
    const deltas = [...html.matchAll(/class="delta"/g)].length
    const windows = [...html.matchAll(/change is the mean of the last \d+ readings against the first \d+/g)].length
    expect(windows).toBe(deltas)
  })
})
