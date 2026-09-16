# Roadmap

Where haelan has got to, and why it got there in that order.

Lifted out of the README before the first release: thirty rows of milestone letters are this
project's own bookkeeping rather than something a reader needs in the first two screens. The
reasoning below the table is a different matter. Specs and plans live under `docs/`, which is not
tracked, so this file is the only place any of it exists.

## The milestones

| Milestone | What it delivers | Status |
|---|---|---|
| **D1** Visual direction | Design tokens, chart styling, the app shell and two reference pages | Done, [#10](https://github.com/bardesss/haelan/pull/10) |
| **M0** Auth probe | Scopes, token lifetime and real v4 payload shapes; throwaway code, lasting findings | Done, [#11](https://github.com/bardesss/haelan/pull/11) |
| **M1a** Store and credentials | The three-tier SQLite schema, encrypted credentials and the compressed raw archive | Done, [#12](https://github.com/bardesss/haelan/pull/12) |
| **M1b** API client and mapping | The v4 client, the data type catalogue and the payload mappers | Done, [#14](https://github.com/bardesss/haelan/pull/14) |
| **M1c** Sync engine | Day aligned windows, per person jobs, sync state and a token bucket | Done, [#19](https://github.com/bardesss/haelan/pull/19) |
| **M1d** Wizard and accounts | The Fastify server, argon2 accounts and the guided setup flow | Done, [#21](https://github.com/bardesss/haelan/pull/21) |
| **M2a** Catalogue and rollups | The metric catalogue, per source `daily` rows with coverage, and the derive queue | Done, [#38](https://github.com/bardesss/haelan/pull/38) |
| **M2b** Priority and merge | Per metric source priority, `merged` rows chosen per local hour, overrides applied at derivation | Done, [#45](https://github.com/bardesss/haelan/pull/45) |
| **M2c** Sleep derivation | Nights assembled across split sessions, naps, stage durations and efficiency | Done, [#50](https://github.com/bardesss/haelan/pull/50) |
| **M2d** Baselines and query layer | Rolling baselines with a thin flag, and the person bound query layer M3 and M4 read through | Done, [#51](https://github.com/bardesss/haelan/pull/51) |
| **M2e** Rebuild | Atomic per person rebuild of tiers 2 and 3 from the archive, triggered by a version bump | Done, [#55](https://github.com/bardesss/haelan/pull/55) |
| **M3** Dashboard | Eight pages, the full chart set, notes and typed events, baseline bands, override controls, i18n | Done |
| **M3a** Web foundations | Routing, sign in, person binding, English and Dutch across every page, TanStack Query | Done, [#64](https://github.com/bardesss/haelan/pull/64) |
| **M3b-1** Core read stack | Units, sample counts and workout durations, and the query layer with its shared downsampler | Done, [#65](https://github.com/bardesss/haelan/pull/65) |
| **M3b-2** HTTP surface | Bearer auth, the response envelope, weak ETags, export, and the person isolation suite | Done, [#67](https://github.com/bardesss/haelan/pull/67) |
| **M3d-1** Page spine and Dashboard | The shared control row and the data hooks, with the Dashboard off fixtures as their first consumer | Done, [#68](https://github.com/bardesss/haelan/pull/68) |
| **M3d-2** Activity, Sleep and Recovery | The three remaining M3d pages, on the control row and hooks M3d-1 built | Done, [#71](https://github.com/bardesss/haelan/pull/71) |
| **M3c** Annotations and corrections | Override, note and event CRUD, re-derive enqueued in the same transaction, and the chart click panel | Done, [#76](https://github.com/bardesss/haelan/pull/76) |
| **M3e-1** Health, Weight and Notes | SpO2, weight and body fat, and the Notes page, the first surface that can delete an annotation | Done, [#81](https://github.com/bardesss/haelan/pull/81) |
| **M3e-2** Insight cards and the shell | Period over period cards, each withheld with its own reason when the data is thin, and the Dutch sweep | Done, [#82](https://github.com/bardesss/haelan/pull/82) |
| **M3f** The consumers M3 never built | The intraday chart, the activity list, naps and the weight trend, and two sleep defects an audit found | Done, [#85](https://github.com/bardesss/haelan/pull/85), [#86](https://github.com/bardesss/haelan/pull/86), [#87](https://github.com/bardesss/haelan/pull/87) |
| **M3 second pass** Corrections a second audit found | The tier 2 readers learn about a person's corrections, and Correct finally gets its home on the intraday chart | Done, [#93](https://github.com/bardesss/haelan/pull/93) |
| **M4** Agent surfaces | The MCP server, thin over M2: typed tools over `PersonQuery` on both transports with a person bound token, and `sql_query` behind its own sandbox. Cut into four: M4a-1 core foundations, M4a-2 the tool catalogue and the stdio entry, M4a-3 the person bound token, `POST /mcp`, the Profile card and the call log, M4b `sql_query`; corrected after review, [#166](https://github.com/bardesss/haelan/pull/166): a killable sandbox, bounded results, and writes that cannot fail a read | Done |
| **M4a-1** Core foundations | The five query layer capabilities the tools read through, and no MCP code at all: a read only open that migrates nothing, the workout decoder moved into `core` behind its own subpath, `type` and `last` on the sessions reader, intraday over an arbitrary window, and notes and events as person bound readers | Done, [#138](https://github.com/bardesss/haelan/pull/138) |
| **M4a-2** Tool catalogue and stdio | Thirteen typed tools over `PersonQuery`, the untrusted-text rule that keeps a note body, a device name or a workout's own title out of the prose an agent reads first, the stdio entry point bound to one person, the isolation suite proving all thirteen against a second person, and `TOOLS.md` generated from the catalogue that ships, guarded by a drift test | Done, [#144](https://github.com/bardesss/haelan/pull/144) |
| **M4a-3** Token, HTTP and the call log | The person bound token, stored as a digest and expiring on its own; `POST /mcp` stateless over the same catalogue; a guard that is not the session guard in either direction; the Agent access card; and a call log with no column for argument values | Done, [#159](https://github.com/bardesss/haelan/pull/159) |
| **M4b** `sql_query` | One read only `SELECT` over a throwaway per person projection database built fresh for the call: seven tables, no `person_id` column, no credential table, samples excluded, a five second deadline, a 500 row cap and a concurrency of one | Done, [#164](https://github.com/bardesss/haelan/pull/164) |
| **M5a** Source naming | A person scoped name for each source, so a 32 character hex id can read "My watch" | Done, [#91](https://github.com/bardesss/haelan/pull/91) |
| **M5b** People | Invites stored as a hash, a member who chooses their own password, the first `is_admin` guard, and suspension | Done, [#94](https://github.com/bardesss/haelan/pull/94) |
| **M5f** Wizard polish | The connect card `/oauth/start` had been reachable from nowhere, and per person data type exclusions | Done, [#95](https://github.com/bardesss/haelan/pull/95), [#96](https://github.com/bardesss/haelan/pull/96) |
| **M5c** Packaging | The image that runs the TypeScript it was tested as, booted twice over one volume on both architectures | Done, [#104](https://github.com/bardesss/haelan/pull/104) |
| **M5d-D** Cheaper sync tests | A test's data types bounded the way its depth already was, after the catalogue took every sprint test from twenty types to forty-two | Done, [#106](https://github.com/bardesss/haelan/pull/106) |
| **The catalogue catches up** | Twenty-two data types the app fetched nothing for, measured off the API's own envelope rather than its release notes; food is recorded unfetchable because a Food carries no clock | Done, [#101](https://github.com/bardesss/haelan/pull/101) |
| **M5d-A** Narrow sample keys | The five identifiers every one of 1.6 million sample rows wrote out in full become integer references; measured 632 MB down to 247 MB | Done, [#108](https://github.com/bardesss/haelan/pull/108) |
| **M5d-B/C** Reclaiming and backup | The 595 MB a rebuild frees and never hands back, reclaimed once a boot, and a daily compacted copy that is integrity-checked and row-counted before it is called a backup | Done, [#112](https://github.com/bardesss/haelan/pull/112) |
| **M5e-1** One error shape | Every route answers the same error envelope, and the injectable responder, the gate's path branch and the second HTTP client that existed to bridge two shapes are gone | Done, [#115](https://github.com/bardesss/haelan/pull/115) |
| **M5e-2** Seed and rehearsal | A deterministic demo data generator, the upgrade path rehearsed end to end from an old schema through rebuild, reclaim, backup and restore, and the script that seeds a directory for anyone to boot an instance against | Done, [#116](https://github.com/bardesss/haelan/pull/116) |
| **M5e-3** Documentation and screenshots | Three screenshots off the seeded demo data, and the README a stranger meets first: the features that shipped and not the ones that did not, one deploy block, and a configuration reference written for people who disagree with the defaults | Done, [#117](https://github.com/bardesss/haelan/pull/117) |
| **M5** Packaging | Cut into six units, a, b, c, d, e and f as listed here, with M5d itself cut into four strands - D cheaper tests, A narrow keys, then B reclaiming the space a rebuild frees but never returns and C backup and restore, which shipped together because a vacuum and a backup are one SQLite operation writing to two places - and M5e itself cut into three: M5e-1 the envelope, M5e-2 the seeded demo data and the automated upgrade rehearsal, M5e-3 the documentation and screenshots - and the catalogue work and the image both landing before the v1.0.0 tag | Done |
| **M6** What only the archive can answer | Source staleness, so a source that quietly stopped reporting says so instead of thinning a chart; all-time records and a milestones timeline; and an Eddington style number, which needs every day on disk to compute at all. Cut into four on 2026-09-15, in the order they are listed here: M6-0 the eligibility probe, M6a staleness, M6b the all-time page and its first consumer, M6c the rest of that page | Not started |
| **M6-0** The eligibility probe | What an all-time number does with a day the reader excluded, and with a day whose coverage is thin, measured rather than decided. Answered, and it answered something else: **coverage never decides a record** - the record holder survives every threshold swept, because a big day is a worn day - and **no eligibility rule moves an Eddington number at all**, including one discarding a third of the days, since that statistic is decided at the top of the distribution and a coverage gate cuts the bottom. Excluding a corrected day stays in on principle rather than on evidence: this household has never excluded anything, so that half is unmeasured rather than measured as negative. **The rule the milestone actually needs is tier selection, not eligibility**: two of the five record-shaped metrics are written only under the `provider` source with no merged row and no coverage number at all, so a reader filtering to `merged`, as every page does, reports them as absent while the archive holds years of them. And **an all-time figure has to name the window it covers**, because the metric an Eddington number is defined on can begin long after the archive does. The write-up is not in git: it carries figures off a household archive and this repository is public | Done |
| **M6a** Source staleness | A per source last reported read, a definition of stale that survives a scale stepped on monthly sitting beside a watch worn daily, and the Settings sources card M5a already gives every source a name in. Independent of the other three units and releasable on its own. Measured before it was written: a flat seven day threshold flags 13 of this household's 17 sources, and a scale weighed monthly makes any fixed number wrong, so a source is stale against **its own** cadence - 14 reporting dates, then silence past four of its own median gaps, floored at 14 days - and one without that history is unjudged rather than stale. Computed on read from `daily` rather than `samples`, which is 23ms against 3,380ms and needs no new index, so nothing is stored and no upgrade owes a rebuild. The control row's selector was specified and then dropped: `distinctSources` already scopes that picker to the range on screen | Done, [#246](https://github.com/bardesss/haelan/pull/246) |
| **M6b** The all-time page | Absorbed into M6c rather than shipped, and the reason is M6-0's. This unit existed to build the spine with the Eddington number as its first consumer, on the argument that a wrong eligibility rule would move that integer visibly. The probe falsified the argument: **no rule moves it**, including one discarding a third of the days, because it is decided at the top of the distribution and every gate proposed cuts the bottom. With that gone there was no reason to build a page twice, and records exercise the probe's real findings far harder | Done in [#N](https://github.com/bardesss/haelan/pull/N) |
| **M6c** The all-time page | `/records`, the only page in the app with no control row: a range picker on an all-time page is a control that either lies or does nothing, so the page states its span instead. The best day on record per metric, an Eddington number, and a timeline of milestones. **Which tier a metric is read from is the load-bearing part** - `floors` and `total_calories` have no merged row at all, so a reader filtering to `merged` the way every other page does reports two of five metrics as absent and looks healthy doing it. Every figure names the window it covers, because a metric's history can begin long after the archive's. Milestones are the shapes that survived measurement: the date each standing record was set rather than every time one was beaten - which is 70 events for one metric and a history of the archive beginning - round numbers per session kind, firsts labelled *first recorded*, and the longest unbroken run of days carrying a reading rather than days above a step goal, since the best 10,000-step run in this archive is two days and the best run with any reading at all is 159 | Done, [#N](https://github.com/bardesss/haelan/pull/N) |
| **M8a** Detail page spine | A session's `attrs` widened from seven keys to fourteen, and the archive re-mapped onto them by a mapping bump; one session by id; and intraday samples over a UTC window, which is the only shape a night crossing midnight has | Done, [#141](https://github.com/bardesss/haelan/pull/141) |
| **M8b** The workout page | A stack of cards over what M8a's widened `attrs` already carried: the tiles, the heart rate zones a session records on its own four-zone vocabulary, the trace pinned to the device that recorded the workout and the fallback for the five sessions in 198 where that device logged nothing, `PAUSE` markers and an exact paused total rather than a fabricated band, the splits table whose absent state is the common case, running dynamics, a comparison stated as a count, and session-scope exclude - which the server has had since M3c and no browser could reach | Done, [#172](https://github.com/bardesss/haelan/pull/172) |
| **M8c** The night page | The night list on Sleep, and a page per night keyed by its local date because a night has no id: the tier 1 tiles it never recomputes, the hypnogram, the naps its own grouping put outside the span, the overnight traces a date-keyed read cannot express, and one exclude control per session the night was assembled from | Done, [#174](https://github.com/bardesss/haelan/pull/174) |
| **The landing page** | A page a stranger meets before the repository does: hand written, wearing the app's own tokens so the two cannot drift, loading nothing from any third party, and rebuilt on every release from the version and date it names - published by its own workflow rather than a job inside the release pipeline, which has half-finished before | Done, [#212](https://github.com/bardesss/haelan/pull/212) |
| **M7** The small screen | A layout that works on a phone: the rail driven by the viewport rather than only by a toggle, the charts and the eight pages below 620px, and the wizard, which is the one flow a person is most likely to walk holding a phone. It also absorbs three gaps the landing page exposed in `packages/tokens`, because a responsive sweep is where the first two start to hurt: the spacing scale stopped at 24px and page-level rhythm was written as arithmetic on `--space-6`; there was no weight or line-height vocabulary at all, so sixteen `font-weight` literals and twenty-four `line-height` literals sat in the app with nothing behind them to say which of them meant the same thing; and the accent wash `color-mix(in oklab, var(--accent) 22%, transparent)` wanted one home before a second caller re-derived it. All three closed in M7a, as `--space-7` through `--space-9`, `--weight-*` and `--leading-*`, and `--accent-wash`. The landing page's display scale is deliberately not included: a dashboard has no use for 4rem type, and a value earns a token when it has a second consumer. M7b measured most of the rest of the spec's phone work as already true - axis density, the heatmap and the tables all held up under Chromium at 375px without a line changed - and spent itself instead on what the spec had missed: every control on Settings sized for a finger rather than a mouse, a tap that reads a chart without also opening a modal, and the two per-record detail pages brought under the same phone check the other nine routes already had, which surfaced and fixed a `display: contents` gap in the 900px card-collapse rule dating to M8. M7c closed the last two pieces: the wizard, whose touch targets turned out mostly already fixed by M7b's rules generalising further than the milestone that wrote them - seven controls below 44px remained across three of its six screens, plus one inline link exempted under WCAG 2.5.8's allowance for a target inside a sentence - and the web app manifest, with 192/512 icons and a maskable variant rendered from the brand mark, making the app installable with no service worker, because this app cannot do anything useful without its server | Done, [#241](https://github.com/bardesss/haelan/pull/241) |
| **M8** Detail pages | A workout page and a night page: automatic splits, pause markers, moving time, zones and running dynamics recovered from the archive - laps are mapped for the v4 schema and no archived payload here carries one; the overnight traces a date-keyed read cannot express; and session-scope exclusion, which the server has had since M3c and no browser could reach | Done |

## Why the order is not alphabetical

**M3d comes before M3c**, out of milestone letter order: section 6's creation flow is a click on a
plotted point, and the pages that plot real points are M3d's, so building the annotation panel
first would mean targeting fixture points that correspond to no row an override could name.

M1a through M1d are a decomposition of the spec's single M1, not phases the spec names: store,
client, sync and wizard each produce working, testable software on their own. **M1 itself is
done**: the design calls it done when a real account's history is on disk, re-syncing is
idempotent, and the whole route from empty database to syncing data ran through the browser. That
run happened on 2026-08-21 and is recorded, including what it broke, in
`probe/findings/console-steps.md`. Two things that run did not settle are listed there rather than
here, because an unanswered question belongs next to its evidence. **M2 is cut the same way**,
into the units its derivation design names: M2a is the first
of them and each has its own row above, and **M2e** is the last. **M3 is cut the same way**,
with M3b-1 and a second plan covering the HTTP surface. D1 and M0 through
M5 are the only phases the design defines; **M6 is the first that it does not**, and the
paragraph below says where it came from. M1 comes before the dashboard deliberately: intraday
samples have a shelf life, since the API only retains them for a recent window, so every week
without ingestion is a week of minute-level history permanently unavailable at that resolution.
Charts can be improved retroactively; resolution cannot be recovered.

**M5 comes before M4**, also out of letter order, and for two reasons rather than convenience.
M4's `sql_query` is the widest read surface this project will have, and person isolation is so far
proven against a database holding one person: M5 brings member management, which is where a second
person first exists to prove it against. And M5 carries backup and the upgrade path while
`DERIVATION_VERSION` and `MAPPING_VERSION` still move often enough to force rebuilds. M4 adds a
surface; M5 retires a risk that is already live.

**Within M5, M5f runs before M5c, M5d and M5e**, also out of letter order: M5c is the unit that
packages the image, and landing the wizard and connect polish first means the first published
artifact already carries it rather than the image going out once and the polish arriving in a
rebuild.

**M6 is not in the design, and that is the point.** Every phase above was specified before any of
it was built. M6 came from the opposite direction: from noticing, once the thing was running, that
this project argues its value is a complete mirror outliving Google's retention windows while every
page it ships renders a window. Nothing in the app yet computes anything that needs more than the
range on screen, so the archive is the argument rather than a feature, and the three pieces of M6
are the ones that cannot be computed without it.

Its first strand is not really a feature. A source that stops reporting is the worst failure a
mirror has, because it looks like a thin chart rather than an error, and nothing here detects it
today. It is grouped with the other two because they read the same history, and it is separable
from them if it ever needs to ship sooner.

**What the three strands share is a rule, not a data layer**, which is what the cut above turns on.
Measured 2026-09-15: `series()` caps no span, so an all-time read is already expressible, and
`daily` is indexed by person, metric and date, so an all-time maximum or a whole step history is an
index scan rather than a missing read path. There is no spine to build. What records and an
Eddington number genuinely share is which days are eligible - whether a day the reader excluded,
or a day whose coverage is thin, can hold a record - and that is one rule with two consumers, which
is why M6-0 measures it before either is designed and M6b builds it once.

**Nothing in M6 should need new stored rows, and a unit that thinks it does owes an argument.** A
stored last reported column is derived state, so `DERIVATION_VERSION` moves, so every existing
install rebuilds on upgrade - and the boot rebuild holds SQLite's write lock for its whole run. That
is the 1.16.0 failure mode, where every authenticated request 500'd until the rebuild committed, and
it is a steep price for a column a bounded `MAX` seek can answer live. If the live read measures too
slow, the next move is an index, not a derived column.

**M7 is separate from M6 rather than inside it**, and the cut is the same one this project makes
everywhere else: M6's three strands share a thesis and, as the paragraph above corrects, a rule
rather than a data layer, while M7 is a sweep across
eight pages, the rail, the charts and the wizard. One milestone whose review had to cover both a
query and a stylesheet would be reviewing neither.

It starts from further along than it looks. The viewport meta tag is right, the twelve column grid
already stacks at 900px, and `.rail-collapsed` already exists as a 60px icon strip. What is missing
is that the collapse is a manual toggle rather than something the viewport decides, and that below
900px there are exactly two media queries in the whole stylesheet. The rail does not clip its last
item on a short viewport; it scrolls. The real defect there was the account and sign-out sitting
437px below the fold of a nested scroller with nothing on screen indicating there was more below -
what M7a fixed.

**M6 is done, and its own order changed while it ran.** It had no order against M4 while neither
was started; M4 shipped in full, and M6 followed. Within it, M6b was to precede M6c so the page
would ship with the Eddington number as its first consumer - and M6-0, the probe that was supposed
to settle a rule for both, instead falsified the reason for that sequence. No eligibility rule
moves an Eddington number. Records, which have to read two metrics that exist only in the provider
tier and have to name the window they cover, exercise what the probe actually found; the integer
does not. So M6c absorbed M6b and shipped one page rather than two halves of one.

That is the second time a measurement in this milestone reversed a decision that had been argued
rather than checked. The first was the streak: the obvious shape, consecutive days above a step
goal, produces a best of **two days** in this archive, where consecutive days carrying any reading
at all produces 159.

**M8 comes before M7.** M7 is a sweep across eight pages, the rail, the charts and the wizard.
Landing two more pages after it would mean either sweeping twice or shipping two pages that do
not work on a phone. M8 before M7 means M7 sweeps ten pages once. M8 had no order against M4 or M6
while none of them were started; both M8 and M4 have since shipped.

**M8 is cut into a spine and two pages**, the same way M1, M2 and M3 were cut: M8a is the mapper
widening, the version bump and the two new reads, and it ships with no page at all. Both pages read
through it, and building a page against a route that does not exist yet would mean building it
against fixtures - which is the situation M3d was deliberately sequenced to avoid, and which M3c
then had to work around.

**M8 and M4 meet in one function, and M8's design is the one that names it.** M4a-1 built
`readIntradayWindow` and `PersonQuery.intradayWindow` so an agent could read one workout at full
resolution instead of fifteen points out of a day-wide budget; M8's design specifies the same pair
for the night page, because a night running 23:15 to 07:02 is not a local date. The function exists
as of M4a-1, and so does the 48 hour refusal, taking M8's number rather than inventing a second
one. What M8 asks of it that is not built is the HTTP route `GET /p/:personId/intraday/window`
that exposes it. **M8's design also moves an open question M4a-1 left**, though only part of the
way, and the difference is the point of the strand: `exercise.splits[]` — carrying a `splitType` of
`DISTANCE` — and `exercise.exerciseEvents[]` are **observed in this household's archived payloads**
and unmapped, so those two exist and M8a is where they are mapped. `exercise.splitSummaries` and
`exercise.notes` appear in the v4 discovery schema; a four-point sample taken at M0 had observed
neither. A fuller measurement taken 2026-09-11, a read-only probe over 15,982 archived exercise
payload rows deduplicated to 197 distinct sessions, replaces that sample and corrects it in one
direction only: `notes` **is** observed — rare, 4 of 197 — so M4a-1's rule now supports mapping it
as an observed field rather than a schema-only one. `splitSummaries` stays schema-only, and the
finding is now stronger, not weaker: zero of 197 sessions carry it, and every `splitType` recorded
by any device this household uses, across every split and lap in the archive, is `DISTANCE` — no
manual lap has ever been recorded. The same probe characterises the events, which until then were
only counted: 257 entries across those sessions, `START` 96, `STOP` 117 and `PAUSE` 44, every one
of them carrying a type, and not one `RESUME`, `AUTO_PAUSE` or `AUTO_RESUME`. A pause is real here;
the resume that would close it has never been recorded, which is a fact M8b's shading has to face
rather than a gap in the mapping. M4a-1 declined to design around a field it had not observed, and
recording an unobserved field here as an observed one would be that same mistake; the correction
above is the opposite mistake avoided in the other direction, now that the evidence has changed.

## The rule that keeps this true

**Every milestone pull request updates this table**, in the same pull request rather than
afterwards. Everything else leaves it alone: a dependency bump or a documentation fix has no row
to touch. A roadmap that is only accurate on the day it was written is worse than none, because it
still looks authoritative.

That rule had one gap, which this line closes: a milestone's own pull request records the status
it has **on the day it is opened**, and "in review" stops being true the moment it merges. Nothing
was then allowed to correct it, since the next milestone's pull request has no business touching
another row. **A pull request may correct a status this table gets wrong**, and only that. M1d
carried "In review" for a day after [#21](https://github.com/bardesss/haelan/pull/21) merged
because of it.
