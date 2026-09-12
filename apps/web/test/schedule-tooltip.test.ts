import { describe, it, expect } from 'vitest'
import { scheduleTooltip } from '../src/charts/scheduleTooltip.js'
import type { Night } from '../src/charts/schedule.js'
import type { Translate } from '../src/format.js'

const MESSAGES: Record<string, string> = {
  'charts.tooltip.line': '{{label}}: {{value}}',
  'charts.columns.toBed': 'To bed',
  'charts.columns.woke': 'Woke',
  'charts.columns.naps': 'Naps',
  'charts.absence.noReading': 'no reading',
}
const t: Translate = (key, options) => {
  let text = MESSAGES[key] ?? key
  if (options) for (const [k, v] of Object.entries(options)) text = text.replaceAll(`{{${k}}}`, String(v))
  return text
}

// Minutes on the noon-to-noon axis: 1400 is 23:20, 1880 is 07:20 the next morning, 840 is 14:00.
const nights: Night[] = [
  { date: '2026-08-10', bed: 1400, wake: 1880, naps: [] },
  { date: '2026-08-11', bed: 1380, wake: 1860, naps: [840] },
  { date: '2026-08-12', bed: null, wake: null, naps: [900, 960] },
]

describe('the sleep schedule tooltip', () => {
  it('names the night and both ends of its span', () => {
    expect(scheduleTooltip(nights, { seriesType: 'custom', value: [0, 1400] }, t))
      .toBe('2026-08-10<br/>To bed: 23:20<br/>Woke: 07:20')
  })

  // The same word the table's own cell carries for a missing end, rather than a blank or a zero
  // that would read as midnight.
  it('says no reading for a night with no bed or wake time', () => {
    expect(scheduleTooltip(nights, { seriesType: 'custom', value: [2, null] }, t))
      .toBe('2026-08-12<br/>To bed: no reading<br/>Woke: no reading')
  })

  // The trap this function exists for. The naps series is built by flatMap across every night, so
  // its dataIndex counts into a flattened list of all naps and NOT into `nights`: the first nap in
  // that list belongs to night 1, and a lookup by dataIndex would name night 0. Resolving through
  // the point's own value - whose first element is the night index the chart plotted it at - is
  // what makes a nap hover name the night it actually happened on.
  it('resolves a nap to the night it belongs to, not to the nap\'s own position', () => {
    expect(scheduleTooltip(nights, { seriesType: 'scatter', value: [1, 840] }, t))
      .toBe('2026-08-11<br/>Naps: 14:00')
    expect(scheduleTooltip(nights, { seriesType: 'scatter', value: [2, 960] }, t))
      .toBe('2026-08-12<br/>Naps: 16:00')
  })

  it('renders nothing for a point that names no night', () => {
    expect(scheduleTooltip(nights, { seriesType: 'custom', value: [99, 0] }, t)).toBe('')
    expect(scheduleTooltip(nights, { seriesType: 'custom', value: undefined }, t)).toBe('')
    expect(scheduleTooltip(nights, {}, t)).toBe('')
  })

  it('routes every word through t(), not a hardcoded literal', () => {
    const shoutingT: Translate = (key, options) => t(key, options).toUpperCase()
    expect(scheduleTooltip(nights, { seriesType: 'custom', value: [0, 1400] }, shoutingT))
      .toBe('2026-08-10<br/>TO BED: 23:20<br/>WOKE: 07:20')
  })
})
