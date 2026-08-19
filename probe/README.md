# Probe (throwaway)

Answers three questions before M1 starts: scope classification, refresh token lifetime,
and the real shape of v4 payloads. Delete this directory once M1 has landed.

Nothing here is production code. No error handling beyond what makes failures legible.

    node probe/auth.mjs          # one-time consent, writes probe/.tokens.json
    node probe/probe-api.mjs     # profile and paired devices, confirms the token works
    node probe/fetch-samples.mjs # archives one window per data type
    node probe/measure.mjs       # median interval and projected volume
    node probe/refresh-check.mjs # append one refresh result to the token log

## Deviations from the plan

The plan was written before the v4 reference was published and guessed at the surface.
Three corrections, each verified against developers.google.com/health:

1. There is no `GET /dataTypes` discovery endpoint. Data type names are documented, not
   discoverable, so `fetch-types.mjs` became `probe-api.mjs`: it calls `users.getProfile`
   and `users.pairedDevices.list` as the token smoke test instead.
2. Reads are `GET /v4/users/me/dataTypes/{dataType}/dataPoints`, not
   `/dataTypes/{type}/data`. The rollup methods are POST, so `api()` takes a method and body.
3. Data type ids are kebab-case (`heart-rate`, `oxygen-saturation`), not the snake_case the
   plan's fetch list used.

## The refresh check runs on a schedule

Registered 2026-08-19, daily at 09:00, logging to `findings/token-log.jsonl`:

    schtasks /query /tn "haelan-refresh-check"

Remove it when this directory goes, or it keeps firing against a deleted script:

    schtasks /delete /tn "haelan-refresh-check" /f

Git Bash rewrites a leading slash into a Windows path, so `schtasks /create` arrives as
`C:/Program Files/Git/create` and fails. Prefix with `MSYS_NO_PATHCONV=1`. Any setup
instruction that hands a Windows user a `schtasks` or `reg` command hits this.
