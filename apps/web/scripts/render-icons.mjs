// Renders the brand mark's geometry to the raster icons a browser cannot get from an SVG.
//
// Run with `pnpm --filter @haelan/web icons`. The mark is round-capped, round-joined strokes over
// straight segments, so exact coverage is available analytically: the stroked shape is the set of
// points within halfWidth of the polyline, and distance-to-polyline is min over segments. That is
// why there is no rasteriser dependency here, and why the output is the mark's own geometry
// rather than a trace of an exported image.
//
// GEOMETRY is the single source of truth. src/components/BrandMark.tsx, public/favicon.svg and
// ../../assets/brand/mark.svg carry the same two paths written out as SVG path data, because
// neither a React component, a tab icon nor a README can read this file at runtime;
// test/brand-mark.test.ts asserts the four never drift apart.
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'

const STEMS = [[[5, 4], [5, 20]], [[19, 4], [19, 20]]]

// A QRS complex, not a zigzag: small dip, tall narrow upstroke, deeper downstroke, return. The
// asymmetry is what reads as a pulse — an equal peak and valley reads as a W — and the small dip
// in front is what stops the upstroke reading as a bare lambda. The apex stops short of the stem
// tops so the middle does not crowd them, and the spike and the trough straddle x=12 so the
// weight sits on the crossbar's centre rather than to one side of it.
const PULSE = [[5, 12], [8.9, 12], [9.8, 13.5], [11.2, 7.3], [13, 15.9], [14, 12], [19, 12]]

export const GEOMETRY = [...STEMS, PULSE]

/** The same two shapes as SVG path data, for the three files that must write them out. */
export const PATHS = {
  stems: 'M5 4v16M19 4v16',
  pulse: 'M5 12h3.9l.9 1.5 1.4-6.2 1.8 8.6 1-3.9H19',
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function distanceToMark(px, py, geometry) {
  let best = Infinity
  for (const line of geometry) {
    for (let i = 0; i + 1 < line.length; i++) {
      best = Math.min(best, distanceToSegment(px, py, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]))
    }
  }
  return best
}

const MARK_CENTER = [12, 12]

// The four stem corners - (5,4), (19,4), (5,20) and (19,20) - are the farthest any point of the
// mark's own polyline sits from its centre: sqrt(7^2 + 8^2) in this 24-unit space. Every other
// vertex (the pulse's own endpoints included) is closer in.
const FARTHEST_VERTEX_FROM_CENTER = Math.hypot(7, 8)

/**
 * How far in to pull the mark, about its own centre, so a maskable icon's ink stays inside the
 * platform's safe zone.
 *
 * A maskable icon may be cropped by the platform to any shape it chooses - a circle, a squircle,
 * a rounded square - and the one region every such shape leaves alone is a centred circle at 80%
 * of the icon's diameter (the "safe zone" maskable.app and Android's adaptive-icon guidance both
 * specify). render() draws GEOMETRY straight to the canvas for every other icon here, which is
 * the right answer for an icon the platform does not crop - but it puts those four stem corners
 * at radius 10.630, past this 9.6 boundary, so a maskable icon needs a genuinely different render
 * rather than the same one with a different `purpose` label.
 *
 * The round cap on each stem end bleeds a further strokeWidth/2 outward past the vertex itself
 * (in this same 24-unit space, since render() converts both the geometry and the stroke width by
 * the one pixel scale below), so what has to clear the boundary is the vertex distance plus that
 * half-width, not the bare vertex - hence solving for the scale that pins
 * `FARTHEST_VERTEX_FROM_CENTER * scale + strokeWidth / 2` to the safe zone's radius exactly,
 * rather than pinning the vertex alone and letting the cap bleed past it.
 */
function scaleForSafeZone(strokeWidth) {
  const safeZoneRadius = 0.4 * 24 // 80% diameter, in the mark's own 24-unit coordinate space
  return (safeZoneRadius - strokeWidth / 2) / FARTHEST_VERTEX_FROM_CENTER
}

/** GEOMETRY, scaled toward `center` - what a maskable render draws instead of the mark as-is. */
function pulledToward(center, scale, geometry) {
  return geometry.map((line) => line.map(([x, y]) => [
    center[0] + (x - center[0]) * scale,
    center[1] + (y - center[1]) * scale,
  ]))
}

/** RGBA pixels. A null `background` leaves the ground transparent. */
function render(size, strokeWidth, ink, background, geometry = GEOMETRY) {
  const scale = size / 24
  const half = (strokeWidth / 2) * scale
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = distanceToMark((x + 0.5) / scale, (y + 0.5) / scale, geometry) * scale
      // One pixel of feathering across the edge: the coverage a scanline rasteriser approximates
      // by supersampling, without the sampling noise.
      const coverage = Math.max(0, Math.min(1, half - distance + 0.5))
      const i = (y * size + x) * 4
      if (background) {
        for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(background[c] + (ink[c] - background[c]) * coverage)
        pixels[i + 3] = 255
      } else {
        for (let c = 0; c < 3; c++) pixels[i + c] = ink[c]
        pixels[i + 3] = Math.round(coverage * 255)
      }
    }
  }
  return pixels
}

function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function png(size, pixels) {
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0   // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** An ICO of PNG-compressed entries, which every browser in the support matrix reads. */
function ico(entries) {
  const header = Buffer.alloc(6 + entries.length * 16)
  header.writeUInt16LE(1, 2)                    // type: icon
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach(({ size, bytes }, i) => {
    const at = 6 + i * 16
    header[at] = size === 256 ? 0 : size
    header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)             // colour planes
    header.writeUInt16LE(32, at + 6)            // bits per pixel
    header.writeUInt32LE(bytes.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += bytes.length
  })
  return Buffer.concat([header, ...entries.map((entry) => entry.bytes)])
}

const ACCENT_DARK = [0x4f, 0x8f, 0xf7]   // --accent, dark theme
const PAGE_DARK = [0x0a, 0x0e, 0x17]     // --surface-page, dark theme

// Transparent, so the tab strip's own chrome shows through rather than a block of one theme's
// page colour. The stroke thickens as the size drops because a 1.3px line at 16px antialiases to
// grey rather than reading as blue.
const ICO_SIZES = [{ size: 16, strokeWidth: 3 }, { size: 32, strokeWidth: 2.6 }, { size: 48, strokeWidth: 2.4 }]

// The two sizes a web app manifest's `icons` list needs to be installable at all, painted the
// same way as apple-touch-icon.png below and for the same reason: an "any" purpose icon can be
// composited onto a background the platform chooses, and a transparent one would sit on whatever
// that platform picked rather than this app's own page colour.
const PWA_SIZE = 512
const PWA_ICON_SIZES = [192, 512]
const PWA_STROKE_WIDTH = 2.2

/** Writes every raster icon into `webDir`/public. Returns what it wrote, for the CLI to report. */
export function renderIcons(webDir) {
  const entries = ICO_SIZES.map(({ size, strokeWidth }) => ({
    size, bytes: png(size, render(size, strokeWidth, ACCENT_DARK, null)),
  }))
  writeFileSync(`${webDir}/public/favicon.ico`, ico(entries))
  // Apple masks and composites its icon, and a transparent one composites onto black, so this
  // gets the page colour painted in rather than an alpha channel.
  writeFileSync(`${webDir}/public/apple-touch-icon.png`, png(180, render(180, 2.2, ACCENT_DARK, PAGE_DARK)))

  for (const size of PWA_ICON_SIZES) {
    writeFileSync(
      `${webDir}/public/icon-${size}.png`,
      png(size, render(size, PWA_STROKE_WIDTH, ACCENT_DARK, PAGE_DARK)),
    )
  }
  // Maskable: the mark pulled into the safe zone (see scaleForSafeZone's own comment), on the
  // same full-bleed background as every other icon here - the background paints every pixel of
  // the canvas regardless of how far in the mark itself sits, so cropping to any shape the
  // platform chooses still lands on this app's own page colour at the edge, never on an
  // unpainted ring nor on a fragment of the mark that should have been safely inside it.
  const maskableGeometry = pulledToward(MARK_CENTER, scaleForSafeZone(PWA_STROKE_WIDTH), GEOMETRY)
  writeFileSync(
    `${webDir}/public/icon-${PWA_SIZE}-maskable.png`,
    png(PWA_SIZE, render(PWA_SIZE, PWA_STROKE_WIDTH, ACCENT_DARK, PAGE_DARK, maskableGeometry)),
  )

  return { ico: ICO_SIZES.map((entry) => entry.size), pwa: [...PWA_ICON_SIZES, `${PWA_SIZE}-maskable`] }
}

// Nothing above this line touches the filesystem, so the drift test can import PATHS without the
// import itself rewriting the files it is about to compare.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = renderIcons(fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''))
  console.log(`favicon.ico ${written.ico.join('/')} | apple-touch-icon.png 180 | icon-*.png ${written.pwa.join('/')}`)
}
