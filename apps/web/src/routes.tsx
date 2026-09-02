import type { ReactNode } from 'react'
import { Dashboard } from './pages/Dashboard.js'
import { Activity } from './pages/Activity.js'
import { Sleep } from './pages/Sleep.js'
import { Recovery } from './pages/Recovery.js'
import { Health } from './pages/Health.js'
import { Weight } from './pages/Weight.js'
import { Settings } from './pages/Settings.js'

export interface Route { path: string, element: ReactNode }

// The two paths between Weight and Settings have no page of their own yet and render Dashboard
// as a placeholder; M3e replaces them. `/` renders Dashboard because it is the Dashboard, which is
// a different thing and is why it was never part of that count. `/settings` is the exception to
// both: it is a real page, not a placeholder, and M3c-12 is the task that added it. The rail in
// Sidebar.tsx lists its own paths rather than being generated from this table (M3e revisits how
// the two relate); a test enforces that the two path sets match, so an edit to either cannot
// silently leave the other with a route nothing links to or a rail item pointing nowhere.
export const ROUTES: readonly Route[] = [
  { path: '/', element: <Dashboard /> },
  { path: '/activity', element: <Activity /> },
  { path: '/sleep', element: <Sleep /> },
  { path: '/recovery', element: <Recovery /> },
  { path: '/health', element: <Health /> },
  { path: '/weight', element: <Weight /> },
  { path: '/nutrition', element: <Dashboard /> },
  { path: '/notes', element: <Dashboard /> },
  { path: '/settings', element: <Settings /> },
]
