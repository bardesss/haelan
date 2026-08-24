import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Shell } from '../src/Shell.js'
import { I18nProvider } from '../src/i18n/index.js'
import { queryKeys } from '../src/api/queryKeys.js'
import { ApiError } from '../src/api/client.js'
import type { ApiErrorKind } from '../src/api/client.js'
import type { Session } from '../src/auth/session.js'

const PERSON: Session = { personId: 'p1', displayName: 'Wilma', username: 'wilma', isAdmin: false }

// Seeds the session query into the exact cache shape TanStack Query leaves behind after a
// successful fetch followed by a failed refetch: state.data survives, status flips to 'error'.
// Every scenario below seeds data alongside the error (rather than leaving data undefined),
// because a query with no data and a stale error triggers query-core's own retry-on-mount fetch
// the instant a fresh observer is constructed (data === undefined is exactly its trigger
// condition), which would race the real apiGet call against this synchronous render. Session
// expiry, setup becoming incomplete mid-visit and an instance going unreachable mid-visit all
// share the same real shape anyway: a session that previously loaded successfully.
function clientWithSession(errorKind: ApiErrorKind): QueryClient {
  const client = new QueryClient()
  client.setQueryData(queryKeys.session(), PERSON)
  const query = client.getQueryCache().build(client, { queryKey: queryKeys.session() })
  query.setState({ status: 'error', error: new ApiError(errorKind, 401, 'no session'), fetchStatus: 'idle' })
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
})

describe('Shell, setup incomplete', () => {
  it('renders nothing while redirecting to the setup wizard', () => {
    const html = render(clientWithSession('setup_incomplete'))
    expect(html).toBe('')
  })
})
