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

  // The method sentence moved off the printed basis line and onto the badge it explains: the same
  // sentence under every tile of a page, with only its numbers changing, was the noise. It must
  // still be said wherever the percentage is - as the badge's tooltip, and inside the badge for a
  // screen reader - and must not come back as a second clause of the printed line.
  it('puts the delta window on the badge, not on the printed basis line', () => {
    const window = 'change is the mean of the last 13 readings against the first 13'
    const html = render(<StatTile label="Steps" value="9,000" basis="sum, 27 of 31 days"
      delta={{ text: '↑ 4%', dir: 'up', tone: 'good', basis: window }} />)
    const badge = html.match(/<span class="delta"[^>]*>.*?<\/span><\/span>/)
    expect(badge, html).not.toBeNull()
    expect(badge![0]).toContain(`title="${window}"`)
    expect(badge![0]).toContain(`↑ 4%<span class="sr-only">; ${window}</span></span>`)
    expect(html).toContain('<p class="basis" id="')
    expect(html.match(/<p class="basis"[^>]*>(.*?)<\/p>/)![1]).toBe('sum, 27 of 31 days')
  })

  it('draws a badge with no tooltip when its delta states no window', () => {
    const html = render(<StatTile label="Steps" value="9,000" delta={{ text: '↑ 4%', dir: 'up' }} />)
    expect(html).not.toContain('title=')
    expect(html).not.toContain('sr-only')
  })
})
