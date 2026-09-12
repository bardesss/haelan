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
import { WorkoutDetail } from './pages/WorkoutDetail.js'

/** `rail` names the rail item a route belongs under, for the routes the rail cannot list itself.
 *  A parameterised path can never be a rail destination (there is no session id to link to), and
 *  without this the reader would stand on a workout page with nothing in the rail marked current. */
export interface Route { path: string, element: ReactNode, rail?: string }

export const WORKOUT_ROUTE = '/activity/:sessionId'

// `/` renders Dashboard because it is the Dashboard, which is a different thing from every other
// entry here, each of which owns one page component. `/settings` was the exception to that until
// M3c-12 gave it one; `/nutrition` was the last remaining placeholder, rendering Dashboard's own
// component the same way `/notes` used to, until this task gave it Nutrition.tsx's honest empty
// page instead. The rail in Sidebar.tsx lists its own paths rather than being generated from this
// table, and stays that way: M3e closes with this milestone, and Sidebar.tsx's own comment on
// RAIL_PATHS says the collapsible rail leaves that derivation untouched. A test enforces that the
// two path sets match, so an edit to either cannot silently leave the other with a route nothing
// links to or a rail item pointing nowhere. That comparison is over unparameterised paths only,
// since M8b: shell.test.tsx's own comment on that case says why a `:` segment is excluded.
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
  { path: WORKOUT_ROUTE, element: <WorkoutDetail />, rail: '/activity' },
]
