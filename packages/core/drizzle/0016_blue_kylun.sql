-- Written in two drizzle-kit passes and merged into one file by hand, because generating the
-- drop and the create together makes drizzle-kit ask, column by column, whether `person_ref` is a
-- rename of `person_id` and so on, and there is no non-interactive way to answer "no, all five are
-- new". Each half below is the generator's own output, unedited; only the join is by hand, and the
-- snapshot beside this file is the one the second pass produced.
--
-- The rows are deliberately not copied. That is not an omission: `samples` is tier 2, regenerable
-- in full from the archived payloads in `raw_payloads`, and copying would mean translating text
-- into integers for 1.6 million rows inside a migration transaction - the slowest and least
-- recoverable place to do it. The next task bumps MAPPING_VERSION and DERIVATION_VERSION, which is
-- what makes the boot rebuild refill this table from tier 1 on the first run after the upgrade.
-- A migration that drops a 1.6 million row table without copying it looks like a mistake to
-- anyone who finds it later, which is why it says so here.

DROP TABLE `samples`;
--> statement-breakpoint
CREATE TABLE `samples` (
	`person_ref` integer NOT NULL,
	`source_ref` integer NOT NULL,
	`metric_ref` integer NOT NULL,
	`utc_ms` integer NOT NULL,
	`tz_offset_minutes` integer NOT NULL,
	`agg_ref` integer NOT NULL,
	`value` real,
	`n` integer NOT NULL,
	`raw_payload_ref` integer,
	FOREIGN KEY (`person_ref`) REFERENCES `people`(`ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_ref`) REFERENCES `sources`(`ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`metric_ref`) REFERENCES `metrics`(`ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_payload_ref`) REFERENCES `raw_payloads`(`ref`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `samples_person_metric_time` ON `samples` (`person_ref`,`metric_ref`,`utc_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `samples_natural` ON `samples` (`person_ref`,`source_ref`,`metric_ref`,`utc_ms`,`agg_ref`);