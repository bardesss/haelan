# @haelan/web

The dashboard the browser loads, and the setup wizard that configures an instance. Both talk to
`@haelan/server`; the pages read a person's real derived data through the versioned API.

    pnpm install
    pnpm dev

`pnpm dev` proxies `/api` and `/oauth` to Fastify on 4235, so run `pnpm dev:server` from the
repository root in another terminal. `changeOrigin` is deliberately off in that proxy: the
server compares `Origin` against `Host`, and rewriting the host would make every mutating
request from the dev server look cross origin.

`predev` and `prebuild` regenerate `@haelan/tokens/theme.css` first, so a fresh clone builds
without a manual step. To regenerate it on its own:

    pnpm --filter @haelan/tokens build:css

Colours come from that stylesheet. Never write a literal colour in this package:
`apps/web/test/no-raw-color.test.ts` fails the build if you do, and it knows about hex,
`rgb()`, `hsl()`, `lab()`, `oklch()`, `color()` and the CSS named colours. To change a colour,
edit `packages/tokens` and regenerate.

Charts read token *names* from `@haelan/tokens` and resolve their *values* from
`getComputedStyle` at render time, so a rename in the tokens package is a compile error here and
a theme switch needs no reload.

## The setup wizard

`src/setup/` renders at any `/setup/*` path and is mounted by `main.tsx` when the server says
setup is unfinished, whatever the URL says. The server owns which step is due, derived from what
is actually in the database, so the browser asks rather than remembers and a reload mid wizard
resumes correctly.

Its one rule, and the reason `CopyField` exists as its own component: **nothing copyable ever
contains a placeholder.** Every redirect URI shown is complete and concrete, built from the
running port and the hostname the owner typed. A value Google's rules reject is rendered as
rejected, with the rule quoted, and is given no copy control at all, because offering it would
cost the reader a console trip to find that out.

Forms use the shared vocabulary in `app.css` (`.field`, `.input`, `.choice`, `.form-actions`),
which M1d added because the dashboard had none and M3's override controls and typed events need
the same one. Add to that layer rather than defining inputs a second time beside a screen.

## Pages

- `Dashboard` (`src/pages/Dashboard.tsx`): the glance, three cards answering last night,
  recovery and today so far from one read of `/glance`, with no control row.
- `Sleep` (`src/pages/Sleep.tsx`): day view of last night plus the month's sleep schedule.

Both are wired up behind the sidebar in `src/main.tsx`, with a theme switch left for manual
review: in a browser console, `document.documentElement.dataset.theme = 'light'` should update
every surface, text colour and chart series with no reload. See
`docs/superpowers/design/chart-styling.md` for how and why that works, and for the full styling
specification the next milestone builds against.
