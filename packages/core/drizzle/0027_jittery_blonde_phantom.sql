ALTER TABLE `people` ADD `sleep_target_minutes` integer DEFAULT 480 NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `sleep_use_baseline` integer DEFAULT true NOT NULL;