import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { About, PROJECT_LINKS, APP_VERSION, updateState } from '../src/pages/settings/About.js'
import { Icon } from '../src/components/icons.js'
import { Sidebar } from '../src/components/Sidebar.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import type { Session } from '../src/auth/session.js'
import { updateStatusKey, isNewer } from '../src/data/useUpdateCheck.js'
import type { UpdateStatus } from '../src/data/useUpdateCheck.js'

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
const MEMBER: Session = {
  personId: 'p1', displayName: 'Robin', username: 'robin', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

/** The instance that has never been allowed to ask, which is every instance until an admin says
 *  otherwise and so is the right default for a case that is not about the check. */
const OFF: UpdateStatus = { enabled: false, latest: null, checkedAtMs: null, reachable: true }

/**
 * Renders with both answers this card reads already in the cache.
 *
 * Seeded rather than fetched: react-query hands back cached data on the first render, so a static
 * render sees the state a case is about instead of the loading state every case would otherwise
 * share. An unseeded query would also reach the real network here.
 */
function render(node: React.ReactNode, options: { lng?: string, status?: UpdateStatus, session?: Partial<Session> } = {}): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.session(), { ...MEMBER, ...options.session })
  client.setQueryData(updateStatusKey(), options.status ?? OFF)
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider lng={options.lng ?? 'en'}>{node}</I18nProvider>
    </QueryClientProvider>,
  )
}

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

/**
 * The update check: five states, one sentence each.
 *
 * The states are asserted through `updateState` rather than by matching the rendered copy, which
 * would be asserting the catalogue against itself. What the render is held to is the one thing the
 * copy cannot say for itself: that the version named in "x is out" is the one the server reported,
 * and that the switch is an admin's.
 */
describe('what the card says about releases', () => {
  const status = (over: Partial<UpdateStatus>): UpdateStatus => ({ ...OFF, ...over })

  it('is off until an admin turns it on, whatever else is true', () => {
    expect(updateState(status({ latest: '99.0.0' }), '1.0.0')).toBe('off')
  })

  it('separates could not ask from nothing to report', () => {
    expect(updateState(status({ enabled: true, reachable: false }), '1.0.0')).toBe('unreachable')
    expect(updateState(status({ enabled: true, latest: null }), '1.0.0')).toBe('unknown')
  })

  it('calls a newer release out and leaves an equal one alone', () => {
    expect(updateState(status({ enabled: true, latest: '1.34.0' }), '1.33.0')).toBe('available')
    expect(updateState(status({ enabled: true, latest: '1.33.0' }), '1.33.0')).toBe('current')
  })

  // A release behind the running one is not a reason to say anything: a household on a build from
  // master is ahead of the latest tag, and telling them to upgrade to the version they passed
  // would be worse than silence.
  it('says nothing when the newest release is older than what is running', () => {
    expect(updateState(status({ enabled: true, latest: '1.32.0' }), '1.33.0')).toBe('current')
  })

  it('names the version the server reported, in the sentence a reader sees', () => {
    const html = render(<About />, { status: status({ enabled: true, latest: '9.9.9' }) })
    expect(html).toContain('9.9.9')
    expect(html).toContain('data-state="available"')
  })

  it('offers the switch to an admin and not to a member', () => {
    expect(render(<About />, { session: { isAdmin: true } })).toContain('type="checkbox"')
    expect(render(<About />)).not.toContain('type="checkbox"')
  })

  // The sentence naming what leaves this instance is shown to whoever can act on it, and it is
  // shown whether the check is on or off: nobody can decide against a sentence they would only
  // see after saying yes.
  it('tells an admin what the check sends before they can switch it on', () => {
    const html = render(<About />, { session: { isAdmin: true } })
    expect(html).toContain('GitHub sees a request from this instance')
  })
})

/**
 * Version comparison, which is the one piece of this the browser owns: the server reports a tag
 * and this decides whether it means anything.
 */
describe('comparing two versions', () => {
  it('reads the numbers rather than the text, so 1.9.0 is behind 1.10.0', () => {
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
    expect(isNewer('1.9.0', '1.10.0')).toBe(false)
  })

  it('compares each part in turn', () => {
    expect(isNewer('2.0.0', '1.99.99')).toBe(true)
    expect(isNewer('1.33.1', '1.33.0')).toBe(true)
    expect(isNewer('1.33.0', '1.33.0')).toBe(false)
  })

  // "I cannot tell" and "you are behind" are different claims, and only one of them belongs on a
  // card. A tag with a suffix, an empty answer, or a build constant that never got replaced all
  // answer the first.
  it('answers no to anything it cannot read as three numbers', () => {
    expect(isNewer('1.34.0-rc.1', '1.33.0')).toBe(false)
    expect(isNewer('nightly', '1.33.0')).toBe(false)
    expect(isNewer(null, '1.33.0')).toBe(false)
    expect(isNewer('1.34.0', '__APP_VERSION__')).toBe(false)
  })
})

/**
 * The bug this file's own page shipped, and the two halves of not shipping it again.
 *
 * An svg carrying a viewBox and no dimensions is sized by its container. Every surface that
 * renders an Icon sets its own size in app.css, which is the pattern .brand-mark's comment
 * describes, and .about-link did not have one: the documentation glyph rendered at the height of
 * the card. It reached a release because the layout harness does not open the settings Info tab,
 * and nothing else looks at rendered size.
 */
describe('an icon cannot render unbounded', () => {
  const css = readFileSync(fileURLToPath(new URL('../src/app.css', import.meta.url)), 'utf8')

  it('is sized by the stylesheet on the surface that renders it', () => {
    expect(css).toContain('.about-link svg')
  })

  // The floor, for the next surface that forgets. A stylesheet rule beats a presentation
  // attribute, so this changes nothing that was already sized; what it changes is the failure
  // mode of forgetting, from an icon as tall as its card to an icon slightly the wrong size.
  it('carries its own width and height as well', () => {
    const html = renderToStaticMarkup(<Icon name="docs" />)
    expect(html).toContain('width="17"')
    expect(html).toContain('height="17"')
  })
})
