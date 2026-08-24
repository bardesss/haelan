import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { submitSignIn } from '../src/auth/signIn.js'
// The .tsx extension is explicit rather than the project's usual .js: signIn.ts and SignIn.tsx
// share a directory and a case-insensitive filesystem (Windows, default macOS) cannot tell an
// import of "SignIn.js" apart from "signIn.js", so the bundler's extension guessing picks
// whichever file it tries first regardless of which one the specifier names.
import { SignIn } from '../src/auth/SignIn.tsx'
import { I18nProvider } from '../src/i18n/index.js'

afterEach(() => { vi.unstubAllGlobals() })

const respond = (status: number, body: unknown) => new Response(
  JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } },
)

describe('submitSignIn', () => {
  it('reports success when the server accepts the credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, { personId: 'p1' })))
    await expect(submitSignIn({ username: 'bartus', password: 'a good long password' }))
      .resolves.toEqual({ ok: true })
  })

  // Wrong credentials are an ordinary answer, so they must not throw past the form and blank the
  // screen. They also must not say which half was wrong.
  it('reports a rejection as a message key rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(401, { error: { kind: 'auth', code: 'bad_credentials' } })))
    await expect(submitSignIn({ username: 'bartus', password: 'wrong' }))
      .resolves.toEqual({ ok: false, messageKey: 'signIn.failed' })
  })

  it('tells an unreachable instance apart from a rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(submitSignIn({ username: 'bartus', password: 'x' }))
      .resolves.toEqual({ ok: false, messageKey: 'signIn.unreachable' })
  })
})

describe('the sign-in screen', () => {
  const markup = () => renderToStaticMarkup(
    <I18nProvider lng="en"><SignIn onSignedIn={() => {}} /></I18nProvider>,
  )

  it('labels both fields, so the form is usable with a screen reader', () => {
    const html = markup()
    expect(html).toContain('Username')
    expect(html).toContain('Password')
  })

  it('marks the password field as a password, so a browser does not offer to autofill it as text', () => {
    expect(markup()).toContain('type="password"')
  })

  it('renders no raw message key, which is what a missing catalogue entry looks like', () => {
    expect(markup()).not.toContain('signIn.')
  })
})
