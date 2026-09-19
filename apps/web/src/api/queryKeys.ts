export const queryKeys = {
  person: (personId: string): readonly unknown[] => ['person', personId],

  session: (): readonly unknown[] => ['session'],

  // Sorted entries rather than the object, because TanStack Query hashes the key structurally and
  // { a, b } and { b, a } would otherwise be two cache entries for one question. Array values are
  // sorted too, on a copy: every array parameter this API takes (a repeated metric, a sources
  // filter) is a set, where order carries no meaning. If an order-significant array parameter is
  // ever needed, it must not be passed as a raw array here, because this will reorder it.
  resource: (personId: string, resource: string, params?: Record<string, unknown>): readonly unknown[] => [
    'person', personId, resource,
    ...(params === undefined ? [] : [Object.entries(params)
      .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]),
  ],

  // /api/settings/rebuild describes every person on the instance at once, not one caller's own
  // record the way `resource` above is keyed - the same reason `membersKey` and `maintenanceKey`
  // (useMembers.ts, useMaintenance.ts) carry no personId either. Kept here rather than in a new
  // data/useRebuildHealth.ts, since RebuildHealth.tsx is the only reader and a whole module for
  // one query and no mutation would be a file for the sake of a file.
  rebuildHealth: (): readonly unknown[] => ['rebuild-health'],
} as const
