import { chartVar, semanticVar } from '@haelan/tokens'

// Not a vitest file: `pnpm typecheck` runs it. The app does not define these
// names, so the only thing stopping it drifting from the package that does is
// that asking for a name which is not a token fails to compile.

// @ts-expect-error the app may only read chart tokens the package defines
chartVar('stage-deeep')
// @ts-expect-error the app may only read semantic tokens the package defines
semanticVar('surface-cardd')
// @ts-expect-error a chart token is not a semantic token
semanticVar('stage-deep')
