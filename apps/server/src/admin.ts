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
  AccountStore, ConfigError, DATABASE_FILENAME, HaelanError, closeDatabase, openDatabase,
} from '@haelan/core'
import type { Database } from '@haelan/core'
import { readConfig } from './config.ts'

const USAGE = `usage: node --experimental-strip-types apps/server/src/admin.ts <command>

  list               every account, with whether it is an admin, disabled or locked
  passwd <username>  set a new password, asked for twice on stdin and never echoed
  unlock <username>  clear a lockout for somebody who knows their password

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
  now: () => number
  env: NodeJS.ProcessEnv
}

type Command =
  | { name: 'list' }
  | { name: 'passwd', username: string }
  | { name: 'unlock', username: string }

type ParseResult = { ok: true, command: Command } | { ok: false, message: string }

function parse(argv: readonly string[]): ParseResult {
  const [name, username, ...rest] = argv
  if (name === 'list') {
    return argv.length === 1 ? { ok: true, command: { name } } : { ok: false, message: 'list takes no arguments' }
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
    return await execute(parsed.command, new AccountStore(db), deps)
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

async function execute(command: Command, accounts: AccountStore, deps: AdminDeps): Promise<number> {
  if (command.name === 'list') {
    listAccounts(accounts, deps)
    return 0
  }
  if (command.name === 'unlock') {
    accounts.clearLockout(command.username)
    deps.out(`lockout cleared for ${command.username}. Their existing password still works.`)
    return 0
  }

  const password = await deps.readSecret('new password')
  const again = await deps.readSecret('repeat it')
  if (password !== again) {
    deps.err('the two entries did not match, so nothing was changed.')
    return 1
  }
  await accounts.setPassword(command.username, password)
  deps.out(`password set for ${command.username}, and any lockout cleared.`)
  return 0
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

// Not `import.meta.main`: it landed in Node 22.18 and this package's engines floor is >=22.13,
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
      now: Date.now,
      env: process.env,
    })
  } finally {
    secrets.close()
  }
}
