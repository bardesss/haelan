import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { About, PROJECT_LINKS, APP_VERSION } from '../src/pages/settings/About.js'
import { Sidebar } from '../src/components/Sidebar.js'
import { I18nProvider } from '../src/i18n/index.js'

/**
 * Where the project's own links live.
 *
 * They were three rows in the rail foot, permanently, between the pages a reader navigates and the
 * account line - and in the collapsed rail, three more unlabelled glyphs. They are not
 * destinations in this app at all: every one leaves for github.com, and a reader reaches for them
 * about as often as they reach for Settings. So they sit in Settings, where the other things a
 * person configures once already are.
 *
 * The reason for having them has not changed, and Sidebar.tsx stated it: a self-hosted tool has no
 * in-app feedback channel of its own, so these point straight at the project's home. That argues
 * for keeping them somewhere findable, which Settings is. It never argued for the rail.
 */
const render = (node: React.ReactNode, lng = 'en') =>
  renderToStaticMarkup(<I18nProvider lng={lng}>{node}</I18nProvider>)

describe('the project links', () => {
  it('names the three the project actually has', () => {
    expect(PROJECT_LINKS.map((link) => link.icon)).toEqual(['docs', 'changelog', 'issues'])
  })

  it('all leave for the project home, which is the whole point of them', () => {
    for (const link of PROJECT_LINKS) {
      expect(link.href, link.icon).toMatch(/^https:\/\/github\.com\/bardesss\/haelan/)
    }
  })

  it('opens each in a new tab without handing the target a window reference', () => {
    const html = render(<About />)
    // rel="noreferrer" on every external anchor: target="_blank" without it gives the opened page
    // a handle on this one through window.opener.
    const anchors = html.match(/<a [^>]*>/g) ?? []
    expect(anchors.length).toBe(PROJECT_LINKS.length)
    for (const anchor of anchors) {
      expect(anchor).toContain('target="_blank"')
      expect(anchor).toContain('rel="noreferrer"')
    }
  })

  it('renders a link per entry, in order', () => {
    const html = render(<About />)
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual(PROJECT_LINKS.map((link) => link.href))
  })
})

/**
 * The version the running bundle was built from.
 *
 * Nothing in this app said which version it was, anywhere. The root package.json carries it
 * (release-please bumps it on every release), apps/server/package.json is still 0.1.0 and is not
 * the release version, and the landing page gets its number from the release pipeline rather than
 * from a running instance - so a person looking at their own instance had no way to tell what they
 * were running short of reading the container tag.
 *
 * It is injected at build time from that one package.json, through a helper both vite configs
 * read. Two configs because the app and the tests do not share one: apps/web/vite.config.ts serves
 * the app and the root vitest.config.ts runs the suite, and a literal written into each is exactly
 * the drift this repo keeps guards against elsewhere.
 */
describe('the version', () => {
  it('is the one in the root package.json, not a hardcoded string', () => {
    const root = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { version: string }
    expect(APP_VERSION).toBe(root.version)
  })

  it('reads as a version rather than as undefined, which is what a missing define looks like', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('is on the card', () => {
    expect(render(<About />)).toContain(APP_VERSION)
  })
})

describe('the rail, once the project links have left it', () => {
  it('links nowhere outside this app any more', () => {
    const html = renderToStaticMarkup(
      <I18nProvider lng="en">
        <Sidebar person="Wilma" active="/" onSignOut={() => {}} />
      </I18nProvider>,
    )
    expect(html).not.toContain('github.com')
  })
})
