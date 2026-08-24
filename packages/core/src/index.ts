export { openDatabase, closeDatabase, tableExists, DATABASE_FILENAME } from './db/open.ts'
export type { Database, DbOrTx } from './db/open.ts'
export { migrateToLatest } from './db/migrate.ts'
export * as schema from './db/schema/index.ts'
export { loadOrCreateKey, KEY_FILENAME, KEY_ENV_VAR } from './crypto/key.ts'
export { seal, unseal } from './crypto/secretBox.ts'
export { CredentialStore } from './store/credentials.ts'
export type { ClientCredentials, StoredRefreshToken } from './store/credentials.ts'
export { RawArchive } from './store/rawArchive.ts'
export type { PutInput, PutResult, ArchivedPayload } from './store/rawArchive.ts'
export { createTestDatabase, seedPerson, corruptArchivedBodies } from './testing/fixtures.ts'
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
export { HaelanError, AuthError, TransientError, SchemaDriftError, DataQualityError, ConfigError, classifyHttp } from './errors.ts'
export type { ErrorKind } from './errors.ts'
export { openHaelan } from './instance.ts'
export type { Instance } from './instance.ts'
export { SourceRegistry } from './store/sources.ts'
export { SyncStateStore } from './store/syncState.ts'
export type { SyncJob, SyncStateRow } from './store/syncState.ts'
export { dayWindows } from './sync/windows.ts'
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
export type { AccountRow, CreateAccountInput, LoginInput, LoginResult } from './store/accounts.ts'
export { SessionStore, SESSION_TTL_MS } from './store/sessions.ts'
export { SettingsStore, setupStep } from './store/settings.ts'
export type { InstanceSettingsRow, PutSettingsInput, SetupStep, SetupDeps } from './store/settings.ts'
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
export { localDateOf, localHourOf } from './derive/localDay.ts'
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
export { groupSessions, DEFAULT_OVERLAP_RATIO } from './derive/sessionOverlap.ts'
export type { SessionGroup, GroupSessionsInput } from './derive/sessionOverlap.ts'

// M2c. Sleep, from sessions and their stages to a day's figures.
export { assembleNights, deriveSleepDay, DEFAULT_NIGHT_GAP_MINUTES, ASLEEP_STAGES, AWAKE_STAGE } from './derive/sleep.ts'
export type { SleepSessionLike, SleepSegmentLike, NightAssembly } from './derive/sleep.ts'
export { mergeSleepDay } from './derive/sleepMerge.ts'
export { SLEEP_METRICS } from './derive/metrics.ts'

// M2d. The query layer M3 and M4 both sit on, and the statistics behind it.
export { PersonQuery } from './query/personQuery.ts'
export type { DailyPoint } from './query/personQuery.ts'
export { baselineOf, zScoreOf, BASELINE_WINDOW_DAYS, BASELINE_MIN_DAYS } from './query/baseline.ts'
export type { Baseline } from './query/baseline.ts'
export { comparePeriods, INSIGHT_MIN_DAY_FRACTION, INSIGHT_MIN_COVERAGE } from './query/insights.ts'
export type { Insight, PeriodPoint, SuppressionReason, DateRange } from './query/insights.ts'
export { coverageIsMeaningful } from './query/coverageSignal.ts'

// M3b1. The rest of PersonQuery's readers: intraday samples, sleep nights, workout sessions and
// the computed trend. Only the shapes they hand back are exported here, never the module level
// readers themselves: those take a person id as a plain argument, and PersonQuery is the only
// place that binding is allowed to live.
export type { Thinned } from './query/downsample.ts'
export type { IntradayPoint } from './query/intraday.ts'
export type { Night, NightSegment } from './query/sleepNights.ts'
export type { WorkoutSession } from './query/sessions.ts'
export type { TrendPoint } from './query/trend.ts'
