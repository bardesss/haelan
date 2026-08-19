export const primitives = {
  blue: {
    900: '#1E2A78',
    800: '#3730A3',
    700: '#312E81',
    500: '#4F8FF7',
    400: '#3B82F6',
    300: '#B3E4FA',
    200: '#ADE5FD',
    100: '#BFD5F9',
  },
  amber: { 700: '#B45309', 500: '#F0A202' },
  slate: {
    950: '#0A0E17',
    900: '#0C111C',
    850: '#121926',
    800: '#0E1520',
    600: '#5A6880',
    500: '#7F8DA8',
    300: '#A9B6CE',
    200: '#E3E8EF',
    100: '#F5F7FB',
    50: '#FFFFFF',
    ink: '#0F172A',
    inkSoft: '#334155',
    paper: '#EAF0FB',
    // Dedicated no-data swatches. A neutral blue-grey step that also clears
    // grid/card contrast collides with state-excluded (#5A6880 sits right at
    // the edge of that same achromatic band), so these lean slightly violet:
    // verified by computation (WCAG contrast >= 3 against grid and card,
    // deltaE >= 18 against state-excluded and stage-deep, in both themes),
    // not chosen by eye.
    noDataDark: '#7C5B95',
    noDataLight: '#8A749E',
  },
  signal: { positive: '#5EC9A0', negative: '#E8846B', positiveDark: '#166F52', negativeDark: '#B4472C' },
  space: { 1: '4px', 2: '8px', 3: '12px', 4: '16px', 5: '20px', 6: '24px' },
  radius: { sm: '3px', md: '8px', lg: '11px', xl: '14px' },
  text: { xs: '10.5px', sm: '12px', md: '13px', lg: '18px', xl: '26px' },
  font: {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  },
} as const
