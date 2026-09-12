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

function distanceToMark(px, py) {
  let best = Infinity
  for (const line of GEOMETRY) {
    for (let i = 0; i + 1 < line.length; i++) {
      best = Math.min(best, distanceToSegment(px, py, line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]))
    }
  }
  return best
}

/** RGBA pixels. A null `background` leaves the ground transparent. */
function render(size, strokeWidth, ink, background) {
  const scale = size / 24
  const half = (strokeWidth / 2) * scale
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = distanceToMark((x + 0.5) / scale, (y + 0.5) / scale) * scale
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

/** Writes both raster icons into `webDir`/public. Returns what it wrote, for the CLI to report. */
export function renderIcons(webDir) {
  const entries = ICO_SIZES.map(({ size, strokeWidth }) => ({
    size, bytes: png(size, render(size, strokeWidth, ACCENT_DARK, null)),
  }))
  writeFileSync(`${webDir}/public/favicon.ico`, ico(entries))
  // Apple masks and composites its icon, and a transparent one composites onto black, so this
  // gets the page colour painted in rather than an alpha channel.
  writeFileSync(`${webDir}/public/apple-touch-icon.png`, png(180, render(180, 2.2, ACCENT_DARK, PAGE_DARK)))
  return ICO_SIZES.map((entry) => entry.size)
}

// Nothing above this line touches the filesystem, so the drift test can import PATHS without the
// import itself rewriting the files it is about to compare.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sizes = renderIcons(fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''))
  console.log(`favicon.ico ${sizes.join('/')} | apple-touch-icon.png 180`)
}
