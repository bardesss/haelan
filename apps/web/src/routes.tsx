import type { ReactNode } from 'react'
import { Dashboard } from './pages/Dashboard.js'
import { Sleep } from './pages/Sleep.js'

export interface Route { path: string, element: ReactNode }

// Six of these render Dashboard for now. M3d and M3e replace them, and the table existing at full
// width already is what lets the rail be generated from it rather than hand-listed, so a page
// cannot appear in the navigation without a route or gain a route nobody can reach.
export const ROUTES: readonly Route[] = [
  { path: '/', element: <Dashboard /> },
  { path: '/activity', element: <Dashboard /> },
  { path: '/sleep', element: <Sleep /> },
  { path: '/recovery', element: <Dashboard /> },
  { path: '/health', element: <Dashboard /> },
  { path: '/weight', element: <Dashboard /> },
  { path: '/nutrition', element: <Dashboard /> },
  { path: '/notes', element: <Dashboard /> },
]
