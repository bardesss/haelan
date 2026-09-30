import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import type { FigureRow, FigureRows } from '../src/components/FigureRow.js'
import type { PeriodFigure } from '../src/data/periodTypes.js'
import { PeriodFigureRows } from '../src/pages/period/PeriodFigureRows.js'
import { SLEEP_PERIOD_MONTH } from './fixtures/sleepPeriod.js'

// Each row's props and the grid's, read rather than drawn: what the rows hand FigureRow (its band,
// its mark, its strip) is the question, and a strip draws nothing under static rendering anyway.
let rowProps: ComponentProps<typeof FigureRow>[] = []
let rowsProps: Omit<ComponentProps<typeof FigureRows>, 'children'> | null = null
vi.mock('../src/components/FigureRow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/FigureRow.js')>()
  return {
    ...actual,
    FigureRows: (props: ComponentProps<typeof FigureRows>) => {
      rowsProps = { max: props.max, side: props.side }
      return <div className="rows">{props.children}</div>
    },
    FigureRow: (props: ComponentProps<typeof FigureRow>) => {
      rowProps.push(props)
      return null
    },
  }
})

const NB = ' '
const LABELS: Record<string, string> = { sleep_efficiency: 'Efficiency', sleep_deep_minutes: 'Deep sleep', sleep_rem_minutes: 'REM', sleep_bedtime_minutes: 'Bedtime' }
const labelOf = (metric: string) => LABELS[metric] ?? metric
const [efficiency, deep, rem, bedtime] = SLEEP_PERIOD_MONTH.figures as [PeriodFigure, PeriodFigure, PeriodFigure, PeriodFigure]

function render(figures: PeriodFigure[], o: Partial<ComponentProps<typeof PeriodFigureRows>> = {}) {
  return renderToStaticMarkup(
    <I18nProvider lng="en"><PeriodFigureRows figures={figures} labelOf={labelOf} noun="night" {...o} /></I18nProvider>,
  )
}

describe('PeriodFigureRows', () => {
  beforeEach(() => { rowProps = []; rowsProps = null })

  it('gives each figure a row with its value, the usual as its band and the value as its mark', () => {
    render([efficiency, deep])
    expect(rowProps.map((row) => row.label)).toEqual(['Efficiency', 'Deep sleep'])
    expect(rowProps.map((row) => row.value)).toEqual([`92${NB}%`, `1h${NB}10m`])
    expect(rowProps[1]!.band).toBe(deep.usual)
    expect(rowProps[1]!.mark).toBe(70)
    expect(rowProps[1]!.judged).toBe(deep.judged)
    expect(rowProps[1]!.standing).toBe('within')
  })

  it('puts the day counts in the plain note under the verdict, not in its toned words', () => {
    render([deep, bedtime])
    // The verdict and its range alone: the window its usual comes from is named once, in the hero.
    expect(rowProps[0]!.verdict).toBe(`your usual 1h${NB}10m`)
    expect(rowProps[1]!.verdict).not.toContain('for a month')
    expect(rowProps[0]!.note).toBe('17 of 28 nights usual · 6 longer · 5 shorter')
    expect(rowProps[1]!.note).toBe('16 of 28 nights usual · 5 later · 7 earlier')
  })

  it('keeps the counts out of a verdict judged worse, which takes the warning tone', () => {
    const worse = { ...deep, standing: 'below' as const, judged: 'worse' as const }
    render([worse])
    expect(rowProps[0]!.judged).toBe('worse')
    expect(rowProps[0]!.verdict).not.toContain('nights usual')
    expect(rowProps[0]!.note).toContain('17 of 28 nights usual')
  })

  it('says there is no usual yet where there is no verdict, and no note where no day was judged', () => {
    const unjudged = { ...deep, usual: null, standing: null, counts: { within: 0, above: 0, below: 0, unjudged: 28 } }
    render([unjudged])
    expect(rowProps[0]!.verdict).toBe('no usual yet')
    expect(rowProps[0]!.note).toBeUndefined()
  })

  it('gives a total\'s note its average per day alone, without the day counts', () => {
    const distance = { ...deep, metric: 'distance', unit: 'meters', value: 5200, total: 156000 }
    render([distance])
    expect(rowProps[0]!.value).toBe(`156.00${NB}km`)
    expect(rowProps[0]!.note).toBe(`5.20${NB}km per day on average`)
    expect(rowProps[0]!.verdict).not.toContain('per day')
  })

  it('draws each figure\'s strip of its points, each over its own usual', () => {
    render([rem])
    const strip = rowProps[0]!.strip!
    expect(strip.values).toEqual(rem.daily.map((day) => day.value))
    expect(strip.labels).toEqual(rem.daily.map((day) => day.from))
    expect(strip.pointJudged).toEqual(rem.daily.map((day) => day.judged))
    expect(strip.metric).toBe('sleep_rem_minutes')
    expect(strip.unit).toBe('REM')
    expect(strip.formatValue(85, '-')).toBe(`1h${NB}25m`)
    expect(strip.formatValue(null, '-')).toBe('-')
  })

  it("marks a per-period figure's count, the number it prints, not its pace", () => {
    // A running month: three naps so far, a pace of 4.2, left unjudged by the server.
    const naps = { ...deep, metric: 'sleep_nap_count', unit: 'count', precision: 0, per: 'period' as const, value: 4.2, total: 3, standing: null, judged: null }
    render([naps])
    expect(rowProps[0]!.value).toBe('3')
    expect(rowProps[0]!.mark).toBe(3)
  })

  it("bars, marks and tones a total by its total against the usual for a period's total", () => {
    const usualTotal = { center: 520_000, low: 500_000, high: 540_000, thin: false, window: deep.usual!.window, periods: 12 }
    const climb = {
      ...rem, metric: 'altitude_gain', unit: 'millimeters', value: 18_000, total: 560_000, standing: 'within' as const, judged: null,
      usualTotal, totalStanding: 'above' as const, totalJudged: 'better' as const,
    }
    render([climb], { bars: true })
    expect(rowProps[0]!.band).toBe(usualTotal)
    expect(rowProps[0]!.mark).toBe(560_000)
    expect([rowProps[0]!.standing, rowProps[0]!.judged]).toEqual(['above', 'better'])
  })

  it('draws the bar alone with `bars`', () => {
    render([rem], { bars: true })
    expect(rowProps[0]!.strip).toBeUndefined()
    expect(rowProps[0]!.band).toBe(rem.usual)
  })

  it('leaves out a figure with no value', () => {
    render([efficiency, { ...deep, value: null }, rem])
    expect(rowProps.map((row) => row.label)).toEqual(['Efficiency', 'REM'])
  })

  it('is nothing at all with no figure left to show', () => {
    expect(render([{ ...deep, value: null }])).toBe('')
    expect(render([])).toBe('')
    expect(rowsProps).toBeNull()
  })

  it('puts the caller\'s own rows after its own, in the same grid, and draws them with no figure left', () => {
    const html = render([efficiency], { children: <p className="own">own row</p> })
    expect(rowProps.map((row) => row.label)).toEqual(['Efficiency'])
    expect(html).toBe('<div class="rows"><p class="own">own row</p></div>')
    expect(render([], { children: <p className="own">own row</p> })).toBe('<div class="rows"><p class="own">own row</p></div>')
  })

  it('hands its grid the cap and the side flag', () => {
    render([efficiency], { max: 3, side: true })
    expect(rowsProps).toEqual({ max: 3, side: true })
  })
})
