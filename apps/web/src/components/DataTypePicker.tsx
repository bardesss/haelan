import { useTranslation } from '../i18n/index.js'
import type { DataTypeChoice } from '../data/useDataTypes.js'

/**
 * One checkbox per catalogue type the sync engine can fetch, checked when the type is being
 * synced for this person.
 *
 * The route this reads from (and writes back to) keeps exclusions, not inclusions --
 * ExcludedDataTypeStore's own vocabulary, so a catalogue type added later syncs for everyone by
 * default rather than needing every person's row updated to include it. A reader of this control
 * thinks the other way around ("is my step count being synced"), so the excluded-to-checked flip
 * happens exactly once, here: Settings wires this component to the mutation without knowing the
 * inversion exists, and the wizard gets the same guarantee by reusing this component rather than
 * building its own checkbox list against the same route.
 *
 * `excluded` is a prop, not derived from `items`, because the parent -- not this component --
 * owns which set is checked. Settings can get away with reading it off `items` (`item.excluded`)
 * because every toggle there mutates and invalidates immediately, so the server state `items`
 * carries catches up before the next click; the wizard fires no mutation until Continue, so
 * `items` never changes mid-step and a second uncheck computed from it would only ever see the
 * first one undone. Deriving `checked` from `items` here reproduced that bug one layer down: React
 * would restore a just-unchecked box because `items` still said it was on, showing the opposite of
 * what the pending PUT was about to do. Taking the checked set as a prop means there is exactly one
 * place either caller's state actually lives, and this component never has an opinion about it.
 */
export function DataTypePicker({ items, excluded, onChange, disabled }: {
  items: DataTypeChoice[]
  excluded: string[]
  onChange: (excluded: string[]) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const excludedSet = new Set(excluded)
  const allOff = items.length > 0 && items.every((item) => excludedSet.has(item.id))

  const toggle = (id: string, checked: boolean): void => {
    const next = checked ? excluded.filter((existing) => existing !== id) : [...excluded, id]
    onChange(next)
  }

  return (
    <div className="data-type-picker">
      {allOff && <p className="field-hint">{t('settings.dataTypes.allOff')}</p>}
      <ul className="data-type-list">
        {items.map((item) => (
          <li key={item.id} className="data-type-row">
            <label>
              <input
                type="checkbox"
                checked={!excludedSet.has(item.id)}
                disabled={disabled}
                onChange={(e) => toggle(item.id, e.currentTarget.checked)}
              />
              <span className="data-type-label">{item.id}</span>
            </label>
            <span className="data-type-tier">{item.tier}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
