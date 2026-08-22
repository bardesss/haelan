CREATE TABLE `derive_queue` (
	`person_id` text NOT NULL,
	`local_date` text NOT NULL,
	`queued_at_ms` integer NOT NULL,
	PRIMARY KEY(`person_id`, `local_date`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_daily` (
	`person_id` text NOT NULL,
	`local_date` text NOT NULL,
	`metric` text NOT NULL,
	`agg` text NOT NULL,
	`source` text NOT NULL,
	`value` real,
	`coverage` real,
	`derivation_version` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_daily`("person_id", "local_date", "metric", "agg", "source", "value", "coverage", "derivation_version") SELECT "person_id", "local_date", "metric", "agg", "source", "value", "coverage", "derivation_version" FROM `daily`;--> statement-breakpoint
DROP TABLE `daily`;--> statement-breakpoint
ALTER TABLE `__new_daily` RENAME TO `daily`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `daily_person_metric_date` ON `daily` (`person_id`,`metric`,`local_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `daily_natural` ON `daily` (`person_id`,`local_date`,`metric`,`agg`,`source`);