import { ApiError } from '../api/apiError.js'
import { canonicalUrl } from './canonicalUrl.js'
import { applyOverlay, createOverlay, writeThrough } from './overlay.js'

export { ApiError } from '../api/apiError.js'
export type { ApiErrorKind } from '../api/apiError.js'

/** Reads one fixture file, relative to wherever the caller keeps the capture. Swapped out in
 *  tests so createDemoTransport can be driven from a plain object instead of a real fetch. */
export type LoadJson = (file: string) => Promise<unknown>

export interface DemoTransport {
  apiGet: <T>(path: string) => Promise<T>
  apiSend: <T>(method: string, path: string, body?: unknown) => Promise<T>
}

/**
 * Answers `apiGet`/`apiSend` from a recorded manifest instead of a network, with the same
 * signatures as `apps/web/src/api/client.ts` so nothing that calls them can tell the difference.
 *
 * `loadJson` is injected rather than hard-coded to `fetch` so this can be driven by a plain
 * object in `apps/web/test/demo-client.test.ts` - the manifest and its files are just data, and
 * the module-level transport below is the only thing that hard-codes how they are actually
 * fetched.
 */
export function createDemoTransport(loadJson: LoadJson): DemoTransport {
  // Cached as the promise itself, not its resolved value: two reads that both arrive before the
  // first load settles must still share one fetch, or "loads the manifest once" would depend on
  // timing rather than being true by construction.
  let manifest: Promise<Record<string, string>> | null = null

  // One overlay per transport, not one per module: apps/web/test/demo-overlay.test.ts and
  // demo-client.test.ts each build their own transport and must not see each other's writes, the
  // same isolation createDemoTransport already gives the manifest cache above.
  const overlay = createOverlay()

  function loadManifest(): Promise<Record<string, string>> {
    if (manifest === null) {
      manifest = (loadJson('manifest.json') as Promise<Record<string, string>>).catch((error: unknown) => {
        // A transient failure must not become a permanent one. Caching the rejected promise
        // forever would fail every later read for a reason that may already have gone away (the
        // static host hiccuped once), with nothing short of a full page reload able to recover -
        // clearing the cache here lets the next read retry from scratch, while the success path
        // above still shares one promise across every reader that arrives before it settles.
        manifest = null
        throw error
      })
    }
    return manifest
  }

  async function readCaptured<T>(path: string): Promise<T> {
    const files = await loadManifest()
    const key = canonicalUrl(path)
    const file = files[key]
    if (file === undefined) {
      // The UI already renders this kind (WorkoutDetail.tsx, Shell.tsx): a page the recorder
      // never captured must fail the same way a real 404 would, not hang or return nothing.
      throw new ApiError('not_found', 404, `the demo has no recorded response for ${path}`)
    }
    const captured = await loadJson(file)
    // Composed over the captured response, not in place of it: a write this session made (a
    // note, an exclusion, a rename) has to show up the moment the page that wrote it refetches,
    // which is exactly what invalidateAffected and invalidateResource (useAnnotations.ts) expect
    // a refetch to answer.
    return applyOverlay(path, captured, overlay) as T
  }

  async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
    // The recorder only ever captured GETs (a sweep of pages, not of writes), so a write has no
    // manifest entry to answer from and goes to the overlay instead - the one thing in this
    // transport that can actually change between two reads.
    if (method !== 'GET') return writeThrough(method, path, body, overlay) as T
    return readCaptured<T>(path)
  }

  function apiGet<T>(path: string): Promise<T> {
    return apiSend<T>('GET', path)
  }

  return { apiGet, apiSend }
}

/**
 * Fetches one fixture file from the built bundle, relative to BASE_URL rather than the origin
 * root so the demo still resolves its own fixtures when served under a sub-path (/haelan/demo/
 * today). vite.demo.config.ts's demoFixtures plugin is what puts them at demo-api/ in the first
 * place.
 *
 * Exported, not just used to build the module-level transport below, so
 * apps/web/test/demo-client.test.ts can drive it directly against a stubbed `fetch` and prove
 * both failure paths land on `ApiError`: a thrown fetch (the network, or here the static host,
 * never answering) and a response that arrives but will not parse are two different failures and
 * must not collapse into the same kind, but neither may propagate as a raw error - every caller's
 * `instanceof ApiError` narrowing (queryClient.tsx's retry predicate, Shell.tsx's error branch) has
 * to see one of the two, exactly as api/client.ts's own apiSend guarantees for a real instance.
 */
export async function loadFromBundle(file: string): Promise<unknown> {
  const url = `${import.meta.env.BASE_URL}demo-api/${file}`
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    // Mirrors api/client.ts's identical catch: a thrown fetch is never a status, so it must not
    // be folded into the response-based handling below.
    throw new ApiError('unreachable', null, `failed to reach demo fixture ${file}`)
  }

  if (!response.ok) {
    // Not a status this transport ever answers with for a captured response - reaching here means
    // the fixture files themselves failed to ship, which is a build problem, not a "not in the
    // demo" one.
    throw new ApiError('unreachable', response.status, `failed to load demo fixture ${file} (${response.status})`)
  }

  try {
    return await response.json()
  } catch {
    // The host answered but the body would not parse - a corrupt or truncated fixture shipped
    // with the build. Not the network failure above, and not the "nobody recorded this" miss
    // readCaptured throws for a genuine manifest gap, so it gets the kind api/client.ts uses for
    // the same shape of failure: an answer that arrived but cannot be trusted.
    throw new ApiError('transient', response.status, `demo fixture ${file} did not parse`)
  }
}

const defaultTransport = createDemoTransport(loadFromBundle)

export function apiGet<T>(path: string): Promise<T> {
  return defaultTransport.apiGet<T>(path)
}

export function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  return defaultTransport.apiSend<T>(method, path, body)
}
