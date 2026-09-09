CREATE TABLE `metrics` (
	`ref` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metrics_name_unique` ON `metrics` (`name`);--> statement-breakpoint
ALTER TABLE `people` ADD `ref` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Existing rows all land here with the placeholder default at once, which would collide on the
-- unique index below on any table with more than one row; rowid is already unique per row, so
-- copying it in gives every existing person a distinct ref without inventing a new numbering.
UPDATE `people` SET `ref` = `rowid`;--> statement-breakpoint
CREATE UNIQUE INDEX `people_ref_unique` ON `people` (`ref`);--> statement-breakpoint
-- Nothing in application code sets `ref` on insert (that is the point: the surrogate is invisible
-- to every existing caller). This trigger is what makes "assigned on insert" true without an app
-- change: a fresh row lands with the placeholder default, and this immediately replaces it with
-- the row's own already-unique rowid.
CREATE TRIGGER `people_ref_ai` AFTER INSERT ON `people` WHEN NEW.`ref` = 0 BEGIN UPDATE `people` SET `ref` = NEW.`rowid` WHERE `rowid` = NEW.`rowid`; END;--> statement-breakpoint
ALTER TABLE `raw_payloads` ADD `ref` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `raw_payloads` SET `ref` = `rowid`;--> statement-breakpoint
CREATE UNIQUE INDEX `raw_payloads_ref_unique` ON `raw_payloads` (`ref`);--> statement-breakpoint
CREATE TRIGGER `raw_payloads_ref_ai` AFTER INSERT ON `raw_payloads` WHEN NEW.`ref` = 0 BEGIN UPDATE `raw_payloads` SET `ref` = NEW.`rowid` WHERE `rowid` = NEW.`rowid`; END;--> statement-breakpoint
ALTER TABLE `sources` ADD `ref` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sources` SET `ref` = `rowid`;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_ref_unique` ON `sources` (`ref`);--> statement-breakpoint
CREATE TRIGGER `sources_ref_ai` AFTER INSERT ON `sources` WHEN NEW.`ref` = 0 BEGIN UPDATE `sources` SET `ref` = NEW.`rowid` WHERE `rowid` = NEW.`rowid`; END;
