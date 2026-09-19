/**
 * The console tool for the one thing the app itself cannot offer: getting back into an account
 * whose password is gone. There is no reset link and no reset route, because an instance with no
 * mail server and no second factor has nothing to prove a request came from the person it names.
 * Physical access to the machine running the container is that proof, and this is what it buys.
 *
 *   node --experimental-strip-types apps/server/src/admin.ts list
 *   docker exec -it haelan node --experimental-strip-types apps/server/src/admin.ts passwd robin
 *
 * It lives beside the server rather than in `scripts/` because of what the Dockerfile copies:
 * `packages/core/src` and `apps/server/src` reach the runtime image and `scripts/` does not. A
 * recovery tool that exists only in a checkout is missing from the one place it is needed, which
 * is a homelab container at the moment somebody is locked out of it.
 *
 * No password is ever an argument. `passwd robin hunter2` would sit in shell history and be
 * readable in `ps` by every user on the machine, so the new password is asked for on stdin and
 * never echoed.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
  AccountStore, ConfigError, DATABASE_FILENAME, EventStore, HaelanError, McpTokenStore, PeopleStore,
  closeDatabase, localDateInZone, openDatabase, startOfLocalDay,
} from '@haelan/core'
import type { Database } from '@haelan/core'
import { RECOVERY_HARVEST_EVENT_KIND } from '@haelan/core/recovery-index'
import { readConfig } from './config.ts'

const USAGE = `usage: node --experimental-strip-types apps/server/src/admin.ts <command>

  list                        every account, with whether it is an admin, disabled or locked
  passwd <username>           set a new password, asked for twice on stdin and never echoed
  unlock <username>           clear a lockout for somebody who knows their password
  harvest-recovery <username> read "YYYY-MM-DD <score>" lines on stdin and store them as that
                               person's Google Health recovery scores, typed by hand off the
                               app's own history screens - there is no API for this number

The data directory comes from HAELAN_DATA_DIR, the same as the server reads it.`

// Two failure modes worth a sentence each, because the stack trace they replace says neither.
const BUSY_MESSAGE = `the database is busy, so nothing was changed.
A rebuild wraps one person's entire re-derivation in a single transaction and holds SQLite's only
write lock for as long as that takes, which on a large instance is ten minutes or more. An upgrade
that changed how data is derived starts one on boot. Wait for it to finish and run this again.`

export interface AdminDeps {
  out: (line: string) => void
  err: (line: string) => void
  /** Asks for one line and returns it without it ever reaching the terminal. */
  readSecret: (label: string) => Promise<string>
  /** Reads stdin to its end and returns everything written to it, unmasked. */
  readStdin: () => Promise<string>
  now: () => number
  env: NodeJS.ProcessEnv
}

/**
 * The `kind` harvested Google Health recovery scores are stored under. Re-exported from
 * `@haelan/core/recovery-index` rather than declared here: `apps/web/src/data/dayAnnotations.ts`
 * needs the same string, to keep a harvested score from marking every chart on every page (see
 * RECOVERY_HARVEST_EVENT_KIND's own comment).
 */
export const HARVEST_KIND = RECOVERY_HARVEST_EVENT_KIND

export interface HarvestRow {
  localDate: string
  score: number
}

export type HarvestParse =
  | { ok: true, rows: HarvestRow[] }
  | { ok: false, message: string }

/**
 * Parses `YYYY-MM-DD <score>` lines.
 *
 * Rejects the whole batch on the first bad line rather than skipping it. A harvest is typed by
 * hand off an app's history tabs, and silently dropping a misread line would leave somebody
 * believing they had logged a day they had not.
 */
export function parseHarvestLines(lines: readonly string[]): HarvestParse {
  const rows: HarvestRow[] = []
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '') continue
    const match = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,3})$/.exec(line)
    const score = match === null ? NaN : Number(match[2])
    if (match === null || !Number.isInteger(score) || score < 0 || score > 100) {
      return { ok: false, message: `line ${index + 1} is not "YYYY-MM-DD <score>": ${line}` }
    }
    rows.push({ localDate: match[1] as string, score })
  }
  return { ok: true, rows }
}

type Command =
  | { name: 'list' }
  | { name: 'passwd', username: string }
  | { name: 'unlock', username: string }
  | { name: 'harvest-recovery', username: string }

type ParseResult = { ok: true, command: Command } | { ok: false, message: string }

function parse(argv: readonly string[]): ParseResult {
  const [name, username, ...rest] = argv
  if (name === 'list') {
    return argv.length === 1 ? { ok: true, command: { name } } : { ok: false, message: 'list takes no arguments' }
  }
  if (name === 'harvest-recovery') {
    if (username === undefined) return { ok: false, message: 'usage: harvest-recovery <username>' }
    if (rest.length > 0) return { ok: false, message: 'harvest-recovery takes one username and nothing else' }
    return { ok: true, command: { name, username } }
  }
  if (name !== 'passwd' && name !== 'unlock') return { ok: false, message: USAGE }
  if (username === undefined) return { ok: false, message: `usage: ${name} <username>` }
  // Refused rather than ignored. A trailing argument on `passwd` is almost certainly the password,
  // and quietly dropping it would leave somebody believing a command worked that has just written
  // their new password into shell history.
  if (rest.length > 0) {
    return {
      ok: false,
      message: `${name} takes one username and nothing else. A password given as an argument is in `
        + 'your shell history and visible in ps to every user on this machine, so this tool asks '
        + 'for it on stdin instead.',
    }
  }
  return { ok: true, command: { name, username } }
}

export async function runAdmin(argv: readonly string[], deps: AdminDeps): Promise<number> {
  const parsed = parse(argv)
  if (!parsed.ok) {
    deps.err(parsed.message)
    return 1
  }

  const dataDir = resolve(readConfig(deps.env).dataDir)
  const dbPath = join(dataDir, DATABASE_FILENAME)
  // Asked before openDatabase, which creates what it cannot find: against a mistyped directory
  // that would leave an empty database behind and then fail on a missing table, which reads as a
  // corrupt instance rather than as the wrong path.
  if (!existsSync(dbPath)) {
    deps.err(`no haelan database at ${dbPath}.\n`
      + 'Set HAELAN_DATA_DIR to the directory this instance was started with.')
    return 1
  }

  // openDatabase rather than openHaelan: this tool reads and writes one table that has existed
  // since the first migration, and an operator command must not migrate a file a running server
  // owns, nor write itself an instance.key beside one.
  let db: Database | null = null
  try {
    db = openDatabase(dataDir)
    return await execute(
      parsed.command, new AccountStore(db), new McpTokenStore(db), new PeopleStore(db), new EventStore(db), deps,
    )
  } catch (err) {
    if (isBusy(err)) {
      deps.err(BUSY_MESSAGE)
      return 1
    }
    if (err instanceof HaelanError) {
      deps.err(err.detail)
      return 1
    }
    if (db === null) {
      deps.err(`could not open ${dbPath}: ${messageOf(err)}`)
      return 1
    }
    throw err
  } finally {
    if (db !== null) closeDatabase(db)
  }
}

async function execute(
  command: Command, accounts: AccountStore, mcpTokens: McpTokenStore, people: PeopleStore, events: EventStore,
  deps: AdminDeps,
): Promise<number> {
  if (command.name === 'list') {
    listAccounts(accounts, deps)
    return 0
  }
  if (command.name === 'unlock') {
    accounts.clearLockout(command.username)
    deps.out(`lockout cleared for ${command.username}. Their existing password still works.`)
    return 0
  }
  if (command.name === 'harvest-recovery') {
    return await harvestRecovery(command.username, accounts, people, events, deps)
  }

  const password = await deps.readSecret('new password')
  const again = await deps.readSecret('repeat it')
  if (password !== again) {
    deps.err('the two entries did not match, so nothing was changed.')
    return 1
  }
  const accountId = await accounts.setPassword(command.username, password)
  // This console tool is the door for the case where even the admin route in members.ts is out
  // of reach - somebody locked out at the console, or with nobody else to ask - but the reason to
  // end this account's MCP tokens is the same one either route acts on: a password set here is
  // set by someone who does not trust whatever currently proves this account's identity, and an
  // agent credential minted under the old proof must not survive the person deciding that.
  mcpTokens.revokeAllForAccount(accountId, deps.now())
  deps.out(`password set for ${command.username}, and any lockout cleared.`)
  return 0
}

/**
 * Stores one Google Health recovery score per parsed line, as an `events` row under
 * `HARVEST_KIND`.
 *
 * A date that already carries a harvested score is replaced, not duplicated. The typical way this
 * command runs twice for the same person is a typo: sixty scores typed by hand off the app's
 * history screens, one misread, corrected and re-run. Two rows for one day would silently double
 * count in any aggregate that ever reads this kind, which is worse than the alternative of quietly
 * overwriting - so long as the operator can see which happened, which is what `written` and
 * `replaced` in the final line are for. Refusing outright was the other option; it would have made
 * the ordinary correction path a manual SQL delete for a tool whose whole reason to exist is that
 * a person should not have to touch the database directly.
 */
async function harvestRecovery(
  username: string, accounts: AccountStore, people: PeopleStore, events: EventStore, deps: AdminDeps,
): Promise<number> {
  // Same lookup mcp.ts's --person flag uses to turn a username into a personId: AccountStore has
  // no getByUsername, and accounts.list() is already the public surface that carries personId
  // alongside username.
  const normalised = username.trim().toLowerCase()
  const account = accounts.list().find((row) => row.username === normalised)
  if (account === undefined) {
    deps.err(`no account named ${normalised}`)
    return 1
  }
  // accounts.personId is a foreign key into people, so this is unreachable in practice - kept as
  // a named failure rather than a thrown TypeError because this is the console tool for when
  // things have already gone wrong, and a stack trace here would replace a sentence that says
  // exactly what is.
  const person = people.get(account.personId)
  if (person === null) {
    deps.err(`account ${normalised} has no person record`)
    return 1
  }

  const raw = await deps.readStdin()
  const parsed = parseHarvestLines(raw.split('\n'))
  if (!parsed.ok) {
    deps.err(parsed.message)
    return 1
  }
  if (parsed.rows.length === 0) {
    deps.out('no lines to harvest.')
    return 0
  }

  let replaced = 0
  for (const row of parsed.rows) {
    // Only a prior harvest is replaced, never another kind of event that happens to land on the
    // same day: illness, travel and the rest are a different person's record of a different
    // thing, and this command has no business touching them.
    const already = events.listFor(person.id, row.localDate, row.localDate)
      .filter((event) => event.kind === HARVEST_KIND)
    for (const dupe of already) events.remove({ personId: person.id, id: dupe.id })
    if (already.length > 0) replaced += 1

    const { startedAtMs, offsetMinutes } = localMidnight(row.localDate, person.timezone)
    events.add({
      personId: person.id,
      kind: HARVEST_KIND,
      startedAtMs,
      startedAtOffsetMinutes: offsetMinutes,
      value: row.score,
    })
  }

  const written = parsed.rows.length
  const fresh = written - replaced
  deps.out(`${written} recovery score${written === 1 ? '' : 's'} written for ${normalised}: `
    + `${fresh} new, ${replaced} replaced.`)
  return 0
}

const DAY_MS = 86_400_000

/**
 * The UTC instant of local midnight opening `localDate` in `timeZone`, and the offset in force at
 * that instant, in minutes.
 *
 * `startOfLocalDay` (exported from `sync/windows.ts`, the same module `dayWindows` uses it in)
 * already walks back an hour at a time and bisects to the minute to find this - because a DST day
 * is 23 or 25 hours long and a fixed 24 hour step would drift - but it seeds from an instant
 * already known to fall inside the target local day, not from a date string. The seed here is UTC
 * midnight of `localDate`, nudged forward a day when that seed lands in the previous local day -
 * the one case it can, for any real offset (UTC-12 to UTC+14, the same range `widenedUtcWindow`
 * guards elsewhere): a zone behind UTC reads UTC midnight as still being the previous local day,
 * and a zone ahead of UTC never does, because no zone is a full day ahead.
 */
function localMidnight(localDate: string, timeZone: string): { startedAtMs: number, offsetMinutes: number } {
  let seed = Date.parse(`${localDate}T00:00:00Z`)
  if (localDateInZone(seed, timeZone) !== localDate) seed += DAY_MS
  const startedAtMs = startOfLocalDay(seed, timeZone)

  const utcMidnight = Date.parse(`${localDate}T00:00:00Z`)
  // Local wall clock at startedAtMs is midnight of localDate; that wall clock, read as if it were
  // itself UTC, is utcMidnight. So utcMidnight = startedAtMs + offsetMinutes * 60_000 - the same
  // relationship derive/localDay.ts's localDateOf builds forward from an offset; this solves it
  // backwards from two already-known instants instead of asking the timezone database twice.
  const offsetMinutes = Math.round((utcMidnight - startedAtMs) / 60_000)
  return { startedAtMs, offsetMinutes }
}

interface Cells { username: string, admin: string, disabled: string, locked: string }

const COLUMNS = ['username', 'admin', 'disabled', 'locked'] as const
const HEADINGS: Cells = { username: 'username', admin: 'admin', disabled: 'disabled', locked: 'locked' }

function listAccounts(accounts: AccountStore, deps: AdminDeps): void {
  const rows = accounts.list()
  if (rows.length === 0) {
    deps.out('no accounts. This instance has not been through the setup wizard yet.')
    return
  }
  const nowMs = deps.now()
  const table = [HEADINGS, ...rows.map((row): Cells => ({
    username: row.username,
    admin: row.isAdmin ? 'yes' : 'no',
    disabled: row.disabledAtMs === null ? 'no' : `since ${iso(row.disabledAtMs)}`,
    locked: lockCell(row.lockedUntilMs, nowMs),
  }))]
  const width = (column: keyof Cells) => Math.max(...table.map((row) => row[column].length))
  for (const row of table) {
    deps.out(COLUMNS.map((column) => row[column].padEnd(width(column))).join('  ').trimEnd())
  }
}

function lockCell(lockedUntilMs: number | null, nowMs: number): string {
  if (lockedUntilMs === null) return 'no'
  // A lapsed lock is shown rather than rounded down to 'no'. The question at the console is
  // usually whether an account was being guessed at, and that outlives the fifteen minutes the
  // lock itself lasts.
  return lockedUntilMs > nowMs ? `until ${iso(lockedUntilMs)}` : `lapsed ${iso(lockedUntilMs)}`
}

const iso = (ms: number): string => new Date(ms).toISOString()

// SQLITE_BUSY, SQLITE_BUSY_SNAPSHOT and SQLITE_BUSY_RECOVERY all mean the same thing to an
// operator, and better-sqlite3 puts each of them on `code` verbatim.
function isBusy(err: unknown): boolean {
  return err instanceof Error && 'code' in err
    && typeof err.code === 'string' && err.code.startsWith('SQLITE_BUSY')
}

const messageOf = (err: unknown): string => err instanceof Error ? err.message : String(err)

/**
 * Asks for lines on stdin without echoing them.
 *
 * readline is pointed at a sink that discards every byte, and each prompt is written to stdout
 * separately. Line editing still works, and nothing the typist enters reaches the terminal or the
 * scrollback that a `docker exec -it` session leaves behind on the host.
 *
 * Lines come from the interface's async iterator rather than from `question`, because `question`
 * only hears the line that arrives while it is waiting. A terminal delivers a keystroke at a time
 * so nothing arrives early there, but a pipe hands readline both lines in one chunk: the first
 * answers `new password` and the second is emitted to nobody and lost, and `repeat it` then waits
 * for input that has already gone by. Measured, twice: the process hung and exited 13 on an
 * unsettled await. The iterator queues lines instead, so the same code serves `docker exec -it`
 * and a test that pipes two lines in.
 *
 * Built lazily because an open interface holds the event loop. Creating one up front would leave
 * `list` printing its table and then waiting forever on input nobody is going to type.
 */
function secretReader(): { read: (label: string) => Promise<string>, close: () => void } {
  const discard = new Writable({ write(_chunk, _encoding, done) { done() } })
  let rl: ReturnType<typeof createInterface> | null = null
  let lines: AsyncIterator<string> | null = null
  return {
    read: async (label) => {
      if (lines === null) {
        rl = createInterface({ input: process.stdin, output: discard, terminal: true })
        lines = rl[Symbol.asyncIterator]()
      }
      process.stdout.write(`${label}: `)
      const line = await lines.next()
      process.stdout.write('\n')
      if (line.done === true) throw new ConfigError('stdin ended before a password was entered')
      return line.value
    },
    close: () => { rl?.close() },
  }
}

/**
 * Everything written to `process.stdin` before it ends, as one string.
 *
 * A harvest is piped in from a file or typed and closed with EOF, not answered line by line like
 * `secretReader`'s prompts - there is nothing to prompt for, and nothing to hide - so this reads
 * the whole stream rather than negotiating one line at a time.
 */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

// Not `import.meta.main`: it landed in Node 22.18 and this package's engines floor is >=22.14,
// where it is `undefined` and this gate would be silently false. That matters most here - this is
// the tool somebody runs when they are locked out, and it would print nothing and exit 0. Keep the
// path comparison until the floor moves past 22.18; `test/engine-floor.test.ts` holds that.
const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  const secrets = secretReader()
  try {
    process.exitCode = await runAdmin(process.argv.slice(2), {
      out: (line) => { process.stdout.write(`${line}\n`) },
      err: (line) => { process.stderr.write(`${line}\n`) },
      readSecret: secrets.read,
      readStdin: readAllStdin,
      now: Date.now,
      env: process.env,
    })
  } finally {
    secrets.close()
  }
}
