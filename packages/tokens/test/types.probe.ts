import { simulate } from '../src/color/cvd.js'
import { lookup, resolveSemantic } from '../src/semantic.js'
import { resolveChart } from '../src/chart.js'
import { resolveMap } from '../src/map.js'

// Not a vitest file: `pnpm typecheck` is what runs it. Every line below must stay
// an error. The package's job is to be the typed source of truth, and the way it
// stopped being one was quiet widening to `string`, which no runtime test can see.

// @ts-expect-error a misspelled simulation must not typecheck
simulate('deuteranopa', '#000000')
// @ts-expect-error a token may only reference a primitive that exists
lookup('blue.999')
// @ts-expect-error group names are checked too
lookup('mauve.400')
// @ts-expect-error chart token keys are a union, not string
resolveChart('dark')['stage-deeep']
// @ts-expect-error semantic token keys are a union, not string
resolveSemantic('light')['text-fain']
// @ts-expect-error there is no third theme
resolveChart('sepia')
// @ts-expect-error map token keys are a union, not string
resolveMap('dark')['watr']
