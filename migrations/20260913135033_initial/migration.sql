CREATE TABLE `devin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`github_delivery_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`output` text,
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
	CONSTRAINT "devin_sessions_status_check" CHECK("status" IN ('pending', 'submitting', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "devin_sessions_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "devin_sessions_analysis_attempts_check" CHECK("analysis_attempts" >= 0),
	CONSTRAINT "devin_sessions_analysis_check" CHECK(("analysis_status" = 'collected' AND "analysis" IS NOT NULL AND CASE WHEN json_valid("analysis") THEN json_type("analysis") = 'object' ELSE 0 END) OR ("analysis_status" IN ('pending', 'unavailable') AND "analysis" IS NULL)),
	CONSTRAINT "devin_sessions_output_check" CHECK(("status" IN ('succeeded', 'failed') AND "output" IS NOT NULL AND CASE WHEN json_valid("output") THEN json_type("output") = 'object' AND json_type("output", '$.outcome') IS 'text' AND json_extract("output", '$.outcome') IN ('fixed', 'needs_human', 'not_reproducible', 'failed', 'already_resolved') AND json_type("output", '$.summary') IS 'text' AND length(trim(json_extract("output", '$.summary'))) > 0 ELSE 0 END) OR ("status" NOT IN ('succeeded', 'failed') AND "output" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `github_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL UNIQUE,
	`event_name` text NOT NULL,
	`repo` text NOT NULL,
	`issue_number` integer,
	`payload` text NOT NULL,
	`inserted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `devin_sessions_analysis_due_idx` ON `devin_sessions` (`analysis_status`,`analysis_next_attempt_at`);