CREATE TABLE `__new_devin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`github_delivery_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`devin_session_id` text UNIQUE,
	`pr_number` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`inserted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_devin_sessions_github_delivery_id_github_webhook_deliveries_delivery_id_fk` FOREIGN KEY (`github_delivery_id`) REFERENCES `github_webhook_deliveries`(`delivery_id`),
	CONSTRAINT "devin_sessions_status_check" CHECK("status" IN ('pending', 'submitting', 'running', 'succeeded', 'failed', 'skipped')),
	CONSTRAINT "devin_sessions_attempts_check" CHECK("attempts" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_devin_sessions` (
	`id`, `github_delivery_id`, `status`, `devin_session_id`, `pr_number`, `attempts`, `inserted_at`, `updated_at`
)
SELECT `id`, `github_delivery_id`, `status`, `devin_session_id`, `pr_number`, `attempts`, `inserted_at`, `updated_at`
FROM `devin_sessions`;
--> statement-breakpoint
DROP TABLE `devin_sessions`;
--> statement-breakpoint
ALTER TABLE `__new_devin_sessions` RENAME TO `devin_sessions`;
