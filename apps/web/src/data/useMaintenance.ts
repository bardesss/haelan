import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'
import { apiGet, apiSend } from '../api/client.js'
import type { ApiError } from '../api/client.js'
import { useSession } from '../auth/session.js'

// Mirrors DatabaseBloat in packages/core/src/db/maintenance.ts, which the route sends whole, the
// same choice useSourceNames.ts makes for NamedSource and for the same reason: apps/web imports
// only @haelan/core's browser safe subpaths, never its root export, because the root pulls
// better-sqlite3 and drizzle into the browser bundle, and this shape is declared nowhere a
// browser safe subpath could reach it.
export interface DatabaseBloat {
  fileBytes: number
  liveBytes: number
  freeBytes: number
  freeFraction: number
}

// Mirrors Omit<BackupFile, 'path'> in packages/core/src/backup/runBackup.ts -- withoutPath in
// apps/server/src/routes/maintenance.ts strips path server side, on purpose, so it is not part of
// either response this shape describes.
export interface CompletedBackup {
  name: string
  takenAtMs: number
  bytes: number
}

/** What GET /api/settings/maintenance answers: the figures a household needs to judge both units. */
export interface MaintenanceStatus {
  bloat: DatabaseBloat
  backups: CompletedBackup[]
  keep: number
  intervalHours: number
  // Mirrors the route's own vacuumBlocked: true only for the one reason worth surfacing before a
  // click, not_enough_disk (the route's own comment on why below_fraction/below_floor are not
  // routed through this flag -- freeFraction and freeBytes above already say those for themselves).
  vacuumBlocked: boolean
}

// Mirrors VacuumDecision/VacuumOutcome's own reason union in packages/core/src/db/vacuum.ts.
export type VacuumDeclineReason = 'below_fraction' | 'below_floor' | 'not_enough_disk'

// Mirrors VacuumOutcome in packages/core/src/db/vacuum.ts.
export type VacuumOutcome =
  | { ran: true, before: DatabaseBloat, after: DatabaseBloat, reclaimedBytes: number, ms: number }
  | { ran: false, reason: VacuumDeclineReason, bloat: DatabaseBloat }

/**
 * Shared by the query and both mutations' invalidation, so all three agree on one cache entry.
 * No personId, the same reason membersKey (useMembers.ts) carries none: the figures behind
 * /api/settings/maintenance describe the one database file the whole household shares, not
 * anything scoped to the caller, and app.requireAdmin is what restricts who may ask at all.
 */
export function maintenanceKey(): readonly unknown[] {
  return ['maintenance']
}

/**
 * The bloat figures, the completed backups and the retention settings. Admin only: the route
 * answers 'forbidden' to anyone else, which is why Settings.tsx mounts Maintenance.tsx at all
 * only when session.data?.isAdmin is true rather than relying on this hook to hide its own
 * failure -- the same split useMembers.ts documents for its own route.
 */
export function useMaintenanceStatus(): UseQueryResult<MaintenanceStatus, ApiError> {
  const session = useSession()
  return useQuery({
    queryKey: maintenanceKey(),
    enabled: session.data !== undefined,
    queryFn: () => apiGet<MaintenanceStatus>('/api/settings/maintenance'),
  })
}

/** A backup taken by hand, outside the nightly schedule. Invalidates the status so the new file counts toward `keep` and `backups` on screen without a manual refresh. */
export function useBackupNow(): UseMutationResult<CompletedBackup, ApiError, void> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiSend<CompletedBackup>('POST', '/api/settings/maintenance/backup'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: maintenanceKey() })
    },
  })
}

/**
 * A vacuum run outside the once-per-boot schedule. Always resolves -- a declined reclaim is a 200
 * with `ran: false`, never a thrown ApiError, the same contract vacuumIfBloated itself documents
 * (packages/core/src/db/vacuum.ts) -- so `reclaim.isError` here means the request itself failed,
 * not that the vacuum declined.
 */
export function useReclaimSpace(): UseMutationResult<VacuumOutcome, ApiError, void> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiSend<VacuumOutcome>('POST', '/api/settings/maintenance/reclaim'),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: maintenanceKey() })
    },
  })
}
