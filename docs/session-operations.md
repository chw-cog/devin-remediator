# Local session reconciliation and operations

## Design sketch (before implementation)

```
list() -> safe summaries
inspect(id) -> safe summary + opaque revision + redacted audit metadata
diagnose(id, remoteId?) -> classified GET evidence (no provider writes)
associate(id, revision, remoteId, reason) -> verified immutable association
resolve(id, revision, reason) -> local ownership released
resume(id, revision, reason) -> verified same-identity tracking
```

Compared extending the already-large session repository with all administrative
HTTP and policy logic versus a cohesive `SessionAdministration` service. Chosen:
the service owns one transactional snapshot/CAS and administrative audit
boundary; the repository owns automated claim/evidence writes. The CLI contains
no SQL. A small shared reconciliation update hides bounded escalation/backoff
policy. Ownership is separate from submission, provider lifecycle, output, and
analysis.

A revision hashes the complete session and attention snapshots (never prints
those snapshots). It fences operator intent and the interval across diagnostic
GET against submission, observation, analysis, and notification changes. Active
submission grace and observation/notification leases reject ownership mutations.
Transactions serialize uniqueness and notification closure. Existing unique
remote-ID constraints remain authoritative. Analysis for an immutable remote ID
continues independently; local release does not invalidate or reset it.

Repeated missing observations retain provider evidence and capacity, with
durable counters/times and bounded backoff. Repeated empty ambiguous-create
recovery no longer permits another POST: this deliberately replaces the former
two-empty-list retry policy. Duplicate recovery blocks immediately. Explicit
resolution is the only capacity-release escape hatch for uncertain active work.

## Commands

Run against the **same local SQLite file/volume as the server**, not a copy or
another environment. Local file access is the administrative authority; there is
no public endpoint. Back up the database first. Opening the CLI applies local
forward migrations (and creates an empty database if the path does not exist).

```sh
mise x -- deno task session-admin --db /path/to/devin-remediator.sqlite list
mise x -- deno task session-admin --db /path/to/devin-remediator.sqlite inspect LOCAL_ID
mise x -- deno task session-admin --db /path/to/devin-remediator.sqlite diagnose LOCAL_ID
# For an unassociated or duplicate-tag claim, select a candidate to diagnose:
mise x -- deno task session-admin --db /path/to/devin-remediator.sqlite diagnose LOCAL_ID --remote-id REMOTE_ID
mise x -- deno task session-admin --db /path/to/devin-remediator.sqlite associate LOCAL_ID --remote-id REMOTE_ID --revision REVISION --reason 'Verified selection under incident INC-123'
mise x -- deno task session-admin --db /path/to/devin-remediator.sqlite resolve LOCAL_ID --revision REVISION --reason 'Stop local ownership under incident INC-123'
mise x -- deno task session-admin --db /path/to/devin-remediator.sqlite resume LOCAL_ID --revision REVISION --reason 'Resume observation under incident INC-123'
```

`LOCAL_ID` is the local session record ID from `list`, not the delivery or
remote ID. `inspect` and successful diagnostic/mutation results return an opaque
`revision`. Use the latest revision for each mutation. JSON output contains only
IDs, normalized states, counters, timestamps, and safe audit metadata. It does
not expose question/status-detail text, URLs, webhook payloads, outputs,
analyses, tokens, provider error bodies, or operator reason text. Reasons are
required nonblank strings of at most 500 characters, stored privately in
`session_admin_events`; output reports only whether a reason was recorded. Avoid
putting secrets in reasons or shell arguments/history.

`list`, `inspect`, and `resolve` are offline and need no provider or GitHub
credentials. `diagnose`, `associate`, and `resume` need `DEVIN_API_KEY` and
`DEVIN_ORGANIZATION_ID` for the intended organization. They perform only the
organization-scoped `GET /v3/organizations/{org}/sessions/{id}`, with a
ten-second bound and no request retries. The getter validates the returned ID
and org. Association and resumption additionally require the exact
`delivery-id:<github-delivery-id>` tag. A partial tag match is not sufficient. A
successful diagnostic by itself does **not** change identity, local ownership,
provider observations, or output/analysis data; ordinary observation applies
fresh provider data after association or resumption.

Diagnostic outcomes: `found`, `not_found` (404), `authentication` (401),
`authorization` (403), `rate_limit` (429), `temporary`
(transport/timeout/408/5xx), and `invalid_response` (malformed body, unexpected
HTTP status, wrong ID/org). Administrative verification also reports
`tag_mismatch`. Outcomes, safe HTTP status codes, remote IDs, and timestamps
persist. Failed association/resume verification records diagnostic evidence and
leaves ownership unchanged.

The command exits 0 on completion and 1 on invalid input, unavailable local
storage/config, stale revision, active lease, ownership conflict, or failed
verification. Diagnostic 404/403/etc. is a completed diagnosis (exit 0), not a
successful provider lookup. `--help` lists commands and arguments. A conflict
requires re-inspection and a fresh decision, not reuse of a stale revision.
Repeating same-identity operations with a current revision is safe; each records
another audit event and never makes a remote write.

## Exceptional reconciliation policy

A list miss or failed list call keeps the submission, identity, provider
snapshot, activity, outputs, and analysis. It records first/last failure
timestamps, total failure count, consecutive failure streak, and the latest
failure kind. Failure backoff is 30, 60, 120, 240, 480, 960, 1920, then 3600
seconds, capped at one hour. Three consecutive failures set a durable escalation
timestamp. Submitted rows remain observable on that bounded cadence and continue
reserving capacity if activity is uncertain/active. Success resets only the
streak; historical failure counts/times/escalation remain visible. A
missing/failed lookup never fabricates closure, completion, failure output, or
capacity release.

Ambiguous submission recovery additionally honors the existing submitting grace.
After three failed/missing tag lookups it stops automatic recovery and retains
`submitting`, attempts, and capacity. Duplicate tag matches block immediately,
with up to the first 200 distinct candidate IDs retained for inspection. Old
blocked rows without captured candidates remain diagnosable by explicit remote
ID found in the authenticated Devin UI. No number of missing lists or single GET
404s authorizes another POST. Definite pre-creation rejection retries retain the
existing independent retry policy.

`resolve` is explicitly **LOCAL POLICY ONLY**: remote execution is unchanged. It
stops ordinary local observation and releases local capacity, not provider
execution or spending. It leaves `status`, the original remote identity,
provider fields (including `activeWork`), output history, and analysis
untouched. It sets separate `localOwnership=released` and permanently blocks
future automatic submission. It neither archives nor terminates nor sends
messages. Any continuing remote work must be managed separately by an authorized
human in Devin.

`resume` requires a verified existing identity and only returns local ownership
to tracking. It cannot recreate a session, reassign an identity, or resume
remote execution. Unassociated released work must instead use verified
`associate`. Association also permanently blocks future POSTs. An already-owned
remote ID cannot be selected by another local row, even if the owning row was
released. An archived provider snapshot is not reset by local resumption;
ordinary closed tracking policy still applies.

## Fencing and notification behavior

Mutations reject live observation or attention leases, and an unblocked
submitting claim within the larger of 120 seconds or the configured
`DEVIN_SUBMITTING_TIMEOUT_SECONDS` (covering bounded submission requests). Use
the same submitting timeout as the server when overriding that setting. After
grace/lease expiry, the transaction increments submission and observation
versions. Late workers cannot associate, append outputs, or open fresh attention
episodes for released work. Submission activity is fenced by the existing
version/timestamp model, not an assertion that remote execution has stopped.

The full session and attention snapshots are hashed only internally to form the
revision, including current analysis state/fences. Intervening writes across the
GET invalidate the operation. The final transaction repeats lease and uniqueness
checks. Local release leaves legitimate analysis collection for the same remote
ID independent, without resetting counters or invalidating its fence.

Resolution atomically cancels unsent attention episodes and marks possible-send
or delivered episodes closed, preserving bodies, receipts, App/installation
ownership, and possible-send markers. Live notification leases reject
resolution. Historical ambiguous sends do not block it forever. The existing
notifier uses `closedAt` to reconcile possible sends **without reposting**;
disabled GitHub notification configurations can still resolve/cancel local work.
Resumption does not resurrect closed attention episodes. A later observed
leave/re-enter wait can create a new episode under the ordinary policy.

## Migration, validation, and integration

`20260914000730_session_reconciliation` is a real generated Drizzle forward
migration: additive columns plus a private administrative audit table/index. It
does not rebuild `devin_sessions`, rewrite shipped migrations, change existing
identity uniqueness, or alter outputs/analysis. A populated baseline upgrade
test preserves attention receipts, provider evidence, and foreign keys;
reapplying migrations is idempotent. Snapshot ancestry is cumulative and linear:
ACU/analysis-generation migration first, then recovery. Combined populated
upgrade tests preserve fractional ACUs, nonzero analysis generations,
notification ownership, quarantine evidence, and old values independently.

The shared `DatabaseClient.layerWithPath` prerequisite is reused for local-only
operations. `DevinClient.layerWithCredentials` constructs the same client
without requiring unrelated server/GitHub config; the server `.layer` is
unchanged in behavior. The image now checks/caches the CLI as well as the
server. No new configuration knobs or Compose edits were added. For Compose
integration, run the CLI with the same SQLite volume/user, pass diagnostic
credentials only when needed, and forward the existing submitting timeout
override consistently. Override the image command with
`task session-admin --db /data/... COMMAND`; never start another server process
just to inspect work.

Focused tests use public operations, real temporary SQLite, and mocked HTTP.
They cover bounded misses, duplicate candidates, diagnostic classifications,
restart, verified immutable association, local release/resume, unique ownership
races, submission/observation/analysis/notification CAS, disabled notifications,
actual CLI argument execution, and populated baseline upgrade. No live provider
or remote control calls were made. The combined-main integration also checks
actual Compose rendering with isolated synthetic environments, not a live daemon
or provider deployment.

### Upgrade quarantine

The data backfill quarantines exactly baseline `pending` rows with no remote ID
and `recovery_empty_checks >= 2`. Those rows were queued by the now-removed
ambiguous-create fallback. They become `submitting` with
`recovery_blocked=true`, keep all counters/results/analysis, and consume local
capacity until explicitly associated or resolved. An audit event with action
`migration` and outcome `legacy_ambiguous_retry` records the migration
reason/time; the escalation time is migration-generated, not a claimed provider
observation or lookup time. Ordinary pending pre-creation rejection retries with
zero empty checks remain eligible. No other pending or failed rows are
quarantined. Operators should run `list` after upgrade and review these rows
before expecting queued work to drain.
