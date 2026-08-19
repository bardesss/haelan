import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const ALLOWED = ['fixtures']

// Every CSS named colour. A guard that only knows about hex is a guard that
// advertises more than it does: `stroke: 'black'` used to walk straight past it.
const NAMED = [
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black', 'blanchedalmond',
  'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue',
  'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey',
  'darkkhaki', 'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon',
  'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'fuchsia',
  'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow', 'grey', 'honeydew', 'hotpink',
  'indianred', 'indigo', 'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon',
  'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey',
  'lightsteelblue', 'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen',
  'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose', 'moccasin', 'navajowhite',
  'navy', 'oldlace', 'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod', 'palegreen',
  'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple',
  'rebeccapurple', 'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
  'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke',
  'yellow', 'yellowgreen',
].join('|')

const RULES: [string, RegExp][] = [
  ['hex literal', /#[0-9a-fA-F]{3,8}\b/],
  // color-mix composes tokens rather than stating a colour, so it is allowed;
  // any literal inside one is still caught by the hex rule above.
  ['colour function', /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|device-cmyk)\s*\(|\bcolor\s*\(/],
  ['named colour in a quoted value', new RegExp(`(['"\`])(${NAMED})\\1`, 'i')],
  ['named colour in a css declaration', new RegExp(`:\\s*(${NAMED})\\s*(!important)?\\s*[;}]`, 'i')],
]

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name))
}

describe('colour discipline', () => {
  // Components must reach for semantic tokens so a theme change stays a value swap.
  it.each(RULES)('has no %s outside the fixtures', (_kind, pattern) => {
    const offenders = files(SRC)
      .filter((f) => !ALLOWED.some((a) => f.includes(a)))
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('actually catches the things it claims to catch', () => {
    const samples = ["stroke: 'black'", 'color: #fff;', 'fill: rgb(1 2 3)', 'background: oklch(0.5 0.1 200);', 'border-color: red;']
    for (const sample of samples) {
      expect(RULES.some(([, pattern]) => pattern.test(sample)), sample).toBe(true)
    }
    const allowed = ['background: var(--surface-card);', 'color-mix(in srgb, var(--accent) 13%, transparent)', "type: 'dashed'"]
    for (const sample of allowed) {
      expect(RULES.some(([, pattern]) => pattern.test(sample)), sample).toBe(false)
    }
  })
})
