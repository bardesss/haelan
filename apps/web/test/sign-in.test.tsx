import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { submitSignIn } from '../src/auth/signInRequest.js'
import { SignIn } from '../src/auth/SignIn.js'
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

  // The wizard's AccountStep already carries this vocabulary; a sign-in screen with its own
  // unstyled inputs and a button missing the layout base class looked like a different app.
  it('uses the app\'s form vocabulary rather than unstyled inputs', () => {
    const html = markup()
    expect(html).toContain('class="input"')
    expect(html).toContain('class="label"')
    expect(html).toMatch(/class="button button-primary"/)
  })
})
