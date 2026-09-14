# Devin Remediator

Devin Remediator gives repository maintainers a controlled way to delegate bug
investigation. Label an issue `devin` to queue one Devin session, retain its
findings and pull request, and see when it needs human input. The intended pilot
is a Superset issue backlog where reproducing reports competes with feature
work.

Devin is suited to tasks that combine repository exploration, reproduction,
implementation, testing, and a pull request handoff. This app supplies issue
context and a shared playbook. Maintainers still review the evidence, approve
sensitive actions in Devin, and merge through their normal workflow.

The Hono server and Effect worker share one Deno process. SQLite persists work
and recovery state without a separate queue service. The bundled
[playbook](playbooks/fix-superset-issue.md) targets Superset. Review its
repository assumptions before using this app elsewhere.

## Run with Docker

You need Docker Compose, mise, a Devin organization API key, and repository
access configured in Devin. **Starting the app creates or updates an
organization playbook. Labeling a new issue can start paid work.** For
credential-free checks, use [Verify locally](#verify-locally) instead.

Create a root `.env` file. It is ignored by Git.

```dotenv
DEVIN_API_KEY=<key-with-session-playbook-and-insights-access>
DEVIN_ORGANIZATION_ID=<organization-id>
GITHUB_WEBHOOK_SECRET=<strong-shared-secret>
SQLITE_DB_FILEPATH=/data/db.sql
```

Start the app and check its HTTP health endpoint.

```sh
mise x -- docker compose up --build -d
mise x -- curl --fail http://localhost:8000/health
mise x -- docker compose logs -f app
```

Health returns `{"status":"ok"}`. It proves the server is listening, not that a
remediation succeeded. Startup applies migrations and synchronizes
`!fix-superset-issue` before accepting requests. Synchronization needs
organization playbook-management permission and fails startup on error. Existing
playbooks are updated even when unchanged. Ticks reuse that ID.

Compose reads `.env` and shell variables; exported shell values take precedence.
SQLite persists in the `sqlite-data` volume. Keep its path under `/data`. Do not
remove the volume to recover a stuck session. Recreate the container after
changing configuration. Rebuild and restart for bundled playbook changes. Run
one deployment that owns this playbook. Overlapping versions and manual remote
edits are unsupported. Effects of playbook updates on already-running sessions
are unverified.

### Connect GitHub

1. Expose `https://<your-host>/api/v1/webhook` through HTTPS.
2. Configure a repository webhook with `application/json`, **Issues** events,
   and the same webhook secret. A GitHub App webhook can replace this webhook.
3. Add the exact lowercase `devin` label to a suitable issue.
4. Follow `webhook.queued` and `Devin session created` in logs, then inspect
   Devin. A 200 response acknowledges durable intake, not a completed fix.

The exact raw body is HMAC-verified. Invalid signatures return constant 401
responses; malformed requests return 400. Persistence or unexpected defects
return 500 without private details. Investigate failures before replaying
deliveries.

A normalized repository and issue number own **one admission for the lifetime of
this database**. Repository case variations deduplicate. Relabeling, new
delivery IDs, completion, archiving, local release, and restart never authorize
a replacement. Same-delivery replay is idempotent. Ignored events retain
delivery history but queue no work. Different repositories and issue numbers are
independent.

### Bound new work

`DEVIN_MAX_SESSION_BUDGET` defaults to 10 ACUs per new session and requires a
positive integer. It is not a deployment spending cap or a guarantee of a fix.
`DEVIN_MAX_CONCURRENT_SESSIONS` defaults to 3 and `DEVIN_MAX_ATTEMPTS` to 3.

Known-rejected 429 submissions retry after a persisted deadline. Fallback
backoff starts at 30 seconds, doubles, and caps at five minutes. A valid later
Retry-After seconds or HTTP-date deadline takes precedence, even beyond five
minutes. Attempts survive restart and eventually exhaust. Retry waiting does not
block HTTP handling. Timeouts, transport loss, 408, 5xx, and malformed success
are ambiguous. They permit only original delivery-tag lookup, never blind
creation retries.

## Enable issue comments

Install a GitHub App with **Issues: Read and write**, an **Issues** event
subscription, and the webhook configuration above. Use its webhook instead of a
duplicate repository webhook. Set all three credentials.

```dotenv
GITHUB_APP_ID=<positive-app-id>
GITHUB_APP_INSTALLATION_ID=<positive-installation-id>
GITHUB_APP_PRIVATE_KEY=<complete-RSA-private-key-PEM>
```

For multiline PEM in `.env`, use single quotes and preserve actual line breaks.
Only one installation is supported. No OAuth client secret or personal access
token is used. Leaving all credentials unset disables comments, not remediation.
Partial or invalid credentials prevent startup.

The App posts a session link after dispatch and when input or approval is
needed. It does not copy private questions into GitHub. **Respond, approve, or
decline in Devin's UI.** GitHub replies are not forwarded. Delivery is
best-effort; brief waits can be missed and duplicate comments remain possible.

## Follow current work and outcomes

Add **Pull requests: Read-only** to the GitHub App and approve the installation
permission change. Set these values and recreate the container.

```dotenv
DASHBOARD_REPOSITORY=owner/repo
DASHBOARD_USERNAME=viewer
DASHBOARD_PASSWORD=<strong-shared-password>
```

Open `/dashboard` with these credentials. Use HTTPS outside localhost because
Basic auth does not encrypt credentials. Leave repository and password unset to
disable it.

Previous and next links browse current in-progress and attention-needed
sessions, three per page, newest session first. They work without JavaScript.
Automatic refresh runs every 30 seconds while visible, preserves the page, and
clamps it if the list shrinks. Historical, released, completed, and archived
sessions are not added to this list. Pages are not frozen across refreshes.
`GET /api/v1/metrics?page=2` uses the same login. Invalid pages return 400;
valid excessive pages clamp. HTML and JSON reuse one 30-second snapshot.

Metric scope matters.

- Repository totals include open and closed issues, not PRs, from GitHub Search.
  Search can lag changes. Unknown GitHub values are not zero.
- Devin counts cover this app only, without historical backfill. Assigned
  issues, issues with a linked PR, and merged PRs are different units. PR
  coverage is one same-repository PR per session.
- Usage sums latest provider-reported ACUs for app-tracked remote sessions,
  including inactive sessions. Missing values are excluded from averages, not
  treated as zero. A reported zero does not prove free compute or zero dollars.
  Official [usage](https://docs.devin.ai/admin/billing/usage.md) and
  [self-serve billing](https://docs.devin.ai/admin/billing/self-serve.md)
  documentation distinguish usage from funding credits, but do not explain
  credit-related zeros in the v3 session field. No dollar-cost conversion is
  assumed here.
- `timing.fixProposed` measures session creation to GitHub PR creation,
  including drafts, not passing CI. `timing.merged` measures session creation to
  GitHub merge, including review and waiting. Neither is active execution time.
  Each tracked session contributes at most one sample per milestone, including
  released and archived sessions. Missing or invalid timestamps are excluded.
  Sample counts and excluded-session counts accompany each median. No samples
  displays an unavailable value. Separate cohorts mean subtracting medians is
  not median review time.

## Recover local tracking safely

Use Devin's UI for remote control. Waiting, paused, and completed sessions
remain observable. Archived sessions stop routine polling. The app never sends
messages, approves actions, changes existing budgets, or creates a replacement
on lookup failure. A proposed fix still needs review and merge.

Inspect local IDs, deadlines, ownership, and diagnostic history in the
container. Adjust the database filename if needed.

```sh
mise x -- docker compose exec app deno task session-admin --db /data/db.sql list
mise x -- docker compose exec app deno task session-admin --db /data/db.sql inspect <local-id>
mise x -- docker compose exec app deno task session-admin --db /data/db.sql diagnose <local-id>
```

`list` and `inspect` need no provider credentials. `diagnose` makes a read-only
Devin request and records safe evidence. For a missing association, add
`--remote-id <original-remote-id>`. Never guess a replacement ID.

Mutations need a fresh revision from `inspect` and a nonempty reason.

```sh
mise x -- docker compose exec app deno task session-admin --db /data/db.sql resume <local-id> --revision <revision> --reason "Verified original session"
mise x -- docker compose exec app deno task session-admin --db /data/db.sql associate <local-id> --remote-id <original-remote-id> --revision <revision> --reason "Verified original delivery tag"
mise x -- docker compose exec app deno task session-admin --db /data/db.sql resolve <local-id> --revision <revision> --reason "Release local tracking only"
```

`resume` and `associate` verify identity, organization, and the original
delivery tag. They request an observation even for a previously closed row,
without inventing an active provider state. Failed or stale observations retain
that request. A fresh archived observation closes routine polling again. Active
leases, stale revisions, and conflicting identities reject recovery. Re-inspect
after any diagnostic or state change.

`resolve` releases local tracking and capacity only. It does not stop remote
work, refund usage, or remove lifetime admission. There is no new-session retry
command. Empty or ambiguous tag searches never authorize another POST.

### Upgrade an existing database

Stop intake and all writers before an authorized upgrade. Back up through
SQLite's backup mechanism, or copy the database and WAL files together while all
connections are closed. Keep a backup outside the deployment volume and test the
upgrade on a copy. App startup and administrative commands both run migrations.

The forward admission migration preserves deliveries, remote IDs, outputs, PRs,
analysis, and notification receipts. It chooses one canonical session per issue,
preferring remote-backed work, then possible creation, attempted or terminal
work, and pristine pending work. Ties use oldest insertion time and ID. Existing
duplicate remote creations remain history and can still be observed; they cannot
be undone. Never-created duplicate or ignored queued rows are fenced and
audited. Unidentified never-created work is quarantined. Creation evidence
without a trustworthy issue identity aborts the whole migration. Investigate on
a copy; do not delete evidence to force startup. Restoring an old backup cannot
safely authorize work that might already exist remotely.

SQLite is intended for this single-process deployment. Independent worker tests
prove exclusive claims, not universal multiprocess availability. Two libSQL
connections contending in one JavaScript event loop can return safe 500s and
need connection reopen. Failed intake rolls back; replay after recovery stays
duplicate-safe. Protect the volume and backups because they contain raw webhooks
and private findings.

## Verify locally

Tests use synthetic providers, temporary SQLite databases, and local HTTP. They
need no real Devin or GitHub credentials.

```sh
mise x -- deno task check
mise x -- deno task test
mise x -- deno test -A src/issue-admission.test.ts src/issue-admission-migration.test.ts src/submission-retry.test.ts
mise x -- deno test --allow-read --allow-write --allow-ffi --allow-sys=cpus,networkInterfaces,hostname --allow-env=LIBSQL_JS_DEV,PATH,HOME --allow-run=mise src/compose-config.test.ts
```

The last command checks actual Compose interpolation with synthetic credentials.
It starts no containers. The default task skips this optional subprocess check.
For browser verification, install Chromium once and run the fixture suite. Node
20 or later is required. On Linux, install Playwright's browser system
dependencies if Chromium reports missing libraries.

```sh
mise x -- npm exec --yes --package=playwright@1.63.0 -- playwright install chromium
mise x -- npm exec --yes --package=playwright@1.63.0 -- node test/dashboard-browser.mjs
```

The browser suite starts a loopback-only fixture, not the real application. Its
numbers are synthetic. It covers auth, no-JavaScript links, 0/1/3/4/7 sessions,
refresh, page shrink, focus, escaping, and narrow layouts.

Build and smoke-test a separate image with no provider network access or
production volume mounts.

```sh
mise x -- docker build -t devin-remediator-check .
mise x -- docker run --rm --network none --mount type=bind,src="$PWD/test",dst=/app/test,readonly devin-remediator-check test -A src/issue-admission.test.ts src/issue-admission-migration.test.ts src/submission-retry.test.ts
```

## Evaluate a pilot

Record a cohort of eligible issues and compare it with a prior or matched manual
cohort. Measure reproducible bugs, verified PR proposals, accepted merges,
required human interventions, and maintainer review time. Track
provider-reported usage and confirm billing separately. Capture failures and
security escalations, not just successful PRs. The dashboard does not measure
saved engineering hours, causal productivity gains, or ROI. No such results are
claimed here.

Structured logs correlate `github_delivery_id`, `session_record_id`, and
`devin_session_id`. The default level is Info. To enable Debug in Compose, add
`LOG_LEVEL: Debug` under `app.environment` before recreating the container.
