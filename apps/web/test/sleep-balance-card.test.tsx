// @vitest-environment happy-dom
//
// The Sleep page's balance card over the period read. The server picks the zero line (the person's
// usual once it is worth standing on, the target until then, or the target always with the usual
// switched off: sleep-balance.test.ts in core pins that choice) and signs each night against it; the
// card words which line it is, draws each night as the server sent it, and names an excluded night.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import * as echarts from 'echarts/core'
import { dayMetricTarget } from '@haelan/core/target-key'
import { Sleep } from '../src/pages/Sleep.js'
import { CHART_VARS } from '../src/charts/tokens.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { SleepPeriodData } from '../src/data/periodTypes.js'
import { SLEEP_PERIOD_MONTH, SLEEP_PERIOD_YEAR } from './fixtures/sleepPeriod.js'
import { stubSleep, withQuery } from './sleepPageStub.js'
import type { SleepStub } from './sleepPageStub.js'
import { flush } from './flush.js'

for (const variable of CHART_VARS) document.documentElement.style.setProperty(variable, '#000000')

let container: HTMLDivElement | null = null
let root: Root | null = null
let restore: () => void = () => {}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root?.unmount() })
  restore()
  restore = () => {}
  container?.remove()
  container = null
  root = null
})

const MONTH_URL = '/sleep?range=month&on=2026-08-15'
const YEAR_URL = '/sleep?range=year&on=2025-06-01'
// The month fixture's sixth night (2026-08-06) has no reading: its balance value is null.
const SILENT = '2026-08-06'

async function renderWith(stub: SleepStub, lng = 'en', url = MONTH_URL): Promise<string[]> {
  window.history.replaceState(null, '', url)
  const urls: string[] = []
  restore = stubSleep(urls, stub)
  const { client, tree } = withQuery(<Sleep />)
  act(() => { root?.render(<I18nProvider lng={lng}>{tree}</I18nProvider>) })
  await flush(client, () => container!.innerHTML)
  return urls
}

const withBalance = (patch: Partial<NonNullable<SleepPeriodData['balance']>>): SleepPeriodData =>
  ({ ...SLEEP_PERIOD_MONTH, balance: { ...SLEEP_PERIOD_MONTH.balance, ...patch } })

const balanceCard = (label = 'Sleep balance'): HTMLElement | undefined =>
  [...container!.querySelectorAll<HTMLElement>('section.card')].find((card) => card.querySelector(':scope > .label')?.textContent === label)
const host = () => balanceCard()!.querySelector<HTMLDivElement>('div[role="img"]')!
const rowFor = (date: string): (string | null)[] | undefined =>
  [...balanceCard()!.querySelectorAll('table.sr-only tbody tr')]
    .map((row) => [...row.querySelectorAll('th, td')].map((cell) => cell.textContent))
    .find((cells) => cells[0] === date)
const drawn = (): unknown[] | undefined =>
  (echarts.getInstanceByDom(host())?.getOption() as { series?: { data?: unknown[] }[] } | undefined)?.series?.[0]?.data
// The x axis's labels and the ones it prints (periodAxisLabels).
const xLabels = (): string[] => {
  const axis = (echarts.getInstanceByDom(host())?.getOption() as { xAxis: { data: string[], axisLabel: { interval: (i: number) => boolean } }[] }).xAxis[0]!
  return axis.data.filter((_, i) => axis.axisLabel.interval(i))
}

const EXCLUDE_SILENT = [{
  id: 'o1', scope: 'day_metric', targetKey: dayMetricTarget({ localDate: SILENT, metric: 'sleep_asleep_minutes' }),
  action: 'exclude', correctedValue: null, reason: 'Away',
}]

describe('the sleep balance card', () => {
  it('states the period\'s running total, signed, against the usual it was measured from', async () => {
    await renderWith({ period: SLEEP_PERIOD_MONTH })
    expect(balanceCard()!.querySelector('.night-week-total')?.textContent).toBe('+0h 09m')
    expect(balanceCard()!.querySelector('.night-week-against')?.textContent).toBe('against your usual 6h 59m, over 28 nights')
    expect(balanceCard()!.querySelector('.night-week-bars-caption')?.textContent).toBe('each bar: that night against your usual')
  })

  it('names the target when the server measured against it', async () => {
    await renderWith({ period: withBalance({ zeroLine: { minutes: 480, source: 'target' } }) })
    expect(balanceCard()!.querySelector('.night-week-against')?.textContent).toBe('against your target of 8h 00m, over 28 nights')
    expect(balanceCard()!.querySelector('.night-week-bars-caption')?.textContent).toBe('each bar: that night against your target')
  })

  it('signs a deficit with one minus', async () => {
    await renderWith({ period: withBalance({ total: -20 }) })
    expect(balanceCard()!.querySelector('.night-week-total')?.textContent).toBe('-0h 20m')
  })

  it('words the zero line in Dutch too', async () => {
    await renderWith({ period: SLEEP_PERIOD_MONTH }, 'nl')
    expect(balanceCard('Slaapbalans')!.querySelector('.night-week-against')?.textContent).toBe('ten opzichte van je gebruikelijke 6u 59m, over 28 nachten')
  })

  it('draws each night on its own date, and a night with no reading as no bar rather than a zero', async () => {
    await renderWith({ period: SLEEP_PERIOD_MONTH })
    expect(drawn()).toEqual(SLEEP_PERIOD_MONTH.balance.values)
    expect(rowFor('2026-08-01')).toBeDefined()
    expect(rowFor(SILENT)![1]).toBe('no reading')
  })

  it('names an excluded night rather than leaving it silent, from the exclusions it asks for', async () => {
    const urls = await renderWith({ period: SLEEP_PERIOD_MONTH, overrides: EXCLUDE_SILENT })
    expect(urls.filter((url) => url.includes('/overrides'))).toHaveLength(1)
    expect(rowFor(SILENT)![1]).toBe('excluded')
    // The other silent nights, which the reader did nothing to, say something else.
    expect(rowFor('2026-08-17')![1]).toBe('no reading')
  })

  it("labels a month's bars by day number, every seventh day", async () => {
    await renderWith({ period: SLEEP_PERIOD_MONTH })
    expect(xLabels()).toEqual(['1', '8', '15', '22', '29'])
  })

  it('draws a week a bar on a year, its nights added up, under month names', async () => {
    await renderWith({ period: SLEEP_PERIOD_YEAR }, 'en', YEAR_URL)
    expect(drawn()).toEqual(SLEEP_PERIOD_YEAR.balance.weekly.map((week) => week.value))
    expect(drawn()).toHaveLength(53)
    expect(rowFor('2025-01-06')).toBeDefined()
    expect(xLabels()).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])
    expect(balanceCard()!.querySelector('.night-week-bars-caption')?.textContent).toBe('each bar: that week added up, against your usual')
    // The total and its nights stay the period's.
    expect(balanceCard()!.querySelector('.night-week-against')?.textContent).toBe('against your usual 7h 00m, over 332 nights')
  })

  it('words the weekly bars in Dutch, against the target too', async () => {
    await renderWith({ period: { ...SLEEP_PERIOD_YEAR, balance: { ...SLEEP_PERIOD_YEAR.balance, zeroLine: { minutes: 480, source: 'target' } } } }, 'nl', YEAR_URL)
    expect(balanceCard('Slaapbalans')!.querySelector('.night-week-bars-caption')?.textContent).toBe('elke balk: die week opgeteld, tegenover je doel')
  })

  it('opens nothing from a week bar: a week is no one night to exclude or note', async () => {
    await renderWith({ period: SLEEP_PERIOD_YEAR }, 'en', YEAR_URL)
    const instance = echarts.getInstanceByDom(host()) as unknown as { trigger: (event: string, payload: unknown) => void }
    act(() => { instance.trigger('click', { componentType: 'series', seriesType: 'bar', dataIndex: 2 }) })
    expect(document.querySelector('.annotate-panel')).toBeNull()
  })

  it('opens the annotate panel on the night a bar was clicked', async () => {
    await renderWith({ period: SLEEP_PERIOD_MONTH })
    const instance = echarts.getInstanceByDom(host()) as unknown as { trigger: (event: string, payload: unknown) => void }
    act(() => { instance.trigger('click', { componentType: 'series', seriesType: 'bar', dataIndex: 2 }) })
    expect(document.querySelector('.annotate-panel')).not.toBeNull()
  })
})
