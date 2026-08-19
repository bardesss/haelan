import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Sidebar } from './components/Sidebar.js'
import { Dashboard } from './pages/Dashboard.js'
import { Sleep } from './pages/Sleep.js'
import './app.css'

function App() {
  const [page, setPage] = useState('dashboard')
  return (
    <div className="layout">
      <Sidebar active={page} person="Bartus" onNavigate={setPage} />
      <main className="main">{page === 'sleep' ? <Sleep /> : <Dashboard />}</main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
