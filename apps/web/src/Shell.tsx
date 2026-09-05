import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Sidebar } from './components/Sidebar.js'
import { SetupApp } from './setup/SetupApp.js'
import { SignIn } from './auth/SignIn.js'
import { RedeemInvite } from './auth/RedeemInvite.js'
import { useSession } from './auth/session.js'
import { useRoute, matchRoute, routeParams, navigate } from './router.js'
import { useTranslation } from './i18n/index.js'
import { ApiError } from './api/client.js'
import { signOutAndResetSession } from './auth/signOutRequest.js'
import { queryKeys } from './api/queryKeys.js'
import { ROUTES } from './routes.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'

export function Shell() {
  const { t } = useTranslation()
  const route = useRoute()
  const session = useSession()
  const queryClient = useQueryClient()
  const active = ROUTES.find((r) => matchRoute(r.path, route)) ?? ROUTES[0]!

  // query-core keeps state.data across a failed refetch, so session.data stays defined forever
  // after one successful load: it is never reliable evidence of being signed in. The error is,
  // so every branch below reads it first. 401 means no session, which is the sign-in screen's
  // job even when a stale display name is still sitting in the cache. 409 means an empty volume,
  // which is the wizard's job. Anything else (unreachable, a 5xx, or a status the client has no
  // name for) is a real failure and belongs on screen with a retry, rather than becoming a
  // redirect loop between the two other screens or quietly presenting a login form for an
  // instance that cannot check a password right now.
  const errorKind = session.error instanceof ApiError ? session.error.kind : null
  const setupIncomplete = errorKind === 'setup_incomplete'
  const [signOutError, setSignOutError] = useState<string | null>(null)

  // An invite link is a deliberate destination on its own, not one of ROUTES' pages (routes.tsx's
  // own comment says why the signed-in table can never carry it): a member holding this link has
  // no account yet, so the token in the URL, not the session, decides whether this screen renders.
  const inviteToken = routeParams('/invite/:token', route)?.token ?? null

  // Reading data alone would be wrong for the reason the big comment below spells out (query-core
  // keeps it forever after one success), but data together with a null error is reliable: that
  // combination exists only once a fetch has actually settled without failing, which is what
  // "already looking at a signed-in session" means here. The pending default (no error yet, no
  // data yet) and a stale display name sitting behind a fresh error both read false, which is
  // exactly what keeps the join screen up through both those states below.
  const signedIn = session.data !== undefined && session.error === null

  // Not called from the render body: pushState is a side effect, and StrictMode's double-invoked
  // initial render would push the same entry to the history stack twice back to back.
  useEffect(() => {
    // Skipped on an invite path: an invited member has no account yet, so a fresh instance
    // answering setup_incomplete is not this reader's cue to build one. Redirecting here would
    // bounce them into the wizard before the join screen below ever got a chance to render.
    if (setupIncomplete && inviteToken === null) navigate('/setup/account')
  }, [setupIncomplete, inviteToken])

  // Ahead of every other branch, including the isPending guard below: the join screen depends on
  // the token in the URL, never on the session, so there is no reason to wait for the session
  // query to settle, or to fall through to the sign-in or wizard screens further down, before
  // showing it. `!signedIn` is what lets this stop applying itself the moment RedeemInvite's own
  // onJoined callback invalidates the session query and it refetches successfully, so the
  // fallthrough at the bottom of this function takes over on the very next render.
  if (inviteToken !== null && !signedIn) {
    return (
      <RedeemInvite
        token={inviteToken}
        onJoined={() => { void queryClient.invalidateQueries({ queryKey: queryKeys.session() }) }}
      />
    )
  }

  if (session.isPending) return null

  if (errorKind === 'unauthorized') {
    return (
      <SignIn
        // Stale data surviving alongside the error is exactly what marks this as a session that
        // expired mid-visit rather than an ordinary first load with nothing signed in yet.
        expired={session.data !== undefined}
        onSignedIn={() => {
          // The whole cache, not just the session query: any page query that was sitting in an
          // error state behind the now-expired session needs to refetch too, not stay broken
          // behind a session that is valid again.
          void queryClient.invalidateQueries()
        }}
      />
    )
  }

  if (setupIncomplete) return null

  // Keyed on session.error rather than errorKind: an error that is not an ApiError (a bug
  // somewhere upstream, not a mapped HTTP failure) still needs a screen. errorKind is null for
  // that shape, and a branch keyed on it would fall through to session.data === undefined below
  // and render nothing, forever, rather than a retry screen the reader can at least act on.
  if (session.error !== null) {
    return (
      <main className="signin">
        <div className="card">
          <h1>{t('shell.error.title')}</h1>
          <p>{t('shell.error.detail')}</p>
          <div className="form-actions">
            <button type="button" className="button button-primary" onClick={() => { void session.refetch() }}>
              {t('shell.error.retry')}
            </button>
          </div>
        </div>
      </main>
    )
  }

  if (session.data === undefined) return null

  return (
    <div className="layout">
      {/* The rail's own boundary, kept apart from the page's below. A throw here costs the reader
          navigation and sign out, not the page they came for; the two boundaries are separate so
          neither failure takes both. */}
      <ErrorBoundary>
        <Sidebar
          active={active.path}
          person={session.data.displayName}
          signOutError={signOutError}
          onSignOut={() => {
            setSignOutError(null)
            // See signOutRequest.ts for why this resets rather than clears the cache: clearing
            // silently leaves the mounted useSession observer reporting the old session forever.
            void signOutAndResetSession(queryClient).then((result) => {
              // A request that never reached the server (an unreachable instance, a dropped
              // connection) should leave the signed-in state exactly as it was rather than
              // silently doing nothing: the reader needs to know the click did not work.
              if (!result.ok) setSignOutError(t('shell.signOutFailed'))
            })
          }}
        />
      </ErrorBoundary>
      {/* A backstop for what a card's own boundary cannot catch within a page: the page's own
          layout, its control row, anything above its cards. A reader hitting this one has lost
          the page rather than one card. */}
      <main className="main"><ErrorBoundary>{active.element}</ErrorBoundary></main>
    </div>
  )
}

export function App() {
  const route = useRoute()
  return route.startsWith('/setup') ? <SetupApp /> : <Shell />
}
