import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RebuildNotice } from '../src/components/RebuildNotice.js'
import { I18nProvider } from '../src/i18n/index.js'

// I18nProvider lng="en" wraps every render here, the same reason InsightCard's own suite does:
// with no language pinned, useTranslation resolves against whichever locale a previous test in
// this process happened to initialise last, not the one this file's assertions are written for.
const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(<I18nProvider lng="en">{node}</I18nProvider>)

// The Dutch counterpart of the same helper, for the dated strings below - i18n-parity.test.ts
// only proves nl.json HAS the same keys as en.json, never that a mid-clause interpolation like
// "is {{when}} mislukt" actually reads correctly once formatSince's own output lands inside it.
const renderNl = (node: React.ReactNode): string =>
  renderToStaticMarkup(<I18nProvider lng="nl">{node}</I18nProvider>)

describe('RebuildNotice', () => {
  it('renders nothing when there is nothing wrong', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={0} producedNothing={false} drops={[]}
        lastError={null} voice="self" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toBe('')
  })

  it('tells the person their data has stopped, not that pages were dropped', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]} lastError="boom" voice="self"
        rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('Your data has stopped updating')
    expect(html).not.toContain('could not be rebuilt and is missing')
  })

  it('names every dropped data type with its count', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={7} producedNothing={false} lastError={null} voice="self"
        rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
        drops={[{ dataType: 'sleep', reason: 'UNIQUE constraint failed', pages: 7 }]}
      />,
    )
    // The exact row, not a bare '7': that substring stays green under a format regression that
    // renders '17' or '70' just as happily, the same gap
    // substring-assertions-hide-format-regressions calls out elsewhere in this codebase.
    expect(html).toContain('sleep: 7 pages, UNIQUE constraint failed')
  })

  /**
   * A count of one, which both {{count}} strings can reach: a drop row counts the pages of one
   * data type that failed one way, and the total is the sum of those. Written as _one/_other
   * rather than left on a single string, the way the other two dozen counted strings in this
   * catalogue are - "1 pages" is the tell of a string nobody gave a plural to.
   */
  it('writes a single page in the singular, in both counted strings', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={1} producedNothing={false} lastError={null}
        voice="admin" personName="Robin" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
        drops={[{ dataType: 'sleep', reason: 'UNIQUE constraint failed', pages: 1 }]}
      />,
    )
    expect(html).toContain('1 page of Robin&#x27;s history could not be rebuilt.')
    expect(html).toContain('sleep: 1 page, UNIQUE constraint failed')
  })

  // The admin voice names whose data it is, since a household's list of people reads nothing
  // like a person's own dashboard, which never needs to say its own name back to them.
  it('names the affected person in the admin voice', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]} lastError={null}
        voice="admin" personName="Robin" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('Robin has stopped receiving data')
  })

  // The error the rebuild reported is shown verbatim - what can and cannot reach that string is
  // argued once, at the catch in packages/core/src/rebuild/runRebuild.ts that captures it - and
  // it is shown whenever the store is holding one, rather than under one state above only.
  it('shows the reported error when there is one', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]} voice="self"
        lastError="UNIQUE constraint failed: samples.id" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('UNIQUE constraint failed: samples.id')
  })

  it('says nothing about an error when the store never recorded one', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]} lastError={null} voice="self"
        rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).not.toContain('The error the rebuild reported')
  })

  /**
   * The third state, and the one this component was blind to. A person whose version stamp went
   * stale with no rebuild attempt behind it - which changing a timezone in Profile does - is
   * skipped by sync from the next tick while rebuild_state holds a clean success. Without this
   * the component returned null and their dashboard said nothing at all.
   */
  it('tells a person waiting for a rebuild that a restart is what runs it', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined={false} droppedPages={0} producedNothing={false} drops={[]} lastError={null} voice="self"
        rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    // The whole paragraph, not a fragment of it: half this sentence is the promise about when
    // the rebuild runs, and a substring assertion on the other half stays green if that promise
    // is reworded into something untrue.
    expect(html).toContain('<p class="maintenance-waiting">Your data is waiting for a rebuild of your history, which runs at the next restart of the server. Nothing has gone wrong, and no new readings are collected until it has run.</p>')
    // Nothing failed, so nothing on screen may say an administrator has to go and look.
    expect(html).not.toContain('An administrator needs to look at this')
  })

  it('names the person waiting for a rebuild in the admin voice', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined={false} droppedPages={0} producedNothing={false} drops={[]} lastError={null}
        voice="admin" personName="Robin" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('Robin is waiting for a rebuild of their history')
  })

  /**
   * A quarantined person is behind on their stamp as well - the rollback took it with them - so
   * both flags arrive true and both routes report them that way. Saying both here would promise
   * a restart fixes it, which for a quarantine is the one thing that is certainly false: the
   * failure is deterministic, so the next boot fails in exactly the same place. The quarantine
   * is the sentence that survives.
   */
  it('says only the quarantine when a quarantined person is also behind on their stamp', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined droppedPages={0} producedNothing={false} drops={[]} lastError={null} voice="self"
        rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('Your data has stopped updating')
    expect(html).not.toContain('at the next restart of the server')
  })

  /**
   * The variant that exists because the sentence above is actively harmful at the one moment it
   * is most likely to be read.
   *
   * apps/server/src/index.ts calls app.listen BEFORE the boot rebuild starts, and that rebuild
   * runs in its own process for as long as fifteen minutes on real data while holding the write
   * lock. For the whole of that window every person the worker has not reached yet has a stale
   * stamp, so awaitingRebuild is true of them - during the run that is fixing them. Right after
   * an upgrade is the single most likely moment anybody sees this state at all, and the reader
   * being told a restart is what runs it is how an operator aborts a rebuild that would have
   * finished.
   *
   * Hiding the line while a rebuild runs was the alternative and was rejected: a person whose
   * data has stopped should not be told nothing. So this says the same thing about their data
   * and a different, true thing about what happens next.
   */
  it('tells a person a rebuild is running now rather than to restart the server', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined={false} droppedPages={0} producedNothing={false} drops={[]} lastError={null} voice="self"
        rebuildInFlight lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-waiting">Your data is waiting for a rebuild of your history, which is running now. Nothing has gone wrong, and no new readings are collected until it finishes, which it will do on its own.</p>')
    // The one sentence a reader must not act on while the thing it describes is already running.
    expect(html).not.toContain('at the next restart of the server')
  })

  it('names the person a running rebuild is catching up on, in the admin voice', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined={false} droppedPages={0} producedNothing={false} drops={[]} lastError={null}
        voice="admin" personName="Robin" rebuildInFlight lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-waiting">Robin is waiting for a rebuild of their history, which is running now. They receive no new data until it finishes, which it will do on its own.</p>')
    expect(html).not.toContain('at the next restart of the server')
  })

  /**
   * A refinement of the awaiting line, not a fourth independent one, so it inherits the awaiting
   * line's own suppression under a quarantine rather than restating the rule. A quarantined
   * person reads true on every one of these flags at once - the rollback took their stamp with
   * them, and a boot rebuild may well be running while their own rebuild is the one that failed
   * in it - and "a rebuild is running now" would read as reassurance about a failure that is
   * deterministic and will happen again in exactly the same place.
   */
  it('says only the quarantine when a quarantined person is caught in a running rebuild', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined droppedPages={0} producedNothing={false} drops={[]} lastError={null} voice="self"
        rebuildInFlight lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('Your data has stopped updating')
    expect(html).not.toContain('which is running now')
    expect(html).not.toContain('at the next restart of the server')
  })

  // A rebuild in flight says nothing at all about anybody who is not behind on their stamp: the
  // flag is instance-wide, so without this guard every household member would be told their data
  // is waiting for a rebuild every time the container restarts.
  it('stays silent about a running rebuild for a person who is not behind on their stamp', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={0} producedNothing={false} drops={[]} lastError={null}
        voice="self" rebuildInFlight lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toBe('')
  })

  /**
   * The fourth state, and the one that made "nothing to say" wrong. A rebuild that reads an
   * archive and writes no rows commits, drops no page and records no error, so every flag above
   * reads clean and this component used to return null for a person whose pages had gone empty.
   *
   * The whole paragraph, not a fragment. Half of this sentence is the promise that the payloads
   * are still held, and a substring assertion on the other half would stay green if that promise
   * were reworded into something that implies data was deleted.
   */
  it('tells a person their history came back empty, and that nothing was deleted', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={0} producedNothing drops={[]}
        lastError={null} voice="self" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toBe('<div class="maintenance"><p class="maintenance-waiting">Your history was rebuilt without any error, but it produced no readings, so these pages are empty. Nothing has been deleted: everything ever collected for you is still stored, and a later version may be able to read it.</p></div>')
  })

  it('names the person whose history came back empty, in the admin voice', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={0} producedNothing drops={[]}
        lastError={null} voice="admin" personName="Robin" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toBe('<div class="maintenance"><p class="maintenance-waiting">Robin&#x27;s history was rebuilt without any error, but it produced no readings, so their pages are empty. Nothing has been deleted: everything ever collected for them is still stored, and a later version may be able to read it.</p></div>')
  })

  /**
   * Suppressed under a quarantine, like the awaiting line and for the same reason. A person whose
   * rebuild rolled back has whatever their last committed attempt left in the two columns, which
   * can be an empty pair, and "it rebuilt without any error" is flatly untrue of somebody whose
   * rebuild is the one that failed. The quarantine is the sentence that survives.
   */
  it('says only the quarantine when a quarantined person also carries an empty rebuild', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="self" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('Your data has stopped updating')
    expect(html).not.toContain('produced no readings')
  })

  /**
   * Suppressed under a pending rebuild too, and for a different reason than the quarantine. This
   * flag describes a replay that has already finished; awaitingRebuild says another one is due,
   * at the next restart or running right now. Printing a verdict about to be recomputed beside
   * "a rebuild is running now" gives the reader two answers where the second is the useful one.
   * It returns on its own if the new rebuild is empty as well, since recordSuccess overwrites
   * both columns every time.
   */
  it('says only the pending rebuild when a person awaiting one also carries an empty rebuild', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined={false} producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="self" rebuildInFlight lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('which is running now')
    expect(html).not.toContain('produced no readings')
  })

  /**
   * Said beside a drop rather than instead of it. The two are different facts about the same
   * rebuild - some pages would not go in, and what did go in produced nothing - and an operator
   * reading only the drop count would conclude the rest of the archive replayed fine.
   */
  it('says both when a rebuild dropped pages and still produced nothing', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing droppedPages={3}
        drops={[]} lastError={null} voice="self" rebuildInFlight={false} lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('it produced no readings')
    expect(html).toContain('Part of your history could not be rebuilt')
  })
})

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * The reason this whole change exists: three of the four states above persist unchanged from one
 * boot to the next once a person's stamp goes current again, so an undated line reads like a live
 * emergency whether it started twenty minutes ago or four months ago. These date the three that
 * can go stale; awaitingRebuild is not among them, and its own comment in RebuildNotice.tsx says
 * why (nothing records when a stamp went stale, and a boot rebuild clears it outright rather than
 * leaving a number sitting there).
 */
describe('RebuildNotice dates the states that can go stale', () => {
  it('dates the quarantine from when the rebuild failed', () => {
    const now = Date.now()
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]}
        lastError="boom" voice="self" rebuildInFlight={false}
        lastErrorAtMs={now - 3 * DAY_MS} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-blocked">Your data has stopped updating. A rebuild of your history failed 3 days ago, so new readings are not being collected. An administrator needs to look at this.</p>')
  })

  it('dates the quarantine from when the rebuild failed, in the admin voice', () => {
    const now = Date.now()
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]}
        lastError={null} voice="admin" personName="Robin" rebuildInFlight={false}
        lastErrorAtMs={now - 3 * DAY_MS} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-blocked">Robin has stopped receiving data. A rebuild of their history failed 3 days ago.</p>')
  })

  /**
   * "as of the rebuild ... ago", never "missing for ... ago". lastSuccessAtMs is when the figures
   * were last MEASURED, not when the drop began - a data type stuck failing across a
   * MAPPING_VERSION bump moves this timestamp forward on every later rebuild while the drop
   * itself is however old the first bad rebuild was, so the copy must not claim an onset.
   */
  it('dates the dropped-pages note, in the self voice', () => {
    const now = Date.now()
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing={false} droppedPages={4}
        drops={[]} lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 3 * HOUR_MS}
      />,
    )
    expect(html).toContain('<p class="maintenance-download-note">Part of your history could not be rebuilt and is missing from these pages, as of the rebuild 3 hours ago. Nothing has been deleted, and it will come back once the cause is fixed.</p>')
  })

  it('dates the dropped-pages note, in the admin voice, with its count', () => {
    const now = Date.now()
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing={false} droppedPages={7}
        drops={[]} lastError={null} voice="admin" personName="Robin" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 3 * HOUR_MS}
      />,
    )
    expect(html).toContain('<p class="maintenance-download-note">7 pages of Robin&#x27;s history could not be rebuilt, as of the rebuild 3 hours ago.</p>')
  })

  it('dates the empty-rebuild note from when the rebuild last committed', () => {
    const now = Date.now()
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 2 * HOUR_MS}
      />,
    )
    expect(html).toBe('<div class="maintenance"><p class="maintenance-waiting">Your history was rebuilt without any error, but it produced no readings, so these pages are empty, as of the rebuild 2 hours ago. Nothing has been deleted: everything ever collected for you is still stored, and a later version may be able to read it.</p></div>')
  })

  it('dates the empty-rebuild note, in the admin voice', () => {
    const now = Date.now()
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="admin" personName="Robin" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 2 * HOUR_MS}
      />,
    )
    expect(html).toBe('<div class="maintenance"><p class="maintenance-waiting">Robin&#x27;s history was rebuilt without any error, but it produced no readings, so their pages are empty, as of the rebuild 2 hours ago. Nothing has been deleted: everything ever collected for them is still stored, and a later version may be able to read it.</p></div>')
  })

  /**
   * The null path. A person can be quarantined by their very first ever attempt, which sets
   * lastErrorAtMs - so this specific pairing (quarantined true, lastErrorAtMs null) is not one
   * today's two callers can actually produce, since isQuarantined is defined as "this timestamp
   * is not null" (packages/core/src/store/rebuildState.ts). It is still asserted here because
   * nothing about this component's own prop types enforces that pairing, and the fallback exists
   * precisely so a caller that ever did fall out of step gets the plain sentence back rather than
   * a rendered "Invalid Date", "null" or "NaN".
   */
  it('falls back to the undated quarantine wording when no failure time is on file', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]}
        lastError="boom" voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-blocked">Your data has stopped updating. A rebuild of your history did not finish, so new readings are not being collected. An administrator needs to look at this.</p>')
    expect(html).not.toContain('ago')
    expect(html).not.toContain('Invalid Date')
    expect(html).not.toContain('NaN')
  })

  // The other reachable half of the same null path: a rebuild can commit and drop pages, or
  // commit and write nothing, with no success time on file only if the row itself is absent -
  // asserted here at this component's own boundary rather than assumed impossible.
  it('falls back to the undated dropped-pages wording when no success time is on file', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing={false} droppedPages={4}
        drops={[]} lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-download-note">Part of your history could not be rebuilt and is missing from these pages. Nothing has been deleted, and it will come back once the cause is fixed.</p>')
    expect(html).not.toContain('ago')
    expect(html).not.toContain('Invalid Date')
    expect(html).not.toContain('NaN')
  })

  it('falls back to the undated empty-rebuild wording when no success time is on file', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={null}
      />,
    )
    expect(html).toBe('<div class="maintenance"><p class="maintenance-waiting">Your history was rebuilt without any error, but it produced no readings, so these pages are empty. Nothing has been deleted: everything ever collected for you is still stored, and a later version may be able to read it.</p></div>')
    expect(html).not.toContain('ago')
    expect(html).not.toContain('Invalid Date')
    expect(html).not.toContain('NaN')
  })
})

/**
 * Dutch renderings of all seven dated keys, asserted as whole lines rather than merely present
 * (i18n-parity.test.ts already proves nl.json has every key en.json has - it says nothing about
 * whether the translation reads correctly with a real formatSince value spliced into it).
 *
 * The sub-minute case gets its own test per key that carries {{when}}, because that is the one a
 * review found genuinely wrong: formatSince used to hand numeric:'auto' a zero-minute distance,
 * and 'auto' idioms that as "binnen een minuut" (Dutch for "within a minute") - future tense,
 * for an event the whole point of this component is to say already happened. Fixed in formatSince
 * itself (apps/web/src/format.ts), not here, because Members.tsx's own "signed in" and "synced"
 * lines call the same function with the same exposure and neither had a test locking in the old,
 * wrong wording either.
 */
describe('RebuildNotice renders the dated strings in Dutch', () => {
  it('dates the quarantine, self voice', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]}
        lastError="boom" voice="self" rebuildInFlight={false}
        lastErrorAtMs={now - 3 * HOUR_MS} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-blocked">Je gegevens worden niet meer bijgewerkt. Een herbouw van je geschiedenis is 3 uur geleden mislukt, dus er worden geen nieuwe metingen verzameld. Een beheerder moet hiernaar kijken.</p>')
  })

  // The case the review flagged: a rebuild that failed under a minute ago must still read as
  // having already happened, not as a warning about to come true.
  it('dates the quarantine from a moment ago without slipping into future tense', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]}
        lastError="boom" voice="self" rebuildInFlight={false}
        lastErrorAtMs={now} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-blocked">Je gegevens worden niet meer bijgewerkt. Een herbouw van je geschiedenis is 0 minuten geleden mislukt, dus er worden geen nieuwe metingen verzameld. Een beheerder moet hiernaar kijken.</p>')
    expect(html).not.toContain('binnen')
  })

  it('dates the quarantine, admin voice', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} producedNothing={false} drops={[]}
        lastError={null} voice="admin" personName="Robin" rebuildInFlight={false}
        lastErrorAtMs={now - 3 * DAY_MS} lastSuccessAtMs={null}
      />,
    )
    expect(html).toContain('<p class="maintenance-blocked">Robin ontvangt geen gegevens meer. Een herbouw van hun geschiedenis is 3 dagen geleden mislukt.</p>')
  })

  it('dates the dropped-pages note, self voice', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing={false} droppedPages={4}
        drops={[]} lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 3 * HOUR_MS}
      />,
    )
    expect(html).toContain('<p class="maintenance-download-note">Een deel van je geschiedenis kon niet worden herbouwd en ontbreekt op deze pagina&#x27;s, op basis van de herbouw van 3 uur geleden. Er is niets verwijderd, en het komt terug zodra de oorzaak is verholpen.</p>')
  })

  it('dates the dropped-pages note without slipping into future tense when the rebuild just committed', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing={false} droppedPages={4}
        drops={[]} lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now}
      />,
    )
    expect(html).toContain('op basis van de herbouw van 0 minuten geleden')
    expect(html).not.toContain('binnen')
  })

  // droppedOtherSince_one, the singular count - present in both catalogues but never rendered by
  // any test before this one.
  it('dates the dropped-pages note, admin voice, in the singular', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing={false} droppedPages={1}
        drops={[]} lastError={null} voice="admin" personName="Robin" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 3 * HOUR_MS}
      />,
    )
    expect(html).toContain('<p class="maintenance-download-note">1 pagina van de geschiedenis van Robin kon niet worden herbouwd, op basis van de herbouw van 3 uur geleden.</p>')
  })

  it('dates the dropped-pages note, admin voice, in the plural', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing={false} droppedPages={7}
        drops={[]} lastError={null} voice="admin" personName="Robin" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 3 * HOUR_MS}
      />,
    )
    expect(html).toContain('<p class="maintenance-download-note">7 pagina&#x27;s van de geschiedenis van Robin konden niet worden herbouwd, op basis van de herbouw van 3 uur geleden.</p>')
  })

  it('dates the empty-rebuild note, self voice', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 2 * HOUR_MS}
      />,
    )
    expect(html).toBe('<div class="maintenance"><p class="maintenance-waiting">Je geschiedenis is zonder fouten herbouwd, maar leverde geen metingen op, dus deze pagina&#x27;s zijn leeg, op basis van de herbouw van 2 uur geleden. Er is niets verwijderd: alles wat ooit voor je is verzameld wordt nog bewaard, en een latere versie kan het misschien wel lezen.</p></div>')
  })

  it('dates the empty-rebuild note without slipping into future tense when the rebuild just committed', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="self" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now}
      />,
    )
    expect(html).toContain('op basis van de herbouw van 0 minuten geleden')
    expect(html).not.toContain('binnen')
  })

  it('dates the empty-rebuild note, admin voice', () => {
    const now = Date.now()
    const html = renderNl(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} producedNothing droppedPages={0} drops={[]}
        lastError={null} voice="admin" personName="Robin" rebuildInFlight={false}
        lastErrorAtMs={null} lastSuccessAtMs={now - 2 * HOUR_MS}
      />,
    )
    expect(html).toBe('<div class="maintenance"><p class="maintenance-waiting">De geschiedenis van Robin is zonder fouten herbouwd, maar leverde geen metingen op, dus hun pagina&#x27;s zijn leeg, op basis van de herbouw van 2 uur geleden. Er is niets verwijderd: alles wat ooit voor hen is verzameld wordt nog bewaard, en een latere versie kan het misschien wel lezen.</p></div>')
  })
})
