import type { ReactNode } from 'react'
import { Dashboard } from './pages/Dashboard.js'
import { Activity } from './pages/Activity.js'
import { Sleep } from './pages/Sleep.js'
import { Recovery } from './pages/Recovery.js'
import { Health } from './pages/Health.js'
import { Weight } from './pages/Weight.js'
import { Nutrition } from './pages/Nutrition.js'
import { Notes } from './pages/Notes.js'
import { Settings } from './pages/Settings.js'

export interface Route { path: string, element: ReactNode }

// `/` renders Dashboard because it is the Dashboard, which is a different thing from every other
// entry here, each of which owns one page component. `/settings` was the exception to that until
// M3c-12 gave it one; `/nutrition` was the last remaining placeholder, rendering Dashboard's own
// component the same way `/notes` used to, until this task gave it Nutrition.tsx's honest empty
// page instead. The rail in Sidebar.tsx lists its own paths rather than being generated from this
// table (M3e revisits how the two relate); a test enforces that the two path sets match, so an
// edit to either cannot silently leave the other with a route nothing links to or a rail item
// pointing nowhere.
export const ROUTES: readonly Route[] = [
  { path: '/', element: <Dashboard /> },
  { path: '/activity', element: <Activity /> },
  { path: '/sleep', element: <Sleep /> },
  { path: '/recovery', element: <Recovery /> },
  { path: '/health', element: <Health /> },
  { path: '/weight', element: <Weight /> },
  { path: '/nutrition', element: <Nutrition /> },
  { path: '/notes', element: <Notes /> },
  { path: '/settings', element: <Settings /> },
]
