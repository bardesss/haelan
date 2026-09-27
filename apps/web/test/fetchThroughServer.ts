import type { Harness } from '../../server/test/harness.ts'

const NO_BODY_STATUSES = new Set([101, 204, 205, 304])

// app.inject's own HTTPMethods type comes from fastify, which is not a dependency apps/web's own
// module resolution can see (apps/server has it, apps/web does not); named here rather than
// imported so this file never has to reach across that boundary for a type.
type InjectMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'PATCH'

/**
 * Routes every request the mounted app makes through the real server, the way a browser reaching
 * it over a socket would - except the transport underneath is app.inject rather than a socket.
 * Shared by the end to end tests (e2e-dashboard.test.tsx, e2e-quick-log.test.tsx).
 *
 * app.inject resolves to a Fastify "light" response (statusCode, rawPayload, a headers object),
 * not a Response, and the app's own client code (apiSend in src/api/client.ts) reads
 * response.text(), response.ok and response.status. A stub that handed that code the injected
 * reply directly would work by accident on today's client and break the moment it read anything
 * else; building a real Response from the injected reply is what keeps these tests exercising the
 * same contract a real browser fetch honours.
 *
 * The session cookie is attached by hand on every request. Nothing here is a browser with a
 * cookie jar, so nothing carries it automatically once signIn() has it; this is the "carries it
 * the way a browser would" half of the replacement.
 */
export function fetchThroughServer(app: Harness['app'], sessionCookie: string): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init.method ?? 'GET').toUpperCase() as InjectMethod
    // origin/host matter to auth.ts's same-origin check on mutating methods (POST/PUT/etc), which
    // the quick-log test's writes trip and the dashboard test's GET-only load never does.
    const headers: Record<string, string> = {
      cookie: `haelan_session=${sessionCookie}`,
      origin: 'http://localhost:4235',
      host: 'localhost:4235',
    }
    if (init.headers) {
      for (const [key, value] of new Headers(init.headers)) headers[key] = value
    }
    const injected = await app.inject({
      method, url, headers,
      payload: typeof init.body === 'string' ? init.body : undefined,
    })
    const responseHeaders = new Headers()
    const contentType = injected.headers['content-type']
    if (typeof contentType === 'string') responseHeaders.set('content-type', contentType)
    // .payload (a string), not .rawPayload (a Buffer): every response here is JSON text, and DOM's
    // BodyInit has no clean type for Node's Buffer. Response's constructor also throws on a body
    // paired with a status the spec says never carries one, which app.inject does not enforce for
    // its own payload the way a real HTTP stack does.
    const body = NO_BODY_STATUSES.has(injected.statusCode) ? null : injected.payload
    return new Response(body, { status: injected.statusCode, headers: responseHeaders })
  }) as typeof fetch
}
