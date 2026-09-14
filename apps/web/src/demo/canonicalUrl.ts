/**
 * One spelling per question.
 *
 * The recorder writes the manifest under these keys and the demo transport looks entries up by
 * them, so the two have to agree about what counts as the same request. `queryKeys.ts` already
 * makes exactly this reduction for the query cache, and for the same reason: a repeated `metric`
 * or `source` is a set, where order carries no meaning, and `{a, b}` and `{b, a}` are one
 * question. Two implementations of that rule agreeing today is how it breaks later, so this is
 * the only one, imported by both sides.
 */
export function canonicalUrl(url: string): string {
  const [path = '', search = ''] = url.split('?')
  if (search === '') return path

  const params = new URLSearchParams(search)
  const byKey = new Map<string, string[]>()
  for (const [key, value] of params) {
    const values = byKey.get(key)
    if (values === undefined) byKey.set(key, [value])
    else values.push(value)
  }

  const sorted = new URLSearchParams()
  for (const key of [...byKey.keys()].sort()) {
    for (const value of [...byKey.get(key)!].sort()) sorted.append(key, value)
  }

  const query = sorted.toString()
  return query === '' ? path : `${path}?${query}`
}
