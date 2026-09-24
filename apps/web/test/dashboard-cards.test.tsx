import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DashCard } from '../src/pages/dashboard/cardShared.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { GlanceFigure, GlanceStaleSource } from '../src/data/useGlance.js'
import { glanceFigure } from './glanceFixture.js'

const WATCH: GlanceStaleSource = { sourceId: 's1', name: 'My watch', lastReportedDate: '2026-09-10', medianGapDays: 1 }

function render(props: Partial<Parameters<typeof DashCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en">
      <DashCard span={4} title="Today" subtitle="so far" staleFigures={[]} {...props}>
        <div>content</div>
      </DashCard>
    </I18nProvider>,
  )
}

describe('DashCard', () => {
  it('puts one source warning beside the title for a stale source shared by two figures, deduplicated', () => {
    const figures: GlanceFigure[] = [
      glanceFigure({ metric: 'steps', staleSources: [WATCH] }),
      glanceFigure({ metric: 'active_minutes', staleSources: [WATCH] }),
    ]
    const html = render({ staleFigures: figures })
    expect(html.match(/class="source-warning"/g)).toHaveLength(1)
    const sentence = 'My watch has not reported since Sep 10, 2026; it usually reports daily.'
    expect(html).toContain(`<span class="source-warning" title="${sentence}">`)
    // Right after the heading, on its row, so the mark sits beside the column's name rather than
    // floating in the card, and outside the h2 so its sentence is not part of the heading's name.
    expect(html).toMatch(/<div class="dash-card-head"><h2 class="dash-card-title"><strong>Today<\/strong> <span>so far<\/span><\/h2><span class="source-warning"/)
  })

  it('reads two sources sharing a display name as two sentences', () => {
    const scale: GlanceStaleSource = { sourceId: 's2', name: 'My watch', lastReportedDate: '2026-09-11', medianGapDays: 1 }
    const figures: GlanceFigure[] = [
      glanceFigure({ metric: 'steps', staleSources: [WATCH] }),
      glanceFigure({ metric: 'active_minutes', staleSources: [scale] }),
    ]
    const html = render({ staleFigures: figures })
    expect(html.match(/class="source-warning"/g)).toHaveLength(1)
    const sentence = 'My watch has not reported since Sep 10, 2026; it usually reports daily. '
      + 'My watch has not reported since Sep 11, 2026; it usually reports daily.'
    expect(html).toContain(`<span class="source-warning" title="${sentence}">`)
  })

  it('keeps the warning\'s sentence out of the heading\'s accessible name', () => {
    const html = render({ staleFigures: [glanceFigure({ metric: 'steps', staleSources: [WATCH] })] })
    expect(html).toMatch(/<h2 class="dash-card-title"><strong>Today<\/strong> <span>so far<\/span><\/h2>/)
    expect(html).not.toMatch(/<h2[^>]*>[^<]*source-warning/)
  })

  it('draws no warning when nothing shown is stale', () => {
    expect(render()).not.toContain('source-warning')
  })

  it('renders the link only when given', () => {
    expect(render()).not.toContain('card-link')
    expect(render({ link: { to: '/activity', text: 'View activity' } }))
      .toContain('<a href="/activity" class="card-link">View activity</a>')
  })
})
