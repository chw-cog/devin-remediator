# Devin session orchestration

`DevinSessionOrchestrator` has two effects. `tick` reconciles running sessions,
recovers stale submissions, and submits newly claimed work. `run` executes a
tick immediately, then sleeps for the configured interval after each tick.

## Ownership and claiming

GitHub ingress owns delivery verification, deduplication, and the original
payload. It inserts the delivery and pending session in one transaction, then
returns. The unique delivery constraints prevent duplicate work for a repeated
delivery ID.

`DevinSessionRepository.claimPending` owns the capacity calculation and claim.
Inside one libSQL write transaction, it counts `submitting` and `running` rows,
selects the oldest pending rows by `inserted_at` and `id`, and conditionally
updates at most the available capacity to `submitting`. It returns those rows
joined to their webhook deliveries only after commit. The transaction never
spans a Devin request.

The existing Effect libSQL adapter serializes write transactions on the shared
connection. A semaphore also serializes complete ticks on the single
orchestrator instance. That prevents a second tick from recovering a live, slow
submission. SQLite, not the semaphore, determines available capacity.

Each submission claim increments `attempts`. This counts reserved submission
attempts, including a crash before the POST starts. Submission and recovery
claims also increment `claim_version`. Updates require the same row ID,
`submitting` status, attempt number, claim version, and null remote ID. A
superseded worker cannot save a response or schedule a retry.

`claimStale` reserves stale rows in a SQLite write transaction before any tag
lookup. It refreshes `updated_at` without consuming a submission attempt.
Another instance can take over only after the stale timeout. Every recovery
result is conditional on ownership, including an empty lookup.

The implementation uses a batch transaction rather than a single-row atomic SQL
subquery. This keeps the query in Drizzle and fixes the set of submissions for a
tick, so a rejected row cannot be retried repeatedly within that tick.

## State transitions

| Transition             | Condition                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `pending → submitting` | A capacity-limited claim commits; increment `attempts`                                 |
| `submitting → running` | Create succeeds, or tag recovery finds exactly one session, and SQLite saves its ID    |
| `submitting → skipped` | No processor is registered for the event kind, or its processor returns `Skipped`      |
| `submitting → pending` | A retryable rejection or two complete empty recovery lookups, below the attempt limit  |
| `submitting → failed`  | A permanent rejection, exhausted rejection, or two complete empty lookups at the limit |
| `pending → failed`     | Attempts already meet the configured limit, including after a configuration change     |
| `running → succeeded`  | Devin reports task completion                                                          |
| `running → failed`     | Devin reports a terminal failure                                                       |

Every transition updates `updated_at`. Terminal rows, including `skipped`, are
neither submitted nor polled again. Skipped rows retain their local job and
delivery without a remote session ID. The skip write requires the same claim
ownership as a submission write. A pending row with an existing remote ID is not
claimable.

## Reconciliation and PR numbers

Every tick first calls `DevinClient.getSession` for persisted running IDs.
Restarting the process reconstructs this work from SQLite without another POST.
A failed GET, timeout, or undecodable response leaves the row running and keeps
its capacity slot.

The integration interprets Devin's states in `src/devin.ts`:

- `new`, `claimed`, and `resuming` remain running.
- `running` with `status_detail: finished` succeeds. Other running details,
  including waiting for user input or approval, remain running.
- `error` and `suspended` fail. This app does not automatically resume sessions.
- `exit` succeeds only with an explicit `finished` detail; otherwise it fails
  conservatively rather than assuming that every exit completed the task.

These rules follow the fields described in the
[Devin v3 Get Session documentation](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session).
They are application policy, not a guarantee that Devin will produce a PR. The
repository saves the first valid GitHub PR number whose URL matches the
delivery's repository. The schema has room for only one PR number.

## Retry and stale recovery

HTTP 429 is a definite retryable rejection. Other non-timeout 4xx responses fail
permanently. HTTP 408, 5xx responses, transport errors, timeouts, and
response-decoding failures are ambiguous: the server might have created a
session. These failures retain `submitting` until recovery.

Definite retries return to pending below `DEVIN_MAX_ATTEMPTS` and fail at the
limit. Normal polling delays the next attempt by
`DEVIN_ORCHESTRATOR_INTERVAL_MS`; there is no exponential backoff or
`Retry-After` scheduling. Direct manual ticks can retry earlier.

The issue-label processor includes `delivery-id:<original-delivery-id>` and
`issue:<issue-number>` in the creation request. Retries keep the original
delivery tag. The issue tag is for navigation, not recovery or deduplication. An
absent issue number produces no issue tag.

A submitting row with a null remote ID becomes eligible for tag lookup when
`updated_at` is older than `DEVIN_SUBMITTING_TIMEOUT_SECONDS`. Lookup runs even
when submission attempts are exhausted. It scans all pages with both
`is_archived=false` and `is_archived=true`, compares returned tags exactly, and
deduplicates by remote session ID.

- One match: save the remote ID and reconcile its current status and PR.
  Finished and failed sessions count as matches and are not resubmitted.
- Multiple matches: log the IDs and set `recovery_blocked`. The row stays
  submitting and holds capacity until manual resolution. Later ticks do not
  automatically choose a session or create another one.
- API errors, timeouts, malformed pages, or incomplete pagination: retain
  submitting and clear the consecutive-empty count. Retry lookup after the stale
  timeout.
- Complete empty lookup: persist the count and wait another full stale timeout
  before checking again. Two consecutive complete empty lookups return the row
  to pending below the attempt limit, or fail it at the limit. A pending retry
  can submit in the same tick if capacity permits.

Missing pagination metadata, missing continuation cursors, and cursor cycles are
failures, not evidence of absence. Recovery itself does not consume a submission
attempt. The next pending claim does.

Listing requires `ViewOrgSessions`. Local tests verify request serialization and
recovery with mocked API responses; they are not a Devin sandbox verification.
Validate tag filtering and archived visibility against the target organization
before relying on this best-effort absence check.

API failure details are represented durably by status and attempts; sanitized
Effect logs carry diagnostic information. There is no persistent error-text
column.

## Remote creation is not atomic with SQLite

The
[published Create Session API](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions)
does not document an idempotency-key guarantee. Its optional `devin_id` query
parameter has no documented retry semantics, so the client does not treat it as
an idempotency mechanism or invent an idempotency header.

The code writes the returned ID immediately after creation. That write is
protected from normal fiber interruption and retried twice at 100 ms intervals.
Only the SQLite write is retried, never the POST. If all writes fail, the row
stays submitting and an error log includes the remote ID for investigation.

A process crash after remote creation but before saving its ID can still leave
an untracked remote session. Persistent database failure or an ambiguous HTTP
response has the same risk. Automatic stale recovery may create a duplicate
remote session and exceed the intended remote concurrency limit. The strict
limit applies to locally tracked active rows, not untracked remote sessions. The
app chooses bounded, best-effort recovery over leaving submissions stuck
forever; it does not promise exactly-once remote creation.

Before manually retrying an ambiguous submission, inspect Devin and the logged
delivery and remote IDs. Stop the app while repairing local state. A failed
local row does not prove that an untracked remote session has stopped.

## Lifecycle and operational limits

The application builds one service graph, acquires `Deno.serve`, and forks the
orchestrator with `Effect.forkScoped`. SIGINT or SIGTERM ends the application
scope. The fiber is interrupted and joined before HTTP shutdown drains requests
and the database layer closes. A hung API call is interruptible; an acquired
remote ID's short persistence retry is not.

Expected polling errors leave durable state intact. An unsuccessful tick is
logged, then the run loop tries again after the interval. Health checks report
HTTP liveness without probing Devin. Queue progress needs log or database
monitoring.

SQLite recovery claims fence workers that share the same database. They do not
coordinate separate database files or prevent a late remote POST from
completing. Use consistent configuration across instances and stop old
application versions before upgrading: older workers do not honor claim
versions. Waiting-for-user sessions and duplicate-blocked submissions can retain
a slot indefinitely. All valid deliveries queue local work, but the default
issues processor creates a remote session only for `action: "labeled"` with the
added `label.name` exactly `devin`. Other deliveries become `skipped` after a
capacity-limited claim. There is no remote cancellation policy.
