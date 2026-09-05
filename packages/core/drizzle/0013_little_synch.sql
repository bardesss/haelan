CREATE TABLE `excluded_data_types` (
	`person_id` text NOT NULL,
	`data_type_id` text NOT NULL,
	`excluded_at_ms` integer NOT NULL,
	PRIMARY KEY(`person_id`, `data_type_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
