# Probe (throwaway)

Answers three questions before M1 starts: scope classification, refresh token lifetime,
and the real shape of v4 payloads. Delete this directory once M1 has landed.

Nothing here is production code. No error handling beyond what makes failures legible.

    node probe/auth.mjs          # one-time consent, writes probe/.tokens.json
    node probe/probe-api.mjs     # profile and paired devices, confirms the token works
    node probe/fetch-samples.mjs # archives one window per data type
    node probe/measure.mjs       # median interval and projected volume
    node probe/refresh-check.mjs # append one refresh result to the token log

M2p, 2026-08-22, measuring the rollup methods `total-calories` and `floors` answer instead of
`list`:

    node probe/scripts/rollup-shapes.mjs

It reads credentials from the instance database rather than `.env.local`, through
`probe/scripts/creds.mjs`. The two disagree: same client id, and the secret in the env file is
one Google now rejects with `invalid_client`. The M1d wizard wrote the current one into the
instance. Every M0 script above still reads the env file and therefore no longer authenticates,
including the scheduled `refresh-check`. See the last section of `findings/rollup-methods.md`.

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

## The refresh check no longer runs

It was registered 2026-08-19, daily at 09:00, logging to `findings/token-log.jsonl`, and was
deleted on 2026-08-22:

    schtasks /delete /tn "haelan-refresh-check" /f

Two reasons, in order. It had stopped working: it authenticates with `.env.local`, whose client
secret Google now rejects, so its last successful entry is 2026-08-21 and its last run exited
-2147020576. And it had stopped being needed: production status removes the documented 7 day
expiry, so the log was confirmation of an answer `findings/README.md` already states rather than
a measurement of anything open. The log stays as the record of the ten days it did run.

Git Bash rewrites a leading slash into a Windows path, so `schtasks /create` arrives as
`C:/Program Files/Git/create` and fails. Prefix with `MSYS_NO_PATHCONV=1`. Any setup
instruction that hands a Windows user a `schtasks` or `reg` command hits this.
