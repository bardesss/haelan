import { useQueryClient } from '@tanstack/react-query'
import { useSession } from '../../auth/session.js'
import { useTranslation } from '../../i18n/index.js'
import { ErrorState } from '../../components/ErrorState.js'
import { Loading } from '../../components/Loading.js'
import { DataTypePicker } from '../../components/DataTypePicker.js'
import { dataTypesKey, useDataTypes, useSetDataTypes } from '../../data/useDataTypes.js'

/**
 * Wires DataTypePicker to the query and the mutation; the picker itself knows neither exists,
 * the same split SourceNames.tsx keeps from useSourceNames.ts, and for the same reason here too:
 * Task 7's wizard step needs the identical checkbox list before a person has a Settings page to
 * mount it from, so nothing query- or mutation-shaped can live in the component it reuses.
 *
 * Rendered for every person, not gated on isAdmin the way Members below it is: what a person
 * fetches for themselves is their own choice, not a household-wide setting an admin arbitrates.
 */
export function DataTypes() {
  const { t } = useTranslation()
  const session = useSession()
  const queryClient = useQueryClient()
  const { items, isPending, isError } = useDataTypes()
  const setDataTypes = useSetDataTypes()

  if (isPending) return <Loading />
  if (isError) {
    return (
      <ErrorState onRetry={() => {
        const personId = session.data?.personId
        if (personId !== undefined) void queryClient.refetchQueries({ queryKey: dataTypesKey(personId), exact: true })
      }} />
    )
  }

  const excluded = items.filter((item) => item.excluded).map((item) => item.id)

  return (
    <div>
      <p className="field-hint">{t('settings.dataTypes.detail')}</p>
      <DataTypePicker
        items={items}
        excluded={excluded}
        disabled={setDataTypes.isPending}
        onChange={(next) => setDataTypes.mutate({ excluded: next })}
        allOffKey="settings.dataTypes.allOff"
      />
      {setDataTypes.isError && <p className="field-error">{t('settings.dataTypes.failed')}</p>}
    </div>
  )
}
