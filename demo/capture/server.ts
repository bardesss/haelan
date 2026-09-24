// The bridge that makes the demo possible: a real Fastify instance, built the same way
// apps/server/src/index.ts builds one in production, booted against a seeded directory and
// exposed as something a browser-shaped `fetch` can call - through `app.inject()`, so no port and
// no network are ever involved. Task 3 installs `fetch` below as `globalThis.fetch` and mounts a
// real page against it; whatever that page asks for lands here, is answered from the seeded data,
// and is recorded under its canonical URL for the demo build to replay later.
// A deep relative import, not '@haelan/core': this directory has no package.json of its own, so
// there is nothing for a bare specifier to resolve against - the same situation
// scripts/seed-demo.mjs is in, and packages/core/src/index.ts's own comment on that script
// explains why (only a package that declares @haelan/core as a dependency gets that resolution).
import { openHaelan } from '../../packages/core/src/instance.ts'
import { buildServer } from '../../apps/server/src/app.ts'
import { canonicalUrl } from '../../apps/web/src/demo/canonicalUrl.ts'
import { DEMO_CLOCK_MS } from '../../apps/web/src/demo/instant.ts'

// The seed's own credentials (scripts/seed-demo.mjs), printed by that script and repeated in the
// README: correct for a throwaway directory that script just wrote, wrong for anything else.
const USERNAME = 'demo'
const PASSWORD = 'demodemo'

export interface CaptureServer {
  fetch: typeof globalThis.fetch
  personId: string
  recorded: Map<string, unknown>
  close(): void
}

export async function startCaptureServer(dataDir: string): Promise<CaptureServer> {
  const instance = openHaelan(dataDir)
  const app = buildServer({
    instance,
    dataDir,
    // Pinned, never Date.now(): a live clock would make the capture - and so the demo it feeds -
    // depend on the day it happened to run. DEMO_CLOCK_MS rather than DEMO_INSTANT_MS since M9b:
    // the glance computes today from this clock, and the archive's exclusive close reads as a day
    // nothing was seeded for, so the Dashboard would have been captured for an empty day. Midday on
    // the last seeded day is the instant the demo browser runs at too, so server and page agree
    // on which day it is.
    now: () => DEMO_CLOCK_MS,
    // Nothing in a capture run may reach Google. The seeded refresh token is one Google never
    // issued (see seed-demo.mjs), so this turns an attempt into an immediate, loud failure rather
    // than a network call that might occasionally succeed against a stub.
    fetch: () => { throw new Error('the capture must not reach the network') },
    // No bundle to serve: this run only answers API calls, so webRoot is left unset entirely
    // (registerStatic never runs) rather than pointed at a directory that may not exist.
  })
  await app.ready()

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: USERNAME, password: PASSWORD },
  })
  if (login.statusCode !== 200) {
    throw new Error(`the seeded credentials did not sign in: ${login.statusCode} ${login.body}`)
  }
  const sessionCookie = login.cookies.find((c) => c.name === 'haelan_session')
  if (!sessionCookie) throw new Error('login succeeded but set no session cookie')
  const { personId } = login.json() as { personId: string }

  const recorded = new Map<string, unknown>()

  const captureFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input)
    const method = init?.method ?? 'GET'
    // A non-GET request would mutate the seeded database that every later page mount reads from.
    // Refusing it here, at the bridge, means no page under Task 3's sweep can do that by accident.
    if (method !== 'GET') {
      throw new Error(`the capture answers only GET, and a page asked for ${method} ${url}`)
    }

    const reply = await app.inject({ method: 'GET', url, cookies: { haelan_session: sessionCookie.value } })
    // A non-200 recorded as-is would replay later as a broken page nobody mounting the demo could
    // explain - refusing here, loudly, is what makes Task 3's sweep notice a route it got wrong.
    if (reply.statusCode !== 200) {
      throw new Error(`${url} answered ${reply.statusCode}; a recorded error renders as a page nobody can explain`)
    }

    // reply.json() throws on a non-JSON body, which is the third refusal this bridge owns.
    const body = reply.json()
    recorded.set(canonicalUrl(url), body)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  return {
    fetch: captureFetch,
    personId,
    recorded,
    close: () => {
      // Not awaited: CaptureServer.close() is synchronous by contract (Task 3 calls it the same
      // way the test's afterAll does, with nothing to await), and nothing here ever listen()s, so
      // there is no socket for a caller to wait on. instance.close() below is the part that
      // matters for cleanup ordering - see the test's own comment on why it must run before
      // rmSync. Firing app.close() first and returning before it settles is safe only because
      // this server registers no onClose hook that touches the database (registerStatic, the one
      // route family that might, never runs here since webRoot is unset) - if a future change
      // adds one, instance.close() below could race it.
      void app.close()
      instance.close()
    },
  }
}
