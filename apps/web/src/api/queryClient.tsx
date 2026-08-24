import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError } from './client.js'
import { queryKeys } from './queryKeys.js'

export function createQueryClient(onUnauthorized: () => void): QueryClient {
  return new QueryClient({
    // On the cache rather than per query: a session expires between one request and the next, and
    // whichever request happens to be in flight when it does is the one that finds out.
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof ApiError && error.kind === 'unauthorized') onUnauthorized()
      },
    }),
    defaultOptions: {
      queries: {
        // An expired session and a forbidden person are answers, not failures to retry. Retrying
        // them delays the sign-in screen by three round trips and tells the reader nothing.
        retry: (attempt, error) => {
          if (error instanceof ApiError && error.kind !== 'transient' && error.kind !== 'unreachable') return false
          return attempt < 2
        },
        // Derived data changes when a sync drains, not while the reader looks at it.
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  })
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // useState rather than a module constant, so the client is created once per mount and a test
  // rendering the tree twice does not share a cache between the two.
  const [client] = useState(() => {
    const created: QueryClient = createQueryClient(() => {
      // Dropping the session entry is enough: useSession refetches, gets its own 401, and the shell
      // renders the sign-in screen. Telling the shell directly would be a second path to the same
      // state, and the two would eventually disagree.
      created.removeQueries({ queryKey: queryKeys.session() })
    })
    return created
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
