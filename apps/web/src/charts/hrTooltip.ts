import type { DayRow } from '../fixtures/july.js'

// The min/max band is a stacked area under the hood, so the default axis tooltip
// would report the stacked delta instead of the true max. Rebuild the real
// values from the day row instead of trusting series data. Pulled out of the
// option object so its three branches are testable: a day that was not worn, a
// worn day whose metric is null, and a normal reading.
export function hrTooltip(days: DayRow[], index: number | undefined): string {
  const day = index === undefined ? undefined : days[index]
  if (!day) return ''
  if (!day.worn) return `${day.date}<br/>not worn`
  if (day.hrMean === null || day.hrMin === null || day.hrMax === null) return `${day.date}<br/>no data`
  return `${day.date}<br/>mean ${day.hrMean} bpm<br/>range ${day.hrMin} to ${day.hrMax} bpm`
}
