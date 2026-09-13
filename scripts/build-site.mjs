// Builds the published landing page from site/index.html. The page is hand-written HTML with
// {{slot}} markers; nothing here knows what the page says, only how a slot is filled.
//
// Usage: pnpm site:build

/**
 * Fills every {{slot}} in `template` from `values`.
 *
 * Both directions are errors rather than warnings. A slot with no value ships a page reading
 * "haelan {{version}}" to a stranger, and a value with no slot is what a renamed slot leaves
 * behind - the page then quietly stops naming the release it was built from, which is the one
 * thing on it that is supposed to be unable to go stale.
 */
export function renderPage(template, values) {
  const used = new Set()
  const out = template.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    if (!(name in values)) throw new Error(`no value for {{${name}}}`)
    used.add(name)
    return values[name]
  })
  const unused = Object.keys(values).filter((name) => !used.has(name))
  if (unused.length > 0) throw new Error(`values nothing uses: ${unused.join(', ')}`)
  return out
}
