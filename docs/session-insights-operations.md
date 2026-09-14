# Local session insights operations

## Design sketch and invariant

```ts
DatabaseClient.layerWithPath(sqliteDbFilepath: string) // scoped DB + migrations only
recollectInsights(sessionRecordId: string)
// Effect<RecollectionReadout, RecollectionError | DatabaseError, DatabaseClient>
// outcome: rescheduled | already_pending | already_collected
```

The explicit local record ID selects one remote-associated row with a durable
completion observation. Only unavailable analysis starts a new collection cycle;
pending is unchanged and collected data is preserved. The response exposes IDs,
consumed ACUs (number or null), analysis scheduling, and a bounded diagnostic,
never outputs, analysis content, webhook payloads, or raw provider text.

Two reset designs were considered: use the existing retry count and timestamp as
the claim identity, or add a durable analysis generation. Retrying resets the
count, and clocks/timestamps can repeat, so the first design admits ABA. Choose
one integer `analysisGeneration`, incremented atomically only on recollection;
analysis writes compare generation as well as the existing identity, pending
status, and attempt count. The existing next-attempt time remains the
retry/lease schedule, not cycle identity. A late failure cannot replace
collected analysis. A database-only exported operation owns this transition; no
new service or provider control authority is needed.

For local initialization, duplicating SQLite setup or supplying fake provider
configuration would obscure resource ownership. `DatabaseClient.layerWithPath`
is the single scoped initializer (including migrations, pragmas, cleanup).
`DatabaseClient.layer` keeps the existing application-config entry point and
behavior. Local commands need no application secrets.

## Invocation

Run from this checkout with an existing local database file. Stop old binaries
before deploying this migration: every analysis writer must understand the new
generation fence. Back up the database first; initialization applies pending
forward migrations, including in inspect mode. No provider credentials, network
permission, or provider call is needed for this command.

```sh
mise x -- deno run --allow-read --allow-write --allow-ffi \
  --allow-env=LIBSQL_JS_DEV --allow-sys=cpus,networkInterfaces,hostname \
  src/recollect-insights.ts --db ./devin-remediator.sqlite \
  --session-id LOCAL_SESSION_RECORD_ID --inspect
```

Remove `--inspect` to explicitly reschedule unavailable analysis. Both `--db`
and `--session-id` are required; the latter is `devin_sessions.id`, not the
provider ID. Missing/blank IDs, missing files/rows, an absent remote
association, and sessions with no completion observation produce errors and a
nonzero exit code. Inspect mode also works for never-completed rows and does not
reschedule them. Successful commands emit one JSON object with safe local
metadata and no raw analysis, remediation output, provider error text, webhook
payload, or secrets.

The response distinguishes `rescheduled`, `already_pending`, and
`already_collected`. Repeated pending requests change nothing, including a live
claim's due time, generation, or counter. Collected analysis is never discarded.
A reset changes only analysis status, attempts, generation, due time, and
reason. Submission fences, provider lifecycle, active-work capacity, completion
history, remote identity, observation leases, outputs, and GitHub notifications
stay intact.

The ordinary orchestrator picks up the newly due row when it next runs. Its
existing `DEVIN_ANALYSIS_MAX_ATTEMPTS` limit and bounded batch/backoff still
apply; this command does not run collection or configure the limit. Collection
can fail again. If the session has resumed externally, the collector can wait
for remote completion and eventually exhaust this new opportunity. Recollection
is not a message, wake-up, approval, archive, termination, or new session
submission.

## Consumed usage and eligibility

`acusConsumed` is the provider's latest **accepted observation**, stored as a
nullable SQLite REAL. Fractional values and reported zero are preserved. Unknown
historical usage stays null; null is not zero. This is neither a budget cap nor
a billing total, and it can lag provider activity. A newer accepted provider
snapshot can correct the value; no monotonic-usage assumption is made. The same
observation identity, lease/version, and provider timestamp rejection used for
lifecycle state also protect usage. Recovery snapshots use the submission fence
and remote-ID match before saving their observation/usage atomically.

`collectionDiagnostic` and `previousDiagnostic` contain only bounded local
labels:

- `local_attempts_exhausted`: our retry opportunity was exhausted, not proof
  that Devin will never offer insights. The new cycle resets this local
  opportunity.
- `no_devin_messages_observed`: the collector saw zero Devin messages in a prior
  provider response and stopped collection. This observation is distinct from
  retry exhaustion; it is not a guarantee of permanent provider ineligibility.
- `unavailable_reason_unknown`: other/legacy unavailability, with raw reason
  text deliberately omitted. No provider guarantee is inferred.
- `pending`, `collected`, `completion_not_observed`: local collection state.

There is no new permanent-provider-ineligibility state: baseline client
responses do not establish such a guarantee. An explicit retry of a zero-message
session may produce the same unavailable result. Collected data is a retained
snapshot, not automatically refreshed insights after further provider work.

## Verification and integration

`src/recollect-insights.test.ts` exercises the public operations, real temporary
SQLite files, CLI argument boundary, restart, generation/attempt/timestamp ABA,
late failure protection, usage fences, and normal orchestration with mocked
HTTP. `src/session-acus-analysis-migration.test.ts` upgrades a baseline database
while preserving legacy values and collected JSON. No authenticated provider
calls are used. The historical lifecycle audit is not current policy; this
feature retains passive tracking and private-safe GitHub notifications.

Integration may call `recollectInsights(localSessionRecordId)` with an existing
`DatabaseClient`, or reuse `inspectSessionInsights` for safe usage readout.
Neither operation requires AppConfig or a provider client. The shared
prerequisite is `DatabaseClient.layerWithPath`; the distinct generated migration
is `20260914000253_session_acus_analysis_generation`. Reconcile Drizzle snapshot
ancestry at the combined integration gate without rewriting shipped migrations.

Verified locally on this lane: `mise x -- deno task check` passes and
`mise x -- deno task test --quiet` passes 246 tests plus 24 steps (baseline: 236
plus 24 steps). Real command-entrypoint smoke checks cover inspect, reschedule,
repeated request, missing row/arguments, and help without application secrets or
network permission. The prerequisite alone passes 237 tests plus 24 steps.
