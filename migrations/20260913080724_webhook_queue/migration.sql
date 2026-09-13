CREATE TABLE `devin_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`github_delivery_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`devin_session_id` text UNIQUE,
	`pr_number` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`inserted_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_devin_sessions_github_delivery_id_github_webhook_deliveries_delivery_id_fk` FOREIGN KEY (`github_delivery_id`) REFERENCES `github_webhook_deliveries`(`delivery_id`),
	CONSTRAINT "devin_sessions_status_check" CHECK("status" IN ('pending', 'submitting', 'running', 'succeeded', 'failed')),
	CONSTRAINT "devin_sessions_attempts_check" CHECK("attempts" >= 0)
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
