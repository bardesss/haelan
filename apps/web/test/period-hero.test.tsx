// @vitest-environment happy-dom
//
// happy-dom, because a dot's click opens the panel through the hero's own state, which only a real
// mount keeps. The strip itself is mocked, the way night-hero.test.tsx reads the night's: what the
// hero hands the chart, and what it does with a click the chart hands back, is the whole question.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import type { Sparkline } from '../src/charts/Sparkline.js'
import type { PeriodFigure, PeriodStripPoint } from '../src/data/periodTypes.js'
import { PeriodHero } from '../src/pages/period/PeriodHero.js'
import { PointPanel } from '../src/pages/period/PointPanel.js'
import type { Emphasised } from '../src/pages/detail/periodText.js'
import { SLEEP_PERIOD_EMPTY, SLEEP_PERIOD_MONTH, SLEEP_PERIOD_YEAR } from './fixtures/sleepPeriod.js'

let sparklineProps: ComponentProps<typeof Sparkline> | null = null
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: ComponentProps<typeof Sparkline>) => {
    sparklineProps = props
    return null
  },
}))

const NB = ' '
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  sparklineProps = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function mount(node: ReactNode): void {
  act(() => { root.render(<I18nProvider lng="en">{node}</I18nProvider>) })
}

// A panel naming the point it was opened for, closed through the hero's own close.
const panelFor = (point: PeriodStripPoint, close: () => void) => (
  <PointPanel title={point.from} rows={[{ label: 'Time asleep', value: String(point.value) }]} open={null}
    onAnnotate={null} onClose={close} />
)

const LONGEST: Emphasised = [{ text: 'longest: ', strong: false }, { text: '7h 27m', strong: true }, { text: ' on Sun, Aug 23 ✦', strong: false }]
const CHANGE: Emphasised = [{ text: '+0h 23m', strong: true }, { text: ' against July', strong: false }]

function hero(figure: PeriodFigure, o: { standout?: Emphasised[], hint?: string, lastYear?: (number | null)[], panel?: typeof panelFor } = {}) {
  return (
    <PeriodHero label="Time asleep" figure={figure} noun="night" standout={o.standout ?? [LONGEST]}
      caption="every night this month" hint={o.hint} lastYear={o.lastYear} panel={o.panel ?? panelFor} />
  )
}

const lines = () => [...container.querySelectorAll('.workout-hero-line')].map((line) => line.textContent)

describe('PeriodHero', () => {
  it('prints the value, the verdict with its window, then the counts and a line for each thing that stood out', () => {
    mount(hero(SLEEP_PERIOD_MONTH.hero, { standout: [LONGEST, CHANGE] }))
    expect(container.querySelector('.detail-hero-value')?.textContent).toBe(`6h${NB}59m`)
    const verdict = container.querySelector('.detail-verdict')
    expect(verdict?.textContent).toMatch(/^within your usual .* for a month, last 12 months$/)
    expect(verdict?.textContent).not.toContain(' · ')
    expect(lines()).toEqual(['16 of 28 nights usual · 6 longer · 6 shorter', 'longest: 7h 27m on Sun, Aug 23 ✦', '+0h 23m against July'])
    // The values the lines turn on are bold, and nothing else is.
    expect([...container.querySelectorAll('.workout-hero-line strong')].map((strong) => strong.textContent)).toEqual(['7h 27m', '+0h 23m'])
    expect(container.querySelector('.dash-caption')?.textContent).toBe('every night this month')
    expect(container.querySelector('h2')?.textContent).toBe('Time asleep')
  })

  it('puts the tap hint beside the caption, and draws none without one', () => {
    mount(hero(SLEEP_PERIOD_MONTH.hero, { hint: 'tap a night for the figures' }))
    expect([...container.querySelectorAll('.period-hero-captions .dash-caption')].map((caption) => caption.textContent))
      .toEqual(['every night this month', 'tap a night for the figures'])
    expect(container.querySelector('.period-hero-hint')?.textContent).toBe('tap a night for the figures')
    mount(hero(SLEEP_PERIOD_MONTH.hero))
    expect(container.querySelector('.period-hero-hint')).toBeNull()
  })

  it('leaves out the lines that have nothing to say', () => {
    const unjudged = { ...SLEEP_PERIOD_MONTH.hero, counts: { within: 0, above: 0, below: 0, unjudged: 28 } }
    mount(hero(unjudged, { standout: [] }))
    expect(lines()).toEqual([])
  })

  it('prints a total\'s per-day average under its value', () => {
    const distance = { ...SLEEP_PERIOD_MONTH.hero, metric: 'distance', unit: 'meters', value: 5200, total: 156000 }
    mount(hero(distance, { standout: [] }))
    expect(container.querySelector('.detail-hero-value')?.textContent).toBe(`156.00${NB}km`)
    expect(lines()[0]).toBe(`5.20${NB}km per day on average`)
  })

  it('draws the strip of its days, each over its own usual, labelling the latest day\'s', () => {
    mount(hero(SLEEP_PERIOD_MONTH.hero))
    const days = SLEEP_PERIOD_MONTH.hero.daily
    expect(sparklineProps?.values).toEqual(days.map((day) => day.value))
    expect(sparklineProps?.labels).toEqual(days.map((day) => day.from))
    expect(sparklineProps?.bands?.[0]).toEqual({ low: 402, high: 437 })
    expect(sparklineProps?.pointJudged).toEqual(days.map((day) => day.judged))
    // The band drawn behind the last point, not the period's usual (6h 59m - 7h 00m) the verdict
    // prints: a band of period averages is too narrow for its two labels not to overprint.
    expect(sparklineProps?.baseline).toEqual({ low: 401, high: 436 })
    expect(sparklineProps?.bandLabels).toEqual({ low: `6h${NB}41m`, high: `7h${NB}16m` })
    expect(sparklineProps?.height).toBe(64)
    expect(sparklineProps?.dots).toBe(true)
    expect(sparklineProps?.tableToggle).toBe(false)
  })

  it('words a dot as opening its figures, not as annotating it, and marks no point as the one shown', () => {
    mount(hero(SLEEP_PERIOD_MONTH.hero))
    expect(sparklineProps?.opensDay?.idle).toBe('Tap a point for its figures')
    expect(sparklineProps?.opensDay?.tail).toBe('Show its figures')
    expect(sparklineProps?.opensDay?.named('Aug 3')).toBe('Figures for Aug 3')
    expect(sparklineProps?.opensDay?.current).toBe('')
    act(() => { root.render(<I18nProvider lng="nl">{hero(SLEEP_PERIOD_MONTH.hero)}</I18nProvider>) })
    expect(sparklineProps?.opensDay?.idle).toBe('Tik op een punt voor de cijfers')
    expect(sparklineProps?.opensDay?.named('3 aug')).toBe('Cijfers van 3 aug')
  })

  it('rings the good days, and only those', () => {
    mount(hero(SLEEP_PERIOD_MONTH.hero))
    const days = SLEEP_PERIOD_MONTH.hero.daily
    expect(sparklineProps?.pointMarks).toEqual(days.map((day) => (day.judged === 'better' ? 'good' : undefined)))
    expect(sparklineProps?.pointMarks?.[2]).toBe('good')
    expect(sparklineProps?.pointMarks?.[4]).toBeUndefined()
  })

  it('hands a year earlier to a daily strip, and not to a weekly one', () => {
    const lastYear = SLEEP_PERIOD_MONTH.hero.daily.map(() => 400)
    mount(hero(SLEEP_PERIOD_MONTH.hero, { lastYear }))
    expect(sparklineProps?.lastYear).toBe(lastYear)
    mount(hero(SLEEP_PERIOD_YEAR.hero, { lastYear: SLEEP_PERIOD_YEAR.hero.daily.map(() => 400) }))
    expect(sparklineProps?.values).toHaveLength(SLEEP_PERIOD_YEAR.hero.weekly!.length)
    expect(sparklineProps?.lastYear).toBeUndefined()
  })

  it('labels the latest point that has a band, whatever the period\'s usual', () => {
    const days = SLEEP_PERIOD_MONTH.hero.daily
    const thin = {
      ...SLEEP_PERIOD_MONTH.hero, usual: { ...SLEEP_PERIOD_MONTH.hero.usual!, thin: true },
      daily: days.map((day, index) => (index === days.length - 1 ? { ...day, band: null } : day)),
    }
    mount(hero(thin))
    expect(sparklineProps?.baseline).toEqual({ low: 402, high: 437 })
  })

  it('passes over a thin band, which the strip leaves unshaded', () => {
    const days = SLEEP_PERIOD_MONTH.hero.daily
    const thinLast = {
      ...SLEEP_PERIOD_MONTH.hero,
      daily: days.map((day, index) => (index === days.length - 1 ? { ...day, band: { ...day.band!, thin: true } } : day)),
    }
    mount(hero(thinLast))
    expect(sparklineProps?.baseline).toEqual({ low: 402, high: 437 })
  })

  it('labels no band when no point has one', () => {
    const bare = { ...SLEEP_PERIOD_MONTH.hero, daily: SLEEP_PERIOD_MONTH.hero.daily.map((day) => ({ ...day, band: null })) }
    mount(hero(bare))
    expect(sparklineProps?.baseline).toBeUndefined()
    expect(sparklineProps?.bandLabels).toBeUndefined()
  })

  it('renders nothing without a value', () => {
    mount(hero(SLEEP_PERIOD_EMPTY.hero))
    expect(container.innerHTML).toBe('')
  })

  it('opens the panel for a clicked dot rather than a page, and closes it on Escape', () => {
    const panel = vi.fn(panelFor)
    const before = window.location.href
    mount(hero(SLEEP_PERIOD_MONTH.hero, { panel }))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    act(() => { sparklineProps!.onPointClick!('2026-08-03') })
    expect(window.location.href).toBe(before)
    expect(panel.mock.calls.at(-1)?.[0]).toBe(SLEEP_PERIOD_MONTH.hero.daily[2])
    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('2026-08-03')
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('moves the panel to another dot when that one is clicked', () => {
    mount(hero(SLEEP_PERIOD_MONTH.hero))
    act(() => { sparklineProps!.onPointClick!('2026-08-03') })
    act(() => { sparklineProps!.onPointClick!('2026-08-05') })
    const dialogs = container.querySelectorAll('[role="dialog"]')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]!.getAttribute('aria-label')).toBe('2026-08-05')
  })

  it('closes the panel when the period changes, even onto a point starting on the same date', () => {
    const shift = (from: string) => from.replace('2026-08', '2026-07')
    const earlier = { ...SLEEP_PERIOD_MONTH.hero, daily: SLEEP_PERIOD_MONTH.hero.daily.map((day) => ({ ...day, from: shift(day.from), to: shift(day.to) })) }
    // The new period still holds a point on 2026-08-03 (its last day), so only the period can close it.
    earlier.daily.push({ ...SLEEP_PERIOD_MONTH.hero.daily[2]! })
    mount(hero(SLEEP_PERIOD_MONTH.hero))
    act(() => { sparklineProps!.onPointClick!('2026-08-03') })
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    mount(hero(earlier))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps the panel open when the same period renders again', () => {
    mount(hero(SLEEP_PERIOD_MONTH.hero))
    act(() => { sparklineProps!.onPointClick!('2026-08-03') })
    mount(hero({ ...SLEEP_PERIOD_MONTH.hero }))
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('opens a week\'s panel on a weekly strip', () => {
    const weeks = SLEEP_PERIOD_YEAR.hero.weekly!
    const panel = vi.fn(panelFor)
    mount(hero(SLEEP_PERIOD_YEAR.hero, { panel }))
    act(() => { sparklineProps!.onPointClick!(weeks[3]!.from) })
    expect(panel.mock.calls.at(-1)?.[0]).toBe(weeks[3])
  })
})
