// @vitest-environment happy-dom
//
// The strip is mocked, the way period-hero.test.tsx reads the hero's: what the card hands the chart
// (its points, their bands and standings, and the spans a run shades) is the question here, and the
// words under it are asserted whole in both languages.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import type { Sparkline } from '../src/charts/Sparkline.js'
import type { RecoveryMethod, RecoveryStretch } from '../src/data/periodTypes.js'
import { HrvStretchCard } from '../src/pages/recovery/HrvStretchCard.js'
import { RECOVERY_PERIOD_MONTH, RECOVERY_PERIOD_YEAR } from './fixtures/recoveryPeriod.js'

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

function mount(stretch: RecoveryStretch | null, method: RecoveryMethod = RECOVERY_PERIOD_MONTH.method, lng: 'en' | 'nl' = 'en'): void {
  act(() => { root.render(<I18nProvider lng={lng}><HrvStretchCard stretch={stretch} method={method} /></I18nProvider>) })
}

const MONTH = RECOVERY_PERIOD_MONTH.stretch
const RUN = MONTH.run!
const verdict = () => container.querySelector('.figure-row-verdict')
const note = () => container.querySelector('.figure-row-note')?.textContent ?? null

describe('HrvStretchCard', () => {
  it('words a run below its usual, with the note, in the out tone', () => {
    mount(MONTH)
    expect(container.querySelector('h2')?.textContent).toBe('HRV against its usual week')
    expect(container.querySelector('.figure-row-label')?.textContent).toBe('7-day average')
    expect(container.querySelector('.figure-row-value')?.textContent).toBe(`31${NB}ms`)
    expect(verdict()?.textContent).toBe('below your usual for 14 measured days')
    expect(verdict()?.className).toBe('figure-row-verdict is-out')
    expect(note()).toBe('7 of the last 7 nightly readings low')
    expect(container.querySelector('.figure-row-note')?.className).toBe('figure-row-note')
    expect(container.querySelector('.dash-caption')?.textContent)
      .toBe('each dot: the average of the 7 days ending on it, against your usual from the 60 days before that week · shaded = a stretch on one side of the band')
  })

  it('says the same in Dutch', () => {
    mount(MONTH, RECOVERY_PERIOD_MONTH.method, 'nl')
    expect(container.querySelector('h2')?.textContent).toBe('HRV tegenover je gebruikelijke week')
    expect(container.querySelector('.figure-row-label')?.textContent).toBe('Gemiddelde over 7 dagen')
    expect(verdict()?.textContent).toBe('14 gemeten dagen onder je gebruikelijke bereik')
    expect(note()).toBe('7 van de laatste 7 nachtelijke metingen laag')
    expect(container.querySelector('.dash-caption')?.textContent)
      .toBe('elke stip: het gemiddelde van de 7 dagen tot en met die dag, tegenover je gebruikelijke bereik uit de 60 dagen vóór die week · gekleurd vlak = een reeks aan één kant van de band')
  })

  it('words a run above its usual, and its note high, in both languages', () => {
    const above: RecoveryStretch = { ...MONTH, run: { ...RUN, side: 'above', days: 5, sideNights: 4, weekReadings: 6 } }
    mount(above)
    expect(verdict()?.textContent).toBe('above your usual for 5 measured days')
    expect(verdict()?.className).toBe('figure-row-verdict is-out')
    expect(note()).toBe('4 of the last 6 nightly readings high')
    mount(above, RECOVERY_PERIOD_MONTH.method, 'nl')
    expect(verdict()?.textContent).toBe('5 gemeten dagen boven je gebruikelijke bereik')
    expect(note()).toBe('4 van de laatste 6 nachtelijke metingen hoog')
  })

  it('says a capped run is longer than the lookback, read from the method', () => {
    const capped: RecoveryStretch = { ...MONTH, run: { ...RUN, capped: true, days: 60 } }
    const method: RecoveryMethod = { ...RECOVERY_PERIOD_MONTH.method, stretch: { ...RECOVERY_PERIOD_MONTH.method.stretch, lookbackDays: 45 } }
    mount(capped, method)
    expect(verdict()?.textContent).toBe('more than 45 days below your usual')
    mount(capped, method, 'nl')
    expect(verdict()?.textContent).toBe('meer dan 45 dagen onder je gebruikelijke bereik')
  })

  it('without a run, words the last day: within its usual, untoned and with no note', () => {
    const days = MONTH.days.map((day) => (day.measured ? { ...day, side: 'within' as const } : day))
    mount({ ...MONTH, days, run: null })
    expect(verdict()?.textContent).toBe('within your usual')
    expect(verdict()?.className).toBe('figure-row-verdict')
    expect(note()).toBeNull()
    mount({ ...MONTH, days, run: null }, RECOVERY_PERIOD_MONTH.method, 'nl')
    expect(verdict()?.textContent).toBe('binnen je gebruikelijke bereik')
  })

  it('without a run, a last day below its band is a stretch shorter than the minimum, in the out tone', () => {
    mount({ ...MONTH, run: null })
    expect(verdict()?.textContent).toBe('below your usual for fewer than 3 measured days')
    expect(verdict()?.className).toBe('figure-row-verdict is-out')
    expect(note()).toBeNull()
    mount({ ...MONTH, run: null }, RECOVERY_PERIOD_MONTH.method, 'nl')
    expect(verdict()?.textContent).toBe('onder je gebruikelijke bereik, minder dan 3 gemeten dagen')
  })

  it('without a run, a last day above its band reads the minimum from the method', () => {
    const days = MONTH.days.map((day) => (day.measured ? { ...day, side: 'above' as const } : day))
    const method: RecoveryMethod = { ...RECOVERY_PERIOD_MONTH.method, stretch: { ...RECOVERY_PERIOD_MONTH.method.stretch, minRun: 4 } }
    mount({ ...MONTH, days, run: null }, method)
    expect(verdict()?.textContent).toBe('above your usual for fewer than 4 measured days')
    expect(verdict()?.className).toBe('figure-row-verdict is-out')
    mount({ ...MONTH, days, run: null }, method, 'nl')
    expect(verdict()?.textContent).toBe('boven je gebruikelijke bereik, minder dan 4 gemeten dagen')
  })

  it('without a run, an unmeasured last day says there are too few readings, untoned', () => {
    const days = MONTH.days.map((day, index) => (index === 30 ? { localDate: day.localDate, measured: false as const, reason: 'thin-week' as const } : day))
    mount({ ...MONTH, days, run: null })
    expect(verdict()?.textContent).toBe('too few readings in the last 7 days')
    expect(verdict()?.className).toBe('figure-row-verdict')
    // The value is the last measured day's, the one before (30 August's 32, not 31 August's 31).
    expect(container.querySelector('.figure-row-value')?.textContent).toBe(`32${NB}ms`)
    mount({ ...MONTH, days, run: null }, RECOVERY_PERIOD_MONTH.method, 'nl')
    expect(verdict()?.textContent).toBe('te weinig metingen in de laatste 7 dagen')
  })

  it('says how much HRV it needs when no day has a baseline yet, untoned, with no strip', () => {
    const days = MONTH.days.map((day) => ({ localDate: day.localDate, measured: false as const, reason: 'thin-baseline' as const }))
    mount({ ...MONTH, days, runs: [], run: null })
    expect(container.querySelector('h2')?.textContent).toBe('HRV against its usual week')
    expect(verdict()?.textContent).toBe('needs 60 days of HRV before its first week')
    expect(verdict()?.className).toBe('figure-row-verdict')
    expect(container.querySelector('.figure-row-value')).toBeNull()
    expect(sparklineProps).toBeNull()
    mount({ ...MONTH, days, runs: [], run: null }, RECOVERY_PERIOD_MONTH.method, 'nl')
    expect(verdict()?.textContent).toBe('heeft 60 dagen HRV nodig vóór de eerste week')
  })

  it('still draws nothing when no day is measured for another reason', () => {
    const days = MONTH.days.map((day) => ({ localDate: day.localDate, measured: false as const, reason: 'thin-week' as const }))
    mount({ ...MONTH, days, runs: [], run: null })
    expect(container.innerHTML).toBe('')
  })

  it('draws nothing without a stretch', () => {
    mount(null)
    expect(container.innerHTML).toBe('')
  })

  it('hands the strip each day, its own band and side, neutral judgements and the run as a span', () => {
    mount(MONTH)
    const props = sparklineProps!
    expect(props.height).toBe(64)
    expect(props.tableToggle).toBe(false)
    expect(props.dots).toBe(true)
    expect(props.values).toHaveLength(31)
    expect(props.values[0]).toBe(48)
    expect(props.values[30]).toBe(31)
    expect(props.labels[17]).toBe('2026-08-18')
    expect(props.bands?.[30]).toEqual({ low: 43, high: 49 })
    expect(props.pointStandings?.[16]).toBe('within')
    expect(props.pointStandings?.[17]).toBe('below')
    expect(props.pointJudged?.every((judged) => judged === null)).toBe(true)
    expect(props.spans).toEqual([{ from: 17, to: 30 }])
    // The last step's edges, labelled as the hero's are.
    expect(props.baseline).toEqual({ low: 43, high: 49 })
    expect(props.bandLabels).toEqual({ low: `43${NB}ms`, high: `49${NB}ms` })
  })

  it('leaves an unmeasured day out of the strip', () => {
    const days = MONTH.days.map((day, index) => (index === 3 ? { localDate: day.localDate, measured: false as const, reason: 'thin-week' as const } : day))
    mount({ ...MONTH, days })
    expect(sparklineProps!.values[3]).toBeNull()
    expect(sparklineProps!.bands?.[3]).toBeNull()
    expect(sparklineProps!.pointStandings?.[3]).toBeNull()
  })

  it('on a year, draws a point per week and shades the weeks each run touches', () => {
    const year: RecoveryStretch = {
      ...RECOVERY_PERIOD_YEAR.stretch,
      runs: [{ from: '2025-03-05', to: '2025-03-20', side: 'below' }, { from: '2025-12-30', to: '2025-12-31', side: 'above' }],
      run: { side: 'above', days: 3, capped: false, since: '2025-12-29', sideNights: 3, weekReadings: 5, filledDays: 0 },
    }
    mount(year)
    const props = sparklineProps!
    expect(props.values).toHaveLength(53)
    expect(props.values[6]).toBeNull()
    expect(props.values[7]).toBe(48)
    expect(props.labels[9]).toBe('2025-03-03')
    expect(props.pointStandings?.[9]).toBe('below')
    expect(props.spans).toEqual([{ from: 9, to: 11 }, { from: 52, to: 52 }])
    expect(container.querySelector('.figure-row-value')?.textContent).toBe(`47${NB}ms`)
    expect(container.querySelector('.dash-caption')?.textContent)
      .toBe("each dot: a week's last measured day, the average of the 7 days ending on it, against your usual from the 60 days before that week · shaded = a stretch on one side of the band")
  })

  it('on a year, shades nothing for a run touching no week, the clipped first week for one reaching into it, and one week once for two runs in it', () => {
    mount({
      ...RECOVERY_PERIOD_YEAR.stretch,
      runs: [
        { from: '2024-12-20', to: '2024-12-24', side: 'below' },
        { from: '2024-12-29', to: '2025-01-02', side: 'below' },
        { from: '2025-03-03', to: '2025-03-04', side: 'below' },
        { from: '2025-03-07', to: '2025-03-08', side: 'above' },
      ],
      run: null,
    })
    expect(sparklineProps!.spans).toEqual([{ from: 0, to: 0 }, { from: 9, to: 9 }])
  })

  it('shades no week on a year without runs', () => {
    mount(RECOVERY_PERIOD_YEAR.stretch)
    expect(sparklineProps!.spans).toEqual([])
    expect(verdict()?.textContent).toBe('within your usual')
  })
})
