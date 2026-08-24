export const queryKeys = {
  person: (personId: string): readonly unknown[] => ['person', personId],

  session: (): readonly unknown[] => ['session'],

  // Sorted entries rather than the object, because TanStack Query hashes the key structurally and
  // { a, b } and { b, a } would otherwise be two cache entries for one question.
  resource: (personId: string, resource: string, params?: Record<string, unknown>): readonly unknown[] => [
    'person', personId, resource,
    ...(params === undefined ? [] : [Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))]),
  ],
} as const
