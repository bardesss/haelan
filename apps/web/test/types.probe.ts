import { chartVar, semanticVar } from '@haelan/tokens'
import { MetricCard } from '../src/components/MetricCard.js'

// Not a vitest file: `pnpm typecheck` runs it. The app does not define these
// names, so the only thing stopping it drifting from the package that does is
// that asking for a name which is not a token fails to compile.

// @ts-expect-error the app may only read chart tokens the package defines
chartVar('stage-deeep')
// @ts-expect-error the app may only read semantic tokens the package defines
semanticVar('surface-cardd')
// @ts-expect-error a chart token is not a semantic token
semanticVar('stage-deep')

// MetricCard computes worn, count and reported itself from metric and points, and a caller's own
// copy of them landing in basisValues would silently outrank that computation the moment it spread
// last (the bug a review caught: Dashboard.tsx's basisOf already returns exactly this shape, so it
// was one migration away from being passed straight through). Rather than trust the spread order
// alone, the type is narrowed so the attempt does not compile either.
MetricCard({
  metric: 'steps',
  query: { isError: false, isPending: false, refetch: () => {} },
  points: [],
  basisKey: 'b',
  basisWornKey: 'bw',
  // @ts-expect-error basisValues may not carry a second copy of a figure MetricCard computes itself
  basisValues: { worn: 1 },
  children: () => null,
})
