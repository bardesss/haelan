import { apiSend, ApiError } from '../api/client.js'

export type SignInResult = { ok: true } | { ok: false, messageKey: 'signIn.failed' | 'signIn.unreachable' }

export async function submitSignIn(input: { username: string, password: string }): Promise<SignInResult> {
  try {
    await apiSend('POST', '/api/auth/login', input)
    return { ok: true }
  } catch (error) {
    if (error instanceof ApiError && error.kind === 'unreachable') {
      return { ok: false, messageKey: 'signIn.unreachable' }
    }
    // Every other answer is "these credentials did not work", said the same way whichever half was
    // wrong: naming the half tells an attacker which usernames exist.
    return { ok: false, messageKey: 'signIn.failed' }
  }
}
