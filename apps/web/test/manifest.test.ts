import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'
import { resolveSemantic } from '@haelan/tokens'
import { renderManifest } from '../scripts/generate-manifest.ts'

const PUBLIC = fileURLToPath(new URL('../public', import.meta.url))
const MANIFEST_PATH = join(PUBLIC, 'manifest.webmanifest')
const INDEX_HTML = fileURLToPath(new URL('../index.html', import.meta.url))
const INDEX_DEMO_HTML = fileURLToPath(new URL('../index.demo.html', import.meta.url))

// A test rather than a script, the same reasoning tools-doc-drift.test.ts gives for TOOLS.md:
// renderManifest() is the same function `pnpm --filter @haelan/web manifest` calls to write the
// checked-in file, so comparing its output against that file is comparing the token source
// against itself with nothing written.
describe('manifest.webmanifest', () => {
  const checkedIn = readFileSync(MANIFEST_PATH, 'utf8')

  it('is exactly what generate-manifest.ts renders from the tokens package', () => {
    expect(renderManifest()).toBe(checkedIn)
  })

  const manifest = JSON.parse(checkedIn)

  it('installs standalone, with no service worker promising an offline app this cannot be', () => {
    expect(manifest.display).toBe('standalone')
  })

  // "." rather than "/": this file ships unmodified from public/ under whatever base the build
  // gives it - "/" for a real instance, "/haelan/demo/" for the published demo - and both
  // start_url and scope resolve against the manifest's own URL rather than the document's, so a
  // relative reference lands back on whichever of those actually served this file. An absolute
  // "/" would send an installed demo's icon back to the site root instead of the demo.
  it('points start_url and scope at its own directory rather than an absolute site root', () => {
    expect(manifest.start_url).toBe('.')
    expect(manifest.scope).toBe('.')
  })

  // Generated from the token package, not typed a third time: apps/web/index.html already
  // hardcodes this exact string twice (see below), and generate-manifest.ts's own comment says
  // why the manifest's two single-valued colour fields both take the dark, fallback one.
  it('takes theme_color and background_color from the same token the dark meta below reads', () => {
    const dark = resolveSemantic('dark')['surface-page']
    expect(dark).toBe('#0A0E17')
    expect(manifest.theme_color).toBe(dark)
    expect(manifest.background_color).toBe(dark)
  })

  it.each([['index.html', INDEX_HTML], ['index.demo.html', INDEX_DEMO_HTML]])(
    '%s hardcodes the same dark and light tokens this manifest is generated from',
    (_name, path) => {
      const html = readFileSync(path, 'utf8')
      const dark = resolveSemantic('dark')['surface-page']
      const light = resolveSemantic('light')['surface-page']
      expect(html).toContain(`content="${dark}" media="(prefers-color-scheme: dark)"`)
      expect(html).toContain(`content="${light}" media="(prefers-color-scheme: light)"`)
    },
  )

  it('links the manifest from both html entry points', () => {
    for (const path of [INDEX_HTML, INDEX_DEMO_HTML]) {
      expect(readFileSync(path, 'utf8')).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    }
  })
})

/**
 * Decodes exactly what render-icons.mjs's `png()` writes: one IHDR, one or more IDAT chunks
 * concatenated before inflating, 8-bit RGBA, and filter type 0 (none) on every scanline. This is
 * not a general PNG reader - it throws on a filter byte it does not recognise rather than
 * silently misreading one, since the only file it is ever asked to read is this repository's own
 * output.
 */
function decodePng(bytes: Buffer): { width: number, height: number, pixels: Buffer } {
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const idatParts: Buffer[] = []
  let offset = 8
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idatParts.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idatParts))
  const stride = width * 4
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    if (filter !== 0) throw new Error(`this PNG uses filter type ${filter} on row ${y}, which this decoder does not read`)
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels }
}

function pixelAt(image: { width: number, pixels: Buffer }, x: number, y: number): [number, number, number, number] {
  const i = (y * image.width + x) * 4
  return [image.pixels[i]!, image.pixels[i + 1]!, image.pixels[i + 2]!, image.pixels[i + 3]!]
}

function hexToRgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]
}

// The one genuinely new drawing decision this task makes: a maskable icon may be cropped by the
// platform to any shape, and the only region every such shape leaves alone is a centred circle at
// 80% of the icon's diameter. This does not reimplement render-icons.mjs's own safe-zone maths to
// check it - that would only prove the two copies of the same formula agree - it instead checks
// the one thing the spec actually promises: no ink outside that circle, and the mark still drawn
// inside it.
//
// "Everywhere outside" means every pixel. The first cut of this sampled one ring of 72 points at
// r = 0.4 * width + 3, which is a circle rather than a region: ink at r = 300 - a whole corner of
// the canvas - sat outside every sample and passed a test whose own name promised it had not.
// The sweep below walks all 262,144 pixels and keeps the furthest one that is not background, so
// what it reports is the actual reach of the ink rather than a verdict about 72 points.
const SAFE_ZONE_FRACTION = 0.4
// One pixel of feathering across the edge (render()'s own comment), plus room for it: the
// boundary the renderer solves for is where the stroke's own outline lands, and the feather puts
// a little colour just past it.
const FEATHER_ALLOWANCE = 3

/** The distance from the icon's centre to the furthest pixel that is not pure background. */
function inkReach(image: { width: number, height: number, pixels: Buffer }, background: [number, number, number]) {
  const center = image.width / 2
  let radius = 0
  let at = { x: 0, y: 0 }
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [r, g, b, a] = pixelAt(image, x, y)
      if (r === background[0] && g === background[1] && b === background[2] && a === 255) continue
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center)
      if (distance > radius) { radius = distance; at = { x, y } }
    }
  }
  return { radius, at }
}

describe('the maskable icon keeps its mark inside the platform safe zone', () => {
  const image = decodePng(readFileSync(join(PUBLIC, 'icon-512-maskable.png')))
  const background = hexToRgb(resolveSemantic('dark')['surface-page'])
  const boundary = SAFE_ZONE_FRACTION * image.width

  it('is pure background everywhere outside the 80%-diameter safe circle', () => {
    const { radius, at } = inkReach(image, background)
    expect(radius, `furthest ink at (${at.x}, ${at.y}), r=${radius.toFixed(2)}`)
      .toBeLessThanOrEqual(boundary + FEATHER_ALLOWANCE)
  })

  // The same sweep over the non-maskable 512, which is the mark drawn at full size rather than
  // pulled into the safe zone. Its ink reaches well past the boundary, which is what makes the
  // check above a real one rather than something every render of this mark passes for free. This
  // was a sentence in a comment claiming it had been confirmed by hand; a claim in a comment is
  // the shape of thing this whole file exists to stop trusting.
  it('is a check icon-512.png would fail, which is what makes it worth running', () => {
    const plain = decodePng(readFileSync(join(PUBLIC, 'icon-512.png')))
    const { radius } = inkReach(plain, background)
    expect(radius).toBeGreaterThan(boundary + FEATHER_ALLOWANCE)
  })

  it('still draws the mark near the centre - the sweep above is not just an empty canvas', () => {
    const center = Math.floor(image.width / 2)
    let inkFound = false
    for (let dy = -40; dy <= 40 && !inkFound; dy++) {
      for (let dx = -40; dx <= 40; dx++) {
        const [r, g, b] = pixelAt(image, center + dx, center + dy)
        if (r !== background[0] || g !== background[1] || b !== background[2]) { inkFound = true; break }
      }
    }
    expect(inkFound).toBe(true)
  })
})
