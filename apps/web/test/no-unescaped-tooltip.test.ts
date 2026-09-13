import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHARTS = fileURLToPath(new URL('../src/charts', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return ['.ts', '.tsx'].includes(extname(entry.name)) ? [path] : []
  })
}

/**
 * Comments go first, and this is not optional: `base.ts`'s own doc comment for `escapeHtml` quotes
 * the exact `<img src=x onerror=...>` payload it defends against, inside backticks, and would
 * otherwise be reported as the very defect it documents.
 *
 * The `[^:]` before `//` keeps a `https://` inside a string from being read as a comment and
 * swallowing the rest of its line.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * A tooltip string is the one thing this app hands a browser as raw HTML.
 *
 * `chart-tooltip-escaping.test.tsx` proves the charts it mounts are correct. This proves the SET
 * of them is, which is the part that actually failed: `Sparkline`'s tooltip interpolated a
 * household member's own note straight into `innerHTML` for the whole of the release that added
 * the escaping, because that file's list named three charts and there were four. A list of
 * examples cannot guard a property held by a directory.
 *
 * So the property is read off source instead, the same device `css-classes.test.ts` and
 * `no-raw-color.test.ts` use for the other two interfaces here that fail silently. Inside
 * `src/charts`, a template literal that contains a `<` is building markup, and one that also
 * contains a `${` is building it out of values; echarts writes the result to `innerHTML`, so
 * every one of those values has to be escaped. `tip` (base.ts) is how: it escapes each `${}` and
 * leaves the literal `<br/>` structure alone. An untagged one is the defect, whether or not the
 * values in it happen to be safe today -- `scheduleTooltip` and `hypnogramTooltip` interpolated
 * only their own formatted numbers, which is an argument about today's callers rather than about
 * the string, and the next value added to either would have inherited nothing.
 *
 * A new chart written the obvious way fails this the moment it is added, rather than the next time
 * somebody happens to audit the directory.
 */
describe('every tooltip in src/charts builds its HTML through tip', () => {
  it('leaves no untagged template literal that interpolates into markup', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(CHARTS)) {
      const source = withoutComments(readFileSync(file, 'utf8'))
      for (const match of source.matchAll(/(\w*)`([^`]*)`/g)) {
        const [, tag = '', body = ''] = match
        if (!body.includes('${') || !body.includes('<')) continue
        if (tag === 'tip') continue
        offenders.push(`${file.slice(CHARTS.length + 1)}: \`${body}\``)
      }
    }
    expect(offenders, 'these build tooltip HTML without escaping their values').toEqual([])
  })

  // The guard has to be able to fail, and its regex is doing enough work that "it passes" is not
  // evidence of that. A string with the exact shape it hunts for, checked through the same
  // matcher, so a future edit that quietly stops matching anything is caught here rather than by
  // the next unescaped tooltip.
  it('recognises the shape it is looking for', () => {
    const offending = 'return `${mark.date}<br/>${mark.text}`'
    const safe = 'return tip`${mark.date}<br/>${mark.text}`'
    const matches = (source: string): string[] =>
      [...source.matchAll(/(\w*)`([^`]*)`/g)]
        .filter(([, tag = '', body = '']) => body.includes('${') && body.includes('<') && tag !== 'tip')
        .map(([m]) => m)

    expect(matches(offending)).toHaveLength(1)
    expect(matches(safe)).toHaveLength(0)
  })
})
