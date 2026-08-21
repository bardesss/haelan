import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

// A path that names a file: an asset directory, or anything ending in an extension. The shell
// is never the right answer for one of these, whether or not the file is there.
const LOOKS_LIKE_A_FILE = /^\/assets\/|\.[a-z0-9]+$/i

export function registerStatic(app: FastifyInstance, webRoot: string): void {
  // No wildcard: false here. That option enumerates the directory once at registration, so a
  // bundle rebuilt while the server runs keeps serving routes for filenames that no longer
  // exist, and the new hashed ones fall through to the handler below. Resolving per request
  // costs a stat and means what is on disk is what is served.
  void app.register(fastifyStatic, { root: webRoot })

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (path.startsWith('/api/') || path.startsWith('/oauth/')) {
      return reply.code(404).send({ error: 'not_found' })
    }
    // A missing file is a missing file. Handing index.html to a <script type="module"> answers
    // it with HTML, and the browser reports a MIME type error that names neither the file that
    // was missing nor the reason, which is a genuinely hard thing to diagnose from.
    if (LOOKS_LIKE_A_FILE.test(path)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    // Client routed paths such as /setup/google have no file behind them, so they get the
    // shell and the router sorts it out.
    return reply.sendFile('index.html')
  })
}
