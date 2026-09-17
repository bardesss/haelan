import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nProvider } from '../src/i18n/index.js'
import { AgainstUsualNote, NOTABLE_Z, usualComparison } from '../src/components/AgainstUsual.js'
import type { Baseline } from '../src/data/useBaseline.js'

/**
 * How unusual the day you are already looking at was.
 *
 * This is the half of anomaly detection worth having, and the probe is why it is only this half. A
 * feed announcing unusual days carries roughly one entry every three days across six metrics, and
 * almost every one is something the person lived through - they were awake for the bad night, they
 * were there for the long walk. A line on a day they chose to open costs nothing when they do not
 * open it, and answers a question they have already asked by opening it.
 *
 * No sigma anywhere in the copy. The z-score decides whether to speak; what it says is the plain
 * difference in the metric's own unit, because "2.3σ below your usual" is jargon in a household
 * app and "about 50 minutes below" is the same fact.
 */
const baseline = (over: Partial<Baseline> = {}): Baseline =>
  ({ center: 420, spread: 30, n: 60, thin: false, ...over })

describe('what makes a day worth remarking on', () => {
  it('says nothing about a day sitting inside the usual spread', () => {
    // 430 against a centre of 420 and a spread of 30 is z = 0.33: an ordinary day, and the great
    // majority of days are this. Silence here is the common case, not an error path.
    expect(usualComparison(430, baseline(), 'sleep_asleep_minutes')).toBeNull()
  })

  it('remarks on a day past the threshold, and says which way', () => {
    const low = usualComparison(340, baseline(), 'sleep_asleep_minutes')
    expect(low?.direction).toBe('below')
    const high = usualComparison(500, baseline(), 'sleep_asleep_minutes')
    expect(high?.direction).toBe('above')
  })

  it('reports the distance in the metric, not the distance in standard deviations', () => {
    // 340 is 80 below the centre. That is the number a reader can act on; 2.67 is not.
    expect(usualComparison(340, baseline(), 'sleep_asleep_minutes')?.amount).toBe(80)
  })

  // A thin baseline is ordinary rather than an edge, and the probe confirms it: the first weeks of
  // an archive, and any day after a gap, have nothing to be judged against. Silence is the only
  // honest answer and it must look the same as an unremarkable day.
  it('says nothing when the baseline is too thin to stand on', () => {
    expect(usualComparison(340, baseline({ thin: true }), 'sleep_asleep_minutes')).toBeNull()
  })

  it('says nothing when there is no baseline at all', () => {
    expect(usualComparison(340, null, 'sleep_asleep_minutes')).toBeNull()
  })

  // zScoreOf answers null for a zero spread - a distance measured in units of nothing - and a
  // caller treating that as zero would call every day ordinary, while treating it as infinite
  // would call every day remarkable.
  it('says nothing when nothing varied', () => {
    expect(usualComparison(340, baseline({ spread: 0 }), 'sleep_asleep_minutes')).toBeNull()
  })

  it('says nothing about a day with no value', () => {
    expect(usualComparison(null, baseline(), 'sleep_asleep_minutes')).toBeNull()
  })

  it('draws the line at the threshold it documents', () => {
    const justUnder = usualComparison(420 - (NOTABLE_Z * 30) + 1, baseline(), 'sleep_asleep_minutes')
    const justOver = usualComparison(420 - (NOTABLE_Z * 30) - 1, baseline(), 'sleep_asleep_minutes')
    expect(justUnder).toBeNull()
    expect(justOver).not.toBeNull()
  })
})

describe('the note a card renders', () => {
  const render = (node: React.ReactNode, lng = 'en') =>
    renderToStaticMarkup(<I18nProvider lng={lng}>{node}</I18nProvider>)

  it('renders nothing at all for an ordinary day, rather than an empty element', () => {
    expect(render(
      <AgainstUsualNote value={430} baseline={baseline()} metric="sleep_asleep_minutes" unit="min" />,
    )).toBe('')
  })

  it('states the difference, the unit and the window it compared against', () => {
    const html = render(
      <AgainstUsualNote value={340} baseline={baseline()} metric="sleep_asleep_minutes" unit="min" />,
    )
    expect(html).toContain('80 min below your 60-day average')
  })

  // No colour and no verdict, for the reason TrainingLoadCard states about its own figure: a
  // personal archive is not licensed to tell somebody a low number is bad.
  it('passes no judgement on the direction', () => {
    const html = render(
      <AgainstUsualNote value={340} baseline={baseline()} metric="sleep_asleep_minutes" unit="min" />,
    )
    expect(html).not.toMatch(/data-tone|negative|positive|warning/)
  })
})
