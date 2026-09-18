import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RebuildNotice } from '../src/components/RebuildNotice.js'
import { I18nProvider } from '../src/i18n/index.js'

// I18nProvider lng="en" wraps every render here, the same reason InsightCard's own suite does:
// with no language pinned, useTranslation resolves against whichever locale a previous test in
// this process happened to initialise last, not the one this file's assertions are written for.
const render = (node: React.ReactNode): string =>
  renderToStaticMarkup(<I18nProvider lng="en">{node}</I18nProvider>)

describe('RebuildNotice', () => {
  it('renders nothing when there is nothing wrong', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={0} drops={[]}
        lastError={null} voice="self"
      />,
    )
    expect(html).toBe('')
  })

  it('tells the person their data has stopped, not that pages were dropped', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} drops={[]} lastError="boom" voice="self"
      />,
    )
    expect(html).toContain('Your data has stopped updating')
    expect(html).not.toContain('could not be rebuilt and is missing')
  })

  it('names every dropped data type with its count', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined={false} droppedPages={7} lastError={null} voice="self"
        drops={[{ dataType: 'sleep', reason: 'UNIQUE constraint failed', pages: 7 }]}
      />,
    )
    // The exact row, not a bare '7': that substring stays green under a format regression that
    // renders '17' or '70' just as happily, the same gap
    // substring-assertions-hide-format-regressions calls out elsewhere in this codebase.
    expect(html).toContain('sleep: 7 pages, UNIQUE constraint failed')
  })

  // The admin voice names whose data it is, since a household's list of people reads nothing
  // like a person's own dashboard, which never needs to say its own name back to them.
  it('names the affected person in the admin voice', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} drops={[]} lastError={null}
        voice="admin" personName="Robin"
      />,
    )
    expect(html).toContain('Robin has stopped receiving data')
  })

  // The error the rebuild reported is shown verbatim (docs/ADR or core's own store already
  // decided lastError is safe to display -- see the commit this branch built on), and it is
  // shown whenever there is one, independent of which of the two states above is also true.
  it('shows the reported error when there is one', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} drops={[]} voice="self"
        lastError="UNIQUE constraint failed: samples.id"
      />,
    )
    expect(html).toContain('UNIQUE constraint failed: samples.id')
  })

  it('says nothing about an error when the store never recorded one', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild={false} quarantined droppedPages={0} drops={[]} lastError={null} voice="self"
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
        awaitingRebuild quarantined={false} droppedPages={0} drops={[]} lastError={null} voice="self"
      />,
    )
    expect(html).toContain('waiting for a rebuild of your history')
    expect(html).toContain('at the next restart of the server')
    // Nothing failed, so nothing on screen may say an administrator has to go and look.
    expect(html).not.toContain('An administrator needs to look at this')
  })

  it('names the person waiting for a rebuild in the admin voice', () => {
    const html = render(
      <RebuildNotice
        awaitingRebuild quarantined={false} droppedPages={0} drops={[]} lastError={null}
        voice="admin" personName="Robin"
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
        awaitingRebuild quarantined droppedPages={0} drops={[]} lastError={null} voice="self"
      />,
    )
    expect(html).toContain('Your data has stopped updating')
    expect(html).not.toContain('at the next restart of the server')
  })
})
