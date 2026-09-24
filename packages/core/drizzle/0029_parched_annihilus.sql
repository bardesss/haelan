ALTER TABLE `instance_settings` ADD `last_sync_finished_at_ms` integer;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `last_sync_rows_written` integer;--> statement-breakpoint
ALTER TABLE `instance_settings` ADD `last_sync_failed` integer;