import { useSyncExternalStore } from 'react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'

/**
 * The path prefix this bundle is served under, '' for a bundle that owns its origin.
 *
 * A real instance serves the app at the root and this stays empty, which is why every existing
 * caller is unaffected. The demo build is served under a prefix (/haelan/demo/ today, /demo/
 * behind a domain later), and so is any instance behind a reverse proxy that mounts it under a
 * sub-path - the second case is why this lives in the router rather than in the demo's own code.
 *
 * Vite sets import.meta.env.BASE_URL from the `base` build option and it always ends in a slash;
 * normalising to a prefix with no trailing slash means withBase can concatenate without thinking
 * about double slashes.
 */
function normalizeBase(raw: string): string {
  return raw.replace(/\/+$/, '')
}

let base = normalizeBase(import.meta.env?.BASE_URL ?? '')

/** Exported for router-base.test.tsx, the same way subscribeForTest is: the base is decided at
 *  build time, so a test cannot otherwise exercise the branch a real instance never takes. */
export function setBaseForTest(value: string): void {
  base = normalizeBase(value)
}

/** An app-relative path as the browser should see it. */
export function withBase(path: string): string {
  return base === '' ? path : `${base}${path}`
}

/** The browser's path as the app should see it. The segment-boundary check matters: '/demo' must
 *  not swallow the first five characters of '/demonstration'. */
function stripBase(path: string): string {
  if (base === '' || !path.startsWith(base)) return path
  const rest = path.slice(base.length)
  if (rest === '') return '/'
  return rest.startsWith('/') ? rest : path
}

const normalize = (value: string) => (value.split('?')[0] ?? '').replace(/\/+$/, '') || '/'

export function routeParams(pattern: string, path: string): Record<string, string> | null {
  const want = normalize(pattern).split('/')
  const got = normalize(path).split('/')
  if (want.length !== got.length) return null
  const params: Record<string, string> = {}
  for (let at = 0; at < want.length; at += 1) {
    const segment = want[at]!
    if (segment.startsWith(':')) {
      const value = got[at]!
      if (value === '') return null
      try {
        params[segment.slice(1)] = decodeURIComponent(value)
      } catch {
        return null
      }
      continue
    }
    if (segment !== got[at]) return null
  }
  return params
}

export function matchRoute(pattern: string, path: string): boolean {
  return routeParams(pattern, path) !== null
}

export function readQuery(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
}

// A null value removes the key, so a control clearing a filter does not have to rebuild the
// string itself and cannot leave `?range=` behind.
export function withQuery(path: string, patch: Record<string, string | null>): string {
  const [base = '', search = ''] = path.split('?')
  const params = readQuery(search)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  const query = params.toString()
  return query === '' ? base : `${base}?${query}`
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

// pushState does not fire popstate, and neither does replaceState, so navigate tells the
// subscribers itself either way.
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const target = withBase(to)
  if (options.replace === true) window.history.replaceState(null, '', target)
  else window.history.pushState(null, '', target)
  for (const listener of listeners) listener()
}

// Exported for the router's own test. useSyncExternalStore subscribes through this, and the
// test needs to prove replaceState notifies as well as pushState, which nothing else observes.
export function subscribeForTest(listener: () => void): () => void {
  return subscribe(listener)
}

/**
 * Brings the element the URL's fragment names into view, if there is one.
 *
 * The browser does this itself only for a real page load or a plain anchor click; navigate() is
 * pushState, which moves the URL and never scrolls. So a Link to "/account#sources" lands at the
 * top of the account page unless something asks. Called by the page that owns the target when it
 * mounts, and by the status panel after its own link, because with the reader already on /account
 * nothing mounts and useRoute (pathname and search, no fragment) does not change either.
 */
export function scrollToHashTarget(): void {
  if (typeof window === 'undefined') return
  // decodeURIComponent throws URIError on a malformed escape (#%E0), and the fragment is whatever
  // the address bar holds. The Account page calls this on mount, so a throw would take the page
  // down for a typo in a URL; a fragment that cannot be decoded names no element anyway.
  let id: string
  try {
    id = decodeURIComponent(window.location.hash.slice(1))
  } catch {
    return
  }
  if (id === '') return
  document.getElementById(id)?.scrollIntoView({ block: 'start' })
}

export function useRoute(): string {
  return useSyncExternalStore(
    subscribe,
    () => stripBase(window.location.pathname) + window.location.search,
    // The server renders no route sensitive markup, so the snapshot on the server is the root.
    () => '/',
  )
}

export function Link({ to, className, children, ...rest }: {
  to: string
  className?: string
  children: ReactNode
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  return (
    <a
      href={withBase(to)}
      className={className}
      onClick={(event) => {
        // A modified click is the reader asking for a new tab, which is the browser's job.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        navigate(to)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}
