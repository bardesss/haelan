ALTER TABLE `people` ADD `current_timezone` text;--> statement-breakpoint
ALTER TABLE `people` ADD `follow_phone_zone` integer DEFAULT true NOT NULL;