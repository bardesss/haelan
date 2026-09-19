import type { Tool } from './contract.ts'
import { personTools } from './tools/person.ts'
import { seriesTools } from './tools/series.ts'
import { intradayTools } from './tools/intraday.ts'
import { annotationTools } from './tools/annotations.ts'
import { workoutTools } from './tools/workouts.ts'
import { sqlTools } from './tools/sql.ts'
import { recoveryTools } from './tools/recovery.ts'

/**
 * Every tool, in the order TOOLS.md documents them. Assembly only: a new tool is a function in a
 * family file and one entry here, so this file stays readable as the surface grows.
 */
export const CATALOGUE: Tool[] = [
  ...personTools, ...seriesTools, ...intradayTools, ...annotationTools, ...workoutTools, ...sqlTools,
  ...recoveryTools,
]
