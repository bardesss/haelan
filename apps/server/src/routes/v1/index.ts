import type { FastifyInstance } from 'fastify'
import { sendCoreError } from '../../api/envelope.ts'
import { registerRequirePerson } from '../../api/requirePerson.ts'
import { registerSeriesRoutes } from './series.ts'
import { registerTier2Routes } from './tier2.ts'
import { registerChangesRoutes } from './changes.ts'

/**
 * Registers the versioned surface. Called through app.register with the /api/v1 prefix (see
 * app.ts), so this plugin's own encapsulation is what keeps the isolation rule and the error
 * handler both scoped here rather than leaking onto the older, flat-shaped routes.
 *
 * The error handler is registered once, here, rather than each route calling the serialiser
 * itself: a route inside this file can let a core call's throw propagate instead of wrapping it,
 * which is what keeps a route down to a parameter check, one core call and a serialiser.
 *
 * testOnlyExtra exists only for apps/server/test/v1-isolation.test.ts, which needs to register a
 * route inside this same plugin scope with no preHandler of its own, to prove the hook below is
 * what guards it rather than something a route author remembered to add. app.ts's real call site
 * never passes it.
 */
export function registerV1(app: FastifyInstance, testOnlyExtra?: (app: FastifyInstance) => void): void {
  registerRequirePerson(app)

  // A plugin-wide hook rather than a per-route preHandler array: the isolation rule has to be a
  // property of this file, not of a list every route author has to remember to update. Five more
  // tasks add routes here; a forgotten array is a silent, fully unauthenticated endpoint, and a
  // hook at this level guards a route whether or not its author thought about it.
  app.addHook('preHandler', async (request, reply) => {
    await app.requireSession(request, reply)
    if (reply.sent) return
    await app.requirePerson(request, reply)
  })

  app.setErrorHandler((error, _request, reply) => sendCoreError(reply, error))

  registerSeriesRoutes(app)
  registerTier2Routes(app)
  registerChangesRoutes(app)

  testOnlyExtra?.(app)
}
