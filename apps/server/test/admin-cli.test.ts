import { existsSync } from 'node:fs'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AccountStore, EventStore, McpTokenStore, createTestDatabase, seedPerson } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { HARVEST_KIND, parseHarvestLines, runAdmin } from '../src/admin.ts'
import type { AdminDeps } from '../src/admin.ts'

const CREATED_MS = 1000
const ATTEMPT_MS = 2000
// What ten failed logins at ATTEMPT_MS leave behind: the store locks for fifteen minutes.
const LOCKED_UNTIL_MS = ATTEMPT_MS + 15 * 60_000
const NOW_MS = ATTEMPT_MS + 60_000

const OLD_PASSWORD = 'correct horse battery staple'
const NEW_PASSWORD = 'a different long password'

let fixture: TestDatabase
let accounts: AccountStore

beforeEach(async () => {
  fixture = createTestDatabase()
  seedPerson(fixture.db, 'p1')
  accounts = new AccountStore(fixture.db)
  await accounts.create({
    id: 'a1', personId: 'p1', username: 'robin', password: OLD_PASSWORD, isAdmin: true, nowMs: CREATED_MS,
  })
})
// Closes the handle before removing the directory. The other order throws EPERM on Windows, and
// that error would replace whichever assertion actually failed.
afterEach(() => { fixture.cleanup() })

interface Capture { deps: AdminDeps, out: string[], err: string[] }

function capture(secrets: readonly string[], nowMs = NOW_MS, dir?: string, stdin = ''): Capture {
  const out: string[] = []
  const err: string[] = []
  const queued = [...secrets]
  return {
    out,
    err,
    deps: {
      out: (line) => { out.push(line) },
      err: (line) => { err.push(line) },
      readSecret: async () => {
        // Louder than returning an empty string: a command that asks more often than the test
        // expected is a change in behaviour, not a password of length zero.
        const next = queued.shift()
        if (next === undefined) throw new Error('asked for more passwords than the test queued')
        return next
      },
      readStdin: async () => stdin,
      now: () => nowMs,
      env: { HAELAN_DATA_DIR: dir ?? fixture.dir },
    },
  }
}

interface LockColumns { password_hash: string, failed_attempts: number, locked_until_ms: number | null }

const columns = (): LockColumns => fixture.db.$client
  .prepare('select password_hash, failed_attempts, locked_until_ms from accounts where id = ?')
  .get('a1') as LockColumns

interface EventColumns {
  kind: string
  started_at_ms: number
  started_at_offset_minutes: number
  value: number | null
}

const eventRows = (): EventColumns[] => fixture.db.$client
  .prepare(
    'select kind, started_at_ms, started_at_offset_minutes, value from events '
      + 'where person_id = ? order by started_at_ms',
  )
  .all('p1') as EventColumns[]

async function lockTheAccount(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await accounts.login({ username: 'robin', password: 'wrong', nowMs: ATTEMPT_MS })
  }
}

describe('admin passwd', () => {
  it('sets a password the new one logs in with and the old one no longer does', async () => {
    const run = capture([NEW_PASSWORD, NEW_PASSWORD])
    expect(await runAdmin(['passwd', 'robin'], run.deps)).toBe(0)
    expect(run.err).toEqual([])
    expect(run.out).toEqual(['password set for robin, and any lockout cleared.'])

    const withNew = await accounts.login({ username: 'robin', password: NEW_PASSWORD, nowMs: NOW_MS })
    expect(withNew).toEqual({
      ok: true,
      // lastLoginAtMs is this sign-in's own clock: the reset did not touch it, and signing in is
      // what stamps it.
      account: { id: 'a1', personId: 'p1', username: 'robin', isAdmin: true, disabledAtMs: null, lastLoginAtMs: NOW_MS },
    })
    const withOld = await accounts.login({ username: 'robin', password: OLD_PASSWORD, nowMs: NOW_MS })
    expect(withOld).toEqual({ ok: false, reason: 'bad_password' })
  })

  // Important 5 of the M4 review: nothing in the own-password-change route, the admin reset
  // route or this console tool used to touch mcp_tokens, so a member noticing a break-in and
  // changing their password had not ended the attacker's access. This is the console tool's half
  // of that fix.
  it('revokes every MCP token this account holds, so a compromised session cannot outlive the reset', async () => {
    const mcpTokens = new McpTokenStore(fixture.db)
    const { token } = mcpTokens.create({
      id: 't1', accountId: 'a1', label: 'a laptop agent', days: 90, nowMs: CREATED_MS,
    })
    expect(token.revokedAtMs).toBeNull()

    expect(await runAdmin(['passwd', 'robin'], capture([NEW_PASSWORD, NEW_PASSWORD]).deps)).toBe(0)

    const [reloaded] = new McpTokenStore(fixture.db).listForAccount('a1')
    // A stamp, not a delete: the row survives for the call log, only revoked rather than gone.
    expect(reloaded).toBeDefined()
    expect(reloaded!.id).toBe('t1')
    expect(reloaded!.revokedAtMs).not.toBeNull()
    expect(reloaded!.revokedReason).toBe('password_reset')
  })

  it('clears the lockout, so the account it just rescued is not locked when it is used', async () => {
    await lockTheAccount()
    const locked = columns()
    expect(locked.failed_attempts).toBe(10)
    expect(locked.locked_until_ms).toBe(LOCKED_UNTIL_MS)

    expect(await runAdmin(['passwd', 'robin'], capture([NEW_PASSWORD, NEW_PASSWORD]).deps)).toBe(0)

    const cleared = columns()
    expect(cleared.failed_attempts).toBe(0)
    expect(cleared.locked_until_ms).toBeNull()
    // The columns being right is half of it. The point of clearing them is that the person can
    // actually get in, which a lock still in force at NOW_MS would refuse before ever hashing.
    const signedIn = await accounts.login({ username: 'robin', password: NEW_PASSWORD, nowMs: NOW_MS })
    expect(signedIn.ok).toBe(true)
  })

  it('refuses a password under eight characters and leaves the old one working', async () => {
    const run = capture(['short7!', 'short7!'])
    expect(await runAdmin(['passwd', 'robin'], run.deps)).toBe(1)
    expect(run.out).toEqual([])
    expect(run.err).toEqual(['password must be at least 8 characters'])

    const stillOld = await accounts.login({ username: 'robin', password: OLD_PASSWORD, nowMs: NOW_MS })
    expect(stillOld.ok).toBe(true)
  })

  it('refuses two entries that do not match, without asking the store anything', async () => {
    const before = columns().password_hash
    const run = capture([NEW_PASSWORD, 'something else entirely'])
    expect(await runAdmin(['passwd', 'robin'], run.deps)).toBe(1)
    expect(run.err).toEqual(['the two entries did not match, so nothing was changed.'])
    expect(columns().password_hash).toBe(before)
  })

  it('names an account it cannot find rather than reporting success', async () => {
    const run = capture([NEW_PASSWORD, NEW_PASSWORD])
    expect(await runAdmin(['passwd', 'nobody'], run.deps)).toBe(1)
    expect(run.out).toEqual([])
    expect(run.err).toEqual(['no account named nobody'])
  })

  it('refuses a password given as an argument, where a shell history would keep it', async () => {
    const before = columns().password_hash
    const run = capture([])
    expect(await runAdmin(['passwd', 'robin', 'hunter2'], run.deps)).toBe(1)
    expect(run.err).toHaveLength(1)
    expect(run.err[0]).toContain('shell history')
    // capture([]) queues nothing, so readSecret throwing is what proves it was never reached.
    expect(run.out).toEqual([])
    expect(columns().password_hash).toBe(before)
  })
})

describe('admin unlock', () => {
  it('clears both lockout columns and leaves the existing password working', async () => {
    const before = columns()
    await lockTheAccount()
    expect(columns().locked_until_ms).toBe(LOCKED_UNTIL_MS)

    const run = capture([])
    expect(await runAdmin(['unlock', 'robin'], run.deps)).toBe(0)
    expect(run.out).toEqual(['lockout cleared for robin. Their existing password still works.'])

    const after = columns()
    expect(after.failed_attempts).toBe(0)
    expect(after.locked_until_ms).toBeNull()
    expect(after.password_hash).toBe(before.password_hash)
    const signedIn = await accounts.login({ username: 'robin', password: OLD_PASSWORD, nowMs: NOW_MS })
    expect(signedIn.ok).toBe(true)
  })

  it('names an account it cannot find', async () => {
    const run = capture([])
    expect(await runAdmin(['unlock', 'nobody'], run.deps)).toBe(1)
    expect(run.err).toEqual(['no account named nobody'])
  })
})

describe('admin list', () => {
  it('prints the state an operator came to look at, and never the hash', async () => {
    await lockTheAccount()
    const stored = columns().password_hash
    // Asserting the absence of a hash proves nothing unless there is one to leak.
    expect(stored.startsWith('$argon2id$')).toBe(true)

    const run = capture([])
    expect(await runAdmin(['list'], run.deps)).toBe(0)
    expect(run.out).toEqual([
      'username  admin  disabled  locked',
      `robin     yes    no        until ${new Date(LOCKED_UNTIL_MS).toISOString()}`,
    ])
    const printed = run.out.join('\n')
    expect(printed).not.toContain(stored)
    expect(printed).not.toContain('$argon2')
  })

  it('shows a disabled account as disabled and an expired lock as lapsed', async () => {
    await lockTheAccount()
    accounts.disable('a1', CREATED_MS + 5)
    const run = capture([], LOCKED_UNTIL_MS + 1)
    expect(await runAdmin(['list'], run.deps)).toBe(0)
    expect(run.out).toEqual([
      'username  admin  disabled                        locked',
      `robin     yes    since ${new Date(CREATED_MS + 5).toISOString()}  `
        + `lapsed ${new Date(LOCKED_UNTIL_MS).toISOString()}`,
    ])
  })

  it('takes no arguments, so a mistyped command is not silently a listing', async () => {
    const run = capture([])
    expect(await runAdmin(['list', 'robin'], run.deps)).toBe(1)
    expect(run.err).toEqual(['list takes no arguments'])
    expect(run.out).toEqual([])
  })
})

describe('admin against a directory with no instance in it', () => {
  it('says which path it tried, and creates nothing there', async () => {
    const missing = `${fixture.dir}-gone`
    const run = capture([], NOW_MS, missing)
    expect(await runAdmin(['list'], run.deps)).toBe(1)
    expect(run.err).toHaveLength(1)
    expect(run.err[0]).toContain(missing)
    expect(run.err[0]).toContain('haelan.sqlite')
    // openDatabase creates what it cannot find, so the path staying absent is the assertion.
    expect(existsSync(missing)).toBe(false)
  })
})

describe('admin with no command', () => {
  it('prints the usage and fails, rather than doing something', async () => {
    const run = capture([])
    expect(await runAdmin([], run.deps)).toBe(1)
    expect(run.out).toEqual([])
    expect(run.err).toHaveLength(1)
    expect(run.err[0]).toContain('passwd <username>')
  })
})

describe('parseHarvestLines', () => {
  it('rejects a harvest line that is not a date and a number', () => {
    const parsed = parseHarvestLines(['2026-09-14 53', 'rubbish'])
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.message).toBe('line 2 is not "YYYY-MM-DD <score>": rubbish')
  })

  it('accepts well formed lines and keeps their dates and scores', () => {
    const parsed = parseHarvestLines(['2026-09-14 53', '2026-09-13 61'])
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.rows).toEqual([
      { localDate: '2026-09-14', score: 53 },
      { localDate: '2026-09-13', score: 61 },
    ])
  })

  it("rejects a score outside 0 to 100, which is the app's own scale", () => {
    const parsed = parseHarvestLines(['2026-09-14 153'])
    expect(parsed.ok).toBe(false)
  })
})

describe('admin harvest-recovery', () => {
  // seedPerson defaults to Europe/Amsterdam, which is CEST (UTC+2) in September, so local
  // midnight of a September date is 22:00 UTC the day before, and the stored offset is 120.
  it("writes one event per line, at local midnight in the person's own timezone", async () => {
    const run = capture([], NOW_MS, undefined, '2026-09-14 53\n2026-09-13 61\n')
    expect(await runAdmin(['harvest-recovery', 'robin'], run.deps)).toBe(0)
    expect(run.err).toEqual([])
    expect(run.out).toEqual(['2 recovery scores written for robin: 2 new, 0 replaced.'])

    expect(eventRows()).toEqual([
      {
        kind: HARVEST_KIND,
        started_at_ms: Date.parse('2026-09-12T22:00:00Z'),
        started_at_offset_minutes: 120,
        value: 61,
      },
      {
        kind: HARVEST_KIND,
        started_at_ms: Date.parse('2026-09-13T22:00:00Z'),
        started_at_offset_minutes: 120,
        value: 53,
      },
    ])
  })

  it('replaces an existing harvested score for the same date rather than duplicating it', async () => {
    const first = capture([], NOW_MS, undefined, '2026-09-14 53\n')
    expect(await runAdmin(['harvest-recovery', 'robin'], first.deps)).toBe(0)

    const second = capture([], NOW_MS, undefined, '2026-09-14 61\n')
    expect(await runAdmin(['harvest-recovery', 'robin'], second.deps)).toBe(0)
    expect(second.out).toEqual(['1 recovery score written for robin: 0 new, 1 replaced.'])

    const rows = eventRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.value).toBe(61)
  })

  it('never touches another kind of event on the same local day', async () => {
    new EventStore(fixture.db).add({
      personId: 'p1',
      kind: 'illness',
      startedAtMs: Date.parse('2026-09-13T22:00:00Z'),
      startedAtOffsetMinutes: 120,
    })

    const run = capture([], NOW_MS, undefined, '2026-09-14 53\n')
    expect(await runAdmin(['harvest-recovery', 'robin'], run.deps)).toBe(0)
    expect(run.out).toEqual(['1 recovery score written for robin: 1 new, 0 replaced.'])

    const kinds = eventRows().map((row) => row.kind).sort()
    expect(kinds).toEqual(['illness', HARVEST_KIND].sort())
  })

  it('rejects the whole batch on the first bad line and writes nothing', async () => {
    const run = capture([], NOW_MS, undefined, '2026-09-14 53\nrubbish\n')
    expect(await runAdmin(['harvest-recovery', 'robin'], run.deps)).toBe(1)
    expect(run.err).toEqual(['line 2 is not "YYYY-MM-DD <score>": rubbish'])
    expect(run.out).toEqual([])
    expect(eventRows()).toEqual([])
  })

  it('names an account it cannot find rather than reading stdin', async () => {
    const run = capture([], NOW_MS, undefined, '2026-09-14 53\n')
    expect(await runAdmin(['harvest-recovery', 'nobody'], run.deps)).toBe(1)
    expect(run.err).toEqual(['no account named nobody'])
    expect(eventRows()).toEqual([])
  })

  it('writes nothing and says so for an empty input', async () => {
    const run = capture([], NOW_MS, undefined, '')
    expect(await runAdmin(['harvest-recovery', 'robin'], run.deps)).toBe(0)
    expect(run.out).toEqual(['no lines to harvest.'])
    expect(eventRows()).toEqual([])
  })

  it('requires a username', async () => {
    const run = capture([])
    expect(await runAdmin(['harvest-recovery'], run.deps)).toBe(1)
    expect(run.err).toEqual(['usage: harvest-recovery <username>'])
  })

  it('takes one username and rejects a trailing argument', async () => {
    const run = capture([])
    expect(await runAdmin(['harvest-recovery', 'robin', 'extra'], run.deps)).toBe(1)
    expect(run.err).toEqual(['harvest-recovery takes one username and nothing else'])
  })
})
