import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
import { Shell } from '../src/Shell.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { ApiError, apiGet } from '../src/api/client.js'
import type { ApiErrorKind } from '../src/api/client.js'
import type { Session } from '../src/auth/session.js'
import { signOutAndResetSession } from '../src/auth/signOutRequest.js'

afterEach(() => { vi.unstubAllGlobals() })

const PERSON: Session = {
  personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false, timezone: 'Europe/Amsterdam', birthDate: null, sex: null, connected: true, credentialsUnreadable: false, baseUrl: 'http://localhost:4235',
}

// Seeds the session query into the exact cache shape TanStack Query leaves behind after a
// successful fetch followed by a failed refetch: state.data survives, status flips to 'error'.
// Every scenario below seeds data alongside the error (rather than leaving data undefined),
// because a query with no data and a stale error triggers query-core's own retry-on-mount fetch
// the instant a fresh observer is constructed (data === undefined is exactly its trigger
// condition), which would race the real apiGet call against this synchronous render. Session
// expiry, setup becoming incomplete mid-visit and an instance going unreachable mid-visit all
// share the same real shape anyway: a session that previously loaded successfully.
// The real status apiSend's KIND_BY_STATUS would have produced for each kind (apps/web/src/api/client.ts),
// rather than pinning every one to 401: only the kind is ever read here, but a fixture with a
// status the client cannot actually produce for that kind is misleading to a future reader.
const STATUS_BY_KIND: Record<ApiErrorKind, number | null> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  setup_incomplete: 409,
  config: 400,
  transient: 500,
  internal: 500,
  unreachable: null,
}

function clientWithSession(errorKind: ApiErrorKind): QueryClient {
  const client = new QueryClient()
  client.setQueryData(queryKeys.session(), PERSON)
  const query = client.getQueryCache().build(client, { queryKey: queryKeys.session() })
  query.setState({ status: 'error', error: new ApiError(errorKind, STATUS_BY_KIND[errorKind], 'no session'), fetchStatus: 'idle' })
  return client
}

const render = (client: QueryClient) => renderToStaticMarkup(
  <QueryClientProvider client={client}>
    <I18nProvider lng="en"><Shell /></I18nProvider>
  </QueryClientProvider>,
)

describe('Shell, session expiry mid-visit', () => {
  // The regression this guards: query-core retains state.data across a failed refetch, so
  // session.data stays defined forever after one success. The old branch order checked
  // `session.data === undefined` before looking at the error, so a stale display name kept
  // rendering the dashboard while every request on the page was 401ing behind it.
  it('renders sign-in, not the dashboard, once the session query reports unauthorized', () => {
    const html = render(clientWithSession('unauthorized'))

    expect(html).not.toContain('Wilma')
    expect(html).toContain('class="signin"')
    expect(html).not.toContain('class="rail"')
  })

  it('names the session as expired rather than presenting an ordinary blank sign-in form', () => {
    const html = render(clientWithSession('unauthorized'))

    expect(html).toContain('ended')
  })

  it('renders the dashboard once the session query actually succeeds', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.session(), PERSON)
    const html = render(client)

    expect(html).toContain('Wilma')
    expect(html).not.toContain('class="signin"')
    expect(html).toContain('Sign out')
  })
})

describe('Shell, an instance that cannot be reached', () => {
  // Before this fix, unreachable, transient, forbidden and not_found all fell through to the
  // sign-in branch: a reader would see a login form, type correct credentials, and be told the
  // instance did not answer. Only unauthorized belongs on the sign-in screen.
  it.each(['unreachable', 'transient', 'forbidden', 'not_found', 'config'] as const)(
    'renders a retry state rather than sign-in when the session query fails with %s',
    (kind) => {
      const html = render(clientWithSession(kind))

      expect(html).not.toContain('type="password"')
      expect(html).not.toContain('Wilma')
      expect(html).toMatch(/<button[^>]*>[^<]*<\/button>/)
    },
  )

  it('lets the reader retry rather than reload', () => {
    const html = render(clientWithSession('unreachable'))
    expect(html.toLowerCase()).toMatch(/try again|retry/)
  })

  // Keyed on session.error rather than on errorKind (which is null for any error that is not an
  // ApiError): a bug somewhere upstream that throws a plain Error still needs a screen, and the
  // old branch order fell through to session.data === undefined below, rendering nothing.
  it('shows the retry screen rather than a blank page for an error shape it cannot name', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.session(), PERSON)
    const query = client.getQueryCache().build(client, { queryKey: queryKeys.session() })
    query.setState({ status: 'error', error: new Error('unexpected shape'), fetchStatus: 'idle' })

    const html = render(client)

    expect(html).not.toBe('')
    expect(html).not.toContain('Wilma')
    expect(html.toLowerCase()).toMatch(/try again|retry/)
  })
})

describe('Shell, signing out', () => {
  // The regression this guards: the sign-out handler used queryClient.clear(), which destroys
  // every query without dispatching an action or notifying an observer, so the exact
  // QueryObserver useSession mounts inside Shell kept reporting the old session forever and the
  // page never moved off the dashboard. This subscribes an observer on the same key first, the
  // same way useSession's mount would (a real Shell never unmounts and remounts on sign-out, it
  // keeps the same observer), then checks what THAT observer reports afterwards, which is what
  // Shell's session.error / session.data branches actually read.
  //
  // A fresh render against the same client after sign-out cannot stand in for this: query-core's
  // optimistic-result computation reports isPending for any observer that has never subscribed
  // while data is undefined, regardless of the query's real settled state (confirmed directly
  // against the installed query-core; this is the same shape as the retry-on-mount quirk noted
  // above, not a Shell bug). A live, previously-subscribed observer is the only way to see the
  // real post-sign-out state without a full DOM.
  it('reports no data and an unauthorized error, the exact shape Shell turns into sign-in', async () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.session(), PERSON)

    const observer = new QueryObserver(client, {
      queryKey: queryKeys.session(),
      queryFn: () => apiGet<Session>('/api/auth/me'),
      retry: false,
    })
    const unsubscribe = observer.subscribe(() => {})
    expect(observer.getCurrentResult().data).toEqual(PERSON)

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url === '/api/auth/logout'
        ? new Response(null, { status: 204 })
        // The server session is gone the instant sign-out succeeds.
        : new Response(JSON.stringify({ error: { kind: 'auth' } }), { status: 401 })
    )))

    const result = await signOutAndResetSession(client)
    await new Promise((resolve) => setTimeout(resolve, 20))
    unsubscribe()

    expect(result).toEqual({ ok: true })
    const final = observer.getCurrentResult()
    expect(final.data).toBeUndefined()
    expect(final.isPending).toBe(false)
    expect(final.error).toBeInstanceOf(ApiError)
    expect((final.error as ApiError).kind).toBe('unauthorized')
  })
})

describe('Shell, setup incomplete', () => {
  it('renders nothing while redirecting to the setup wizard', () => {
    const html = render(clientWithSession('setup_incomplete'))
    expect(html).toBe('')
  })
})
