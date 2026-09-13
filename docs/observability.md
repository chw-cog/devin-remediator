# Application logging reference

The application entrypoint uses Effect's JSON console logger. Each application
log is one JSON record with a timestamp, level, message, fiber ID, and
structured `annotations`. `LOG_LEVEL` defaults to `Info` and accepts `Debug`,
`Info`, `Warn`, `Error`, `Fatal`, or `None`. Invalid values fail startup.

Debug mode:

```sh
LOG_LEVEL=Debug mise x -- deno task start
```

## Correlation fields

- `component` identifies the emitting service. `operation` identifies its
  method. Nested services replace these fields while retaining the caller's
  identifiers.
- `request_id` identifies one webhook HTTP request. The response exposes it as
  `x-request-id`. The application generates it rather than trusting an incoming
  ID.
- `github_delivery_id` joins HTTP receipt to background processing, including
  redeliveries and recovery after a restart.
- `github_event` contains the GitHub event name, including unregistered events.
- `session_record_id` identifies the local queue record. `devin_session_id`
  identifies the remote session once known.
- `repo`, `issue_number`, `attempt`, and `claim_version` accompany work on a
  session. `claim_version` distinguishes workers that handled different claims.
- `tick_id` identifies one orchestrator pass. It changes between passes.
- `playbook_id`, `devin_organization_id`, and `pr_number` appear where
  available.
- `duration_ms` measures an operation or HTTP request. `http_status`,
  `error_type`, `error_reason`, nested `cause_type_*`, and `disposition` provide
  safe failure classifications where available.

The worker reconstructs its context from SQLite. It does not inherit an HTTP
request's fiber or `request_id`. The delivery ID and local session record ID are
the durable correlation keys.

For example, the single call `Effect.logDebug("webhook.processor_missing")`
inherits these annotations from its submission scope:

```json
{
  "message": "webhook.processor_missing",
  "level": "DEBUG",
  "annotations": {
    "component": "DevinSessionOrchestrator",
    "operation": "submit",
    "github_event": "push",
    "github_delivery_id": "delivery-push",
    "session_record_id": "local-record-id",
    "repo": "owner/repo",
    "issue_number": 42,
    "devin_session_id": null,
    "attempt": 1,
    "claim_version": 1,
    "tick_id": "orchestrator-pass-id"
  }
}
```

## Pipeline log map

### `src/app.ts` — HTTP boundary

`http.request.completed` records the route, method, status, request ID, delivery
ID, event name, and elapsed time. Its severity follows the response: Info for
success, Warn for 4xx, and Error for 5xx. Unexpected defects produce a safe
classification rather than a raw exception.

Health checks do not emit access logs. Existing webhook response statuses remain
unchanged, including 500 for signature and repository-metadata rejection.

### `src/webhook-delivery-handler.ts` — verification and durable receipt

- Warn: signature-verification failure, rejected signature, rejected metadata.
- Error: transaction failure, without SQL or bound parameters.
- Info: `webhook.queued` after the transaction commits, with the new local
  session record ID.
- Info: `webhook.duplicate` when a delivery already exists. Metadata describes
  the received redelivery, not a replacement of the stored original.

### `src/devin-session-repository.ts` — queue and claim ownership

Debug logs expose active-session count, available capacity, claimed count,
recovery claims, operation outcomes, and durations. State-update logs include
`changed`, so a stale claim is distinguishable from a successful write.

Queue-level operations have a tick ID but no single delivery ID. Per-record
operations carry claim identifiers.

### `src/devin-session-orchestrator.ts` — processing and recovery

Info logs cover claims, skips, successful submissions, recovery, and successful
completion. Completion includes the PR number when known.

Warnings identify retry scheduling, ambiguous submission outcomes, and
unavailable reconciliation. Recovery logs distinguish empty lookups, exhausted
attempts, and duplicate remote sessions. Duplicate-tag errors include matching
session IDs and the automatic-recovery block.

Errors identify terminal submission or remote-session failure, remote creation
without local persistence, superseded claims after remote creation, and failed
ticks. Tick failures include the next retry delay.

Debug logs cover ordinary reconciliation, missing processors, and operation
durations. Empty ticks and unchanged running sessions are silent at Info.

### `src/webhook-event-processors.ts` — event filtering and playbooks

Debug logs identify nonmatching filters and reused playbooks. Info logs identify
created playbooks and session submission starts, including the playbook ID.
These logs inherit the delivery's event name and identifiers.

### `src/devin.ts` — Devin API

Debug logs identify each client operation, organization, successful HTTP
response status and method, operation duration, and safe failure classification.
Session lookup logs add the remote session ID. Recovery pagination logs include
archive scope, page size, continuation state, and final match count.

The orchestrator owns actionable Warn and Error logs for handled API failures.
The client does not repeat them at those levels.

### `src/database.ts` and `src/index.ts` — lifecycle

Database initialization records readiness, storage mode, migration duration, and
safe failure classifications. Application lifecycle logs identify the bound port
and shutdown. The orchestrator records its concurrency limit, attempt limit,
poll interval, and recovery timeout when it starts.

## Safety and scope

Application logs exclude webhook bodies, issue text, Devin prompts, playbook
bodies, signatures, authorization headers, API keys, raw HTTP responses, SQL
parameters, and raw error messages or stacks. Error wrappers can contain these
values, so logging copies diagnostic fields instead of serializing errors.

Repository names and correlation IDs are operational metadata, not anonymous
data. Log retention and access controls belong in the deployment's log
collector. High-cardinality IDs belong in log fields, not metric labels.

This change configures logging, not a metrics backend or an OpenTelemetry
exporter. Existing Effect function spans remain in place. Logs are not a durable
audit ledger: a crash can occur after a database commit and before its log.

The executable logging checks are in `src/logging.test.ts`:

```sh
mise x -- deno task test src/logging.test.ts
```
