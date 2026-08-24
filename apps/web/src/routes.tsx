import type { ReactNode } from 'react'
import { Dashboard } from './pages/Dashboard.js'
import { Sleep } from './pages/Sleep.js'

export interface Route { path: string, element: ReactNode }

// Six of these render Dashboard for now. M3d and M3e replace them. The rail in Sidebar.tsx lists
// its own paths rather than being generated from this table (M3e revisits how the two relate); a
// test enforces that the two path sets match, so an edit to either cannot silently leave the other
// with a route nothing links to or a rail item pointing nowhere.
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
