CREATE TABLE `moods` (
	`person_id` text NOT NULL,
	`local_date` text NOT NULL,
	`score` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `moods_person_date` ON `moods` (`person_id`,`local_date`);--> statement-breakpoint
ALTER TABLE `people` ADD `quick_log_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `quick_log_presets` text;