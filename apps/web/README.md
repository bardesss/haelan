# @vitals/web

Reference pages for the visual direction. Fixtures only, no data layer, no network.

    pnpm install
    pnpm dev

`predev` and `prebuild` regenerate `@vitals/tokens/theme.css` first, so a fresh clone builds
without a manual step. To regenerate it on its own:

    pnpm --filter @vitals/tokens build:css

Colours come from that stylesheet. Never write a literal colour in this package:
`apps/web/test/no-raw-color.test.ts` fails the build if you do, and it knows about hex,
`rgb()`, `hsl()`, `lab()`, `oklch()`, `color()` and the CSS named colours. To change a colour,
edit `packages/tokens` and regenerate.

Charts read token *names* from `@vitals/tokens` and resolve their *values* from
`getComputedStyle` at render time, so a rename in the tokens package is a compile error here and
a theme switch needs no reload.

## Pages

- `Dashboard` (`src/pages/Dashboard.tsx`): month view, headline stat tiles, the heart rate
  range chart with baseline band and event annotations, the hypnogram, sleep schedule and
  activity heatmap, and two distinct empty states.
- `Sleep` (`src/pages/Sleep.tsx`): day view of last night plus the month's sleep schedule.

Both are wired up behind the sidebar in `src/main.tsx`, with a theme switch left for manual
review: in a browser console, `document.documentElement.dataset.theme = 'light'` should update
every surface, text colour and chart series with no reload. See
`docs/superpowers/design/chart-styling.md` for how and why that works, and for the full styling
specification the next milestone builds against.
