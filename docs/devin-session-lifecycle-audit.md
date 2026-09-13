# Devin session lifecycle audit

Reviewed on 2026-09-13 UTC against `main` at
`92914d48ad8afa4497dda6a364642ef5261322cb`.

**Implementation addendum.** Finding 2 now records the implemented GitHub App
notification flow and its local verification. Other findings, tables, and the
original verification section remain historical audit evidence.

## Summary

Our application manages a **one-shot remediation job**, not the full lifecycle
of a Devin session. Its creation recovery and pagination are careful. The main
gap is that it treats a resumable session as an irreversible local result.

The highest-priority changes are:

1. Stop treating every suspension as permanent failure.
2. Surface requests for user input and approval instead of silently polling
   them.
3. Add an explicit policy for sessions that disappear, resume externally, or
   need to be stopped.

This is a source-and-documentation audit, not an observation of production Devin
sessions. No authenticated Devin requests or implementation changes were made.
Existing changes to `compose.yaml` and local log files were left untouched.

## The documented lifecycle

The application uses the organization-scoped **v3 API**
(`src/devin.ts:336–350`). Older v1 examples are not its status contract.

| Devin observation or operation     | Documented meaning                                                                  | Our handling                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `new`, `claimed`, `resuming`       | Valid v3 session states                                                             | Local `running`                                                       |
| `running` / `working`              | Actively working                                                                    | Local `running`                                                       |
| `running` / `waiting_for_user`     | Needs user input                                                                    | Local `running`; no distinct intervention state                       |
| `running` / `waiting_for_approval` | Awaiting safe-mode action approval                                                  | Local `running`; no distinct intervention state                       |
| `running` / `finished`             | Task complete                                                                       | Local `succeeded`; stops normal reconciliation                        |
| `suspended`                        | Paused, with a reason such as inactivity, user request, or quota exhaustion         | Local `failed`; stops normal reconciliation                           |
| Send message                       | Automatically resumes a suspended session                                           | No client operation                                                   |
| Archive                            | Puts a running session to sleep; remains viewable but cannot be modified or resumed | No client operation; archive flag is not used in state interpretation |
| Terminate                          | Cannot subsequently be resumed                                                      | No client operation                                                   |
| Session expiration                 | Cannot continue a session after 30 days                                             | No expiry or replacement policy                                       |

Sources: [Get Session][get], [Send message][message], [Archive][archive],
[Terminate][terminate], [Session expiration][expiry]. Code:
`src/devin.ts:88–198,303–333`.

Two distinctions matter:

- **Task completion is not session termination.** The API explicitly places
  `finished` under top-level `running`. Recognizing this combination as
  completion is correct.
- **Suspension is not necessarily task failure.** The usage guide says an idle
  session sleeps after 30 minutes by default, configurable for Enterprise
  between 5 and 120 minutes. Sleeping sessions consume no usage and can be woken
  by a message. Creation defaults `resumable` to `true`, preserving VM state
  after the session stops. [Usage][usage], [Create Session][create]

The reviewed v3 schema enumerates `exit` and `error`, but does not provide a
full transition table or establish that `exit` always retains
`status_detail=finished`. Our `exit` classification is therefore a local policy,
not a fully documented provider guarantee.

## Findings

Priority labels describe recommended work order, not observed incident severity.
“Confirmed” means supported by current code and the cited contract. Conditional
risks identify scenarios that still require a live fixture or policy decision.

### 1. High — Suspension becomes irreversible local failure

**Confirmed semantic mismatch.** `interpretSession` maps every `suspended`
session to `failed`, regardless of `status_detail` (`src/devin.ts:169–198`).
`finish` persists that result, and `findRunning` excludes it from future normal
reconciliation (`src/devin-session-repository.ts:257–275,332–357`).

Devin documents both resumable suspension and suspension reasons that are not
task failures: inactivity, user request, usage limits, credits, and quota.
Sending a message automatically resumes a suspended session. [Get][get],
[Message][message]

**Consequence:** if someone resumes the same session in Devin and it later
completes, the local job stays failed. Insights collection may notice that it is
running again, but cannot update the job result
(`src/devin-session-orchestrator.ts:258–329`).

A second, conditional risk is missed completion: an application outage could
span task completion and subsequent idle suspension. On return, the application
would classify the observed suspension as failure. The docs do not promise
historical completion replay, so this needs a captured lifecycle trace rather
than an assumed transition sequence.

**Recommendation:** retain provider status and reason separately from the
remediation outcome. Treat recoverable suspension as paused or needing
intervention. Do not automatically wake every suspension: user-requested pauses,
budget limits, archive state, and expiration require different policies.

### 2. Implemented. Input and approval waits have durable issue notifications

The original finding described the earlier implementation. Current lifecycle
interpretation distinguishes `needs_input` from `needs_approval`. Accepted
observations preserve progress, PR references, and the session URL, release
active-work capacity, and retain polling. Neither a wait nor structured output
implies completion. [Get][get], [Create][create]

`DevinSessionRepository` now saves an attention episode atomically in both
accepted-observation paths. A forward migration backfills current waiting
sessions without changing lifecycle, outputs, capacity, or analysis. A new
episode represents entry into a wait, a change of wait kind, or an observed
leave-and-reenter recurrence. Progress-only updates stay quiet.

`GitHubCommentNotifier` in `src/github-comment-notifier.ts` delivers the
originating issue comment through the authenticated Octokit supplied by
`GitHubClient` in `src/github.ts`. The client owns App authentication and its
in-memory token cache. The notifier owns SQLite claims, rate limits, retries,
immutable comment receipts, and recovery pagination. Token acquisition and each
comment request consume the same one-request-per-tick budget.

GitHub App authentication supersedes the initial PAT proposal. One configured
installation uses `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and redacted
`GITHUB_APP_PRIVATE_KEY`. All absent disables delivery visibly while retaining
pending work. Partial or invalid credentials fail configuration. Configure
selected-repository **Issues** read/write permission and subscribe the App
webhook to **Issues** events. The existing `GITHUB_WEBHOOK_SECRET` remains
separate. See
[setup and delivery limits](../README.md#enable-issue-attention-comments-with-a-github-app).

Public comments contain a generic reason, a safe session link, and distinct
input or approval directions. They do not contain question, blocker, progress,
or verification text. The authenticated Devin UI is the only continuation
surface. GitHub replies are not forwarded. No public control endpoint, automated
message, or automated approval was added.

Recovery requires a matching marker attributed to the persisted App ID. App and
installation identity cannot be reassigned on an ambiguous flight. Missing or
foreign App attribution blocks retry unless another verified match exists. Two
complete negative scans separated by grace precede any ambiguous repost.
Superseded unsent episodes are cancelled, and superseded possible sends are
reconciled without reposting.

**Verified locally.** `src/github-comment-notifier.test.ts`,
`src/github.test.ts`, and `src/attention-migration.test.ts` exercise
synthetic-key JWT signing, mock token exchange and actual Octokit JSON requests,
restart, pagination, stale claims, throttling, recurrence, capacity, privacy,
and upgrade waits. Config and entrypoint tests cover optional credentials and
production environment permissions. No live authenticated API calls were used.

Review regressions cover metadata correction before the first delivery attempt
and HTTP 403 throttling during recovery. Corrected metadata updates the existing
unsent episode. A rate-limited lookup retains its cursor and resumes after the
cooldown without posting another comment.

The official
[Common Flows example](https://docs.devin.ai/api-reference/common-flows) pairs
`devin-abc123` with `https://app.devin.ai/sessions/devin-abc123`. That exact
prefixed-ID fixture is covered. Other URL forms are blocked unless they exactly
match the persisted remote identity and safe host/path policy.

**Remaining limits.** GitHub offers no exactly-once comment key. Delayed
visibility, edited or deleted markers, and remote request races can still
duplicate comments. Attribution availability is mock-tested, not guaranteed by a
live fixture. Blocked ownership, access, or attribution needs operator
investigation. Polling cannot detect transitions entirely between observations
or a new same-kind question without an observed lifecycle transition.

### 3. High — Missing sessions can hold capacity indefinitely

**Confirmed behavior; provider cause is conditional.** Missing IDs and lookup
failures retain local `running` indefinitely
(`src/devin-session-orchestrator.ts:133–154`). There is no last-observed
timestamp, missing counter, or durable provider error in the session table
(`src/schemas.ts:27–59`). The client has no single-session getter.

The API exposes Get Session with distinct HTTP error responses, archive and
termination operations, and a finite continuation window. List Sessions accepts
`is_archived`, but its query schema does **not** document a default. [Get][get],
[List][list], [Archive][archive], [Terminate][terminate], [Expiration][expiry]

**Consequence:** three persistently missing jobs can consume the default three
slots forever. Archive filtering is one possible cause, not an established
explanation: the current docs do not prove that omitting `is_archived` excludes
archived sessions.

**Recommendation:** retain on a transient miss, then escalate repeated misses to
an explicit reconciliation state. Use Get Session for diagnosis and distinguish
authentication, authorization, not-found, rate limiting, and temporary outage.
Do not turn a single 404 or missing list item into permission to create a
duplicate. Add an operator resolution path and a bounded stale-job policy.

### 4. Medium — Local completion releases ownership without a remote control policy

**Confirmed scope gap, not proof of runaway billing.** Once a job is `succeeded`
or `failed`, normal reconciliation stops and local capacity is freed. Creation
does not set `resumable` or `max_acu_limit`
(`src/webhook-event-processors.ts:121–145`), although both are supported by the
client schema (`src/devin.ts:33–56`). The API defaults resumability to true.
[Create][create]

There is no message, archive, or terminate method in `DevinClient`
(`src/devin.ts:303–333,601–609`). Application shutdown closes local scoped work,
not remote sessions (`src/index.ts:21–39`).

**Consequence:** our concurrency limit counts local jobs, not all remotely
active sessions. A session resumed outside the application after local
finalization is not accounted for. There is also no application-level
cancellation path or per-job execution budget. Organization-level limits may
still apply; omission of `max_acu_limit` does not prove unlimited spend.

**Recommendation:** choose an explicit ownership policy:

- **One-shot jobs:** capture the result, then deliberately retain, archive, or
  terminate the session according to product requirements.
- **Continuable sessions:** retain remote-state tracking and reconcile
  authorized follow-up work under the same identity.

Set a configurable per-session ACU cap independently of concurrency. Archive and
terminate are not interchangeable with a reversible pause: the docs say archived
sessions cannot resume and termination is irreversible. [Archive][archive],
[Terminate][terminate]

Do not terminate sessions merely because this service restarts; durable restart
reconciliation is useful and should remain intact.

### 5. Medium — Ambiguous creation recovery cannot establish exactly-once submission

**Known residual risk, already acknowledged by the code.** On an ambiguous POST,
the application keeps the durable claim. Recovery searches both archived and
unarchived sessions, paginates completely, and checks the exact delivery tag
(`src/devin.ts:480–524`). Two empty recovery checks eventually permit another
creation attempt (`src/devin-session-repository.ts:225–254`).

V3 documents tags and list filters, but the reviewed create and list contracts
provide no idempotency key, tag uniqueness guarantee, or visibility deadline. V1
exposes an `idempotent` option; that does not make it a v3 option.
[Create][create], [List][list], [V1 create][v1-create]

**Consequence:** a session invisible through both checks could coexist with a
retried session. This is a conditional risk, not evidence that duplicates have
occurred. Conversely, duplicate matches set `recoveryBlocked`, exclude the claim
from automatic recovery, and leave it consuming capacity
(`src/devin-session-repository.ts:187–213,236–250`).

**Recommendation:** preserve the current safeguards, document best-effort
semantics, and add an operator workflow to associate or resolve ambiguous and
duplicate sessions. Confirm supported v3 idempotency and consistency guarantees
with Cognition before claiming exactly-once behavior.

### 6. Medium — The persisted record loses the information needed to recover

**Confirmed modeling gap.** The response decoder accepts provider status, status
detail, ACUs, URL, archive state, timestamps, and session relationships. The
database stores the remote ID but none of those provider observations
(`src/devin.ts:88–141`; `src/schemas.ts:27–59`). Normal terminal logs include
the mapped local status and output outcome, not the original suspension reason
(`src/devin-session-orchestrator.ts:160–173`).

The documented suspension reasons distinguish user intent, payment failure,
credit exhaustion, quota allocation, and errors. Those conditions require
different remedies. [Get][get]

**Consequence:** a generic failed row cannot distinguish a paused session from a
failed remediation without another remote investigation. `updatedAt` records
local transitions, not a polling heartbeat.

**Recommendation:** persist the latest provider status/detail, observation time,
remote update time, archive flag, session URL, and ACUs. Keep remediation
outcome, provider lifecycle, and analysis state separate. This supports findings
1–4 without making every remote state a new local terminal outcome.

### 7. Medium — Insights retry configuration is ignored by the production entrypoint

**Confirmed code defect discovered during the audit.**
`DEVIN_ANALYSIS_MAX_ATTEMPTS` is declared with default 12 (`src/config.ts:15`),
but omitted from the explicit environment object supplied to
`ConfigProvider.fromUnknown` (`src/index.ts:41–59`). The normal entrypoint
therefore cannot honor that environment override.

This matters because insights generation is asynchronous and can fail. The API
allows another generation request after a failed attempt, while the UI guide
says generation usually takes about a minute and may have timed out after five
minutes. Neither duration is an API SLA. [Generate insights][generate],
[Insights guide][insights-guide]

Our collector counts lookup failures, missing rows, remote-running waits, and
generation waits toward one bounded attempt budget. Exhaustion permanently marks
analysis unavailable (`src/devin-session-repository.ts:359–418`).

**Recommendation:** wire the missing environment variable and test the actual
entrypoint configuration. Consider separating retryable transport failure,
generation-in-progress, and genuine ineligibility, with an explicit manual
recollection path. Bounded retries are reasonable; the problem is treating local
exhaustion as proof the provider can never produce analysis.

## What already agrees with the documentation

- **V3 state vocabulary:** the current status and status-detail enums match the
  fetched v3 schema. `running/finished` correctly means task completion.
- **Completion versus remediation success:** `succeeded` can contain outcome
  `needs_human`, `not_reproducible`, or `failed`. Existing tests deliberately
  separate execution completion from the remediation outcome.
- **Structured output:** we request the schema and required final output, and do
  not treat intermediate output alone as completion
  (`src/webhook-event-processors.ts:121–142`; `src/devin.ts:188–198`).
- **List polling:** v3 explicitly populates `status_detail` and
  `structured_output` on get/list endpoints. A getter is not required for normal
  polling. Its value here would be exceptional reconciliation.
- **Pagination:** requests use `first=200`, follow cursors, deduplicate IDs, and
  reject missing/repeated continuation cursors. The 200-ID batch is our policy,
  not a documented maximum length of `session_ids` (`src/devin.ts:436–474`;
  [List][list], [Pagination][pagination]).
- **Insights:** the bulk insights endpoint exists. Null analysis means analysis
  has not completed. Repeated generation requests return `already_exists` when
  generated or in progress, and can return `started` after a failed attempt. The
  zero-Devin-message exclusion is documented
  (`src/devin-session-orchestrator.ts:258–329`; [List insights][list-insights],
  [Generate][generate], [Insights guide][insights-guide]).
- **Restart and ambiguous POST handling:** durable claims, fencing, SQL-only
  persistence retries, and conservative recovery are valuable local safeguards.
  They should not be replaced with blind POST retries.

## Uncertainties and claims not established

- **Late output or PR metadata:** terminal rows are not refreshed, so late data
  would be missed. The reviewed docs do not establish atomic publication with
  `finished`, but they also do not establish a real delay. Treat this as a
  contract-fixture question, not a confirmed race.
- **Archive default:** the list query default is undocumented. Do not confuse
  the response field's default `false` with a query-filter default.
- **Expiration representation:** the product documents the 30-day continuation
  limit, not an `expired` v3 status or the exact API response after expiry.
- **Pagination metadata:** the OpenAPI response requires only `items` and gives
  `has_next_page` a default of false. Our permissive normal-page decoding is not
  itself a demonstrated contract violation.
- **Rate limits:** the local loop sleeps 3 seconds after each tick
  (`src/config.ts:16–19`; `src/devin-session-orchestrator.ts:388–391`). V1's
  structured-output guide recommends 10–30 seconds, but that is not a documented
  hard v3 rate limit. Backoff and jitter are operational improvements, not a
  proven v3 violation. [V1 structured output][v1-output]
- **Enum evolution:** a future unrecognized enum can fail a whole batch, but no
  current status mismatch was found. This is forward-compatibility hardening.

## Verification

Ran:

```sh
mise x -- deno task test src/devin.test.ts src/devin-session-orchestrator.test.ts
```

Result: **100 passed, 24 steps, 0 failed**.

Also executed the real `interpretSession` function against documented state
combinations, without network access:

| Input                            | Actual local result | Actual fallback outcome |
| -------------------------------- | ------------------- | ----------------------- |
| `running/finished`               | `succeeded`         | `needs_human`           |
| `suspended/inactivity`           | `failed`            | `failed`                |
| `suspended/usage_limit_exceeded` | `failed`            | `failed`                |
| `running/waiting_for_user`       | `running`           | null                    |
| `running/waiting_for_approval`   | `running`           | null                    |

The existing test at `src/devin.test.ts:948–1007` explicitly expects suspension
to fail and waiting states to remain running. Passing tests therefore confirm
the implementation, not the suitability of that lifecycle policy.

The next contract tests should cover suspension → authorized resume →
completion, input/approval intervention, repeated list absence with diagnostic
Get Session, external archive/termination, and continuation after local
finalization. A production-entrypoint test should verify the analysis-attempt
override.

Research used directly fetched official Markdown/OpenAPI pages. Search summaries
were discovery aids, not final evidence: a search summary still mentioned an
older ACU-based idle threshold, while the fetched usage page specified the
30-minute default quoted above.

The delegated research agent lacked its advertised web tools, so the parent
supplied fetched primary-source excerpts. The read-only code scout returned
findings, but its harness rejected the task for making no implementation edits.
The report's conclusions were checked against source and fetched documentation;
neither delegated run is claimed as a successful independent validation gate.

## Sources

[get]: https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session
[create]: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions
[message]: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages
[archive]: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-archive
[terminate]: https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions
[list]: https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions
[pagination]: https://docs.devin.ai/api-reference/concepts/pagination
[usage]: https://docs.devin.ai/admin/billing/usage
[expiry]: https://docs.devin.ai/admin/common-issues#session-expiration
[generate]: https://docs.devin.ai/api-reference/v3/sessions/post-organizations-session-insights-generate
[list-insights]: https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions-insights
[insights-guide]: https://docs.devin.ai/product-guides/session-insights
[v1-create]: https://docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session
[v1-output]: https://docs.devin.ai/api-reference/v1/structured-output
