import type { FastifyInstance } from 'fastify'
import { setupStep } from '@haelan/core'
import type { SetupStep } from '@haelan/core'

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
    const isSetupRoute = path.startsWith('/api/setup/') || path.startsWith('/oauth/')

    if (step !== 'done' && !isSetupRoute) {
      return reply.code(409).send({ error: 'setup_incomplete', step })
    }
    if (step === 'done' && isSetupRoute) {
      return reply.code(409).send({ error: 'setup_complete' })
    }
  })
}

function currentStep(app: FastifyInstance): SetupStep {
  const { accounts, settings, credentials } = app.haelan.stores
  return setupStep({ accounts, settings, credentials })
}
