CREATE TABLE `observations` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`source_id` text NOT NULL,
	`kind` text NOT NULL,
	`started_at_ms` integer NOT NULL,
	`started_at_offset_minutes` integer NOT NULL,
	`ended_at_ms` integer,
	`ended_at_offset_minutes` integer,
	`local_date` text NOT NULL,
	`value` text,
	`raw_payload_id` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_payload_id`) REFERENCES `raw_payloads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `observations_person_date` ON `observations` (`person_id`,`local_date`);