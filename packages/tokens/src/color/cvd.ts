import { hexToRgb, rgbToHex, toLinear, fromLinear } from './convert.js'

type Matrix = [number[], number[], number[]]

// Vienot 1999 dichromat simulation, applied in linear RGB.
const MATRICES: Record<string, Matrix> = {
  deuteranopia: [[0.625, 0.375, 0], [0.7, 0.3, 0], [0, 0.3, 0.7]],
  protanopia: [[0.567, 0.433, 0], [0.558, 0.442, 0], [0, 0.242, 0.758]],
  tritanopia: [[0.95, 0.05, 0], [0, 0.433, 0.567], [0, 0.475, 0.525]],
}

export type CvdKind = keyof typeof MATRICES

export function simulate(kind: CvdKind, hex: string): string {
  const m = MATRICES[kind]
  if (!m) throw new Error(`unknown simulation: ${kind}`)
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number]
  const out = m.map((row) => (row[0] ?? 0) * r + (row[1] ?? 0) * g + (row[2] ?? 0) * b)
  return rgbToHex(out.map(fromLinear) as [number, number, number])
}
