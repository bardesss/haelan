/**
 * Readable default names for the apps whose data carries no device name.
 *
 * What the data really carries: sources.ts's `describe()` names a source after the payload's
 * `device.displayName` when there is one, and otherwise after `application.packageName`, verbatim.
 * So a source of kind 'app' or 'manual' whose display name is a package name is a source nobody
 * ever gave a name to - the provider only told us which app wrote the record - and that raw id is
 * what the status panel, the pickers and Settings used to print: `com.haelan.android`,
 * `health.openscale.sync.oss`, and on a phone that has been reset or re-paired a handful of
 * `com.android.healthconnect.phone.<hash>` rows that differ only in the hash.
 *
 * The rule is keyed on the package name and gated on the kind, never on the display name alone: a
 * source of kind 'device' carries a name its device chose, and a watch that happened to call itself
 * "com.haelan.android" would be naming itself, which is its right. A 'manual' source is included
 * because `describe()` gives a typed-in reading from an app the same package-name display name, and
 * the person reads "Haelan (phone)" for it just as well as for the app's measured rows.
 *
 * Resolved at read time and never written to `sources.display_name`: a rebuild regenerates
 * `sources` from the archive, and keeping that regeneration a pure function of the archive is worth
 * more than saving a lookup. An alias always wins over a default, because an alias is the person's
 * own decision and a default is only this table's guess.
 *
 * The web localises from `key` (useSourceNames.ts mirrors DefaultName, the way it mirrors
 * NamedSource, rather than this module growing a browser subpath for one type); the English here is
 * what every surface without a reader's language gets - MCP tools, exports, the API's `name` field.
 */

/** The catalogue key the web app localises under `sourceNames.default.<key>`. */
export type KnownAppKey = 'haelanPhone' | 'openScale' | 'healthConnectPhone'

/**
 * What a surface needs to say a default name in the reader's language. Null for a source that is
 * not a known app. Beside an alias it is still set (without disambiguation), because Settings shows
 * it as the rename field's placeholder - what the source goes back to being called - but the alias
 * wins everywhere a name is printed; a surface that carries no alias (the status panel's rows, a
 * record's source) is sent null instead, so it cannot get the order wrong.
 */
export interface DefaultName {
  key: KnownAppKey
  /**
   * The person's local date (YYYY-MM-DD) the source was first seen, set only when two or more of
   * this person's un-renamed sources would otherwise print the same default name. Null otherwise,
   * because a date beside a name nothing else shares is noise.
   */
  since: string | null
  /**
   * The first characters of the source id, set only when `since` did not separate them either:
   * sources first created by the same upload, or re-keyed by the same rebuild, share a first-seen
   * date, and two identical labels merge into one legend entry and one picker option nobody can
   * tell apart. Ugly on purpose - it is the last resort, and renaming the source removes it.
   */
  tag: string | null
}

interface KnownApp {
  key: KnownAppKey
  english: string
  matches: (packageName: string) => boolean
}

/**
 * The known packages, and why each is here.
 *
 * `com.haelan.android` is this project's own companion app, which records through Health Connect
 * under its own package. `health.openscale.sync.oss` is the package openScale's Health Connect sync
 * add-on writes a scale's weighings under. `com.android.healthconnect.phone` is the
 * phone's own Health Connect recording - the platform suffixes it with a hash per install, so it
 * matches as a prefix; the bare name matches too, since nothing promises the suffix is always there.
 *
 * "Haelan", not the wordmark's "Hælan": a source name is copy a reader may type back (into the
 * rename field, a search, an agent's prompt), and brand-mark.test.tsx pins the rule that copy never
 * carries a character most keyboards cannot produce. The web catalogue says it the same way.
 *
 * Deliberately not here: Google Fit (`com.google.android.apps.fitness`), which appears in this
 * repository only as a synthetic fixture in sources.test.ts, and the companion app's debug build,
 * which only a developer ever runs. Add a package when the data shows it, not before.
 */
const KNOWN_APPS: readonly KnownApp[] = [
  { key: 'haelanPhone', english: 'Haelan (phone)', matches: (p) => p === 'com.haelan.android' },
  { key: 'openScale', english: 'openScale', matches: (p) => p === 'health.openscale.sync.oss' },
  {
    key: 'healthConnectPhone',
    english: 'Health Connect (phone)',
    matches: (p) => p === 'com.android.healthconnect.phone' || p.startsWith('com.android.healthconnect.phone.'),
  },
]

/** The known app a source's display name is the package of, or null. See the module comment. */
export function knownAppOf(source: { kind: 'device' | 'app' | 'manual', displayName: string }): KnownApp | null {
  if (source.kind === 'device') return null
  return KNOWN_APPS.find((app) => app.matches(source.displayName)) ?? null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "4 Sep 2026" from "2026-09-04". Hand-built rather than Intl, because the English default is a
 * fixed string an agent reads and a test pins, and ICU data differing between Node builds is not
 * something a name should depend on. The year is always said: the server has no "this year" to
 * leave it out against without reading a clock, and a name that changes on New Year's Day would
 * move every ETag that carries it.
 */
function englishDate(localDate: string): string {
  const [year, month, day] = localDate.split('-')
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`
}

/** The English form of a default name, with its disambiguation when it has one. */
export function englishDefaultName(defaultName: DefaultName): string {
  const app = KNOWN_APPS.find((a) => a.key === defaultName.key)!
  const dated = defaultName.since === null ? app.english : `${app.english}, since ${englishDate(defaultName.since)}`
  return defaultName.tag === null ? dated : `${dated} (${defaultName.tag})`
}

/** How many leading characters of the id `tag` carries. Enough for a household's handful. */
const TAG_LENGTH = 4

export interface NameableSource {
  id: string
  displayName: string
  kind: 'device' | 'app' | 'manual'
  alias: string | null
  /** The person's local date the source was first seen, from sources.createdAtMs. */
  firstSeenDate: string
}

/**
 * Every default name for one person's sources, disambiguated against each other.
 *
 * Takes the whole list rather than one source, because whether a default needs its date depends
 * on the others: one Health Connect row is "Health Connect (phone)", two are each told apart by
 * when they appeared. Only un-renamed sources count toward a collision - once the person has named
 * one of two, the other is alone under the default again and loses its date.
 *
 * Returns a map holding only the sources that are known apps; everything absent resolves through
 * the plain alias-then-display-name-then-id chain. A renamed known app is in it with no date or tag:
 * it collides with nothing while its alias stands, and the placeholder that reads it is a hint.
 */
export function defaultNamesOf(rows: readonly NameableSource[]): Map<string, DefaultName> {
  const byKey = new Map<KnownAppKey, NameableSource[]>()
  const out = new Map<string, DefaultName>()
  for (const row of rows) {
    const app = knownAppOf(row)
    if (app === null) continue
    if (row.alias !== null) {
      out.set(row.id, { key: app.key, since: null, tag: null })
      continue
    }
    byKey.set(app.key, [...(byKey.get(app.key) ?? []), row])
  }

  for (const [key, group] of byKey) {
    if (group.length === 1) {
      out.set(group[0]!.id, { key, since: null, tag: null })
      continue
    }
    const perDate = new Map<string, number>()
    for (const row of group) perDate.set(row.firstSeenDate, (perDate.get(row.firstSeenDate) ?? 0) + 1)
    for (const row of group) {
      const tag = (perDate.get(row.firstSeenDate) ?? 0) > 1 ? row.id.slice(0, TAG_LENGTH) : null
      out.set(row.id, { key, since: row.firstSeenDate, tag })
    }
  }
  return out
}
