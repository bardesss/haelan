ALTER TABLE `rebuild_state` ADD `rows_written` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `rebuild_state` ADD `payloads_seen` integer DEFAULT 0 NOT NULL;