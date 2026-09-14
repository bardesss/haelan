import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))
const INDEX_HTML = fileURLToPath(new URL('../index.html', import.meta.url))
const BRAND = fileURLToPath(new URL('../../../assets/brand', import.meta.url))
const MANIFEST = fileURLToPath(new URL('../public/manifest.webmanifest', import.meta.url))

/**
 * What a file's first bytes say it is, rather than what its name says it is.
 *
 * This exists because the two are not the same thing and nothing here used to check. The first
 * cut of this mark shipped two JPEGs named `.png`, linked with `type="image/png"`, and every
 * check passed: a name is not evidence, a `type` attribute is a claim the author makes, and the
 * only thing that actually decides how a byte stream renders is the byte stream. So this reads
 * the signature and compares it against both of the places the format is asserted.
 */
function sniff(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x00010000) return 'image/vnd.microsoft.icon'
  if (bytes.subarray(0, 400).toString('utf8').includes('<svg')) return 'image/svg+xml'
  return 'unknown'
}

const BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.ico': 'image/vnd.microsoft.icon',
  '.svg': 'image/svg+xml',
}

function imageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) in BY_EXTENSION)
    .map((entry) => join(dir, entry.name))
}

describe('every shipped icon is the format its name claims', () => {
  it.each([...imageFiles(PUBLIC), ...imageFiles(BRAND)])('%s', (path) => {
    expect(sniff(readFileSync(path))).toBe(BY_EXTENSION[extname(path)])
  })
})

describe('index.html describes the icons it links', () => {
  const html = readFileSync(INDEX_HTML, 'utf8')

  /** Each `<link rel="...icon...">`, with the href and the type it declares. */
  const links = [...html.matchAll(/<link\s+[^>]*rel="[^"]*icon[^"]*"[^>]*>/g)].map((tag) => ({
    tag: tag[0],
    href: /href="([^"]+)"/.exec(tag[0])?.[1],
    type: /type="([^"]+)"/.exec(tag[0])?.[1],
  }))

  it('links at least the svg, the ico and the apple touch icon', () => {
    expect(links.map((link) => link.href).sort())
      .toEqual(['/apple-touch-icon.png', '/favicon.ico', '/favicon.svg'])
  })

  it.each(links)('$href exists and is what the link says it is', ({ href, type }) => {
    const bytes = readFileSync(join(PUBLIC, href!.replace(/^\//, '')))
    const actual = sniff(bytes)
    expect(actual).not.toBe('unknown')
    // A `type` is optional on a <link rel="icon">, but a wrong one is worse than none: it is the
    // claim a browser reads before it fetches anything.
    if (type !== undefined) expect(type).toBe(actual)
  })

  // 185KB of JPEG for a tab icon is what the first cut cost. The mark is two paths; there is no
  // size at which that needs kilobytes, and a budget is the only thing that notices a regression
  // back to a raster export.
  it.each(links)('$href is small enough to be a mark rather than a photograph', ({ href }) => {
    const bytes = readFileSync(join(PUBLIC, href!.replace(/^\//, '')))
    expect(bytes.length).toBeLessThan(16 * 1024)
  })
})

interface ManifestIcon { src: string, sizes: string, type: string, purpose: string }

describe('manifest.webmanifest names icons that exist and are what it says they are', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { icons: ManifestIcon[] }

  it('names exactly the 192, 512 and maskable 512 sizes a manifest needs', () => {
    expect(manifest.icons.map((icon) => icon.src).sort())
      .toEqual(['icon-192.png', 'icon-512-maskable.png', 'icon-512.png'])
  })

  it.each(manifest.icons)('$src exists and is what the manifest says it is', ({ src, type }) => {
    const bytes = readFileSync(join(PUBLIC, src))
    const actual = sniff(bytes)
    expect(actual).not.toBe('unknown')
    expect(type).toBe(actual)
  })

  // Same budget and the same reason as index.html's own icons above: 185KB of JPEG is what an
  // exported raster cost the first time, and there is no size the mark's own two paths should
  // ever reach - a 512px canvas included.
  it.each(manifest.icons)('$src is small enough to be a mark rather than a photograph', ({ src }) => {
    const bytes = readFileSync(join(PUBLIC, src))
    expect(bytes.length).toBeLessThan(16 * 1024)
  })
})

describe('the ico carries the sizes a browser chooses between', () => {
  const ico = readFileSync(join(PUBLIC, 'favicon.ico'))
  const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const offset = 6 + i * 16
    return { width: ico[offset] === 0 ? 256 : ico[offset]!, bits: ico.readUInt16LE(offset + 6) }
  })

  it('holds 16, 32 and 48', () => {
    expect(entries.map((entry) => entry.width).sort((a, b) => a - b)).toEqual([16, 32, 48])
  })

  // 24bpp is what the first cut shipped, and it is why the mark sat on an opaque block in the
  // tab strip instead of on the browser's own chrome.
  it('has an alpha channel in every size', () => {
    for (const entry of entries) expect(entry.bits).toBe(32)
  })
})
