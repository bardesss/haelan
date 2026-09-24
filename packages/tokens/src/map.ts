import { lookup, type Theme } from './semantic.js'
import type { ColorPath } from './primitives.js'

/**
 * Map roles: what the workout page's basemap paints each kind of ground with, per theme.
 *
 * A layer of its own, beside chart.ts, rather than a borrowing of semantic tokens, because the
 * semantic layer answers a different question in each theme. A road has to be lighter than the
 * land on a light page and darker than it on a dark one, which is what "road" means on any map
 * people already read; `border-subtle` goes the other way in the light theme, so a style built out
 * of semantic names would pick a different name per theme for the same feature, and that choice
 * belongs in a token rather than in a branch in the style function. The web app reads these off
 * the document at build time and hands MapLibre the resolved hex, since MapLibre parses colours
 * itself and never resolves `var()` (WorkoutRoute's basemap module says the rest).
 *
 * Calm on purpose. The map is a backdrop for one accent-coloured line, so nothing here is
 * saturated and nothing sits far from the land in lightness: the route has to be the only thing
 * on the card that reads before it is looked for. The route itself is not a map token - it is
 * `accent`, the same colour the plain trace draws in when the basemap is off.
 *
 * Not on Android: the companion app draws no map, and android.ts maps a curated subset by name.
 */
export const mapTokens = {
  dark: {
    // surface-inset's step: the map reads as a well sunk into its card, not as a second card.
    land: 'slate.925',
    water: 'blue.950',
    park: 'mint.950',
    // One step lighter per feature, from the land up: buildings, then roads, then the major ones.
    building: 'slate.900',
    road: 'slate.850',
    'road-major': 'slate.800',
    label: 'slate.500',
    // The land itself, so a label's halo knocks the streets out under its letters without
    // drawing a visible box round them.
    'label-halo': 'slate.925',
  },
  light: {
    land: 'slate.200',
    // blue.100 rather than the paler blue.200 or blue.50: the route crosses water as often as it
    // crosses anything, and blue.200 held the light accent to 2.9:1, under the floor the route
    // line answers to (accessibility.test.ts). blue.50 cleared it but sat barely off the land.
    water: 'blue.100',
    park: 'mint.100',
    // The same four steps the dark side walks, walked up instead of down: land, then buildings,
    // then roads, each a step lighter. Roads lighter than the land is how every light street map
    // draws them, and slate.50 is the white a card is, so a major road reads as the widest white
    // line rather than as ink.
    building: 'slate.150',
    road: 'slate.100',
    'road-major': 'slate.50',
    label: 'slate.650',
    'label-halo': 'slate.200',
  },
} satisfies Record<Theme, Record<string, ColorPath>>

export type MapToken = keyof (typeof mapTokens)['dark']
export const MAP_KEYS = Object.keys(mapTokens.dark) as MapToken[]

export function resolveMap(theme: Theme): Record<MapToken, string> {
  const entries = Object.entries(mapTokens[theme]).map(([k, v]) => [k, lookup(v)])
  return Object.fromEntries(entries) as Record<MapToken, string>
}
