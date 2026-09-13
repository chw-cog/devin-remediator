# Devin playbook API

## Official contract

- [Create an org-level playbook](https://docs.devin.ai/api-reference/v3/playbooks/post-organizations-playbooks):
  `POST /v3/organizations/{org_id}/playbooks` requires `title` and `body`.
  Optional fields are `macro` and `structured_output_schema`. A macro starts
  with `!`, followed by letters, digits, underscores, or hyphens. Creation
  requires `ManageOrgPlaybooks` (`org.playbooks.manage`).
- [List org-level playbooks](https://docs.devin.ai/api-reference/v3/playbooks/organizations-playbooks):
  `GET /v3/organizations/{org_id}/playbooks` accepts `first` (1–200,
  default 100) and `after`. There is no documented macro filter. The response
  contains `items` and optional `has_next_page` (default false), `end_cursor`,
  and `total`. Listing requires `UseDevinSessions` (`org.devins.use`).
- The create and list schemas return `playbook_id`, `title`, `body`, nullable
  `macro`, creator/updater IDs and timestamps, `access_type` (`enterprise` or
  `org`), nullable `org_id`, and optional nullable `structured_output_schema`.
- [Create Session](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions)
  accepts the optional nullable string `playbook_id`, not `runbook_id`.

The inspected create reference lists HTTP 409 as a generic conflict. It does not
document macro uniqueness, an idempotency key, atomic create-if-absent, or
read-after-write consistency. A 409 alone does not establish those guarantees.

## Application behavior

`DevinClient.createPlaybook` sends the documented request and validates the
response. `findPlaybookByMacro` scans all pages for an exact match. Incomplete
pagination or malformed responses fail rather than imply absence. Multiple
distinct IDs with the same macro block submission.

`WebhookEventProcessors` creates **Fix Superset issue**, macro
`!fix-superset-issue`, only when lookup returns no match. It preserves an
existing playbook's title and body and passes its ID as `playbook_id` when
creating the session.

A layer-scoped semaphore serializes lookup and creation within one registry
instance. Each event checks remote state again; there is no persisted or
process-global ID cache. On HTTP 409, the processor repeats lookup and uses the
matching playbook only if found. Transient or ambiguous playbook failures are
retryable prerequisites: no session has been submitted yet. A retry checks for
the playbook before attempting creation again.

This is best-effort deduplication across separate application instances or
delayed remote visibility. The local semaphore cannot guarantee one remote
playbook across those boundaries without a provider uniqueness guarantee.
