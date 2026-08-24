import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

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
      params[segment.slice(1)] = decodeURIComponent(value)
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

// pushState does not fire popstate, so navigate tells the subscribers itself.
export function navigate(to: string): void {
  window.history.pushState(null, '', to)
  for (const listener of listeners) listener()
}

export function useRoute(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname + window.location.search,
    // The server renders no route sensitive markup, so the snapshot on the server is the root.
    () => '/',
  )
}

export function Link({ to, className, children }: {
  to: string
  className?: string
  children: ReactNode
}) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        // A modified click is the reader asking for a new tab, which is the browser's job.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        navigate(to)
      }}
    >
      {children}
    </a>
  )
}
