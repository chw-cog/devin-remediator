CREATE TABLE `issue_admissions` (
	`repo` text NOT NULL,
	`issue_number` integer NOT NULL,
	`canonical_session_id` text NOT NULL UNIQUE,
	CONSTRAINT `issue_admissions_pk` PRIMARY KEY(`repo`, `issue_number`),
	CONSTRAINT `fk_issue_admissions_canonical_session_id_devin_sessions_id_fk` FOREIGN KEY (`canonical_session_id`) REFERENCES `devin_sessions`(`id`) ON UPDATE RESTRICT ON DELETE RESTRICT,
	CONSTRAINT "issue_admissions_repo_check" CHECK("repo" = lower("repo") AND "repo" NOT GLOB '*[^a-z0-9_./-]*' AND length("repo") - length(replace("repo", '/', '')) = 1 AND "repo" NOT LIKE '/%' AND "repo" NOT LIKE '%/'),
	CONSTRAINT "issue_admissions_number_check" CHECK(typeof("issue_number") = 'integer' AND "issue_number" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `next_submission_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;--> statement-breakpoint
ALTER TABLE `devin_sessions` ADD `observation_requested` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TEMP TABLE admission_candidates AS
SELECT s.id, lower(d.repo) AS repo, d.issue_number,
  CASE WHEN d.repo NOT GLOB '*[^A-Za-z0-9_./-]*'
    AND length(d.repo) - length(replace(d.repo, '/', '')) = 1
    AND d.repo NOT LIKE '/%' AND d.repo NOT LIKE '%/'
    AND typeof(d.issue_number) = 'integer' AND d.issue_number BETWEEN 1 AND 9007199254740991
    THEN 1 ELSE 0 END AS identified,
  CASE WHEN json_valid(d.payload) THEN
    d.event_name = 'issues' AND json_extract(d.payload, '$.action') = 'labeled'
    AND json_extract(d.payload, '$.label.name') = 'devin'
    ELSE 0 END AS eligible,
  CASE WHEN s.devin_session_id IS NOT NULL THEN 0
    WHEN s.status IN ('submitting', 'submitted') OR s.recovery_empty_checks > 0
      OR s.provider_lifecycle IS NOT NULL OR s.provider_created_at IS NOT NULL
      OR s.provider_updated_at IS NOT NULL OR s.last_observed_at IS NOT NULL
      OR s.session_url IS NOT NULL OR s.pr_number IS NOT NULL
      OR s.completion_observed_at IS NOT NULL OR s.analysis IS NOT NULL
      OR s.recovery_candidate_ids != '[]'
      OR EXISTS (SELECT 1 FROM json_each(s.outputs) o WHERE CASE WHEN o.type = 'object'
        AND json_extract(o.value, '$.outcome') = 'failed'
        AND json_extract(o.value, '$.summary') IN (
          'Submission attempts exhausted before session creation.',
          'Submission rejected; retry attempts exhausted.',
          'Submission permanently rejected before session creation.'
        ) THEN 0 ELSE 1 END) THEN 1
    WHEN s.attempts > 0 OR s.status != 'pending' THEN 2 ELSE 3 END AS priority,
  s.inserted_at
FROM devin_sessions s JOIN github_webhook_deliveries d ON d.delivery_id = s.github_delivery_id;
--> statement-breakpoint
CREATE TEMP TABLE admission_safety (
  safe INTEGER NOT NULL CHECK(safe = 1)
);
--> statement-breakpoint
CREATE TEMP TRIGGER admission_safety_guard
BEFORE INSERT ON admission_safety
WHEN NEW.safe != 1
BEGIN
  SELECT RAISE(ABORT, 'Migration blocked: creation evidence lacks a trustworthy repository and issue identity; investigate on a database copy without deleting evidence.');
END;
--> statement-breakpoint
INSERT INTO admission_safety SELECT 0 FROM admission_candidates WHERE priority <= 1 AND identified = 0;
--> statement-breakpoint
INSERT INTO issue_admissions (repo, issue_number, canonical_session_id)
SELECT repo, issue_number, id FROM (
  SELECT *, row_number() OVER (PARTITION BY repo, issue_number ORDER BY priority, inserted_at, id) AS ordinal
  FROM admission_candidates WHERE identified = 1 AND (eligible = 1 OR priority <= 1)
) WHERE ordinal = 1;
--> statement-breakpoint
INSERT INTO session_admin_events (session_record_id, action, reason, outcome, recorded_at)
SELECT s.id, 'migration', 'Lifetime issue admission blocks never-created duplicate or ineligible queued work.',
  CASE WHEN c.identified = 0 THEN 'issue_identity_quarantined' ELSE 'issue_admission_skipped' END,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM devin_sessions s JOIN admission_candidates c ON s.id = c.id
WHERE s.status = 'pending' AND c.priority >= 2
  AND NOT EXISTS (SELECT 1 FROM issue_admissions a WHERE a.canonical_session_id = s.id);
--> statement-breakpoint
UPDATE devin_sessions SET status = 'skipped', recovery_blocked = 1,
  claim_version = claim_version + 1, observation_version = observation_version + 1,
  admin_version = admin_version + 1, observation_lease_until = NULL
WHERE status = 'pending' AND id IN (SELECT id FROM admission_candidates WHERE priority >= 2)
  AND NOT EXISTS (SELECT 1 FROM issue_admissions a WHERE a.canonical_session_id = devin_sessions.id);
--> statement-breakpoint
UPDATE devin_sessions SET next_submission_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
WHERE status = 'pending' AND attempts > 0 AND id IN (SELECT id FROM admission_candidates WHERE priority >= 2);
--> statement-breakpoint
INSERT INTO session_admin_events (session_record_id, action, reason, outcome, recorded_at)
SELECT s.id, 'migration', 'Creation evidence on pending work requires verified recovery, never another POST.',
  'issue_creation_quarantined', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM devin_sessions s JOIN admission_candidates c ON c.id = s.id
WHERE s.status = 'pending' AND s.devin_session_id IS NULL AND c.priority <= 1;
--> statement-breakpoint
UPDATE devin_sessions SET status = 'submitting', recovery_blocked = 1,
  claim_version = claim_version + 1, admin_version = admin_version + 1
WHERE status = 'pending' AND devin_session_id IS NULL AND id IN (SELECT id FROM admission_candidates WHERE priority <= 1);
--> statement-breakpoint
DROP TABLE admission_candidates;
--> statement-breakpoint
DROP TRIGGER admission_safety_guard;
--> statement-breakpoint
DROP TABLE admission_safety;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_validate BEFORE INSERT ON issue_admissions
WHEN EXISTS (SELECT 1 FROM issue_admissions WHERE repo = NEW.repo AND issue_number = NEW.issue_number AND canonical_session_id != NEW.canonical_session_id)
OR NOT EXISTS (
  SELECT 1 FROM devin_sessions s JOIN github_webhook_deliveries d ON d.delivery_id = s.github_delivery_id
  WHERE s.id = NEW.canonical_session_id AND lower(d.repo) = NEW.repo AND d.issue_number = NEW.issue_number
)
BEGIN SELECT RAISE(ABORT, 'Invalid issue admission binding'); END;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_no_update BEFORE UPDATE ON issue_admissions
BEGIN SELECT RAISE(ABORT, 'Issue admission is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_no_delete BEFORE DELETE ON issue_admissions
BEGIN SELECT RAISE(ABORT, 'Issue admission is permanent'); END;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_session_identity BEFORE UPDATE OF id, github_delivery_id ON devin_sessions
WHEN EXISTS (SELECT 1 FROM issue_admissions WHERE canonical_session_id = OLD.id)
  AND (NEW.id != OLD.id OR NEW.github_delivery_id != OLD.github_delivery_id)
BEGIN SELECT RAISE(ABORT, 'Canonical session identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_delivery_identity BEFORE UPDATE OF delivery_id, repo, issue_number ON github_webhook_deliveries
WHEN EXISTS (SELECT 1 FROM devin_sessions s JOIN issue_admissions a ON a.canonical_session_id = s.id WHERE s.github_delivery_id = OLD.delivery_id)
  AND (NEW.delivery_id != OLD.delivery_id OR NEW.repo != OLD.repo OR NEW.issue_number IS NOT OLD.issue_number)
BEGIN SELECT RAISE(ABORT, 'Canonical delivery identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_delivery_replace BEFORE INSERT ON github_webhook_deliveries
WHEN EXISTS (
  SELECT 1 FROM github_webhook_deliveries d JOIN devin_sessions s ON s.github_delivery_id = d.delivery_id
  JOIN issue_admissions a ON a.canonical_session_id = s.id
  WHERE d.delivery_id = NEW.delivery_id AND (d.repo != NEW.repo OR d.issue_number IS NOT NEW.issue_number)
)
BEGIN SELECT RAISE(ABORT, 'Canonical delivery identity is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_dispatch BEFORE UPDATE ON devin_sessions
WHEN NEW.status = 'submitting' AND (OLD.status != 'submitting' OR NEW.attempts > OLD.attempts)
  AND NOT EXISTS (SELECT 1 FROM issue_admissions WHERE canonical_session_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'Only canonical issue work may submit'); END;
--> statement-breakpoint
CREATE TRIGGER issue_admissions_dispatch_insert BEFORE INSERT ON devin_sessions
WHEN NEW.status = 'submitting'
BEGIN SELECT RAISE(ABORT, 'Submission requires existing issue admission'); END;
