import type { FastifyInstance } from 'fastify'
import { setupStep } from '@haelan/core'
import type { SetupStep } from '@haelan/core'
import { errorBody } from '../api/envelope.ts'

// Open in both directions: during setup there is nobody to authenticate, and afterwards a
// container health probe still has no cookie.
const ALWAYS_OPEN = new Set(['/api/health', '/api/setup/state'])

export function registerSetupGate(app: FastifyInstance): void {
  app.get('/api/setup/state', async () => ({ step: currentStep(app) }))

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? ''
    if (ALWAYS_OPEN.has(path)) return
    // The gate governs the API, not the browser. A document request for /setup/google is how
    // the wizard is reached in the first place, and answering it with a 409 JSON body makes
    // an unconfigured instance impossible to configure.
    if (!path.startsWith('/api/') && !path.startsWith('/oauth/')) return

    const step = currentStep(app)
    const isConsentRoute = path.startsWith('/oauth/')
    const isSetupRoute = path.startsWith('/api/setup/') || isConsentRoute

    if (step !== 'done' && !isSetupRoute) {
      // The versioned surface answers this gate in the envelope like every other status it can
      // return. It is reached before any session check, so on a fresh instance it is the very
      // first thing a client sees, and a client narrowing on body.error.kind cannot read a flat
      // string. The older families keep the flat shape the wizard's own client reads.
      if (path.startsWith('/api/v1/')) {
        return reply.code(409).send({
          ...errorBody('setup_incomplete', 'setup_incomplete', `setup is at the ${step} step`),
          step,
        })
      }
      return reply.code(409).send({ error: 'setup_incomplete', step })
    }
    // Consent outlives setup; the rest of the wizard does not. A grant can die after setup is
    // long finished - the owner revokes haelan in their Google account, or Google invalidates it
    // - and consent is the only thing that revives it, because putRefreshToken clearing
    // revoked_at_ms is the sole path back. Closing /oauth/* here left hand-editing SQLite as the
    // only recovery, and would have blocked a second member's first consent too (M5 invites).
    // The wizard's own API stays closed: those routes build an instance that already exists, and
    // re-running one silently rewrites what a working install depends on. /oauth/* is safe to
    // leave open because it does not rely on this gate for its protection - /oauth/start takes a
    // session, and /oauth/callback only accepts state this instance signed, for the person named
    // inside it.
    if (step === 'done' && isSetupRoute && !isConsentRoute) {
      return reply.code(409).send({ error: 'setup_complete' })
    }
  })
}

function currentStep(app: FastifyInstance): SetupStep {
  const { accounts, settings, credentials } = app.haelan.stores
  return setupStep({ accounts, settings, credentials })
}
