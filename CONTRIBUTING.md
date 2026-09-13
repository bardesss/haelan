# Contributing

## The bar, written down in advance

This is one household's instance, not a platform, so what would be accepted is decided here rather
than per pull request.

**Accepted:** a fix. A feature that makes sense for one household running its own copy. A new
translation. Documentation that corrects itself against the code.

**Not accepted:** anything serving a different shape of deployment. Hosting for others, public
internet exposure, writing data back to Google. The [Non-goals](README.md#non-goals) section says
why, and it is linked rather than restated.

If you are unsure which side of that line something falls on, open an issue before building it.
A rejected pull request costs you more than a rejected idea does.

## Before you open a pull request

```
pnpm typecheck
pnpm test
```

CI runs both again, plus `pnpm build`, a check that the generated stylesheet is not tracked, and
the commit message rule below. Nothing in CI is unavailable to you locally.

**A change touching derivation or mapping needs a version bump.** Rows built under the old rules
sitting beside rows built under the new ones is exactly what `DERIVATION_VERSION` and
`MAPPING_VERSION` exist to prevent. Moving either one rebuilds every derived row from the archive
on the next boot, which is not free: see [Upgrading](README.md#upgrading) for what the largest one
so far actually cost. Bumping when you did not need to wastes a user's eleven minutes. Not bumping
when you should have leaves them with two generations of rows in one table and no error to tell
them.

## Conventions

- **No em dashes anywhere:** prose, documentation, UI copy, code comments, commit messages.
- **No agent session links in commit messages or pull request bodies.** `Co-Authored-By` trailers
  are attribution and are welcome; a session URL is meaningless to everyone but the account that
  created it. Enforced by `.githooks/commit-msg` and by CI.
- **Comments are sparse and record why, not what.**
- **Real health data never gets committed.** Archived payloads stay gitignored and every test
  fixture is synthetic. `packages/core/src/testing/seed.ts` generates realistic data
  deterministically, and it exists so that nobody is ever tempted to paste in a real day.
- **No parameter properties, enums or decorators.** The server runs under Node's type stripping,
  which does not implement them. `pnpm typecheck` catches it.
- **Every change reaches `master` through a pull request, and nothing is ever force pushed.**

That last rule has exactly one exception, recorded here rather than quietly. On 2026-08-22,
`master` was rewritten once to strip agent session links from 22 commit messages, before the
repository was public and while nothing else had cloned it. Content was untouched, verified by the
rewritten tree being byte-identical to the original and by the commit count and every
`Co-Authored-By` line surviving. The merge references on pull requests #30 through #38 point at
commits that rewrite left unreachable. There is no second exception.

## The name, the mark and the tokens

**The display name is Hælan. Everything anybody types is `haelan`.** The æ is the display spelling
and nothing else: the package, the container image, the command, the repository and every
instruction in the tool catalogue stay `haelan`, because those are the strings a reader has to
reproduce. The name is not translated copy either, so it stays Hælan in every language rather than
going through i18n.

**Colour, spacing and type have one definition, in `packages/tokens`.** They live there as
TypeScript and are emitted, today as CSS through `scripts/build-css.ts`, with light and dark
resolved from the same values. Nothing downstream hard codes a colour: `apps/web/test/no-raw-color.test.ts`
is what enforces that, and CI separately checks the generated stylesheet is not tracked. A surface written in another language gets its own emitted target
from that package rather than a copied palette.

**The mark is `assets/brand/mark.svg`, drawn once and painted by whatever holds it.** It takes
`currentColor` and carries no fill or stroke of its own, which is why a single definition serves the
rail, the sign in page and the setup card in both themes. `apps/web/test/brand-mark.test.tsx` pins
that. A hard coded colour there is the regression that would quietly need a second asset back.

**Voice: only what is shipped, and polished rather than salesy.** Documentation describes what works
today, and anything unbuilt stays in the roadmap, labelled as such. A public repository listing
unbuilt features as features spends trust it cannot get back. Where a smooth sentence and an
unflattering accurate one disagree, the accurate one ships: the storage section names a realistic 2 GB,
and the README says the one manual Google Cloud step cannot be made to disappear. If a draft needs a
disclaimer to be true, rewrite the claim rather than adding the disclaimer.

## Pull request titles, and the release they cut

**A pull request title is a conventional commit**, because merging squashes it onto master and
Release Please reads it there to decide whether a release exists and how big it is. A prose title
is not a style disagreement, it is a release that silently never happens. CI checks the title on
every push to a pull request.

```
feat: an instance's address can be changed after setup
fix(web): stack the log table into cards on a phone
docs: the contributor rules move to their own file
```

`feat` and `fix` cut a release, minor and patch. `docs`, `test`, `ci`, `build`, `chore`, `perf`,
`refactor` and `revert` land on master and cut nothing, which is right for a change nobody running
the dashboard would notice. A breaking change takes a `!` before the colon and cuts a major.

Write the title for somebody reading the changelog later, not for the reviewer reading the diff
now. It is the sentence that outlives the pull request.

## The changelog

**CHANGELOG.md is generated. Do not edit it.** Release Please rewrites it from the titles above
when it opens its release pull request, and a hand-written entry there is overwritten without
warning. This is the opposite of the rule that stood until 1.1.0, where entries were written by
hand in the same pull request as the change.

The reasoning behind the swap: releases were being forgotten. Merging does not release, and the
tag was missed twice on the first day this repository was public, so work sat finished and
unreleased. Automation that cuts the release from what already merged removes the step that was
being skipped.

What moved rather than disappeared is the prose. A changelog entry is now one line, and the
reasoning belongs in the pull request body it links to, which is where this project already
writes at length.

Releasing is therefore: merge your change, and Release Please opens or updates a release pull
request. Merging **that** is what publishes. The image is built, both architectures are booted,
and only then does the release stop being a draft, so a release page never points at an image
that failed to reach the registry.

## If you are working with a coding agent

Welcome, and held to the same bar. Not a lower one, and not a separate one. haelan is itself built
with one. A change is judged by whether it holds up, so there is no separate review track and
nothing to disclose beyond being straight about what was actually verified.

This section is written to be read by an agent, and all of it applies.

**The bar here is measurement rather than assertion.** That is a higher bar than the tests passing,
and it is the one thing most likely to be missed, because a change can satisfy every instruction it
was given and still be wrong. Five failure modes have actually produced work in this repository
that *looked* finished:

- **A green test proves nothing until you have seen it fail for the right reason.** Break the code
  the test names, watch it go red, restore it, and say in the pull request what it printed. A pin
  written here once asserted step coverage only, and ratified the exact regression it had been
  written to prevent. Tests that have never been red are decoration.

- **Assert the value, not a substring of it.** `toContain('412')` stays green when the precision
  breaks and the cell reads `412.0`. Assert the cell.

- **A number in a commit message or a pull request came from running something.** Not from what
  running it was expected to produce. A timing claim in this README was once fourteen times out
  because it was reasoned about instead of measured.

- **Read the whole diff, not each change in isolation.** Reviewing a change against the
  instructions it was given confirms it matched them. It cannot tell you the instructions were
  wrong, and repeatedly here they were. Whole-branch review caught what per-change review could
  not, every time.

- **Open the artefact, not the page.** A screenshot captured mid-animation, a chart with a broken
  axis, a navigation rail with its last item cut off: each of those passed every check that looked
  at the running app, and was obvious the moment somebody opened the file that shipped.

And one hard rule, because breaking it is worse than any broken feature: **never hand-write a test
fixture that looks like real health data, and never paste in a real one.** Use the seed generator.
A plausible fabricated day is worse than no fixture, because the test passes and the shape was
never the API's; a real one is somebody's medical history in a public git history, permanently.
