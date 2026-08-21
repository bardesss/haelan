CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until_ms` integer,
	`created_at_ms` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_person_id_unique` ON `accounts` (`person_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_unique` ON `accounts` (`username`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `instance_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`consent_path` text NOT NULL,
	`sync_interval_minutes` integer DEFAULT 60 NOT NULL,
	`setup_completed_at_ms` integer,
	`updated_at_ms` integer NOT NULL
);
