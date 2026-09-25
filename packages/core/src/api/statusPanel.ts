export const PANEL_DEFAULT_WINDOW_DAYS = 30
export const PHONE_QUIET_MS = 24 * 3_600_000

export type ConnectionKind = 'google' | 'phone'
export type ConnectionProblem = 'revoked' | 'credentials_unreadable' | 'sync_failed' | 'phone_quiet'

/**
 * A known app's default name, as `name` was built from it. Structurally the DefaultName in
 * sourceNames.ts, restated rather than imported because this module is import-free (see
 * status-panel-subpath.test.ts); `key` is widened to string for the same reason, and the web reads
 * it through the `sourceNames.default.<key>` catalogue entries either way.
 */
export interface StatusDefaultName { key: string, since: string | null, tag: string | null }

export interface StatusDevice {
  sourceId: string
  /** The English name every non-web reader gets: alias, known-app default, display name, id. */
  name: string
  /**
   * Set when `name` is a known app's default, so the panel can say it in the reader's language.
   * composeStatus always sets it; optional because the web reads this type too, and the demo's
   * captured /api/status predates the field until it is next regenerated - absent reads as null.
   */
  defaultName?: StatusDefaultName | null
  lastReportedDate: string | null
  stale: boolean
  /** Whether the person chose it (true/false) or it follows the default (null). */
  choice: boolean | null
  /**
   * For a stale device, the metrics it reported routinely in its last active week
   * (sourceCadence.ts's `routineMetrics`): what the reader stopped getting when it went quiet.
   * Catalogue keys, named for the reader by the web. Empty for every device that is not stale.
   *
   * Here because the panel is now the one place a quiet source is announced. The cards used to
   * carry a warning triangle each and every range page a "stopped in this range" line, which said
   * the same thing up to a dozen times a page; the panel says it once, and this list is what those
   * per-card warnings told the reader that a device row alone did not - which charts it affects.
   */
  metrics: string[]
}

/**
 * One data type whose sync is failing for this person, as sync_state records it: the same set
 * SyncStateStore.freshnessFor counts as `failing` (a type this person syncs whose
 * consecutiveFailures is above zero). `lastError` is stored raw - usually a HaelanError's message,
 * `[kind] detail`, cut at 500 characters by recordFailure - and is left raw here: turning it into
 * something a reader can follow is a question about the reader's language, so the web does it.
 */
export interface StatusFailure {
  dataType: string
  lastError: string | null
  lastErrorAtMs: number | null
}

export interface StatusConnection {
  kind: ConnectionKind
  lastDeliveryAtMs: number | null
  problem: ConnectionProblem | null
  devices: StatusDevice[]          // visible devices only, most recent first
  /**
   * The Google connection's failing data types, newest error first; an empty array when none
   * fail. Absent on the phone, whose uploads are not synced per data type and so have nothing in
   * sync_state to report.
   *
   * Optional in the type rather than required because the demo answers /api/status from a
   * capture, and a capture recorded before this field existed carries none: the panel must read an
   * absent list as "nothing to name", not fall over on it.
   *
   * Here because "Part of the last sync failed" on its own told the reader something went wrong
   * and nothing about what: the per-type failures were on disk all along, counted by freshnessFor
   * for the members list and never shown to the person they belong to.
   */
  failures?: StatusFailure[]
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
  activity: ReadonlyArray<{
    sourceId: string, lastReportedDate: string | null, status: 'reporting' | 'stale' | 'unjudged',
    continuedElsewhere: boolean, routineMetrics: readonly string[],
  }>
  names: ReadonlyMap<string, string>
  /** Known-app defaults by source id, from NamedSource.defaultName. Absent means none. */
  defaultNames?: ReadonlyMap<string, StatusDefaultName | null>
  choices: ReadonlyMap<string, boolean>
  /** This person's failing data types (SyncStateStore.failuresFor), in any order. */
  syncFailures: ReadonlyArray<StatusFailure>
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
    // A source that continued reporting under a new source id (renamed/replaced device) isn't
    // stale from the person's point of view: something is still reporting, just elsewhere.
    const stale = seen.status === 'stale' && !seen.continuedElsewhere
    const device: StatusDevice = {
      sourceId: seen.sourceId,
      name: input.names.get(seen.sourceId) ?? seen.sourceId,
      defaultName: input.defaultNames?.get(seen.sourceId) ?? null,
      lastReportedDate: seen.lastReportedDate,
      stale,
      choice,
      // Gated on `stale` here rather than trusted from the input: a renamed watch has a routine
      // list too (it is what continuedElsewhere was judged over), and printing it beside a row
      // that is not marked quiet would read as a list of what that device still sends.
      metrics: stale ? [...seen.routineMetrics] : [],
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
    // Newest error first, because the one that failed last is the likeliest to still be failing
    // on the next run and the likeliest to be what the reader just saw go wrong. A failure with
    // no timestamp sorts last - "newest" cannot be claimed for it - and ties fall to the id so the
    // list does not shuffle between polls. Copied before sorting: the input is the caller's.
    const failures = input.syncFailures.map((f) => ({ ...f })).sort((a, b) =>
      (b.lastErrorAtMs ?? Number.NEGATIVE_INFINITY) - (a.lastErrorAtMs ?? Number.NEGATIVE_INFINITY)
      || a.dataType.localeCompare(b.dataType))
    connections.push({ kind: 'google', lastDeliveryAtMs: input.run.lastFinishedAtMs, problem, devices: google, failures })
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
