CREATE TABLE `credentials` (
	`person_id` text PRIMARY KEY NOT NULL,
	`refresh_token_encrypted` text NOT NULL,
	`granted_scopes` text NOT NULL,
	`revoked_at_ms` integer,
	`obtained_at_ms` integer NOT NULL,
	`client_id_override` text,
	`client_secret_override_encrypted` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `daily` (
	`person_id` text NOT NULL,
	`local_date` text NOT NULL,
	`metric` text NOT NULL,
	`agg` text NOT NULL,
	`source` text NOT NULL,
	`value` real,
	`coverage` real NOT NULL,
	`derivation_version` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `daily_person_metric_date` ON `daily` (`person_id`,`metric`,`local_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `daily_natural` ON `daily` (`person_id`,`local_date`,`metric`,`agg`,`source`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`started_at_ms` integer NOT NULL,
	`started_at_offset_minutes` integer NOT NULL,
	`ended_at_ms` integer,
	`ended_at_offset_minutes` integer,
	`value` real,
	`note` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`local_date` text NOT NULL,
	`body` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notes_person_date` ON `notes` (`person_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_encrypted` text NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`scope` text NOT NULL,
	`target_key` text NOT NULL,
	`action` text NOT NULL,
	`corrected_value` real,
	`reason` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `overrides_person_target` ON `overrides` (`person_id`,`scope`,`target_key`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`timezone` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `raw_payloads` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`data_type` text NOT NULL,
	`request_params` text NOT NULL,
	`window_start_ms` integer NOT NULL,
	`window_end_ms` integer NOT NULL,
	`fetched_at_ms` integer NOT NULL,
	`http_status` integer NOT NULL,
	`body_gzip` blob NOT NULL,
	`body_hash` text NOT NULL,
	`body_bytes` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `raw_payloads_person_type_window` ON `raw_payloads` (`person_id`,`data_type`,`window_start_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `raw_payloads_body_hash` ON `raw_payloads` (`person_id`,`data_type`,`body_hash`);--> statement-breakpoint
CREATE TABLE `samples` (
	`person_id` text NOT NULL,
	`source_id` text NOT NULL,
	`metric` text NOT NULL,
	`utc_ms` integer NOT NULL,
	`tz_offset_minutes` integer NOT NULL,
	`agg` text NOT NULL,
	`value` real,
	`n` integer NOT NULL,
	`raw_payload_id` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_payload_id`) REFERENCES `raw_payloads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `samples_person_metric_time` ON `samples` (`person_id`,`metric`,`utc_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `samples_natural` ON `samples` (`person_id`,`source_id`,`metric`,`utc_ms`,`agg`);--> statement-breakpoint
CREATE TABLE `session_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`stage` text NOT NULL,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_segments_session` ON `session_segments` (`session_id`,`start_ms`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`external_id` text NOT NULL,
	`start_ms` integer NOT NULL,
	`start_offset_minutes` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`end_offset_minutes` integer NOT NULL,
	`local_date` text NOT NULL,
	`attrs` text NOT NULL,
	`raw_payload_id` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_payload_id`) REFERENCES `raw_payloads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_person_kind_date` ON `sessions` (`person_id`,`kind`,`local_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_natural` ON `sessions` (`person_id`,`source_id`,`kind`,`external_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_person_external` ON `sources` (`person_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`person_id` text NOT NULL,
	`data_type` text NOT NULL,
	`high_water_ms` integer,
	`backfill_cursor_ms` integer,
	`backfill_complete_at_ms` integer,
	`last_success_at_ms` integer,
	`last_error_at_ms` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`person_id`, `data_type`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
