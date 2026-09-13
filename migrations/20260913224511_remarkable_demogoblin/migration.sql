CREATE TABLE `attention_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`session_record_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`reason` text NOT NULL,
	`repo` text NOT NULL,
	`issue_number` integer,
	`remote_id` text,
	`session_url` text,
	`closed_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`body` text,
	`expected_app_id` integer,
	`expected_installation_id` integer,
	`possible_send_at` integer,
	`scan_page` integer DEFAULT 1 NOT NULL,
	`scan_matches` integer DEFAULT 0 NOT NULL,
	`scan_unverified` integer DEFAULT false NOT NULL,
	`comment_id` integer,
	`negative_scans` integer DEFAULT 0 NOT NULL,
	`last_failure` text,
	CONSTRAINT `fk_attention_notifications_session_record_id_devin_sessions_id_fk` FOREIGN KEY (`session_record_id`) REFERENCES `devin_sessions`(`id`),
	CONSTRAINT "attention_reason_check" CHECK("reason" IN ('needs_input', 'needs_approval')),
	CONSTRAINT "attention_status_check" CHECK("status" IN ('pending', 'delivered', 'cancelled', 'blocked')),
	CONSTRAINT "attention_flight_check" CHECK("possible_send_at" IS NULL OR ("body" IS NOT NULL AND "expected_app_id" IS NOT NULL AND "expected_app_id" > 0 AND "expected_installation_id" IS NOT NULL AND "expected_installation_id" > 0)),
	CONSTRAINT "attention_receipt_check" CHECK("status" != 'delivered' OR ("comment_id" IS NOT NULL AND "comment_id" > 0)),
	CONSTRAINT "attention_counters_check" CHECK("sequence" > 0 AND "version" >= 0 AND "attempts" >= 0 AND "scan_page" > 0 AND "scan_matches" >= 0 AND "negative_scans" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE `github_notification_gate` (
	`id` integer PRIMARY KEY DEFAULT 1,
	`version` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`next_request_at` integer DEFAULT 0 NOT NULL,
	`next_report_at` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "github_notification_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attention_episode_idx` ON `attention_notifications` (`session_record_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `attention_due_idx` ON `attention_notifications` (`status`,`due_at`);
--> statement-breakpoint
INSERT INTO `github_notification_gate` (`id`) VALUES (1);
--> statement-breakpoint
INSERT INTO `attention_notifications` (`id`, `session_record_id`, `sequence`, `reason`, `repo`, `issue_number`, `remote_id`, `session_url`)
SELECT lower(hex(randomblob(16))), s.id, 1, s.provider_lifecycle, d.repo, d.issue_number, s.devin_session_id, s.session_url
FROM devin_sessions s JOIN github_webhook_deliveries d ON d.delivery_id = s.github_delivery_id
WHERE s.status = 'submitted' AND s.provider_lifecycle IN ('needs_input', 'needs_approval');