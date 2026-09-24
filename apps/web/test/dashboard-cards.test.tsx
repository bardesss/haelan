import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DashCard } from '../src/pages/dashboard/cardShared.js'
import { NightCard } from '../src/pages/dashboard/NightCard.js'
import { I18nProvider } from '../src/i18n/index.js'
import type { GlanceFigure, GlanceSleep, GlanceStaleSource } from '../src/data/useGlance.js'
import { glanceBody, glanceFigure, GLANCE_TODAY } from './glanceFixture.js'

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

const TODAY = GLANCE_TODAY

// glanceBody().sleep is typed GlanceSleep | null on the payload; every case here supplies a night,
// so the assertion is made once here rather than at every call site below.
function sleepFixture(over: {
  asleep?: Partial<GlanceFigure>, efficiency?: Partial<GlanceFigure>,
  bedtime?: Partial<GlanceFigure>, waketime?: Partial<GlanceFigure>,
} = {}): GlanceSleep {
  const sleep = glanceBody().sleep as GlanceSleep
  return {
    ...sleep,
    asleep: { ...sleep.asleep, ...over.asleep },
    efficiency: { ...sleep.efficiency, ...over.efficiency },
    bedtime: { ...sleep.bedtime, ...over.bedtime },
    waketime: { ...sleep.waketime, ...over.waketime },
  }
}

function renderNight(props: Partial<Parameters<typeof NightCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider lng="en">
      <NightCard sleep={sleepFixture()} span={8} today={TODAY} timezone="Europe/Amsterdam" {...props} />
    </I18nProvider>,
  )
}

describe('NightCard', () => {
  it('leads with the time asleep in display type, and links to the night', () => {
    const html = renderNight()
    expect(html).toContain('class="dash-headline"')
    expect(html).toContain('href="/sleep/night/2026-09-23"')
  })

  it('says a secondary figure outside its usual in words as well as colour', () => {
    const sleep = sleepFixture({ bedtime: { metric: 'sleep_bedtime_minutes', value: 14, standing: 'above' } })
    const html = renderNight({ sleep })
    expect(html).toMatch(/class="dash-mini-value is-out"[^>]*>00:14</)
    expect(html).toContain('later than usual')
  })

  it('keeps the usual sentence for a screen reader on the strip', () => {
    const html = renderNight()
    expect(html).toContain('within your usual')
  })
})
