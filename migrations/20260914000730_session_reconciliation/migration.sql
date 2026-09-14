CREATE TABLE `session_admin_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_record_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`remote_id` text,
	`outcome` text NOT NULL,
	`http_status` integer,
	`recorded_at` text NOT NULL,
	CONSTRAINT `fk_session_admin_events_session_record_id_devin_sessions_id_fk` FOREIGN KEY (`session_record_id`) REFERENCES `devin_sessions`(`id`)
);
--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `local_ownership` text DEFAULT 'tracking' NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `lookup_failure_streak` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `lookup_failure_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `first_lookup_failure_at` text;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `last_lookup_failure_at` text;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `last_lookup_failure` text;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `reconciliation_escalated_at` text;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `next_recovery_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `admin_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `recovery_candidate_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `session_admin_events_session_idx` ON `session_admin_events` (`session_record_id`,`id`);
--> statement-breakpoint
-- Baseline's two-empty-list fallback could leave an ambiguous POST queued again.
-- Quarantine only that durable signature, without inventing provider evidence.
INSERT INTO `session_admin_events` (`session_record_id`, `action`, `reason`, `outcome`, `recorded_at`)
SELECT `id`, 'migration', 'Migration quarantined the legacy ambiguous-create retry; remote execution is unchanged.', 'legacy_ambiguous_retry', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `devin_sessions`
WHERE `status` = 'pending' AND `devin_session_id` IS NULL AND `recovery_empty_checks` >= 2;
--> statement-breakpoint
UPDATE `devin_sessions`
SET `status` = 'submitting', `recovery_blocked` = true, `reconciliation_escalated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `status` = 'pending' AND `devin_session_id` IS NULL AND `recovery_empty_checks` >= 2;
