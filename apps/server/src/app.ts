import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import {
  AccountStore, CredentialStore, RawArchive, SessionStore, SettingsStore, SourceRegistry, SyncStateStore,
} from '@haelan/core'
import type { Instance } from '@haelan/core'
import { registerSetupGate } from './routes/setupGate.ts'

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
  /** Absolute path to the built web bundle. Unset in tests, which serve no static files. */
  webRoot?: string
}

export interface Stores {
  accounts: AccountStore
  sessions: SessionStore
  settings: SettingsStore
  credentials: CredentialStore
  syncState: SyncStateStore
  sources: SourceRegistry
  archive: RawArchive
}

export interface ServerContext extends ServerDeps { stores: Stores }

declare module 'fastify' {
  interface FastifyInstance { haelan: ServerContext }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false })
  const stores: Stores = {
    accounts: new AccountStore(deps.instance.db),
    sessions: new SessionStore(deps.instance.db),
    settings: new SettingsStore(deps.instance.db),
    credentials: deps.instance.credentials,
    syncState: new SyncStateStore(deps.instance.db),
    sources: new SourceRegistry(deps.instance.db),
    archive: deps.instance.archive,
  }
  app.decorate('haelan', { ...deps, stores })

  app.get('/api/health', async () => ({ ok: true }))
  registerSetupGate(app)

  return app
}
