import { useTranslation } from '../../i18n/index.js'
import { Card } from '../../components/Card.js'
import type { RecoveryMethod } from '../../data/periodTypes.js'

/** A weight as a whole percentage: 0.75 reads 75. */
const percent = (weight: number) => String(Math.round(weight * 100))

/**
 * "How the index works": four short paragraphs of plain prose, no list, on what the index weighs,
 * where its usual sits, what its weights were tuned against, and how the HRV stretch is called.
 * Every number in it is the server's (`method`, read from the constants the index and the stretch
 * are computed by), never typed into a sentence, so the text cannot drift from the code.
 */
export function HowTheIndexWorks({ method }: { method: RecoveryMethod }) {
  const { t, i18n } = useTranslation()
  const { weights, usualBand, stretch } = method
  return (
    <Card span={12} label={t('recovery.method.label')} measured>
      <p>{t('recovery.method.ingredients', {
        hrv: percent(weights.hrv), restingHeartRate: percent(weights.restingHeartRate),
        sleep: percent(weights.sleep), respiratoryRate: percent(weights.respiratoryRate), days: method.baselineDays,
      })}</p>
      <p>{t('recovery.method.usual', { low: usualBand.low, high: usualBand.high })}</p>
      <p>{t('recovery.method.tuned')}</p>
      <p>{t('recovery.method.stretch', {
        weekDays: stretch.weekDays, minReadings: stretch.minReadings, minRun: stretch.minRun,
        band: stretch.band.toLocaleString(i18n.language),
      })}</p>
    </Card>
  )
}
