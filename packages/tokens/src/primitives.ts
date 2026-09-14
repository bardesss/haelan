// Layer one: raw scales with no meaning attached (meaning lives in semantic.ts, chart.ts). Numbers rise as measured Lab lightness falls (layering.test.ts asserts this).
export const primitives = {
  blue: {
    50: '#E8F0FE',
    100: '#B3E4FA',
    200: '#BFD5F9',
    // 44% accent over surface-page, the .choice/.setup-horizon chosen border. Composited exactly
    // like the 350 and 500 dark neighbours below: color-mix(in srgb, blue.500 <pct>%, transparent)
    // over the surface the rule actually paints on (see semantic.ts border-chosen).
    350: '#ACC9F9',
    500: '#4F8FF7',
    600: '#2376E9',
    // 44% accent over surface-page, dark side of the same border-chosen composite.
    750: '#28477A',
    800: '#3730A3',
    900: '#1E2A78',
    950: '#152138',
  },
  // Shared sequential ramp, even in perceived lightness; each theme reads it in the direction that suits its own page (see chart.ts).
  azure: {
    100: '#B7E4F7',
    300: '#74BAD8',
    500: '#3B8FB3',
    700: '#156588',
    900: '#003E5D',
  },
  amber: { 500: '#F0A202', 700: '#B45309' },
  // Reserved for the absence marker; its separation from every other chart colour is measured, not chosen by eye (see chart.ts).
  plum: { 300: '#C1A2BC', 800: '#523145' },
  mint: { 400: '#5EC9A0', 700: '#166F52' },
  coral: { 400: '#E8846B', 700: '#AB432A' },
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
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px', 7: '32px', 8: '48px', 9: '64px' },
  radius: { sm: '3px', md: '8px', lg: '11px', xl: '14px' },
  duration: { fast: '120ms', slow: '240ms' },
  ease: { standard: 'cubic-bezier(0.2, 0, 0, 1)' },
  text: { micro: '12px', xs: '13.5px', sm: '15.5px', md: '17px', lg: '24px', xl: '34px' },
  // Three weights and three leadings, counted off both stylesheets rather than invented: app.css
  // used 600 thirteen times and 700 three times; site.css used 700, 600 and 650. The leadings were
  // 1.5, 1.6 and 1.4 in the app. No drift between the two: site.css has always set 1.6 for body
  // prose, the same as the app. What the count actually shows is an absence of vocabulary - the
  // app carried sixteen weight literals and twenty-four line-height literals with nothing behind
  // them, so nothing said which of them meant the same thing, and M7b has a responsive type pass
  // to make that answerable before it can do anything else. 650 has one consumer today, kept
  // because a three-step scale with a hole in it is worse than a lightly used step.
  weight: { medium: '600', semibold: '650', bold: '700' },
  leading: { tight: '1.4', normal: '1.5', relaxed: '1.6' },
  font: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  },
} as const

export const COLOR_GROUPS = ['blue', 'azure', 'amber', 'plum', 'mint', 'coral', 'slate'] as const
export type ColorGroup = (typeof COLOR_GROUPS)[number]

// The set of strings layer two and layer three may reference, so a typo in a token definition is a compile error, not a runtime throw.
export type ColorPath = {
  [G in ColorGroup]: `${G}.${keyof (typeof primitives)[G] & (string | number)}`
}[ColorGroup]
