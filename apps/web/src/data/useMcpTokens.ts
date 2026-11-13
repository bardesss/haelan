import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { queryKeys } from '../api/queryKeys.js'
import { useSession } from '../auth/session.js'

export interface McpTokenRow {
  id: string
  label: string
  createdAtMs: number
  expiresAtMs: number
  lastUsedAtMs: number | null
  revokedAtMs: number | null
  // Null while live, and on a row revoked before the server recorded why.
  revokedReason: 'manual' | 'password_changed' | 'password_reset' | null
}

export interface McpCallRow {
  id: string
  tokenId: string
  atMs: number
  tool: string | null
  rowCount: number | null
  durationMs: number | null
  outcome: 'ok' | 'error' | 'refused'
}

export interface MintedToken { token: McpTokenRow, secret: string }

/**
 * Shared by the query and both mutations' invalidations, so all three agree on one cache entry.
 * The key carries the person so a sign-in as someone else never reads the previous person's list.
 */
export function mcpTokensKey(personId: string): readonly unknown[] { return queryKeys.resource(personId, 'mcp-tokens') }
export function mcpCallsKey(personId: string): readonly unknown[] { return queryKeys.resource(personId, 'mcp-calls') }

export function useMcpTokens(): UseQueryResult<{ tokens: McpTokenRow[] }> {
  const personId = useSession().data?.personId
  return useQuery({
    queryKey: mcpTokensKey(personId ?? ''),
    queryFn: () => apiGet<{ tokens: McpTokenRow[] }>('/api/profile/mcp-tokens'),
    enabled: personId !== undefined,
  })
}

/**
 * The calls made with the caller's own tokens. Invalidated by neither mutation: minting a token
 * makes no call, and revoking one does not erase the calls it already made - that is precisely the
 * point of revocation being a stamp.
 */
export function useMcpCalls(): UseQueryResult<{ calls: McpCallRow[] }> {
  const personId = useSession().data?.personId
  return useQuery({
    queryKey: mcpCallsKey(personId ?? ''),
    queryFn: () => apiGet<{ calls: McpCallRow[] }>('/api/profile/mcp-calls'),
    enabled: personId !== undefined,
  })
}

/**
 * The secret comes back in this response and in no other, ever. The card holds it in component
 * state and shows it once; nothing writes it to the cache, because a cached secret is one that
 * reappears on a later render of a screen the reader thought they had left.
 */
export function useCreateMcpToken(): UseMutationResult<MintedToken, ApiError, { label: string, days: number }> {
  const queryClient = useQueryClient()
  const personId = useSession().data?.personId
  return useMutation({
    mutationFn: (input) => apiSend<MintedToken>('POST', '/api/profile/mcp-tokens', input),
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: mcpTokensKey(personId) })
    },
  })
}

export function useRevokeMcpToken(): UseMutationResult<void, ApiError, { id: string }> {
  const queryClient = useQueryClient()
  const personId = useSession().data?.personId
  return useMutation({
    mutationFn: (input) => apiSend<void>('DELETE', `/api/profile/mcp-tokens/${input.id}`),
    onSuccess: () => {
      if (personId !== undefined) void queryClient.invalidateQueries({ queryKey: mcpTokensKey(personId) })
    },
  })
}
