// @vitest-environment happy-dom
//
// happy-dom because the tooltip is state: it appears on hover or focus and goes on leave or blur,
// which static markup never reaches. dashboard-visuals.test.tsx keeps the static cases.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { act } from 'react'
import type { ComponentProps } from 'react'
import { I18nProvider, initI18n } from '../src/i18n/index.js'
import { WeekBars } from '../src/pages/dashboard/WeekBars.js'
import { dayTooltip } from '../src/charts/dayTooltip.js'
import { chartBase, dayMarks } from '../src/charts/base.js'
import { readChartTokens } from '../src/charts/tokens.js'

const DATES = ['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23']
const VALUES = [8900, 7100, null, 6400, 10200, 9840, 4820]
const format = (v: number) => v.toLocaleString('en')
// happy-dom's import.meta.url is not a file URL, so the stylesheet is found from the working
// directory, the device glance-calendar.test.tsx uses.
const WEB = [process.cwd(), resolve(process.cwd(), 'apps/web')].find((dir) => existsSync(join(dir, 'src/app.css')))!

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function mount(props: Partial<ComponentProps<typeof WeekBars>> = {}) {
  act(() => {
    root.render(
      <I18nProvider lng="en">
        <WeekBars values={VALUES} dates={DATES} tone="steps" label="Steps, last 7 days" line="Steps"
          language="en" format={format} current="2026-09-23" {...props} />
      </I18nProvider>,
    )
  })
}

function slot(date: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[aria-label*="${new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))}"]`)
  if (!found) throw new Error(`no bar for ${date}`)
  return found
}

function tip(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.week-bar-tip')
}

// The strips' tooltip for the same day, through the very function the charts use, so the bar's
// tooltip is held to the chart's markup rather than to a second copy of it written out here.
function chartTooltip(index: number): string {
  const t = initI18n('en').t as unknown as Parameters<typeof dayTooltip>[0]['t']
  const values = VALUES
  return dayTooltip({
    values, labels: DATES, excluded: [], annotations: [],
    marks: dayMarks({ dates: DATES, values, excluded: [], annotations: [], excludedText: '' }),
    trend: undefined, hasTrend: false, episodic: false, unit: 'Steps',
    format: (v, absent) => (v === null ? absent : format(v)), t,
  }, { componentType: 'series', dataIndex: index })
}

describe('a week bar that opens its day', () => {
  it('opens the clicked bar\'s day', () => {
    const pick = vi.fn()
    mount({ onPick: pick })
    act(() => { slot('2026-09-22').click() })
    expect(pick.mock.calls).toEqual([['2026-09-22']])
  })

  it('does not open the day already shown', () => {
    const pick = vi.fn()
    mount({ onPick: pick })
    act(() => { slot('2026-09-23').click() })
    expect(pick).not.toHaveBeenCalled()
  })

  it('shows the chart tooltip on focus, with the open line after it, and hides it on blur', () => {
    mount({ onPick: vi.fn() })
    expect(tip()).toBeNull()
    act(() => { slot('2026-09-22').focus() })
    expect(tip()!.getAttribute('role')).toBe('tooltip')
    expect(tip()!.innerHTML).toBe(`${chartTooltip(5).replaceAll('<br/>', '<br>')}<br>Open this day`)
    expect(tip()!.innerHTML).toBe('2026-09-22<br>Steps: 9,840<br>Open this day')
    act(() => { slot('2026-09-22').blur() })
    expect(tip()).toBeNull()
  })

  it('shows it on hover and hides it when the pointer leaves', () => {
    mount({ onPick: vi.fn() })
    act(() => { slot('2026-09-17').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(tip()!.innerHTML).toBe('2026-09-17<br>Steps: 8,900<br>Open this day')
    act(() => { slot('2026-09-17').dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
    expect(tip()).toBeNull()
  })

  it('shows the day shown without the open line, since it opens nothing', () => {
    mount({ onPick: vi.fn() })
    act(() => { slot('2026-09-23').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(tip()!.innerHTML).toBe('2026-09-23<br>Steps: 4,820')
  })

  it('never says it opens a day without somewhere to open it', () => {
    mount()
    act(() => { slot('2026-09-17').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(tip()!.innerHTML).toBe('2026-09-17<br>Steps: 8,900')
  })
})

// The chart tooltip's colours, read off chartBase itself with every token standing for its own CSS
// variable, so a change to what the charts' tooltip is painted with fails here until the bars follow.
describe('the week bar tooltip is painted like the charts\' tooltip', () => {
  it('uses the same background, border and text tokens as chartBase(tokens).tooltip', () => {
    const tokens = readChartTokens({ getPropertyValue: (variable: string) => `var(${variable})` })
    const { tooltip } = chartBase(tokens)
    const css = readFileSync(join(WEB, 'src/app.css'), 'utf8')
    const rule = css.match(/\n\.week-bar-tip \{([^}]*)\}/)![1]!
    expect(rule).toContain(`background: ${tooltip.backgroundColor};`)
    expect(rule).toContain(`border: 1px solid ${tooltip.borderColor};`)
    expect(rule).toContain(`color: ${tooltip.textStyle.color};`)
    expect(tooltip.backgroundColor).toBe('var(--chart-tooltip-bg)')
  })
})
