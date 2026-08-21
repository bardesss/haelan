import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './components/Sidebar.js'
import { Dashboard } from './pages/Dashboard.js'
import { Sleep } from './pages/Sleep.js'
import { SetupApp } from './setup/SetupApp.js'
import { useRoute, navigate } from './router.js'
import './app.css'

function Shell() {
  const [page, setPage] = useState('dashboard')
  return (
    <div className="layout">
      <Sidebar active={page} person="Bartus" onNavigate={setPage} />
      <main className="main">{page === 'sleep' ? <Sleep /> : <Dashboard />}</main>
    </div>
  )
}

function App() {
  const route = useRoute()
  const [ready, setReady] = useState(route.startsWith('/setup'))

  // The URL is not the authority on whether setup is done: an instance with an empty volume
  // answers every data route with 409 setup_incomplete, so the wizard is what a bare / must
  // show. Asking once on load is how the browser finds that out.
  useEffect(() => {
    if (route.startsWith('/setup')) { setReady(true); return }
    void fetch('/api/setup/state')
      .then((response) => response.json() as Promise<{ step: string }>)
      .then(({ step }) => {
        if (step !== 'done') navigate('/setup/account')
        setReady(true)
      })
      .catch(() => setReady(true))
  }, [route])

  if (!ready) return null
  return route.startsWith('/setup') ? <SetupApp /> : <Shell />
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
