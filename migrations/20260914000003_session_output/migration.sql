CREATE TABLE `__new_devin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`github_delivery_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`output` text,
	`devin_session_id` text UNIQUE,
	`pr_number` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claim_version` integer DEFAULT 0 NOT NULL,
	`recovery_empty_checks` integer DEFAULT 0 NOT NULL,
	`recovery_blocked` integer DEFAULT false NOT NULL,
	`inserted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_devin_sessions_github_delivery_id_github_webhook_deliveries_delivery_id_fk` FOREIGN KEY (`github_delivery_id`) REFERENCES `github_webhook_deliveries`(`delivery_id`),
	CONSTRAINT "devin_sessions_status_check" CHECK("status" IN ('pending', 'submitting', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "devin_sessions_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "devin_sessions_output_check" CHECK(("status" IN ('succeeded', 'failed') AND "output" IS NOT NULL AND CASE WHEN json_valid("output") THEN json_type("output") = 'object' AND json_type("output", '$.outcome') IS 'text' AND json_extract("output", '$.outcome') IN ('fixed', 'needs_human', 'not_reproducible', 'failed', 'already_resolved') AND json_type("output", '$.summary') IS 'text' AND length(trim(json_extract("output", '$.summary'))) > 0 ELSE 0 END) OR ("status" NOT IN ('succeeded', 'failed') AND "output" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_devin_sessions`(`id`, `github_delivery_id`, `status`, `output`, `devin_session_id`, `pr_number`, `attempts`, `claim_version`, `recovery_empty_checks`, `recovery_blocked`, `inserted_at`, `updated_at`) SELECT `id`, `github_delivery_id`, `status`, CASE WHEN `outcome` IS NULL THEN NULL ELSE json_object('outcome', `outcome`, 'summary', 'Legacy session: structured output was not recorded.') END, `devin_session_id`, `pr_number`, `attempts`, `claim_version`, `recovery_empty_checks`, `recovery_blocked`, `inserted_at`, `updated_at` FROM `devin_sessions`;--> statement-breakpoint
DROP TABLE `devin_sessions`;--> statement-breakpoint
ALTER TABLE `__new_devin_sessions` RENAME TO `devin_sessions`;
