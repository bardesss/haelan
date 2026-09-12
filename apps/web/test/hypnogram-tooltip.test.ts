import { describe, it, expect } from 'vitest'
import { hypnogramTooltip } from '../src/charts/hypnogramTooltip.js'
import type { Stage } from '../src/fixtures/july.js'
import type { Translate } from '../src/format.js'

const MESSAGES: Record<string, string> = {
  'charts.hypnogramTooltip.span': '{{from}} to {{to}}',
  'charts.tooltip.line': '{{label}}: {{value}}',
  'sleep.stage.deep': 'Deep',
  'sleep.stage.light': 'Light',
}
const t: Translate = (key, options) => {
  let text = MESSAGES[key] ?? key
  if (options) for (const [k, v] of Object.entries(options)) text = text.replaceAll(`{{${k}}}`, String(v))
  return text
}

const MINUTE_MS = 60_000
// Raw milliseconds from the night's own start, the shape Hypnogram's `segments` prop carries: the
// component rounds per displayed value and never before a sum (its stageTotals comment says why).
const segments: { stage: Stage; startMs: number; endMs: number }[] = [
  { stage: 'light', startMs: 0, endMs: 34 * MINUTE_MS },
  { stage: 'deep', startMs: 34 * MINUTE_MS, endMs: 71 * MINUTE_MS },
]

describe('the hypnogram tooltip', () => {
  // The same four values the accessible table's own row carries for this segment - from, to,
  // stage, duration - so a reader hovering and a reader reading the table are told one thing.
  it('names the span, the stage and the duration of the hovered segment', () => {
    expect(hypnogramTooltip(segments, 1, t)).toBe('0h 34m to 1h 11m<br/>Deep: 0h 37m')
  })

  it('renders nothing for an index that is not a segment', () => {
    expect(hypnogramTooltip(segments, 99, t)).toBe('')
    expect(hypnogramTooltip(segments, undefined, t)).toBe('')
  })

  it('routes every word through t(), not a hardcoded literal', () => {
    const shoutingT: Translate = (key, options) => t(key, options).toUpperCase()
    expect(hypnogramTooltip(segments, 0, shoutingT)).toBe('0H 00M TO 0H 34M<br/>LIGHT: 0H 34M')
  })
})
