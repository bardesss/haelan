CREATE TABLE `session_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`at_ms` integer NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`altitude_metres` real,
	`horizontal_accuracy_metres` real,
	`vertical_accuracy_metres` real,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_routes_session` ON `session_routes` (`session_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_routes_natural` ON `session_routes` (`session_id`,`ordinal`);