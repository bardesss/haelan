// Node's default for an unhandled rejection is to end the process. A late write or a timer
// callback that rejects after its caller moved on is a failed unit of work, not a reason to
// take every household's dashboard down, so it is logged and the server keeps running.
export function installProcessGuards(
  target: { on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown },
  logError: (message: string, error: unknown) => void,
): void {
  target.on('unhandledRejection', (reason) => { logError('unhandled rejection', reason) })
}
