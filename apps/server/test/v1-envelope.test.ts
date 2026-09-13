import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, TransientError, openHaelan } from '@haelan/core'
import { statusFor, errorBody, sendCoreError } from '../src/api/envelope.ts'

const fakeReply = () => {
  const sent: { status?: number, body?: unknown } = {}
  const reply = {
    code(status: number) { sent.status = status; return reply },
    send(body: unknown) { sent.body = body; return reply },
    sent,
  }
  return reply
}

let cleanup: (() => void) | null = null
// Guarded on the handle rather than wrapped in try/catch: an rmSync that threw here - EPERM from a
// SQLite handle Windows has not finished releasing - would replace the assertion error with its
// own and hide which behaviour actually broke.
afterEach(() => { if (cleanup !== null) { cleanup(); cleanup = null } })

describe('the error envelope', () => {
  it('maps each kind to its status', () => {
    expect(statusFor('unauthorized')).toBe(401)
    expect(statusFor('forbidden')).toBe(403)
    expect(statusFor('not_found')).toBe(404)
    expect(statusFor('setup_incomplete')).toBe(409)
    expect(statusFor('config')).toBe(400)
    expect(statusFor('transient')).toBe(503)
  })

  // The client narrows on kind, so it is the field that must always be present and must never be
  // a free string. code is for a human reading a log, message for a human reading a screen.
  it('always carries a kind, a code and a message', () => {
    expect(errorBody('config', 'bad_range', 'from is after to')).toEqual({
      error: { kind: 'config', code: 'bad_range', message: 'from is after to' },
    })
  })

  // PersonQuery validates its own arguments and throws rather than returning an emptiness, and
  // its messages name the real problem, so they are the useful thing to show.
  it('turns a ConfigError from core into a 400 carrying its message', () => {
    const reply = fakeReply()
    sendCoreError(reply as never, new ConfigError("no metric named 'hart_rate'"))
    expect(reply.sent.status).toBe(400)
    expect(reply.sent.body).toMatchObject({ error: { kind: 'config', message: expect.stringContaining('hart_rate') } })
  })

  // HaelanError's constructor tags its message with its own kind, for a log line where nothing
  // else states the class. The body states it in a field, so echoing the tagged message put the
  // class in twice and a caller read "[config] no metric named 'hart_rate'" next to
  // kind: "config". Asserted exactly rather than with stringContaining, which is what let the
  // duplicate sit here unnoticed through four review rounds.
  it('leaves the kind tag out of the message it shows a caller, since the body names the kind', () => {
    const reply = fakeReply()
    sendCoreError(reply as never, new ConfigError("no metric named 'hart_rate'"))
    expect(reply.sent.body).toEqual({
      error: { kind: 'config', code: 'config', message: "no metric named 'hart_rate'" },
    })
  })

  // code is a copy of kind for anything core threw, and carries no information: ConfigError has
  // no code of its own to derive one from. Pinned so the placeholder is visible in the suite
  // rather than only in a comment, and so the day core grows real codes this test is what says
  // the contract moved. The codes on 401, 403 and 404 are real; see requirePerson.
  it('answers a placeholder code, not a real one, for anything core threw', () => {
    const config = fakeReply()
    sendCoreError(config as never, new ConfigError('metric is required'))
    expect(config.sent.body).toMatchObject({ error: { kind: 'config', code: 'config' } })

    const transient = fakeReply()
    sendCoreError(transient as never, new TransientError('the API answered 429'))
    expect(transient.sent.body).toMatchObject({ error: { kind: 'transient', code: 'transient' } })
  })

  // An unexpected throw is a bug in us. Echoing its message risks leaking a query, a path or a
  // row into a response, so the log gets the detail and the caller gets a kind.
  it('turns anything else into a 500 that says nothing about itself', () => {
    const reply = fakeReply()
    sendCoreError(reply as never, new Error('SQLITE_CORRUPT: /home/robin/.local-data/haelan.sqlite'))
    expect(reply.sent.status).toBe(500)
    // 'internal', not 'transient': a caller that retries on kind must not hammer a deterministic
    // bug in us forever.
    expect(reply.sent.body).toMatchObject({ error: { kind: 'internal' } })
    expect(JSON.stringify(reply.sent.body)).not.toContain('haelan.sqlite')
  })

  it('maps a TransientError from core to 503, since retrying it can work', () => {
    const reply = fakeReply()
    sendCoreError(reply as never, new TransientError('the API answered 429'))
    expect(reply.sent.status).toBe(503)
  })

  /**
   * A real SQLITE_BUSY, produced the only way one can be: by a second connection holding the write
   * lock while this one tries to write. Not a hand-built Error carrying a `code`, because the
   * mapping under test reads a better-sqlite3 error and a stand-in would pass whatever shape the
   * mapping happened to expect.
   *
   * This is the boot rebuild's shape exactly. It rebuilds one person inside a single transaction
   * from its own process, so on a household of one it holds this lock for the whole rebuild, and
   * every write route that lands in that window throws this.
   */
  const realBusyError = (): unknown => {
    const dir = mkdtempSync(join(tmpdir(), 'haelan-busy-'))
    cleanup = () => rmSync(dir, { recursive: true, force: true })
    const a = openHaelan(dir, {})
    const b = openHaelan(dir, {})
    try {
      b.db.$client.pragma('busy_timeout = 50')
      a.db.$client.exec('begin immediate')
      // Any write at all needs the lock, so a table of this test's own is used rather than one of
      // the schema's: it keeps the probe from breaking the day a column gains a constraint, and a
      // statement that failed for a schema reason would produce the wrong error entirely.
      b.db.$client.exec('create table busy_probe (x)')
      throw new Error('the write was supposed to be refused and was not')
    } catch (error) {
      // Asserted here rather than trusted, because this helper silently producing some other
      // SqliteError is exactly how these two tests would go on passing while testing nothing.
      expect((error as Error).message).toContain('database is locked')
      return error
    } finally {
      a.db.$client.exec('rollback')
      a.close()
      b.close()
    }
  }

  // 'transient', not 'internal'. The kind is the whole of what a caller is told about whether to
  // try again, and a locked database is the textbook case where trying again works: the lock ends
  // when the rebuild commits. Left under 'internal' - which is where an unrecognised throw lands,
  // and where this one landed in 1.16.0 - every write route answers a bare 500 for the length of a
  // rebuild, which the web client does not retry and the reader sees as "gave no answer".
  it('maps a locked database to 503, since the lock ends when the rebuild commits', () => {
    const reply = fakeReply()
    sendCoreError(reply as never, realBusyError())
    expect(reply.sent.status).toBe(503)
    expect(reply.sent.body).toMatchObject({ error: { kind: 'transient' } })
  })

  // The message says the instance is busy and says nothing else. A path, a statement or a row
  // reaching a caller is what the 'internal' branch above is careful to prevent, and a new branch
  // that echoed the driver's own message would walk straight past that care.
  it('says the instance is busy without echoing what the driver said', () => {
    const reply = fakeReply()
    const error = realBusyError()
    sendCoreError(reply as never, error)
    expect(JSON.stringify(reply.sent.body)).not.toContain('haelan.sqlite')
    expect(JSON.stringify(reply.sent.body)).not.toContain('busy_probe')
  })
})
