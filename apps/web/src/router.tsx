import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'

export function matchRoute(pattern: string, path: string): boolean {
  const normalize = (value: string) => (value.split('?')[0] ?? '').replace(/\/+$/, '') || '/'
  return normalize(pattern) === normalize(path)
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
