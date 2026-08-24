import type { QueryClient } from '@tanstack/react-query'
import { apiSend } from '../api/client.js'

export function submitSignOut(): Promise<void> {
  return apiSend('POST', '/api/auth/logout')
}

// Extracted from Shell so the one behaviour that actually matters here can be tested without a
// DOM, the same reason createBoundQueryClient in api/queryClient.tsx is its own function.
// queryClient.clear() looks like the obvious way to drop every signed-in query and is wrong:
// it routes to query.destroy(), which dispatches no action and notifies no observer, so the
// exact QueryObserver useSession relies on kept reporting the old session forever and the page
// only changed on some unrelated re-render. resetQueries() reaches that same observer: it drops
// the data and refetches through the observer's own queryFn, which 401s now that the server
// session is gone and lands on the sign-in branch through the ordinary error path.
export async function signOutAndResetSession(queryClient: QueryClient): Promise<{ ok: true } | { ok: false }> {
  try {
    await submitSignOut()
  } catch {
    return { ok: false }
  }
  await queryClient.resetQueries()
  return { ok: true }
}
