import type { SyncStatus } from './api.js'

const DAY_MS = 86_400_000

// How far back this type has walked, as a fraction of the horizon it is walking to. A cursor
// still null after a run means it has not started rather than that it is at zero, and those
// read differently to somebody watching a bar.
function reached(cursorMs: number | null, horizonDays: number, nowMs: number): number | null {
  if (cursorMs === null) return null
  const walked = (nowMs - cursorMs) / DAY_MS
  return Math.max(0, Math.min(1, walked / horizonDays))
}

export function BackfillStep({ status, nowMs }: { status: SyncStatus, nowMs?: number }) {
  const now = nowMs ?? status.startedAtMs ?? status.lastFinishedAtMs ?? 0
  const finished = status.backfill.filter((row) => row.complete).length

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
    </section>
  )
}
