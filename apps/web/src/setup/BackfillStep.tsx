import type { SyncStatus } from './api.js'

const DAY_MS = 86_400_000

// Measured on 29 days of one real person's data and projected to each horizon: intraday types
// are capped at 90 days, which is why five years costs barely more than one. The numbers are
// shown because nobody can derive them from the page.
const HORIZON_CHOICES = [
  { days: 365, label: '1 year', disk: '0.17 GB' },
  { days: 730, label: '2 years', disk: '0.18 GB' },
  { days: 1825, label: '5 years', disk: '0.18 GB' },
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
  const now = nowMs ?? status.startedAtMs ?? status.lastFinishedAtMs ?? 0
  const finished = status.backfill.filter((row) => row.complete).length
  // The intraday cap is a server fact, not a constant this bundle can import (apps/web does not
  // depend on @haelan/core). The rows already say it: intraday types are the ones walking to
  // something shorter than the operator's chosen horizon, so the smallest horizonDays present is
  // the cap. An empty list can't happen through this screen today — a session only exists after
  // account creation, which creates the person before this screen is reachable — but Math.min()
  // of nothing is Infinity, and "the last Infinity days" would be a worse failure than falling
  // back to the number production uses everywhere else, so the fallback stays even though the
  // branch is currently unreachable.
  const intradayDays = status.backfill.length > 0
    ? Math.min(...status.backfill.map((row) => row.horizonDays))
    : 90

  return (
    <section className="setup-step">
      <h1>Filling in your history</h1>
      <p>
        haelan is walking backwards from today, most recent first, so the days you are most
        likely to look at arrive first. You can leave this page. It resumes where it stopped if
        the instance restarts, and the trailing week is fetched every run regardless.
      </p>

      <p className="setup-note">
        {status.running
          ? `Running. ${finished} of ${status.backfill.length} data types have reached their horizon.`
          : `Idle. ${finished} of ${status.backfill.length} data types have reached their horizon.`}
        {' '}Heart rate walks a shorter horizon than everything else on purpose: it is roughly
        95 percent of all rows, and a day of it is three orders of magnitude denser than a day
        of weight.
      </p>

      <ul className="setup-progress">
        {status.backfill.map((row) => {
          const fraction = reached(row.cursorMs, row.horizonDays, now)
          return (
            <li key={row.dataType} data-complete={String(row.complete)}>
              <span className="progress-type">{row.dataType}</span>
              <span className="field-hint">{row.horizonDays} days back</span>
              <span className="progress-state">
                {row.complete
                  ? 'complete'
                  : fraction === null
                    ? 'not started'
                    : `${Math.round(fraction * 100)}%`}
              </span>
            </li>
          )
        })}
      </ul>

      <div className="setup-horizon">
        <h2>How far back should haelan go?</h2>
        {failure && <p className="form-error" role="alert">{failure}</p>}
        <p className="setup-note">
          Minute level detail is kept for the last {intradayDays} days whichever you pick, because
          it is most of the size. This chooses how far back the daily history goes. Changing it
          later re-aims the walk and never deletes anything already fetched.
        </p>
        <ul>
          {HORIZON_CHOICES.map((choice) => (
            <li key={choice.days} data-chosen={String(choice.days === status.userHorizonDays)}>
              <button type="button" onClick={() => onHorizonChange(choice.days)}>
                {choice.label}
              </button>
              <span className="field-hint">{choice.disk}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
