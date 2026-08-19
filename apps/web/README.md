# @vitals/web

Reference pages for the visual direction. Fixtures only, no data layer, no network.

    pnpm --filter @vitals/tokens build:css
    pnpm dev

Colours come from `theme.generated.css`. Never write a literal colour in this package:
`apps/web/test/no-raw-color.test.ts` fails the build if you do. To change a colour, edit
`packages/tokens` and regenerate.

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
