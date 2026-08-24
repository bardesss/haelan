import { QueryClient, QueryClientProvider, QueryCache, hashKey } from '@tanstack/react-query'
import type { Query } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError } from './client.js'
import { queryKeys } from './queryKeys.js'

export function createQueryClient(onUnauthorized: (query: Query<unknown, unknown, unknown>) => void): QueryClient {
  return new QueryClient({
    // On the cache rather than per query: a session expires between one request and the next, and
    // whichever request happens to be in flight when it does is the one that finds out.
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (error instanceof ApiError && error.kind === 'unauthorized') onUnauthorized(query)
      },
    }),
    defaultOptions: {
      queries: {
        // Retry exactly the two kinds worth retrying, and nothing else. An expired session and a
        // forbidden person are answers, not failures: retrying them delays the sign-in screen by
        // three round trips and tells the reader nothing. Everything that reaches a queryFn goes
        // through apiSend, which throws only ApiError, so anything else here is a bug in our own
        // code, and retrying a bug delays the error and triples the work.
        retry: (attempt, error) => {
          if (error instanceof ApiError && (error.kind === 'transient' || error.kind === 'unreachable')) {
            return attempt < 2
          }
          return false
        },
        // Derived data changes when a sync drains, not while the reader looks at it.
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  })
}

// Extracted from QueryProvider so the wiring can be tested without a DOM: this is the one place
// the rule "a 401 from any request returns the reader to sign-in" actually gets connected, and a
// mistake here (closing over the wrong client, or none) would be silent everywhere else.
export function createBoundQueryClient(): QueryClient {
  const created: QueryClient = createQueryClient((query) => {
    // The session query 401ing is not news to it, it is the session itself reporting that there
    // is no session: useSession's own retry: false already lets that settle into an error state.
    // Invalidating it here as well would refetch it immediately, which 401s again, which lands
    // back here, forever. Removing was worse: it deletes a query useSession's observer is still
    // watching, so on the observer's next render it rebuilds an unfetched query and refetches it
    // on the spot, the exact same loop from the other direction.
    if (hashKey(query.queryKey) === hashKey(queryKeys.session())) return

    // Any other query 401ing means the session died between one request and the next. Invalidate
    // rather than remove: invalidating leaves the query alive to be refetched through the normal
    // observer path (and, if that refetch also 401s, the check above stops it there) instead of
    // deleting a query something may still be observing.
    created.invalidateQueries({ queryKey: queryKeys.session() })
  })
  return created
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // useState rather than a module constant, so the client is created once per mount and a test
  // rendering the tree twice does not share a cache between the two.
  const [client] = useState(createBoundQueryClient)
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
