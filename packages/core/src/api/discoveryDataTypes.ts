/**
 * The data type identifiers a discovery document names, which is not the same as the ones the API
 * has.
 *
 * There is no list to read. `users.dataTypes.dataPoints` takes the data type as a path parameter,
 * so the API never enumerates them, and no schema does either. What the document does carry is
 * identifiers written into rollup-value descriptions, which is why this reads prose rather than
 * structure: prose is the only place they appear.
 *
 * The consequence is a blind spot with a known shape - only rollup-capable types are named - and
 * the caller is expected to print it rather than let a clean run read as coverage.
 */
export function dataTypesNamedIn(doc: unknown): string[] {
  if (typeof doc !== 'object' || doc === null) return []
  const found = new Set<string>()
  for (const match of JSON.stringify(doc).matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)` data type/g)) {
    const id = match[1]
    if (id !== undefined) found.add(id)
  }
  return [...found].sort()
}
