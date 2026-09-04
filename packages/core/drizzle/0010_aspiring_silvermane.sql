CREATE TABLE `source_aliases` (
	`person_id` text NOT NULL,
	`source_id` text NOT NULL,
	`alias` text NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`person_id`, `source_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_aliases_person_alias` ON `source_aliases` (`person_id`,`alias`);