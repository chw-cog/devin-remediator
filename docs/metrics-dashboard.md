# Metrics API reference

The dashboard and API are read-only views of one configured repository. They
share the same snapshot and HTTP Basic authentication.

## Routes

| Route                       | Response                                                                   |
| --------------------------- | -------------------------------------------------------------------------- |
| `GET /dashboard`            | Server-rendered HTML with up to three ongoing or attention-needed sessions |
| `GET /dashboard/styles.css` | Same-origin stylesheet                                                     |
| `GET /dashboard/client.js`  | Same-origin live-refresh module                                            |
| `GET /api/v1/metrics`       | JSON snapshot                                                              |

All four routes require authentication and return `Cache-Control: no-store`.
Invalid credentials return `401`. The routes are absent when the dashboard is
disabled. `/health` and signed webhook intake retain their existing behavior.

The page has no external assets, frontend build, framework, or chart library. A
small vanilla JavaScript module fetches the JSON endpoint 30 seconds after each
completed refresh. It pauses polling while the tab is hidden and refreshes when
the tab becomes visible. Requests do not overlap and time out after 20 seconds.
The script updates text and constructs session links through DOM methods, not
untrusted HTML. Existing values remain visible on failure, with a retry notice
and the last snapshot time. A `401` stops polling and asks the viewer to reload
to sign in again.

With JavaScript, **Refresh** requests an update without reloading. Without
JavaScript, the server-rendered page still works and **Refresh** reloads it. The
API and page share a 30-second in-memory cache per process, including partial
snapshots. Concurrent readers reuse the same computation. A restart clears the
cache.

## Configuration

| Variable               | Meaning                                                    |
| ---------------------- | ---------------------------------------------------------- |
| `DASHBOARD_REPOSITORY` | One `owner/name`, normalized to lowercase                  |
| `DASHBOARD_USERNAME`   | Basic-auth username; default `viewer`                      |
| `DASHBOARD_PASSWORD`   | Required nonblank password when a repository is configured |

Absent or empty repository and password values disable the dashboard. Partial
configuration and invalid repository names fail startup. Passwords are redacted
in configuration values and never included in snapshots.

Deployment requires HTTPS or a trusted TLS-terminating reverse proxy. Basic
authentication does not encrypt credentials. This is a shared POC login, not
per-user authorization.

GitHub reads use the existing App installation credentials and a separate
read-only token cache with **Issues: read** and **Pull requests: read**. The
notifier retains its independent **Issues: write** token cache, so missing
dashboard permissions do not interrupt comments. The installation must include
the configured repository. Without usable GitHub credentials, local metrics
remain available but repository counts and needed merge checks are unknown.

## JSON fields

### Repository and source scope

- `repository`: configured repository.
- `generatedAt`: start of the local snapshot, in UTC.
- `cacheSeconds`: cache duration.
- `scope.repositoryIssues`: `github_all_open_and_closed_issues`.
- `scope.devinWork`: `app_tracked_only`.
- `scope.trackedSince`: earliest matching label delivery retained locally, or
  `null`. This is not a claim that all GitHub history since that date was
  received.
- `scope.prCoverage`: `one_same_repository_pr_per_session`.
- `github.checkedAt`: start of the GitHub read attempt.
- `github.status`: `available` or `partial`.

### Issues and pull requests

| Field                            | Unit and definition                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `issues.repositoryTotal`         | GitHub Search `total_count` for `repo:owner/name is:issue`; includes closed issues and excludes PRs                   |
| `issues.assignedToDevin`         | Distinct issue numbers with an `issues` / `labeled` / exact `devin` label event observed by this app                  |
| `issues.withDevinPr`             | Distinct assigned issues with a PR association from a tracked remote session                                          |
| `issues.withMergedDevinPr`       | Distinct issues in that cohort with at least one confirmed merged PR; `null` if any tracked PR merge state is unknown |
| `pullRequests.tracked`           | Distinct PR numbers associated with that issue cohort                                                                 |
| `pullRequests.merged`            | Distinct tracked PRs with non-null GitHub `merged_at`; `null` if any merge state is unknown                           |
| `pullRequests.confirmedMerged`   | Confirmed merges, even when the full merged total is unavailable                                                      |
| `pullRequests.unknownMergeState` | Tracked PRs without a successful merge check                                                                          |

Repeated deliveries, label applications, and sessions do not multiply issue
counts. PRs shared across issues count once as PRs. One issue can have multiple
PRs through separate tracked sessions. The four dashboard counts therefore have
different units and are not a single conversion funnel.

GitHub Search is indexed and can lag recent changes. Incomplete results are
rejected rather than presented as a total. Its 1,000-item search enumeration
limit does not limit the `total_count` field used here.

PR associations come from the app's existing provider observations. They do not
prove a PR was authored by Devin. Only the first matching same-repository PR
retained per session is represented. No historical importer or additional Devin
poller is added.

### Usage

- `usage.unit`: `ACU`, not dollars.
- `usage.total`: sum of each tracked remote session's latest known finite,
  nonnegative ACUs.
- `usage.averagePerSession`: total divided by `measuredSessions`.
- `usage.trackedSessions`: distinct remote session IDs attached to local
  deliveries for this repository.
- `usage.measuredSessions`: sessions with known usage, including measured zero.
- `usage.missingSessions`: tracked sessions without usable usage.
- `usage.oldestObservationAt` and `usage.latestObservationAt`: range of local
  session observations.

Both total and average are `null` when no usage is known. A known zero remains
zero. Inactive, failed, released, and archived sessions contribute known usage.
Local jobs that never obtained a remote session do not contribute. Spawned
sessions not tracked by this app are not separately counted.

Usage is an observed snapshot, not a billing ledger. Released sessions can stop
receiving observations. This API neither estimates USD nor queries
organization-wide consumption.

### Completion time

`completion.medianMilliseconds` is the median of:

```text
first completion observed locally − provider creation time
```

Provider creation timestamps use the application's existing Unix-second
convention. Completion observations use local UTC timestamps. Missing, invalid,
and negative durations are excluded. The median of an even-sized sample is the
mean of the two middle values.

`completion.sampleCount` and `completion.excludedSessions` disclose coverage. An
empty sample produces `null`. `completion.definition` is
`creation_to_first_observed_completion_including_waiting`.

This includes startup, pauses, waiting, and polling lag. It is not accumulated
active execution time. First completion remains first completion after a session
resumes.

### Session list

`activeSessionCount` counts app-owned remote sessions that are neither archived
nor completed/closed. Unknown, paused, and intervention states are included so
work needing attention does not disappear.

`activeSessions` contains at most three entries, ordered by latest observation
or insertion time, then local ID:

- `id` and a validated HTTPS Devin session `url`, or `null`.
- `issue.number`, a derived GitHub `issue.url`, and a title from the received
  webhook. Titles can lag edits made on GitHub.
- `lifecycle`, raw `providerStatus`, and `providerStatusDetail`.
- Latest validated `remediationOutcome`, or `null`.
- Observed `acus` and `observedAt`.

Provider status and remediation outcome are independent. `fix_proposed` does not
mean merged. Raw webhook payloads, prompts, analysis, output summaries, and
verification evidence are not exposed. HTML text is escaped, and the page uses a
restrictive Content Security Policy.

## Failure and request limits

Authentication has a five-second deadline. Issue and individual PR requests have
five-second deadlines. At most four PR reads run concurrently; the whole PR
batch has a ten-second deadline. If the batch deadline expires, its merge checks
are treated as unknown. There are no immediate retries.

GitHub failures produce `200` snapshots with explicit unknown components, not
false zeros. A local database failure produces `503`, with a retry page for HTML
and a sanitized error for JSON.

Dashboard requests have their own bounded read path. They do not share the
comment notifier's persisted three-second request schedule. The cache is
process-local, not a distributed rate limiter. Very large tracked PR sets may
exceed the read deadline and require a future persisted snapshot design.

## Verification

`src/metrics.test.ts` exercises real SQLite migrations and the Hono routes with
an injected GitHub transport. The suite covers cohort deduplication, fractional
and missing usage, observed duration, merge uncertainty, authentication, HTML
escaping, safe links, empty state, and storage failure.

The implementation does not require a real Devin session or a GitHub write to
test its read paths. Live provider permission and billing behavior still depend
on the deployment's account and installation.

`test/dashboard-browser.mjs` drives the actual authenticated Hono page in
Chromium against a local fixture. It covers automatic refresh, failure recovery,
hidden-tab behavior, DOM safety, keyboard focus, responsive layout, and the
no-JavaScript fallback. Playwright is test tooling, not an application
dependency:

```sh
mise x -- npx --yes playwright@1.63.0 install chromium
mise x -- npm exec --yes --package=playwright@1.63.0 -- node test/dashboard-browser.mjs
```

The [research brief](research/metrics-dashboard.md) compares lightweight UI
options and records the provider documentation behind these definitions.
