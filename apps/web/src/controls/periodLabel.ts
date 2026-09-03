import type { RangeKey } from './range.js'

// The stepper used to print both ISO endpoints joined by common.to: 32 characters reading
// "2026-09-01 tot en met 2026-09-30" directly beside the button the reader had just pressed to ask
// for a month. A period chosen from a fixed set of five has a name, and in all five cases the name
// is both shorter and closer to the question being asked than its own bounds are. It was also the
// widest thing in the control row by a wide margin, at 413px of a 920px row, so the row wrapped and
// staggered; that is a consequence of this rather than the reason for it.
//
// Every Date below is built and formatted in UTC on purpose. These strings are plain calendar dates
// carrying no zone of their own, and parsing one through a zone behind UTC moves it to the previous
// day, which prints the wrong month name for every period that starts on the 1st.
const utc = (iso: string): Date => new Date(`${iso}T00:00:00Z`)
const fmt = (locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' })

// Month and day names come from Intl rather than the catalogue, so a locale the app has no
// translation file for still gets its own month names here rather than English ones, and nl.json
// does not carry twelve month names that Intl already knows.
export function periodLabel(tab: RangeKey, from: string, to: string, locale: string): string {
  const a = utc(from)
  const b = utc(to)
  const year = from.slice(0, 4)
  const sameYear = year === to.slice(0, 4)

  // A single day, whichever tab produced it: the Day tab always, and any other tab whose period
  // collapsed to one day. Checked before the switch so those two cannot disagree.
  if (from === to) return fmt(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(a)

  if (tab === 'year') return sameYear ? year : `${year} - ${to.slice(0, 4)}`

  // Only when the two ends really are inside one calendar month. The Month tab's period is a
  // calendar month today (M3d-1), but a hand typed anchor or a future change to how periods are
  // cut could hand this two ends that straddle a boundary, and "september 2026" for a window
  // reaching into October would be a label stating something false rather than merely terse.
  if (tab === 'month' && from.slice(0, 7) === to.slice(0, 7)) {
    return fmt(locale, { month: 'long', year: 'numeric' }).format(a)
  }

  if (tab === '3months') {
    if (!sameYear) {
      const my = fmt(locale, { month: 'short', year: 'numeric' })
      return `${my.format(a)} - ${my.format(b)}`
    }
    const m = fmt(locale, { month: 'short' })
    return `${m.format(a)} - ${m.format(b)} ${year}`
  }

  // Week, and any month-tab period that straddled a boundary above. Day precision, with the year
  // printed once when both ends share it and on both ends when they do not.
  if (!sameYear) {
    const dmy = fmt(locale, { day: 'numeric', month: 'short', year: 'numeric' })
    return `${dmy.format(a)} - ${dmy.format(b)}`
  }
  const dm = fmt(locale, { day: 'numeric', month: 'short' })
  return `${dm.format(a)} - ${dm.format(b)} ${year}`
}
