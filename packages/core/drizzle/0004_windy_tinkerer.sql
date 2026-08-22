CREATE TABLE `source_priority` (
	`person_id` text NOT NULL,
	`metric` text NOT NULL,
	`source_id` text NOT NULL,
	`rank` integer NOT NULL,
	PRIMARY KEY(`person_id`, `metric`, `source_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `daily` ADD `source_mix` text;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `session_overlap_ratio` real DEFAULT 0.5 NOT NULL;