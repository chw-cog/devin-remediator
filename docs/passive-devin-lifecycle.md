# Passive Devin session tracking

The remediator follows continuable Devin sessions without waking them or
changing provider controls. Operators continue work in the Devin UI. The service
does not send messages, approve actions, change budgets, notify GitHub, archive
sessions, terminate sessions, or create replacements for missing observations.

## Submission and provider state

`devin_sessions.status` describes local submission. `pending` and `submitting`
retain their queue and recovery meanings. `submitted` means a remote identity is
associated, not that remediation succeeded. `skipped` means no applicable
processor. `failed` denotes exhausted or definite local submission failure.

Provider observations are separate nullable fields. `provider_status`,
`provider_status_detail`, and `is_archived` retain the provider values.
`provider_updated_at` and `provider_created_at` are interpreted as Unix seconds.
`last_observed_at` is the local UTC time when an accepted observation is
recorded. `session_url` links to the provider session. An omitted archive flag
preserves a previously observed flag; without one, it remains unknown. A query
filter alone does not fabricate an archive observation.

The pure classifier produces the following local lifecycle states.

| Provider observation                                                        | Local lifecycle                     | Active-work capacity   |
| --------------------------------------------------------------------------- | ----------------------------------- | ---------------------- |
| `new`, `claimed`, `resuming`                                                | `active`                            | Counted                |
| `running/working` or running without a detail                               | `active`                            | Counted                |
| `running/waiting_for_user`                                                  | `needs_input`                       | Not counted            |
| `running/waiting_for_approval`                                              | `needs_approval`                    | Not counted            |
| `suspended/inactivity` or `suspended/user_request`                          | `paused`                            | Not counted            |
| Suspended for usage, credits, quota, or payment                             | `needs_intervention`                | Not counted            |
| Unknown suspension reason, provider error, ambiguous exit or running detail | `needs_intervention`                | Conservatively counted |
| `running/finished` or `exit/finished`                                       | `completed`                         | Not counted            |
| Observed archived flag                                                      | `closed`, regardless of other state | Not counted            |

Unknown details remain available for investigation and do not invalidate other
sessions in the same decoded API batch. Suspension, missing output, and
ambiguous exit do not create a failed remediation result.

## Reconciliation and capacity

Active and unobserved sessions are due every orchestration tick. Waiting,
paused, completed, and intervention states use
`DEVIN_RETAINED_POLL_INTERVAL_MS`, default 60000 milliseconds. This interval is
at least the active tick interval. Due times survive restarts. Archived sessions
stop normal reconciliation.

Each tick claims at most 200 due rows per batch, with a fresh 60-second lease
before requesting that batch. A stable creation-time and ID cursor visits each
row at most once per tick. The client paginates explicit unarchived queries and
searches missing IDs with an explicit archived query. Both searches share the
existing 30-second request bound.

Reconciliation runs before new submission claims. Observed active work, unknown
activity, submitting jobs, and live observation leases count toward local
capacity. Retained inactive jobs do not reserve slots merely because they become
due. Lookup misses and HTTP errors release the observation lease and retain the
snapshot, outputs, and identity. Abandoned leases expire. No remote execution
timeout is inferred from `DEVIN_SUBMITTING_TIMEOUT_SECONDS`.

A session resumed in the Devin UI becomes active under the same identity when
next observed. It then counts against capacity before new claims. This is a
polling-based local limit, not a provider-enforced cap. External activity can be
unobserved between polls, and slow ticks can delay reconciliation.

## Output history and fencing

Valid `structured_output` is decoded independently of lifecycle. Active,
waiting, paused, and completed observations can all contribute results.
`outputs` records changed decoded results, not provider events. An unchanged
result, reordered object keys, null, or invalid output adds nothing. A sequence
A, B, A records all three observed changes. Array order and meaningful field
differences remain significant. Missing PR references do not erase an already
recorded PR number.

The repository checks the current stored result inside the same SQLite
transaction that records the provider snapshot and appends output. An expired or
superseded observation claim cannot write. A lower provider update timestamp
cannot replace an accepted newer snapshot. Replaying the same claim cannot
append again. Equal provider timestamps do not establish provider event order; a
later valid claim may accept different content at the same timestamp.

The API exposes only its latest output. Polling can miss intermediate changes.
This history is not a complete transcript or audit log of Devin turns.

## Continuation window and insights

`continuationWindowElapsed(createdAtSeconds, nowMillis)` derives an explicitly
local advisory at 30 days from remote creation. Unknown creation returns null.
The calculation uses testable Effect time where called. It is not an API
`expired` status or a claim about exact provider expiry enforcement. Age alone
never closes a session, including actively working sessions. Retained tracking
continues until an archive is observed.

Observed raw completion enables independent best-effort insights collection,
including an already archived completed session. Available analysis is retained
across resumption. Pause alone never triggers generation. Retry bounds, durable
backoff, generation concurrency, and the collection timeout remain independent
of lifecycle tracking. `DEVIN_ANALYSIS_MAX_ATTEMPTS` is forwarded by the
production entrypoint. Configuration overrides also require container
environment forwarding.

## Migration and operational limits

The forward `20260913212818_passive_lifecycle` migration leaves the earlier
outputs migration intact. Legacy running, succeeded, or failed records with
remote IDs become `submitted` with unknown provider observations and are due for
refresh. Existing output arrays, analyses, retry counters, and evidence are
preserved. Historical outputs can include fallback results created by the prior
code; this migration does not rewrite their meaning.

Legacy running or succeeded records without remote IDs are quarantined locally
as `submitting` with `recovery_blocked=true`. They retain history, consume
capacity, and cannot automatically resubmit. They require operator investigation
and explicit association outside this passive workflow. Genuine local failures
without remote IDs remain failed.

SQLite may report lock contention between workers. The orchestration loop
retries failed ticks; uncertain submissions enter delivery-tag recovery rather
than directly repeating the remote POST. Concurrent startup migrations and
multiple synchronous SQLite clients on the same JavaScript thread can fail under
contention in the current adapter. The independent-worker test uses separate
Deno threads and clients; it does not establish failure-free startup or an
exactly-once remote-creation guarantee.

The [historical lifecycle audit](devin-session-lifecycle-audit.md) describes the
pre-change implementation and its source-backed provider contract.
