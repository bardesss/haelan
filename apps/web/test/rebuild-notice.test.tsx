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
      <RebuildNotice quarantined={false} droppedPages={0} drops={[]} lastError={null} voice="self" />,
    )
    expect(html).toBe('')
  })

  it('tells the person their data has stopped, not that pages were dropped', () => {
    const html = render(
      <RebuildNotice quarantined droppedPages={0} drops={[]} lastError="boom" voice="self" />,
    )
    expect(html).toContain('Your data has stopped updating')
    expect(html).not.toContain('could not be rebuilt and is missing')
  })

  it('names every dropped data type with its count', () => {
    const html = render(
      <RebuildNotice
        quarantined={false} droppedPages={7} lastError={null} voice="self"
        drops={[{ dataType: 'sleep', reason: 'UNIQUE constraint failed', pages: 7 }]}
      />,
    )
    expect(html).toContain('sleep')
    expect(html).toContain('7')
  })

  // The admin voice names whose data it is, since a household's list of people reads nothing
  // like a person's own dashboard, which never needs to say its own name back to them.
  it('names the affected person in the admin voice', () => {
    const html = render(
      <RebuildNotice
        quarantined droppedPages={0} drops={[]} lastError={null} voice="admin" personName="Robin"
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
        quarantined droppedPages={0} drops={[]} lastError="UNIQUE constraint failed: samples.id" voice="self"
      />,
    )
    expect(html).toContain('UNIQUE constraint failed: samples.id')
  })

  it('says nothing about an error when the store never recorded one', () => {
    const html = render(
      <RebuildNotice quarantined droppedPages={0} drops={[]} lastError={null} voice="self" />,
    )
    expect(html).not.toContain('The error the rebuild reported')
  })
})
