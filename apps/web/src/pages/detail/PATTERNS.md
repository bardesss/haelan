# Page patterns

Every redesigned page is built from the pieces below. A section that looks like one of these uses the component named here rather than a copy of it. The dashboard and the night page are the reference renderings.

## Page shell

- Root: `<div className="detail-page">` on a detail page, `<div className="dashboard">` on the dashboard.
- Every state (loading, a failed read, nothing to show, a missing record) keeps the header and draws its message in `<div className="grid"><Card span={12}>…</Card></div>`. A missing record is an `EmptyState`, not a retry.

## Header: `PageHeader`, with `DetailNav` or `DayNav`

- `title` says what the page is about: a date through `useHeaderDate` (the short form on a phone), or a name. `line` says when and who, on one line. Names, notes and badges belong in a card.
- `DetailNav` draws ‹ › to the neighbours the payload's `nav` names (never computed), disabled rather than hidden when null, then the way back as a `.button` ("Alle nachten", no arrow glyph). ← and → step through `StepArrows`; `ignoreKeysInside` names the parts of the page with arrow keys of their own.
- On a phone (620px and below) the header stays one row, the title ends in an ellipsis, and every control is 44×44.

## Hero: `Card label` and `.dash-lead`

- The value in `.dash-headline`, formatted by `formatFigureValue`.
- The verdict line: `verdictLine`'s words in `.detail-verdict`, coloured by `verdictTone`. Always printed on a detail page; on the dashboard only when the figure is outside its usual.
- The strip: `Sparkline` with `height={64}` and `dots`, each day's usual shaded behind it, both band edges labelled (`bandLabels`), each dot coloured by its own day's verdict (`pointStandings` and `pointJudged`), described by the printed verdict's id through `BasisContext` rather than a hidden copy, and each dot opening its own page (`useOpensDay`, worded for a day or a night). A `.dash-caption` says what the points are.
- The card is left out when there is no value.

## Figure rows: `FigureRow` inside `FigureRows`

- Each row: a `.label`, the value (its unit set smaller), a bar or a strip, then the verdict line.
- Pass both `judged` and `standing`. Draw a strip where the trend is the point, the bar otherwise. A thin usual draws no bar and says so.
- A row without a value is left out; a card without rows is left out.
- `FigureRows` sets one column per row, up to four (`max={3}` where the card gives the rows three quarters, `side` inside a `SideCard`); below 900px every grid of two or more is two across.
- Text under a value that is not a verdict passes `band={null}`.

## Verdict words and colour

- Words come from `verdictLine` on a detail page and `usualLine` on the dashboard, which share their catalogue keys. The dashboard may drop the range where a verdict sits inline beside other figures (`usualShort`), but keeps the words.
- Dutch says "gebruikelijk(e)", never "gewoon" or "normaal". A clock time is later or earlier than its usual, a pace slower or faster; neither is above or below.
- Colour is `verdictTone(judged, standing)`: better in `--positive`, worse in `--negative`, outside the usual on a figure judged neither way (`is-out`) in `--negative`, inside the usual plain. A strip's dots and a bar's mark take the same tone. The steps pace line keeps its own ahead-only green, since a pace is not a judgement.
- The server judges (`standing` and `judged` on every figure and every strip day); the web only words and colours what it sent.

## Values

- One formatter per unit. A duration reads "0h 25m", a signed one "-0h 23m"; a figure that is only ever a few minutes (time to fall asleep, active minutes) reads "12 min".
- A value never wraps inside itself: `formatFigureValue` joins its parts with no-break spaces.
- A range prints its unit once, after the second number ("60 – 65 bpm"); a duration or clock time keeps both ends whole.

## Cards

- A detail card is `Card span={12} label=…`; its label renders as an `h2` styled as `.label`. A dashboard card is `DashCard` (a title, a muted subtitle, a `.card-link`).
- A side section (the day before a night) is a `SideCard` whose caption names the relation.
- Legends use `.detail-legend`, captions `.dash-caption`.
- A detail page's charts keep their show-numbers control; the dashboard's strips pass `tableToggle={false}`.

## The day block

`DayLogBlock` (mood, chips, note), then steps and active minutes as `FigureRow`s, then `TodayWorkouts` labelled "Trainingen" / "Workouts". The block is left out with no log, neither figure and no workout.

## Terms (nl / en)

Tijd in slaap / Time asleep · Naar bed / Bedtime · Wakker geworden / Wake time · Stappen / Steps · Actieve minuten / Active minutes · Trainingen / Workouts · Rusthartslag / Resting heart rate · gebruikelijk / usual.

## Breakpoints

- 900px: every card spans the full row, figure rows go two across, side cards stack.
- 620px: the phone header, 44px targets.

## Type scale

Hero 48 · dashboard card lead 34 · row figure 24 · inline mini 17.
