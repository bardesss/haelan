CREATE TABLE `rebuild_drops` (
	`person_id` text NOT NULL,
	`data_type` text NOT NULL,
	`reason` text NOT NULL,
	`pages` integer NOT NULL,
	PRIMARY KEY(`person_id`, `data_type`, `reason`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rebuild_state` (
	`person_id` text PRIMARY KEY NOT NULL,
	`last_attempt_at_ms` integer,
	`last_success_at_ms` integer,
	`last_error_at_ms` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`dropped_pages` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
