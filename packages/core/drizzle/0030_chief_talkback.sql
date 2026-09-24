CREATE TABLE `source_panel_visibility` (
	`person_id` text NOT NULL,
	`source_id` text NOT NULL,
	`visible` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	PRIMARY KEY(`person_id`, `source_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
