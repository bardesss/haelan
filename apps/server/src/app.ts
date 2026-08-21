import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import type { Instance } from '@haelan/core'

/** Overrides for Google's endpoints. Tests point these at a stub; production leaves them unset. */
export interface EndpointOverrides {
  apiRoot?: string
  tokenEndpoint?: string
  authEndpoint?: string
}

export interface ServerDeps {
  instance: Instance
  now: () => number
  fetch: typeof globalThis.fetch
  endpoints?: EndpointOverrides
  /** Absolute path to the built web bundle. Unset in tests, which never serve static files. */
  webRoot?: string
}

declare module 'fastify' {
  interface FastifyInstance {
    haelan: ServerDeps
  }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  app.decorate('haelan', deps)

  app.get('/api/health', async () => ({ ok: true }))

  return app
}
