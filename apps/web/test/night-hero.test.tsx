import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import type { Sparkline } from '../src/charts/Sparkline.js'
import { NightHero } from '../src/pages/sleep/night/NightHero.js'
import { NIGHT_DATE, nightPageFixture } from './fixtures/nightPage.js'

// The strip's props, read the way dashboard-cards.test.tsx reads the dashboard's own strips: echarts
// never mounts under static rendering, and what the hero hands the chart is the whole question.
let sparklineProps: ComponentProps<typeof Sparkline> | null = null
vi.mock('../src/charts/Sparkline.js', () => ({
  Sparkline: (props: ComponentProps<typeof Sparkline>) => {
    sparklineProps = props
    return null
  },
}))

const render = (onOpenNight?: (localDate: string) => void) => renderToStaticMarkup(
  <I18nProvider lng="en"><NightHero asleep={nightPageFixture().figures.asleep} localDate={NIGHT_DATE} onOpenNight={onOpenNight} /></I18nProvider>,
)

describe('the night page\'s hero strip', () => {
  beforeEach(() => { sparklineProps = null })

  // As the dashboard's night strip: the band behind the line, and its two edges named beside it.
  it('labels the usual band\'s edges, as the dashboard\'s strip does', () => {
    render()
    expect(sparklineProps?.baseline).toEqual({ center: 387, low: 306, high: 468, thin: false })
    expect(sparklineProps?.bandLabels).toEqual({ low: '5h\u00a006m', high: '7h\u00a048m' })
  })

  it('opens a clicked night on its own page, and not the night already shown', () => {
    const open = vi.fn()
    render(open)
    sparklineProps!.onPointClick!('2026-09-03')
    expect(open.mock.calls).toEqual([['2026-09-03']])
    expect(sparklineProps!.opensDay?.current).toBe(NIGHT_DATE)
    // Worded for what a dot opens: a night, not a day (the dashboard's strips open a day).
    expect(sparklineProps!.opensDay?.tail).toBe('Open this night')
    expect(sparklineProps!.opensDay?.idle).toBe('Tap a night to open it')
  })

  it('is a plain strip with nowhere to open a night', () => {
    render(undefined)
    expect(sparklineProps!.onPointClick).toBeUndefined()
    expect(sparklineProps!.opensDay).toBeUndefined()
  })

  // Described by the verdict it prints beside the strip, not by a hidden second copy of it.
  it('says its verdict once', () => {
    const html = render()
    expect(html.split('within your usual 5h\u00a006m – 7h\u00a048m')).toHaveLength(2)
    expect(html).not.toContain('sr-only')
  })
})
