export const PANEL_DEFAULT_WINDOW_DAYS = 30
export const PHONE_QUIET_MS = 24 * 3_600_000

export type ConnectionKind = 'google' | 'phone'
export type ConnectionProblem = 'revoked' | 'credentials_unreadable' | 'sync_failed' | 'phone_quiet'

export interface StatusDevice {
  sourceId: string
  name: string
  lastReportedDate: string | null
  stale: boolean
  /** Whether the person chose it (true/false) or it follows the default (null). */
  choice: boolean | null
}

export interface StatusConnection {
  kind: ConnectionKind
  lastDeliveryAtMs: number | null
  problem: ConnectionProblem | null
  devices: StatusDevice[]          // visible devices only, most recent first
}

export interface StatusSync {
  running: boolean
  lastFinishedAtMs: number | null
  lastRowsWritten: number | null
  lastFailed: number | null
  cooldownRemainingMs: number
}

export interface StatusPanel {
  connections: StatusConnection[]
  /** Null when the person has no Google connection at all: nothing to sync by hand. */
  sync: StatusSync | null
  /** Visible rows in a problem state: connections with a problem plus stale visible devices. */
  problems: number
  hiddenDevices: number
}

export interface StatusInput {
  today: string                     // person's local date, YYYY-MM-DD
  nowMs: number
  google: { state: 'none' | 'connected' | 'revoked' | 'credentials_unreadable' }
  run: StatusSync
  phone: { lastUploadAtMs: number | null, sourceIds: ReadonlySet<string> }
  activity: ReadonlyArray<{ sourceId: string, lastReportedDate: string | null, status: 'reporting' | 'stale' | 'unjudged', continuedElsewhere: boolean }>
  names: ReadonlyMap<string, string>
  choices: ReadonlyMap<string, boolean>
}

/**
 * Whether a source is shown by default, absent an explicit choice: it reported within the
 * last PANEL_DEFAULT_WINDOW_DAYS days, counting today's own date as day zero (inclusive).
 * A null lastReportedDate (never seen) never earns the default.
 */
export function shownByDefault(lastReportedDate: string | null, today: string): boolean {
  if (lastReportedDate === null) return false
  const windowStart = addDays(today, -PANEL_DEFAULT_WINDOW_DAYS)
  return lastReportedDate >= windowStart
}

/**
 * The status panel's answer for one person, composed from facts the server already holds.
 * Pure, so every household shape is a unit test rather than a server fixture.
 *
 * Attribution: nothing in the database records which connection a source's data came through,
 * but a companion upload's archive row names the source it resolved to (requestParams.dataSource),
 * so the phone's sources are exactly that set and every other source came from Google. A device
 * that reached Haelan both ways normally has two source ids (a Fitbit id and a Health Connect id),
 * so it appears once under each; one whose ids collapsed appears under the phone only.
 */
export function composeStatus(input: StatusInput): StatusPanel {
  let hiddenDevices = 0
  const google: StatusDevice[] = []
  const phone: StatusDevice[] = []

  for (const seen of input.activity) {
    // A household whose only live connection is the phone can still have old archive rows
    // attributed to Google (from a connection that was later removed). Those devices belong
    // to a connection this panel no longer shows at all, so they are dropped silently rather
    // than counted hidden — "hidden" means "visible connection, invisible device".
    if (input.google.state === 'none' && !input.phone.sourceIds.has(seen.sourceId)) continue

    const choice = input.choices.get(seen.sourceId) ?? null
    const byDefault = shownByDefault(seen.lastReportedDate, input.today)
    if (!(choice ?? byDefault)) { hiddenDevices += 1; continue }
    const device: StatusDevice = {
      sourceId: seen.sourceId,
      name: input.names.get(seen.sourceId) ?? seen.sourceId,
      lastReportedDate: seen.lastReportedDate,
      // A source that continued reporting under a new source id (renamed/replaced device) isn't
      // stale from the person's point of view: something is still reporting, just elsewhere.
      stale: seen.status === 'stale' && !seen.continuedElsewhere,
      choice,
    }
    ;(input.phone.sourceIds.has(seen.sourceId) ? phone : google).push(device)
  }

  const newestFirst = (a: StatusDevice, b: StatusDevice) =>
    (b.lastReportedDate ?? '').localeCompare(a.lastReportedDate ?? '') || a.name.localeCompare(b.name)
  google.sort(newestFirst)
  phone.sort(newestFirst)

  const connections: StatusConnection[] = []
  if (input.google.state !== 'none') {
    const problem: ConnectionProblem | null = input.google.state === 'revoked' ? 'revoked'
      : input.google.state === 'credentials_unreadable' ? 'credentials_unreadable'
        : (input.run.lastFailed ?? 0) > 0 ? 'sync_failed' : null
    connections.push({ kind: 'google', lastDeliveryAtMs: input.run.lastFinishedAtMs, problem, devices: google })
  }
  if (input.phone.lastUploadAtMs !== null) {
    const quiet = input.nowMs - input.phone.lastUploadAtMs > PHONE_QUIET_MS
    connections.push({ kind: 'phone', lastDeliveryAtMs: input.phone.lastUploadAtMs, problem: quiet ? 'phone_quiet' : null, devices: phone })
  }

  const problems = connections.filter((c) => c.problem !== null).length
    + connections.reduce((n, c) => n + c.devices.filter((d) => d.stale).length, 0)

  return {
    connections,
    sync: input.google.state === 'connected' ? input.run : null,
    problems,
    hiddenDevices,
  }
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}
