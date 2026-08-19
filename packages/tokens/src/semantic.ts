import { primitives } from './primitives.js'

export type Theme = 'dark' | 'light'
export const THEMES: Theme[] = ['dark', 'light']

export const semantic: Record<Theme, Record<string, string>> = {
  dark: {
    'surface-page': 'slate.950',
    'surface-card': 'slate.850',
    'surface-inset': 'slate.800',
    'surface-rail': 'slate.900',
    'text-primary': 'slate.paper',
    'text-secondary': 'slate.300',
    'text-muted': 'slate.500',
    'text-faint': 'slate.600',
    accent: 'blue.500',
    'accent-soft': 'blue.100',
    focus: 'blue.300',
    positive: 'signal.positive',
    negative: 'signal.negative',
  },
  light: {
    'surface-page': 'slate.100',
    'surface-card': 'slate.50',
    'surface-inset': 'slate.200',
    'surface-rail': 'slate.50',
    'text-primary': 'slate.ink',
    'text-secondary': 'slate.inkSoft',
    'text-muted': 'slate.600',
    'text-faint': 'slate.500',
    accent: 'blue.400',
    'accent-soft': 'blue.900',
    focus: 'blue.400',
    positive: 'signal.positiveDark',
    negative: 'signal.negativeDark',
  },
}

export function lookup(path: string): string {
  const [group, key] = path.split('.')
  const value = (primitives as Record<string, Record<string, string>>)[group ?? '']?.[key ?? '']
  if (!value) throw new Error(`unknown primitive: ${path}`)
  return value
}

export function resolveSemantic(theme: Theme, extra?: Record<string, string>): Record<string, string> {
  const source = extra ?? semantic[theme]
  return Object.fromEntries(Object.entries(source).map(([name, path]) => [name, lookup(path)]))
}
