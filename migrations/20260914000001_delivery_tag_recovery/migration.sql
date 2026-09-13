ALTER TABLE `devin_sessions` ADD `claim_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `recovery_empty_checks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `recovery_blocked` integer DEFAULT false NOT NULL;