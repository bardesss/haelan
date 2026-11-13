import type { TFunction } from 'i18next'

// The three refusals the callback itself decides on, before Google is asked anything. The server
// keeps no message for them (a refusal that came before the exchange has nothing to explain), so
// the wizard writes the sentence.
const REFUSALS = { bad_state: 'badState', no_session: 'noSession', wrong_person: 'wrongPerson' } as const

export function callbackCodeOf(route: string): string | null {
  const query = route.split('?')[1]
  if (query === undefined) return null
  const code = new URLSearchParams(query).get('error')
  return code === null || code === '' ? null : code
}

export function refusalMessage(code: string, origin: string, t: TFunction): string | null {
  if (!Object.hasOwn(REFUSALS, code)) return null
  return t(`setup.callback.${REFUSALS[code as keyof typeof REFUSALS]}`, { baseUrl: origin })
}
