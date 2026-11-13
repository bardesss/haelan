CREATE TABLE `companion_deletions` (
	`person_id` text NOT NULL,
	`data_type` text NOT NULL,
	`record_id` text NOT NULL,
	`deleted_at_ms` integer NOT NULL,
	PRIMARY KEY(`person_id`, `record_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `companion_record_samples` (
	`person_ref` integer NOT NULL,
	`record_id` text NOT NULL,
	`source_ref` integer NOT NULL,
	`metric_ref` integer NOT NULL,
	`first_utc_ms` integer NOT NULL,
	`last_utc_ms` integer NOT NULL,
	PRIMARY KEY(`person_ref`, `record_id`, `metric_ref`, `source_ref`),
	FOREIGN KEY (`person_ref`) REFERENCES `people`(`ref`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`metric_ref`) REFERENCES `metrics`(`ref`) ON UPDATE no action ON DELETE no action
);
