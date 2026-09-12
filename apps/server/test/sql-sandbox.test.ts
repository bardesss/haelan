import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PersonQuery, createTestDatabase, seedPerson, schema, ConfigError } from '@haelan/core'
import type { TestDatabase } from '@haelan/core'
import { CATALOGUE } from '../src/mcp/catalogue.ts'
import { SQL_ROW_CAP } from '../src/mcp/runSql.ts'
import { seedToolData } from './mcp-fixtures.ts'

const tool = () => CATALOGUE.find((t) => t.name === 'sql_query')!

let test: TestDatabase
let alice: PersonQuery

beforeEach(() => {
  test = createTestDatabase()
  seedPerson(test.db, 'alice')
  seedPerson(test.db, 'bart')
  seedToolData(test.db)
  alice = new PersonQuery(test.db, 'alice')
})
afterEach(() => test.cleanup())

const run = (sql: string) => tool().run(alice, { sql }) as Promise<{
  columns: string[], rows: unknown[][], truncated: boolean, textTruncated: boolean
}>

describe('what the caller\'s SQL cannot reach', () => {
  // Each of these is a measured refusal, and all of them rest on one thing: the caller's string
  // reaches prepare().iterate() and nothing else. Route it through .run() or .exec() and every
  // line below goes green while the sandbox is gone.
  it('cannot ATTACH the live database', async () => {
    await expect(run("ATTACH DATABASE 'haelan.db' AS live")).rejects.toThrow(ConfigError)
  })

  it('cannot smuggle a second statement', async () => {
    await expect(run("SELECT 1; ATTACH DATABASE 'haelan.db' AS live")).rejects.toThrow(ConfigError)
  })

  it('cannot load an extension, and is told SQLite\'s own reason rather than the canned sentence', async () => {
    // load_extension refuses at iterate() - prepare() and columns() both succeed, since SQLite
    // reports this as a one-column statement before it ever runs. That matters here: this *was*
    // exactly one SELECT, so the canned "sql_query runs exactly one SELECT" sentence would be
    // actively false if it fired here. Asserting only the error class would miss a regression
    // that broadened asAgentError's regex to also swallow "not authorized" - this pins both sides.
    const error = await run("SELECT load_extension('/tmp/x.so')").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).toMatch(/not authorized/)
    expect((error as Error).message).not.toMatch(/exactly one SELECT/)
  })

  it('cannot read a file', async () => {
    // readfile() is the SQLite "fileio" loadable extension, which better-sqlite3 never compiles
    // in - so this proves only that this build has no such function, not that this app's own
    // load_extension refusal above would also stop a build that did have fileio loaded. It earns
    // its place anyway: it pins that whatever message SQLite gives for "no such function" reaches
    // the agent verbatim, not the canned "exactly one SELECT" sentence - the same property the
    // load_extension case above pins, from a genuinely different failure mode.
    const error = await run("SELECT readfile('/etc/hostname')").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as Error).message).toMatch(/no such function/)
    expect((error as Error).message).not.toMatch(/exactly one SELECT/)
  })

  it('cannot write', async () => {
    await expect(run("INSERT INTO daily VALUES ('2026-01-01','steps','sum','merged',1,1,null,0)"))
      .rejects.toThrow(ConfigError)
    await expect(run('DELETE FROM daily')).rejects.toThrow(ConfigError)
  })

  it('says what it does allow, rather than naming an API the agent cannot reach', async () => {
    // better-sqlite3's own message here is "This statement does not return data. Use run()
    // instead", which sends an agent looking for a method it has no access to.
    await expect(run('DELETE FROM daily')).rejects.toThrow(/exactly one SELECT/)
  })

  it('reaches no table that holds a credential', async () => {
    for (const forbidden of ['accounts', 'credentials', 'mcp_tokens', 'auth_sessions']) {
      await expect(run(`SELECT * FROM ${forbidden}`)).rejects.toThrow(/no such table/)
    }
  })
})

describe('the row cap', () => {
  it('stops pulling rather than materialising, so an infinite query still returns', async () => {
    // The shape that burned 10.8 seconds under .all(). Bounded here because the cap is applied by
    // not pulling: measured at 0.8ms for 501 rows of an unbounded generator.
    const started = Date.now()
    const result = await run('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c')
    expect(result.rows).toHaveLength(SQL_ROW_CAP)
    expect(result.truncated).toBe(true)
    expect(Date.now() - started).toBeLessThan(4000)
  })

  it('does not claim truncation when everything fitted', async () => {
    const result = await run('SELECT metric FROM daily LIMIT 3')
    expect(result.rows).toHaveLength(3)
    expect(result.truncated).toBe(false)
  })
})

describe('one at a time', () => {
  it('refuses a second concurrent query rather than starting a second thread', async () => {
    const slow = run('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c')
    const second = run('SELECT 1 AS one')
    await expect(second).rejects.toThrow(/already running/)
    await slow
  })

  it('is available again once the first finished', async () => {
    await run('SELECT 1 AS one')
    const result = await run('SELECT 2 AS two')
    expect(result.rows).toEqual([[2]])
  })
})

describe('free text', () => {
  it('truncates a very long cell and says so', async () => {
    const long = 'x'.repeat(5000)
    test.db.insert(schema.notes).values({ id: 'long', personId: 'alice', localDate: '2026-08-02', body: long, updatedAtMs: 0 }).run()
    const result = await run("SELECT body FROM notes WHERE id = 'long'")
    expect((result.rows[0]![0] as string).length).toBe(2000)
    expect(result.textTruncated).toBe(true)
  })
})

describe('the deadline', () => {
  it('gives up on a CPU-bound query and leaves the main thread serving', async () => {
    // count(*) over a generated set is the residual this design does not bound: one row, arriving
    // only at the end, so the row cap cannot help. What the worker buys is that the main thread
    // stays responsive while it burns - which is the whole reason for the thread, and the only
    // way to prove it is to do something else while waiting.
    //
    // The bound (60,000,000) only needs to outlast the 5-second deadline, not run for minutes:
    // terminate() cannot interrupt the native call underneath it, so whatever this reaches keeps
    // burning, on its own thread, until it naturally finishes - a much larger bound (2 billion)
    // measured at roughly six to seven minutes of that, long enough to contend with sibling test
    // files this suite runs alongside. This number is sized off two direct throughput
    // measurements on this machine (4.1-5.8 million rows/second for an unworkered recursive
    // count) to land the *query's own* natural runtime around 13-15 seconds - comfortably past
    // the deadline with margin for a slower run, but reaped in seconds rather than minutes once
    // the suite moves on. Confirmed by running this case three times in a row: the timeout fires
    // reliably every time, and the thread's own completion time (measured in the paired case
    // below via the file it leaves locked) lands in that same window.
    const query = run('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 60000000) SELECT count(*) FROM c')
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 100)
    await expect(query).rejects.toThrow(/did not finish within/)
    clearInterval(timer)
    // A blocked event loop fires no timers at all. This is the assertion the worker is for.
    expect(ticks).toBeGreaterThan(10)
  }, 20_000)
})
