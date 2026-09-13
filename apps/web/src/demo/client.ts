import { ApiError } from '../api/apiError.js'
import { canonicalUrl } from './canonicalUrl.js'

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

  function loadManifest(): Promise<Record<string, string>> {
    if (manifest === null) manifest = loadJson('manifest.json') as Promise<Record<string, string>>
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
    return loadJson(file) as Promise<T>
  }

  async function apiSend<T>(method: string, path: string, _body?: unknown): Promise<T> {
    // The recorder only ever captured GETs (a sweep of pages, not of writes). A write reaching
    // this far is a miss until Task 6's overlay layers on top of this transport.
    if (method !== 'GET') {
      throw new ApiError('not_found', 404, `the demo has no recorded response for ${method} ${path}`)
    }
    return readCaptured<T>(path)
  }

  function apiGet<T>(path: string): Promise<T> {
    return apiSend<T>('GET', path)
  }

  return { apiGet, apiSend }
}

// The path the demo build's fixtures land at (vite.demo.config.ts's demoFixtures plugin copies
// demo/capture/out/ there). Relative to BASE_URL rather than the origin root, so the demo still
// resolves its own fixtures when served under a sub-path (/haelan/demo/ today).
async function loadFromBundle(file: string): Promise<unknown> {
  const response = await fetch(`${import.meta.env.BASE_URL}demo-api/${file}`)
  if (!response.ok) {
    // Not a status this transport ever answers with for a captured response - reaching here means
    // the fixture files themselves failed to ship, which is a build problem, not a "not in the
    // demo" one.
    throw new ApiError('unreachable', null, `failed to load demo fixture ${file} (${response.status})`)
  }
  return response.json()
}

const defaultTransport = createDemoTransport(loadFromBundle)

export function apiGet<T>(path: string): Promise<T> {
  return defaultTransport.apiGet<T>(path)
}

export function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  return defaultTransport.apiSend<T>(method, path, body)
}
