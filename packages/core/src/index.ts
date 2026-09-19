export { openDatabase, closeDatabase, tableExists, DATABASE_FILENAME } from './db/open.ts'
// M4a-1. The open a process that is not the server uses: read-only, migrating nothing, creating
// no key. openHaelan does all three of those and is wrong for every surface except the server.
export { openReadOnly } from './db/openReadOnly.ts'
export type { Database, DbOrTx } from './db/open.ts'
export { migrateToLatest } from './db/migrate.ts'
export { databaseBloat, freeDiskBytes, BLOAT_FRACTION, BLOAT_FLOOR_BYTES, DISK_MARGIN } from './db/maintenance.ts'
export type { DatabaseBloat } from './db/maintenance.ts'
export { vacuumIfBloated, vacuumDecision } from './db/vacuum.ts'
export type { VacuumOutcome, VacuumDecision } from './db/vacuum.ts'
export * as schema from './db/schema/index.ts'
export { loadOrCreateKey, KEY_FILENAME, KEY_ENV_VAR } from './crypto/key.ts'
export { seal, unseal } from './crypto/secretBox.ts'
export { CredentialStore } from './store/credentials.ts'
export type { ClientCredentials, StoredRefreshToken } from './store/credentials.ts'
export { RawArchive } from './store/rawArchive.ts'
export type { PutInput, PutResult, ArchivedPayload } from './store/rawArchive.ts'
// insertSample and readSamples are here rather than only in the package's own tests because
// `samples` is keyed on integers now: a caller outside this package that reached for
// `schema.samples` directly would have to build refs by hand, and could not read a metric
// name back out of a row at all.
export {
  createTestDatabase, seedPerson, corruptArchivedBodies, insertSample, readSamples,
} from './testing/fixtures.ts'
export type { TestDatabase } from './testing/fixtures.ts'
export {
  ACTIONS, DATA_TYPES, dataTypeById, FILTER_MEMBERS, horizonDaysFor, supports,
  INTRADAY_HORIZON_DAYS, USER_HORIZON_CHOICES, DEFAULT_USER_HORIZON_DAYS,
} from './api/catalogue.ts'
export type { Action, DataType, FilterMember, MappingTarget, TypeTier } from './api/catalogue.ts'
export { TokenProvider, RevokedError } from './api/tokens.ts'
export type { TokenProviderDeps } from './api/tokens.ts'
export { HealthClient } from './api/client.ts'
export type { ListInput, ListResult, ClientDeps } from './api/client.ts'
export { mapSamples, mapWindowSamples } from './api/mapSamples.ts'
export type { SampleRow } from './api/mapSamples.ts'
export { mapSessions } from './api/mapSessions.ts'
export type { SessionRow, SegmentRow } from './api/mapSessions.ts'
export { mapObservations } from './api/mapObservations.ts'
export type { MapObservationsInput } from './api/mapObservations.ts'
export {
  HaelanError, AuthError, TransientError, SchemaDriftError, DataQualityError, ConfigError,
  CredentialsUnreadableError, classifyHttp,
} from './errors.ts'
export type { ErrorKind } from './errors.ts'
export { openHaelan } from './instance.ts'
export type { Instance } from './instance.ts'
export { SourceRegistry } from './store/sources.ts'
export { SyncStateStore } from './store/syncState.ts'
export type { SyncJob, SyncStateRow } from './store/syncState.ts'
export { dayWindows, startOfLocalDay } from './sync/windows.ts'
export type { Window } from './sync/windows.ts'
export { TokenBucket } from './sync/tokenBucket.ts'
export type { TokenBucketDeps } from './sync/tokenBucket.ts'
export { runJob } from './sync/runJob.ts'
export type { JobDeps, JobInput, JobResult, RateLimiter } from './sync/runJob.ts'
export { runSync } from './sync/runSync.ts'
export type { SyncInput, SyncReport } from './sync/runSync.ts'
export { DeriveQueue } from './store/deriveQueue.ts'
export type { QueueEntry } from './store/deriveQueue.ts'

// M1d. The wizard and the accounts behind it: everything the server needs to take an instance
// from an empty volume to a syncing household, and nothing it does not. `apps/server` reaches
// core only through this file, which is why the store classes are here rather than deep
// imported: `exports` in package.json publishes this module and no other.
export { PeopleStore } from './store/people.ts'
export type { PersonRow } from './store/people.ts'
export { AccountStore } from './store/accounts.ts'
export type {
  AccountRow, AccountListRow, CreateAccountInput, LoginInput, LoginResult,
} from './store/accounts.ts'
export { SessionStore, SESSION_TTL_MS, SESSION_LAST_SEEN_RESOLUTION_MS } from './store/sessions.ts'
export {
  SettingsStore, setupStep, DEFAULT_BACKUP_KEEP, DEFAULT_BACKUP_INTERVAL_HOURS,
} from './store/settings.ts'
export type {
  InstanceSettingsRow, PutSettingsInput, SetupStep, SetupDeps, BackupPolicy,
} from './store/settings.ts'
export { CONSENT_PATHS } from './db/schema/accounts.ts'
export type { ConsentPath } from './db/schema/accounts.ts'
export { buildConsentUrl, exchangeAuthorizationCode, probeAccess, SCOPES } from './api/oauth.ts'
export type { ConsentUrlInput, ExchangeInput, ExchangeResult, ProbeInput } from './api/oauth.ts'
export { runBackfill } from './sync/runBackfill.ts'
export type { BackfillInput, BackfillResult } from './sync/runBackfill.ts'
export type { SyncProgress } from './sync/runJob.ts'
// Synthetic payload builders, exported for the server's Google stub. Test-only in intent, and
// the file they come from invents every value it emits: nothing here reads real health data.
export { samplePoint, intervalPoint, dailyPoint, sleepPoint, body, dailyRollupBody } from './testing/payloads.ts'
export type { RollupWindow } from './testing/payloads.ts'
// The demo data generator. The upgrade rehearsal drives it from outside this package through
// this export. `scripts/seed-demo.mjs`, which writes the README screenshots' data, does not: it
// deep-imports `testing/seed.ts` directly, the same way `check-enum-drift.mjs` deep-imports its
// own catalogue module, because `@haelan/core` does not resolve from a script run at the repo
// root - only a package that declares it as a dependency gets that resolution.
export { seedArchive } from './testing/seed.ts'
export type { SeedArchiveInput, SeedArchiveResult } from './testing/seed.ts'

// M2a. The derivation layer: tier 3 from tier 2, and the two types that have no tier 2 at all.
// ACTIONS, supports, DeriveQueue and QueueEntry are exported above already, added when earlier
// tasks in this milestone first needed them across the apps/server boundary.
export { METRICS, DAILY_AGGS, metricSpec } from './derive/metrics.ts'
export type { MetricSpec, DailyAgg } from './derive/metrics.ts'
export { DERIVATION_VERSION } from './derive/version.ts'
export { MAPPING_VERSION } from './api/version.ts'
export { peopleNeedingRebuild } from './rebuild/versions.ts'
export type { RebuildNeed } from './rebuild/versions.ts'
export { runRebuild } from './rebuild/runRebuild.ts'
export type {
  RebuildInput, RebuildReport, RebuildPersonReport, RebuildFailure,
} from './rebuild/runRebuild.ts'
export type { OrphanedOverride } from './rebuild/retarget.ts'
export { RebuildStateStore, isQuarantined } from './store/rebuildState.ts'
export type { RebuildDrop, RebuildStateRow } from './store/rebuildState.ts'
export { localDateOf, localHourOf, shiftLocalDate, widenedUtcWindow } from './derive/localDay.ts'
// The same question as localDateOf above, asked with an IANA zone rather than a fixed offset.
// Aliased because the two cannot share a name and a caller holding a person's `timezone` string
// needs this one: an offset is a fact about an instant, a zone is a fact about a person.
export { localDateOf as localDateInZone } from './sync/localDate.ts'
export { coverageOf } from './derive/coverage.ts'
export { rollUpDay, PROVIDER_SOURCE } from './derive/rollup.ts'
export type { DailyRow, SampleLike } from './derive/rollup.ts'
export { runDerive } from './derive/runDerive.ts'
export type { DeriveReport } from './derive/runDerive.ts'
export { deriveDayInto } from './derive/deriveDay.ts'
export type { DeriveDayInput } from './derive/deriveDay.ts'
export { mapRollups } from './api/mapRollups.ts'
export type { RollupMapping } from './api/mapRollups.ts'
export { runRollupJob, rollupRangeCapDays } from './sync/runRollupJob.ts'

// M2b. Choosing between sources, and the corrections that apply while we do.
export { priorityFrom, fallbackOrder, DEFAULT_LIST, UNRANKED_BASE } from './derive/priority.ts'
export type { Priority, PriorityInput, SourceFacts } from './derive/priority.ts'
export { mergeDay } from './derive/merge.ts'
export type { MixEntry, MergeDayInput } from './derive/merge.ts'
export { MERGED_SOURCE } from './derive/rollup.ts'
export { SourcePriorityStore } from './store/sourcePriority.ts'
export type { StoredList } from './store/sourcePriority.ts'
export { SourceAliasStore, nameFor, MAX_ALIAS_LENGTH } from './store/sourceAliases.ts'
export type { NamedSource } from './store/sourceAliases.ts'
export { ExcludedDataTypeStore } from './store/excludedDataTypes.ts'
export { getSource } from './store/sources.ts'
export type { SourceRow } from './store/sources.ts'
export {
  sampleTarget, sessionTarget, dayMetricTarget,
  parseSampleTarget, parseSessionTarget, parseDayMetricTarget,
} from './derive/targetKey.ts'
export type { OverrideScope, SampleTarget, DayMetricTarget } from './derive/targetKey.ts'
// applyToSamples, applyToDay, applyToSessions, excludedMetrics and encodeMix are deliberately
// absent. Each has exactly one caller, deriveDayInto, inside the transaction it was given, and
// this file is the package's only integration point with the server and the other apps. The
// same line is already drawn for the mappers' internals.
export type { OverrideLike, SessionLike } from './derive/overrides.ts'
export { OverrideStore } from './store/overrides.ts'
export type { PutOverrideInput, StoredOverride } from './store/overrides.ts'
export { NoteStore } from './store/notes.ts'
export type { PutNoteInput, StoredNote } from './store/notes.ts'
export { EventStore } from './store/events.ts'
export type { AddEventInput, StoredEvent } from './store/events.ts'
export { ObservationStore } from './store/observations.ts'
export type { ObservationRow } from './store/observations.ts'
export { InviteStore, INVITE_TTL_MS } from './store/invites.ts'
export type { PendingInvite } from './store/invites.ts'
export {
  McpTokenStore, mcpTokenUsable, MCP_TOKEN_PREFIX, MCP_TOKEN_DAYS, DEFAULT_MCP_TOKEN_DAYS,
} from './store/mcpTokens.ts'
export type { McpToken, McpTokenDays } from './store/mcpTokens.ts'
export { McpCallLog, MCP_CALL_LOG_TTL_MS } from './store/mcpCalls.ts'
export type { McpCall } from './store/mcpCalls.ts'
export type { McpCallOutcome } from './db/schema/index.ts'
export { groupSessions, DEFAULT_OVERLAP_RATIO } from './derive/sessionOverlap.ts'
export type { SessionGroup, GroupSessionsInput } from './derive/sessionOverlap.ts'

// M2c. Sleep, from sessions and their stages to a day's figures.
export { assembleNights, deriveSleepDay, DEFAULT_NIGHT_GAP_MINUTES, ASLEEP_STAGES, AWAKE_STAGES } from './derive/sleep.ts'
export type { SleepSessionLike, SleepSegmentLike, NightAssembly } from './derive/sleep.ts'
export { mergeSleepDay } from './derive/sleepMerge.ts'
export { SLEEP_METRICS } from './derive/metrics.ts'

// M2d. The query layer M3 and M4 both sit on, and the statistics behind it.
export { PersonQuery, requireDate } from './query/personQuery.ts'
export type { DailyPoint, SeriesResult } from './query/personQuery.ts'
export { PROJECTION_TABLES } from './query/projection.ts'
export { baselineOf, baselineWindow, zScoreOf, BASELINE_WINDOW_DAYS, BASELINE_MIN_DAYS } from './query/baseline.ts'
export type { Baseline } from './query/baseline.ts'
export { readSourceActivity } from './query/sourceActivity.ts'
export { readAllTime, RECORD_METRICS } from './query/allTime.ts'
export type { AllTime, AllTimeSpan, MetricRecord, Milestone } from './query/allTime.ts'
export { eddingtonOf } from './api/eddington.ts'
export { recordOf } from './api/allTimeRecords.ts'
export type { DailyRecord, DatedValue } from './api/allTimeRecords.ts'
export { longestRun, MIN_RUN_DAYS } from './api/runs.ts'
export type { Run } from './api/runs.ts'
export type { SourceActivity } from './query/sourceActivity.ts'
export {
  cadenceOf, MIN_REPORTING_DATES, STALE_GAP_MULTIPLIER, STALE_FLOOR_DAYS, UNJUDGED_FLOOR_DAYS,
} from './api/sourceCadence.ts'
export type { SourceCadence, SourceStatus } from './api/sourceCadence.ts'
export { comparePeriods, INSIGHT_MIN_DAY_FRACTION, INSIGHT_MIN_COVERAGE } from './query/insights.ts'
export type { Insight, PeriodPoint, SuppressionReason, DateRange } from './query/insights.ts'
export { coverageIsMeaningful } from './query/coverageSignal.ts'

// M3b1. The rest of PersonQuery's readers: intraday samples, sleep nights, workout sessions and
// the computed trend. Only the shapes they hand back are exported here, never the module level
// readers themselves: those take a person id as a plain argument, and PersonQuery is the only
// place that binding is allowed to live.
export type { Thinned } from './query/downsample.ts'
export type { IntradayPoint, IntradayResult } from './query/intraday.ts'
export type { Night, NightSegment } from './query/sleepNights.ts'
export type { WorkoutSession } from './query/sessions.ts'
export type { TrendPoint } from './query/trend.ts'

// M3b2 task 7. /changes reads "which days moved since a moment", which none of the above answer.
// Same discipline as the readers above: readChanges takes a plain person id and stays unexported,
// reachable only through PersonQuery.changes, so a later SQL surface never gets a way to name a
// person id straight from the outside.
export type { ChangedPair, ChangesResult } from './query/changes.ts'

// M5d-a. The translator between a metric name, a person id, a source id and a raw payload id and
// the narrow integer ref each of their tables carries. Every reader and writer of `samples` goes
// through it, and a caller outside this package that wants to write or read a sample row has to:
// the table's five identifier columns are integers, and a ref means nothing without it.
export { SampleKeys } from './db/keys.ts'
export type { SampleText } from './db/keys.ts'

// M5d-c. A daily compacted copy, verified before it is ever called a backup.
export { runBackup, listBackups, pruneBackups, backupDecision, BACKUP_DIR_NAME } from './backup/runBackup.ts'
export type { BackupFile, BackupDecision } from './backup/runBackup.ts'

// M4a-1. The query layer additions the agent surface reads through, and the workout decoder two
// apps now share. readIntradayWindow itself is deliberately absent, the same line every other
// module level reader is on: it takes a person id as a plain argument, and PersonQuery is the
// only way in from outside this package.
export type { WorkoutSummary } from './api/workoutSummary.ts'
export { workoutSummary, numberOrNull } from './api/workoutSummary.ts'
export { EXERCISE_TYPES } from './api/enums.ts'

// M4a-2 task 3. describe_person's own reader: the bound person's id, display name, timezone and
// sources, in the shape PersonQuery.describe returns it. Same discipline as every bound reader
// above — only the shape is exported, never a module level function taking a person id.
export type { DescribedPerson } from './query/personQuery.ts'
