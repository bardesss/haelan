import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './components/Sidebar.js'
import { SetupApp } from './setup/SetupApp.js'
import { SignIn } from './auth/SignIn.js'
import { useSession } from './auth/session.js'
import { useRoute, matchRoute, navigate } from './router.js'
import { QueryProvider } from './api/queryClient.js'
import { I18nProvider } from './i18n/index.js'
import { ApiError } from './api/client.js'
import { ROUTES } from './routes.js'
import './app.css'

function Shell() {
  const route = useRoute()
  const session = useSession()
  const active = ROUTES.find((r) => matchRoute(r.path, route)) ?? ROUTES[0]!

  if (session.isPending) return null

  // 409 means an empty volume, which is the wizard's job, and 401 means no session, which is the
  // sign-in screen's. Anything else is a real failure and belongs on screen rather than becoming a
  // redirect loop between the two.
  if (session.error instanceof ApiError && session.error.kind === 'setup_incomplete') {
    navigate('/setup/account')
    return null
  }
  if (session.data === undefined) return <SignIn onSignedIn={() => { void session.refetch() }} />

  return (
    <div className="layout">
      <Sidebar active={active.path} person={session.data.displayName} />
      <main className="main">{active.element}</main>
    </div>
  )
}

function App() {
  const route = useRoute()
  return route.startsWith('/setup') ? <SetupApp /> : <Shell />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <QueryProvider>
        <App />
      </QueryProvider>
    </I18nProvider>
  </StrictMode>,
)
