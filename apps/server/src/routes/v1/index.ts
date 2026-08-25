import type { FastifyInstance } from 'fastify'
import { sendCoreError } from '../../api/envelope.ts'
import { registerRequirePerson } from '../../api/requirePerson.ts'

/**
 * Registers the versioned surface. Called through app.register with the /api/v1 prefix (see
 * app.ts), so this plugin's own encapsulation is what keeps the isolation rule and the error
 * handler both scoped here rather than leaking onto the older, flat-shaped routes.
 *
 * The error handler is registered once, here, rather than each route calling the serialiser
 * itself: a route inside this file can let a core call's throw propagate instead of wrapping it,
 * which is what keeps a route down to a parameter check, one core call and a serialiser.
 */
export function registerV1(app: FastifyInstance): void {
  registerRequirePerson(app)

  app.setErrorHandler((error, _request, reply) => sendCoreError(reply, error))

  // A stand-in so the guard above has a real route to run in front of. Task 4 replaces this
  // with the real /series handler, backed by PersonQuery.series and keyed by metric.
  app.get<{ Params: { personId: string } }>(
    '/p/:personId/series',
    { preHandler: [app.requireSession, app.requirePerson] },
    async () => ({ ok: true }),
  )
}
