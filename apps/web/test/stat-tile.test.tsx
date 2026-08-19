import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatTile } from '../src/components/StatTile.js'

const render = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('StatTile', () => {
  it('colours a delta with no stated tone as neutral', () => {
    const html = render(<StatTile label="Steps" value="9,000" basis="sum, 27 of 31 days"
      delta={{ text: '↑ 4%', dir: 'up' }} />)
    expect(html).toContain('data-dir="up"')
    expect(html).toContain('data-tone="neutral"')
  })

  it('keeps direction and tone as separate attributes when they disagree', () => {
    const html = render(<StatTile label="Resting heart rate" value="54" basis="mean, 27 of 31 days"
      delta={{ text: '↑ 4%', dir: 'up', tone: 'bad' }} />)
    expect(html).toContain('data-dir="up"')
    expect(html).toContain('data-tone="bad"')
  })

  it('renders no delta chip at all when the caller has no delta to state', () => {
    const html = render(<StatTile label="Sleep" value="7h 10m" basis="recorded, 2026-07-31" />)
    expect(html).not.toContain('class="delta"')
  })

  it('states the delta window alongside the tile basis', () => {
    const html = render(<StatTile label="Steps" value="9,000" basis="sum, 27 of 31 days"
      delta={{ text: '↑ 4%', dir: 'up', tone: 'good', basis: 'change is the mean of the last 13 readings against the first 13' }} />)
    expect(html).toContain('sum, 27 of 31 days; change is the mean of the last 13 readings against the first 13')
  })
})
