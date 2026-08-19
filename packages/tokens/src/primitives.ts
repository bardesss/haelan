// Layer one: raw scales with no meaning attached. A step number here says only
// "this is the Nth stop on a lightness ramp"; what it is *for* is decided in
// semantic.ts and chart.ts. Numbers rise as measured Lab lightness falls, which
// packages/tokens/test/layering.test.ts asserts against the colour maths rather
// than trusting the names.
export const primitives = {
  blue: {
    100: '#B3E4FA',
    200: '#BFD5F9',
    500: '#4F8FF7',
    600: '#2376E9',
    800: '#3730A3',
    900: '#1E2A78',
  },
  // One shared sequential ramp, even in perceived lightness. Each theme reads it
  // in the direction that puts "more" furthest from its own page: see chart.ts.
  azure: {
    100: '#B7E4F7',
    300: '#74BAD8',
    500: '#3B8FB3',
    700: '#156588',
    900: '#003E5D',
  },
  amber: { 500: '#F0A202', 700: '#B45309' },
  // Reserved for the absence marker. Its separation from every other chart
  // colour is a computed result, not a preference: see chart.ts.
  plum: { 300: '#C1A2BC', 800: '#523145' },
  mint: { 400: '#5EC9A0', 700: '#166F52' },
  coral: { 400: '#E8846B', 700: '#B4472C' },
  slate: {
    50: '#FFFFFF',
    100: '#F5F7FB',
    150: '#EAF0FB',
    200: '#E3E8EF',
    300: '#B7C8DB',
    400: '#97A8B9',
    500: '#788899',
    600: '#647484',
    650: '#556575',
    700: '#3D4D5C',
    800: '#273645',
    850: '#192937',
    900: '#121926',
    925: '#0E1520',
    950: '#0C111C',
    975: '#0A0E17',
  },
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px' },
  radius: { sm: '3px', md: '8px', lg: '11px', xl: '14px' },
  text: { micro: '12px', xs: '13.5px', sm: '15.5px', md: '17px', lg: '24px', xl: '34px' },
  font: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  },
} as const

export const COLOR_GROUPS = ['blue', 'azure', 'amber', 'plum', 'mint', 'coral', 'slate'] as const
export type ColorGroup = (typeof COLOR_GROUPS)[number]

// The set of strings layer two and layer three are allowed to reference, so a
// typo in a token definition is a compile error rather than a runtime throw.
export type ColorPath = {
  [G in ColorGroup]: `${G}.${keyof (typeof primitives)[G] & (string | number)}`
}[ColorGroup]
