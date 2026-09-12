CREATE TABLE `mcp_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`at_ms` integer NOT NULL,
	`tool` text,
	`row_count` integer,
	`duration_ms` integer,
	`outcome` text NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `mcp_tokens`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mcp_calls_token_at` ON `mcp_calls` (`token_id`,`at_ms`);--> statement-breakpoint
CREATE INDEX `mcp_calls_at` ON `mcp_calls` (`at_ms`);--> statement-breakpoint
CREATE TABLE `mcp_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`last_used_at_ms` integer,
	`revoked_at_ms` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_token_hash_unique` ON `mcp_tokens` (`token_hash`);