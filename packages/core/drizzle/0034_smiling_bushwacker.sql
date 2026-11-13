CREATE TABLE `sync_window_failures` (
	`person_id` text NOT NULL,
	`data_type` text NOT NULL,
	`window_start_ms` integer NOT NULL,
	`window_end_ms` integer NOT NULL,
	`local_date` text NOT NULL,
	`consecutive_runs` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_failed_at_ms` integer NOT NULL,
	`skipped_at_ms` integer,
	PRIMARY KEY(`person_id`, `data_type`, `window_start_ms`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
