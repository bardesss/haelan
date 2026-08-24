import { apiSend } from '../api/client.js'

export function submitSignOut(): Promise<void> {
  return apiSend('POST', '/api/auth/logout')
}
