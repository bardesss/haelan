import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SyncProgress } from '@haelan/core'
import { errorBody } from '../api/envelope.ts'

const KEEPALIVE_MS = 15_000

/**
 * The one person this caller may be told about, or null once a 401 has been sent. requireSession
 * leaves an accountId on the request and accounts.person_id turns it into a person; the account
 * can be gone by the time we look, since a session outlives the row it points at until it is
 * resolved again, which is the same 401 /api/auth/me answers in that case.
 *
 * A local helper rather than a decorated preHandler: these are the only two routes on the flat
 * surface that read per-person state, and the versioned surface has its own guard keyed on the
 * :personId path segment, which neither of these routes has.
 */
function personIdFor(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): string | null {
  const accountId = request.accountId
  const account = accountId ? app.haelan.stores.accounts.getById(accountId) : null
  if (!account) {
    void reply.code(401).send(errorBody('unauthorized', 'no_session', 'sign in required'))
    return null
  }
  return account.personId
}

/**
 * Whether a progress event is this listener's to see. Scoping the snapshot alone would not be
 * enough: subscribe forwards every event of every run to every connected client, and job_started,
 * window_done and job_finished each name a person and count rows written for them.
 *
 * run_finished carries no personId, and is forwarded to everyone on purpose. It is the
 * instance-wide "the run is over" the backfill screen stops on, and withholding it from a member
 * whose own jobs were not in the run would leave their page waiting for an event never coming.
 * It reports totals for the run as a whole, which says a run happened rather than whose it was.
 */
function visibleTo(event: SyncProgress, personId: string): boolean {
  return !('personId' in event) || event.personId === personId
}

export function registerSync(app: FastifyInstance): void {
  app.get('/api/sync/status', { preHandler: [app.requireSession] }, async (request, reply) => {
    const personId = personIdFor(app, request, reply)
    if (personId === null) return reply
    return app.haelan.runner.status(personId)
  })

  app.post('/api/sync/run', { preHandler: [app.requireSession] }, async (_request, reply) => {
    // tryStart, not trigger: a backfill batch runs for minutes and the browser wants an answer
    // now. It takes the mutex synchronously and leaves the run going, so the refusal is a real
    // answer rather than a race, and the stream and the status route carry the rest.
    const outcome = app.haelan.runner.tryStart('manual')
    if (outcome.started) return reply.code(202).send({ started: true })
    // A cooldown is a different shape of "not now" than the other two: it names when a retry
    // would succeed rather than only that one would eventually, so it gets its own status and a
    // retry-after header rather than folding into the 409 below.
    if (outcome.reason === 'cooldown') {
      const seconds = Math.ceil((outcome.retryAfterMs ?? 0) / 1000)
      return reply.code(429).header('retry-after', String(seconds)).send(errorBody(
        'transient', 'cooldown', `a sync finished moments ago; try again in ${seconds}s`,
      ))
    }
    // Neither remaining refusal means setup is incomplete: a run is already going, or the
    // instance is on its way down, and in both cases the honest answer is to try again shortly -
    // which is what 'transient' means. The code still carries which of the two it was.
    return reply.code(409).send(errorBody(
      'transient',
      outcome.reason ?? 'busy',
      outcome.reason === 'shutting_down' ? 'the instance is shutting down' : 'a sync is already running',
    ))
  })

  app.get('/api/sync/events', { preHandler: [app.requireSession] }, async (request, reply) => {
    // Before the head goes out, so a caller with no account still gets an ordinary 401 rather
    // than an event stream that opens and then says nothing.
    const personId = personIdFor(app, request, reply)
    if (personId === null) return reply

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // A reverse proxy that buffers this will make the progress bar arrive all at once.
      'x-accel-buffering': 'no',
    })
    reply.hijack()

    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`)
    // The current status first, so a page that connects mid run renders the truth rather than
    // an empty bar waiting for the next event.
    send({ kind: 'status', ...app.haelan.runner.status(personId) })

    const unsubscribe = app.haelan.runner.subscribe((event) => {
      if (visibleTo(event, personId)) send(event)
    })
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), KEEPALIVE_MS)
    keepalive.unref()

    request.raw.on('close', () => {
      clearInterval(keepalive)
      unsubscribe()
      reply.raw.end()
    })
  })
}
