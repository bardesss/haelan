import { describe, it, expect } from 'vitest'
import { ConfigError, TransientError } from '@haelan/core'
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

  // An unexpected throw is a bug in us. Echoing its message risks leaking a query, a path or a
  // row into a response, so the log gets the detail and the caller gets a kind.
  it('turns anything else into a 500 that says nothing about itself', () => {
    const reply = fakeReply()
    sendCoreError(reply as never, new Error('SQLITE_CORRUPT: /home/bartus/.local-data/haelan.sqlite'))
    expect(reply.sent.status).toBe(500)
    expect(JSON.stringify(reply.sent.body)).not.toContain('haelan.sqlite')
  })

  it('maps a TransientError from core to 503, since retrying it can work', () => {
    const reply = fakeReply()
    sendCoreError(reply as never, new TransientError('the API answered 429'))
    expect(reply.sent.status).toBe(503)
  })
})
