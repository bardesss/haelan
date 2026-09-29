// @vitest-environment happy-dom
//
// happy-dom for the toggle's click, which needs a real mount; the rest reads static markup parsed
// into a host element, which needs a document to parse into.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { ComponentProps } from 'react'
import { I18nProvider } from '../src/i18n/index.js'
import { ExpandableList } from '../src/pages/period/ExpandableList.js'

// Twenty synthetic nights, newest first, across two months: 2026-09-10 back to 2026-08-22.
const NIGHTS = Array.from({ length: 20 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 8, 10 - i))
  return date.toISOString().slice(0, 10)
})

type Props = ComponentProps<typeof ExpandableList<string>>
function render(o: Partial<Props> = {}, lng = 'en') {
  const props: Props = {
    items: NIGHTS, keyOf: (night) => night, render: (night) => <p className="night">{night}</p>,
    expanded: false, onToggle: () => {}, ...o,
  }
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<I18nProvider lng={lng}><ExpandableList {...props} /></I18nProvider>)
  return host
}

const nights = (host: HTMLElement) => [...host.querySelectorAll('.night')].map((night) => night.textContent)

describe('ExpandableList', () => {
  it('shows the first 7 of 20, and a button offering all 20', () => {
    const host = render()
    expect(nights(host)).toEqual(NIGHTS.slice(0, 7))
    const button = host.querySelector('button.button')
    expect(button?.textContent).toBe('Show all 20')
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.period-list-expanded')).toBeNull()
  })

  it('words the button in Dutch', () => {
    expect(render({}, 'nl').querySelector('button')?.textContent).toBe('Toon alle 20')
    expect(render({ expanded: true }, 'nl').querySelector('button')?.textContent).toBe('Toon minder')
  })

  it('names what it shows where the caller words the button', () => {
    expect(render({ showAll: (count) => `Show all ${count} nights` }).querySelector('button')?.textContent).toBe('Show all 20 nights')
    // Expanded, "Show fewer" stays the list's own.
    expect(render({ expanded: true, showAll: (count) => `Show all ${count} nights` }).querySelector('button')?.textContent).toBe('Show fewer')
  })

  it('takes its own count of visible items', () => {
    expect(nights(render({ visible: 3 }))).toEqual(NIGHTS.slice(0, 3))
  })

  it('shows every item, and no button, when there are no more than it shows', () => {
    const host = render({ items: NIGHTS.slice(0, 7), expanded: true })
    expect(nights(host)).toEqual(NIGHTS.slice(0, 7))
    expect(host.querySelector('button')).toBeNull()
    expect(host.querySelector('.period-list-expanded')).toBeNull()
  })

  it('expanded, shows all 20 in columns under their months, and offers fewer', () => {
    const host = render({ expanded: true, groupOf: (night) => night.slice(0, 7), groupLabel: (month) => `month ${month}` })
    expect(nights(host)).toEqual(NIGHTS)
    expect(host.querySelector('.period-list-expanded')).not.toBeNull()
    const groups = [...host.querySelectorAll('.period-list-group')]
    expect(groups.map((group) => group.querySelector('h3')?.textContent)).toEqual(['month 2026-09', 'month 2026-08'])
    expect(groups.map((group) => group.querySelectorAll('.night').length)).toEqual([10, 10])
    const button = host.querySelector('button')
    expect(button?.textContent).toBe('Show fewer')
    expect(button?.getAttribute('aria-expanded')).toBe('true')
  })

  it('names a group by its key without a label', () => {
    const host = render({ expanded: true, groupOf: (night) => night.slice(0, 7) })
    expect([...host.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual(['2026-09', '2026-08'])
  })

  it('expanded without groups, lists every item with no headings', () => {
    const host = render({ expanded: true })
    expect(nights(host)).toEqual(NIGHTS)
    expect(host.querySelector('h3')).toBeNull()
  })

  it('hands the toggle back to the page, collapsed and expanded alike', () => {
    for (const expanded of [false, true]) {
      const onToggle = vi.fn()
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      act(() => {
        root.render(<I18nProvider lng="en"><ExpandableList items={NIGHTS} keyOf={(night) => night} render={(night) => night}
          expanded={expanded} onToggle={onToggle} /></I18nProvider>)
      })
      act(() => { host.querySelector('button')!.click() })
      expect(onToggle).toHaveBeenCalledTimes(1)
      act(() => { root.unmount() })
      host.remove()
    }
  })
})
