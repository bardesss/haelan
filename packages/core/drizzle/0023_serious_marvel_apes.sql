ALTER TABLE `rebuild_state` ADD `rows_written` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rebuild_state` ADD `payloads_with_data` integer DEFAULT 0 NOT NULL;