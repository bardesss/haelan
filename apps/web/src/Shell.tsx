import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Sidebar } from './components/Sidebar.js'
import { SetupApp } from './setup/SetupApp.js'
import { SignIn } from './auth/SignIn.js'
import { useSession } from './auth/session.js'
import { useRoute, matchRoute, navigate } from './router.js'
import { useTranslation } from './i18n/index.js'
import { ApiError } from './api/client.js'
import { signOutAndResetSession } from './auth/signOutRequest.js'
import { ROUTES } from './routes.js'

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

  // Not called from the render body: pushState is a side effect, and StrictMode's double-invoked
  // initial render would push the same entry to the history stack twice back to back.
  useEffect(() => {
    if (setupIncomplete) navigate('/setup/account')
  }, [setupIncomplete])

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
      <main className="main">{active.element}</main>
    </div>
  )
}

export function App() {
  const route = useRoute()
  return route.startsWith('/setup') ? <SetupApp /> : <Shell />
}
