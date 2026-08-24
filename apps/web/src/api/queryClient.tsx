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
  const created: QueryClient = createQueryClient(() => {
    // Dropping the session entry is enough: useSession refetches, gets its own 401, and the shell
    // renders the sign-in screen. Telling the shell directly would be a second path to the same
    // state, and the two would eventually disagree.
    created.removeQueries({ queryKey: queryKeys.session() })
  })
  return created
}

export function QueryProvider({ children }: { children: ReactNode }) {
  // useState rather than a module constant, so the client is created once per mount and a test
  // rendering the tree twice does not share a cache between the two.
  const [client] = useState(createBoundQueryClient)
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
