CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_account_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`redeemed_at_ms` integer,
	`revoked_at_ms` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);