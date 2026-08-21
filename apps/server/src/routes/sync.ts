import type { FastifyInstance } from 'fastify'

const KEEPALIVE_MS = 15_000

export function registerSync(app: FastifyInstance): void {
  app.get('/api/sync/status', { preHandler: [app.requireSession] }, async () =>
    app.haelan.runner.status())

  app.post('/api/sync/run', { preHandler: [app.requireSession] }, async (_request, reply) => {
    // tryStart, not trigger: a backfill batch runs for minutes and the browser wants an answer
    // now. It takes the mutex synchronously and leaves the run going, so the refusal is a real
    // answer rather than a race, and the stream and the status route carry the rest.
    const outcome = app.haelan.runner.tryStart('manual')
    return outcome.started
      ? reply.code(202).send({ started: true })
      : reply.code(409).send({ error: outcome.reason })
  })

  app.get('/api/sync/events', { preHandler: [app.requireSession] }, async (request, reply) => {
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
    send({ kind: 'status', ...app.haelan.runner.status() })

    const unsubscribe = app.haelan.runner.subscribe(send)
    const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), KEEPALIVE_MS)
    keepalive.unref()

    request.raw.on('close', () => {
      clearInterval(keepalive)
      unsubscribe()
      reply.raw.end()
    })
  })
}
