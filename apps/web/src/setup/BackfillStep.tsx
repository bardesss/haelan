import { useTranslation } from '../i18n/index.js'
import { dataTypeName } from '../data/dataTypeName.js'
import type { SyncStatus } from './api.js'

const DAY_MS = 86_400_000

// Measured on 29 days of one real person's data and projected to each horizon: intraday types
// are capped at 365 days, which is why five years costs barely more than one. The numbers are
// shown because nobody can derive them from the page.
const HORIZON_CHOICES = [
  { days: 365, labelKey: 'setup.backfill.horizon.oneYear', disk: '1.05 GB' },
  { days: 730, labelKey: 'setup.backfill.horizon.twoYears', disk: '1.05 GB' },
  { days: 1825, labelKey: 'setup.backfill.horizon.fiveYears', disk: '1.06 GB' },
]

// How far back this type has walked, as a fraction of the horizon it is walking to. A cursor
// still null after a run means it has not started rather than that it is at zero, and those
// read differently to somebody watching a bar.
function reached(cursorMs: number | null, horizonDays: number, nowMs: number): number | null {
  if (cursorMs === null) return null
  const walked = (nowMs - cursorMs) / DAY_MS
  return Math.max(0, Math.min(1, walked / horizonDays))
}

export function BackfillStep({ status, nowMs, onHorizonChange, failure }: {
  status: SyncStatus
  nowMs?: number
  onHorizonChange: (days: number) => void
  failure?: string | null
}) {
  const { t } = useTranslation()
  const now = nowMs ?? status.startedAtMs ?? status.lastFinishedAtMs ?? 0
  const finished = status.backfill.filter((row) => row.complete).length
  // The intraday cap is a server fact, not a constant this bundle can import (apps/web does not
  // depend on @haelan/core). The rows already say it: intraday types are the ones walking to
  // something shorter than the operator's chosen horizon, so the smallest horizonDays present is
  // the cap. An empty list cannot happen through this screen today, because a session only
  // exists after account creation and that creates the person before this screen is
  // reachable. The fallback stays anyway: Math.min() of nothing is Infinity, and "the last
  // Infinity days" would be a worse failure than falling back to the number production uses
  // everywhere else.
  const intradayDays = status.backfill.length > 0
    ? Math.min(...status.backfill.map((row) => row.horizonDays))
    : 365

  return (
    <section className="setup-step">
      <h1>{t('setup.backfill.title')}</h1>
      <p>{t('setup.backfill.intro')}</p>

      <p className="setup-note">
        {status.running
          ? t('setup.backfill.runningNote', { finished, total: status.backfill.length })
          : t('setup.backfill.idleNote', { finished, total: status.backfill.length })}
      </p>

      <ul className="setup-progress">
        {status.backfill.map((row) => {
          const fraction = reached(row.cursorMs, row.horizonDays, now)
          return (
            <li key={row.dataType} data-complete={String(row.complete)}>
              <span className="progress-type">{dataTypeName(t, row.dataType)}</span>
              <span className="field-hint">{t('setup.backfill.daysBack', { days: row.horizonDays })}</span>
              <span className="progress-state">
                {row.complete
                  ? t('setup.backfill.complete')
                  : fraction === null
                    ? t('setup.backfill.notStarted')
                    : `${Math.round(fraction * 100)}%`}
              </span>
            </li>
          )
        })}
      </ul>

      <div className="setup-horizon">
        <h2>{t('setup.backfill.horizonQuestion')}</h2>
        {failure && <p className="form-error" role="alert">{failure}</p>}
        <p className="setup-note">{t('setup.backfill.horizonNote', { intradayDays })}</p>
        <ul>
          {HORIZON_CHOICES.map((choice) => (
            <li key={choice.days} data-chosen={String(choice.days === status.userHorizonDays)}>
              <button
                type="button"
                aria-pressed={choice.days === status.userHorizonDays}
                onClick={() => onHorizonChange(choice.days)}
              >
                {t(choice.labelKey)}
              </button>
              <span className="field-hint">{choice.disk}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
