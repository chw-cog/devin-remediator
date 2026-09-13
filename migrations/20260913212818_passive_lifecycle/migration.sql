PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_devin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`github_delivery_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`provider_status` text,
	`provider_status_detail` text,
	`provider_lifecycle` text,
	`active_work` integer,
	`is_archived` integer,
	`provider_created_at` integer,
	`provider_updated_at` integer,
	`session_url` text,
	`last_observed_at` text,
	`next_observation_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`observation_version` integer DEFAULT 0 NOT NULL,
	`observation_lease_until` text,
	`completion_observed_at` text,
	`outputs` text DEFAULT '[]' NOT NULL,
	`analysis` text,
	`analysis_status` text DEFAULT 'pending' NOT NULL,
	`analysis_attempts` integer DEFAULT 0 NOT NULL,
	`analysis_next_attempt_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL,
	`analysis_reason` text,
	`devin_session_id` text UNIQUE,
	`pr_number` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_version` integer DEFAULT 0 NOT NULL,
	`recovery_empty_checks` integer DEFAULT 0 NOT NULL,
	`recovery_blocked` integer DEFAULT false NOT NULL,
	`inserted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_devin_sessions_github_delivery_id_github_webhook_deliveries_delivery_id_fk` FOREIGN KEY (`github_delivery_id`) REFERENCES `github_webhook_deliveries`(`delivery_id`),
	CONSTRAINT "devin_sessions_status_check" CHECK("status" IN ('pending', 'submitting', 'submitted', 'failed', 'skipped')),
	CONSTRAINT "devin_sessions_provider_lifecycle_check" CHECK("provider_lifecycle" IS NULL OR "provider_lifecycle" IN ('active', 'needs_input', 'needs_approval', 'paused', 'needs_intervention', 'completed', 'closed')),
	CONSTRAINT "devin_sessions_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "devin_sessions_analysis_attempts_check" CHECK("analysis_attempts" >= 0),
	CONSTRAINT "devin_sessions_analysis_check" CHECK(("analysis_status" = 'collected' AND "analysis" IS NOT NULL AND CASE WHEN json_valid("analysis") THEN json_type("analysis") = 'object' ELSE 0 END) OR ("analysis_status" IN ('pending', 'unavailable') AND "analysis" IS NULL)),
	CONSTRAINT "devin_sessions_outputs_check" CHECK(CASE WHEN json_valid("outputs") THEN json_type("outputs") = 'array' ELSE 0 END)
);
--> statement-breakpoint
INSERT INTO `__new_devin_sessions`(`id`, `github_delivery_id`, `status`, `outputs`, `analysis`, `analysis_status`, `analysis_attempts`, `analysis_next_attempt_at`, `analysis_reason`, `devin_session_id`, `pr_number`, `attempts`, `claim_version`, `recovery_empty_checks`, `recovery_blocked`, `inserted_at`, `updated_at`) SELECT `id`, `github_delivery_id`, CASE WHEN `status` IN ('running', 'succeeded') AND `devin_session_id` IS NULL THEN 'submitting' WHEN `status` IN ('running', 'succeeded', 'failed') AND `devin_session_id` IS NOT NULL THEN 'submitted' ELSE `status` END, `outputs`, `analysis`, `analysis_status`, `analysis_attempts`, `analysis_next_attempt_at`, `analysis_reason`, `devin_session_id`, `pr_number`, `attempts`, `claim_version`, `recovery_empty_checks`, CASE WHEN `status` IN ('running', 'succeeded') AND `devin_session_id` IS NULL THEN 1 ELSE `recovery_blocked` END, `inserted_at`, `updated_at` FROM `devin_sessions`;--> statement-breakpoint
DROP TABLE `devin_sessions`;--> statement-breakpoint
ALTER TABLE `__new_devin_sessions` RENAME TO `devin_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `devin_sessions_observation_due_idx` ON `devin_sessions` (`status`,`next_observation_at`);--> statement-breakpoint
CREATE INDEX `devin_sessions_analysis_due_idx` ON `devin_sessions` (`analysis_status`,`analysis_next_attempt_at`);
