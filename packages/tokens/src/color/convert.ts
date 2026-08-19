export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function toLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function fromLinear(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055
  return c * 255
}

export function toLab(hex: string): { L: number; a: number; b: number } {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number]
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) * 100
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) * 100
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) * 100
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x / 95.047)
  const fy = f(y / 100)
  const fz = f(z / 108.883)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

export function deltaE(hexA: string, hexB: string): number {
  const x = toLab(hexA)
  const y = toLab(hexB)
  return Math.hypot(x.L - y.L, x.a - y.a, x.b - y.b)
}
