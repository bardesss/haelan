import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'

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
 * No personId in it, like membersKey: the route answers for whoever is asking, so keying it to a
 * person would be one entry per caller under a key naming the wrong thing.
 */
export function mcpTokensKey(): readonly unknown[] { return ['mcp-tokens'] }
export function mcpCallsKey(): readonly unknown[] { return ['mcp-calls'] }

export function useMcpTokens(): UseQueryResult<{ tokens: McpTokenRow[] }> {
  return useQuery({
    queryKey: mcpTokensKey(),
    queryFn: () => apiGet<{ tokens: McpTokenRow[] }>('/api/profile/mcp-tokens'),
  })
}

/**
 * The calls made with the caller's own tokens. Invalidated by neither mutation: minting a token
 * makes no call, and revoking one does not erase the calls it already made - that is precisely the
 * point of revocation being a stamp.
 */
export function useMcpCalls(): UseQueryResult<{ calls: McpCallRow[] }> {
  return useQuery({
    queryKey: mcpCallsKey(),
    queryFn: () => apiGet<{ calls: McpCallRow[] }>('/api/profile/mcp-calls'),
  })
}

/**
 * The secret comes back in this response and in no other, ever. The card holds it in component
 * state and shows it once; nothing writes it to the cache, because a cached secret is one that
 * reappears on a later render of a screen the reader thought they had left.
 */
export function useCreateMcpToken(): UseMutationResult<MintedToken, ApiError, { label: string, days: number }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<MintedToken>('POST', '/api/profile/mcp-tokens', input),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: mcpTokensKey() }) },
  })
}

export function useRevokeMcpToken(): UseMutationResult<void, ApiError, { id: string }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => apiSend<void>('DELETE', `/api/profile/mcp-tokens/${input.id}`),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: mcpTokensKey() }) },
  })
}
