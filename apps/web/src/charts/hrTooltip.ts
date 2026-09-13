import { tip } from './base.js'
import type { DayRow } from '../fixtures/july.js'
import { formatMetricValue } from '../format.js'
import type { Translate } from '../format.js'

// The band is a stacked area under the hood, so the default tooltip would report the stacked delta; rebuild from the day row instead.
//
// Every number here goes through formatMetricValue before it ever reaches t(): heart_rate's
// catalogue precision is 0 (metrics.ts), and day.hrMean/hrMin/hrMax are the raw /series values --
// rollup.ts's weighted mean is essentially never a whole number (precision-audit.md's own trace).
// A raw interpolation here is exactly the reported bug: a reader hovering this chart saw
// "mean 90.18407633664866 bpm", on a template literal that also never called t() at all, so the
// words around that number stayed English no matter what language the rest of the app was in.
export function hrTooltip(days: DayRow[], index: number | undefined, t: Translate, language: string): string {
  const day = index === undefined ? undefined : days[index]
  if (!day) return ''
  if (!day.worn) return tip`${day.date}<br/>${t('charts.absence.notWorn')}`
  if (day.hrMean === null || day.hrMin === null || day.hrMax === null) {
    // Same word the accessible tables beside this chart already use for a day with nothing to
    // report, rather than a second synonym ("no data") this tooltip used to keep on its own.
    return tip`${day.date}<br/>${t('charts.absence.noReading')}`
  }
  const mean = formatMetricValue(day.hrMean, 'heart_rate', language, '')
  const min = formatMetricValue(day.hrMin, 'heart_rate', language, '')
  const max = formatMetricValue(day.hrMax, 'heart_rate', language, '')
  // The unit through t(), not a literal 'bpm' interpolated straight in: IntradayHeartRate.tsx
  // (charts.hrTooltip's other reader, now shared with spo2 and hrv) made the same template take
  // an explicit {{unit}} for exactly that reason - this file is heart_rate-only, so its own unit
  // never varies, but the template it shares no longer bakes one in.
  const unit = t('charts.units.bpm')
  return tip`${day.date}<br/>${t('charts.hrTooltip.mean', { value: mean, unit })}<br/>${t('charts.hrTooltip.range', { min, max, unit })}`
}
