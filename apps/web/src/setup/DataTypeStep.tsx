import { useState } from 'react'
import { useTranslation } from '../i18n/index.js'
import { DataTypePicker } from '../components/DataTypePicker.js'
import { useDataTypes, useSetDataTypes } from '../data/useDataTypes.js'

/**
 * Shown once, between consent and backfill, on SetupApp's own local state. setupStep in
 * packages/core is computed from accounts, settings and credentials, the same three inputs it has
 * always had; this screen adds no fourth value to it; SetupApp decides to show it the same way it
 * already decides to show BackfillStep, which is also not one of setupStep's values.
 *
 * Continue always advances, whether or not a choice was made and whether or not saving it
 * succeeded. The alternative -- a wizard nobody can finish because an optional preference 500'd --
 * is worse than fetching one data type somebody meant to turn off, and the default the person
 * lands on either way, everything on, is the same thing the sync engine already does for a data
 * type it has never heard a preference about.
 */
export function DataTypeStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const { items } = useDataTypes()
  const setDataTypes = useSetDataTypes()
  // Null until DataTypePicker's onChange fires once. Continue only has something worth saving
  // once a reader has actually touched a checkbox, so clicking straight through issues no PUT at
  // all rather than one that repeats back the same set the GET just answered with.
  //
  // Once non-null, this is the ONLY source of the checked set: items never changes underneath it
  // (no mutation fires until Continue, so the GET this screen mounted with is all items ever
  // holds), so a second click computed against items would silently undo the first one -- the
  // Critical this component used to reproduce. DataTypePicker's `excluded` prop is fed this array
  // directly rather than anything derived from items once a reader has touched a checkbox.
  const [pending, setPending] = useState<string[] | null>(null)
  const excluded = pending ?? items.filter((item) => item.excluded).map((item) => item.id)

  const handleContinue = () => {
    if (pending === null) {
      onDone()
      return
    }
    // onSettled, not onSuccess: a failed save still has to release the wizard, which is the whole
    // point of this screen existing outside setupStep's derivation.
    setDataTypes.mutate({ excluded: pending }, { onSettled: onDone })
  }

  return (
    <section className="setup-step">
      <h1>{t('setup.dataTypes.title')}</h1>
      <p>{t('setup.dataTypes.intro')}</p>
      <DataTypePicker items={items} excluded={excluded} disabled={setDataTypes.isPending} onChange={setPending} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={setDataTypes.isPending}
          onClick={handleContinue}
        >
          {t('setup.dataTypes.continue')}
        </button>
      </div>
    </section>
  )
}
