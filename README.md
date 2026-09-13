# Devin remediator

A Deno app using Hono, Effect, Octokit, and Drizzle's native Effect adapter for
local libSQL. One Deno 2.9.6 process runs the HTTP server and
`DevinSessionOrchestrator`. SQLite holds the durable queue and remote session
identities. No external queue or worker process is required.

## Run locally

Set `DEVIN_API_KEY`, `DEVIN_ORGANIZATION_ID`, and `GITHUB_WEBHOOK_SECRET` in
your environment. Use the same webhook secret in GitHub's webhook settings.
Optionally set `SQLITE_DB_FILEPATH`; `AppConfig` defaults it to
`./devin-remediator.sqlite` when unset or empty. The parent directory must
already exist.

```sh
deno task start
```

The server listens on `http://localhost:8000`. Use `deno task dev` for watch
mode. If Deno is managed by mise, prefix commands with `mise exec --`. Startup
opens one shared SQLite connection and applies migrations before listening.
SQLite uses WAL mode and enables foreign keys. Shutdown on `SIGINT` or `SIGTERM`
interrupts and joins the orchestrator, drains HTTP requests, then closes SQLite.

## Run with Docker

Create a `.env` file in the repo root (ignored by Git):

```dotenv
DEVIN_API_KEY=dummy-devin-api-key
DEVIN_ORGANIZATION_ID=dummy-devin-organization-id
GITHUB_WEBHOOK_SECRET=dummy-github-webhook-secret
SQLITE_DB_FILEPATH=/data/db.sql
```

The dummy values let the app start. Replace them before sending real webhooks or
creating Devin sessions. Keep the database path under `/data`, then run:

```sh
docker compose up --build -d --wait
curl --fail http://localhost:8000/health
docker compose logs -f app
```

Compose runs only `app` with the Dockerfile's unchanged default command. The
`sqlite-data` volume mounts at `/data` and stores `db.sql`. The app applies
migrations before listening, so migration failures prevent startup. The app
health check waits for `/health` to respond successfully. `docker compose down`
preserves the volume; adding `--volumes` deletes it.

## Endpoints

`GET /health` returns `200` with `{"status":"ok"}`. This is process liveness,
not Devin availability or queue progress. It makes no database or Devin calls.

`POST /api/v1/webhook` accepts a JSON object with these headers:

- `X-GitHub-Event`: a nonempty event name.
- `X-GitHub-Delivery`: a nonempty delivery ID.
- `X-Hub-Signature-256`: GitHub's HMAC-SHA256 signature of the raw request body.

Accepted deliveries return an empty `200`. Malformed JSON, non-object payloads,
and missing or empty required headers return `400`.

Each payload must include a nonempty `repository.full_name`. If `issue` is
present, `issue.number` must be a positive integer.

Octokit's `Webhooks.verify` verifies the exact raw body using
`GITHUB_WEBHOOK_SECRET`. The receiver then inserts a `github_webhook_deliveries`
row and a `devin_sessions` row with status `pending` in one transaction. The
payload is stored unchanged, including whitespace.

Repeated delivery IDs return `200` without changing either row. Other database
errors roll back both inserts and return a generic `500`. Invalid signatures and
invalid repository or issue metadata also return a generic `500`. Missing or
empty required server configuration prevents startup.

All accepted events queue a local job. The receiver does not call Devin. The
orchestrator reads the committed work independently and selects one processor by
event name. The default issues processor creates a session only when `action` is
`labeled` and the added `label.name` is exactly `devin`. Other issues deliveries
and events without a processor become terminal `skipped`. Existing labels in
`issue.labels` do not affect this decision. Different delivery IDs for the same
issue can create separate sessions.

## Orchestrator configuration

These optional environment variables accept positive integers. Invalid values
prevent startup.

| Variable                           | Default | Meaning                                                          |
| ---------------------------------- | ------- | ---------------------------------------------------------------- |
| `DEVIN_MAX_CONCURRENT_SESSIONS`    | `3`     | Maximum local `submitting` plus `running` records                |
| `DEVIN_MAX_ATTEMPTS`               | `3`     | Maximum reserved submission attempts per delivery                |
| `DEVIN_ORCHESTRATOR_INTERVAL_MS`   | `3000`  | Delay after each completed tick                                  |
| `DEVIN_SUBMITTING_TIMEOUT_SECONDS` | `60`    | Age at which an unknown submission becomes eligible for recovery |

`DEVIN_API_KEY` and `DEVIN_ORGANIZATION_ID` configure the existing Devin v3
organization API client. Create, get, and complete tag lookups time out after 30
seconds. The API key must permit session creation, inspection, and
`ViewOrgSessions` listing in that organization. Creating the issue playbook also
requires `ManageOrgPlaybooks` (`org.playbooks.manage`); looking it up requires
`UseDevinSessions` (`org.devins.use`).

See [orchestration behavior and limitations](docs/orchestration.md) for the
state transitions, retry policy, and remote-creation ambiguity.

## Database schemas and migrations

Drizzle schemas live in `src/schemas.ts`. SQL migrations and Drizzle metadata
live in `migrations/`. To generate a migration after changing the schemas:

```sh
deno task db:generate
```

Review and commit the generated files. Production startup and in-memory tests
apply the same migrations.

### Effect integration

`DatabaseClient.layer` in `src/database.ts` reads `AppConfig`, opens the
connection, applies migrations, and closes the connection when its scope ends.
`createApp` in `src/app.ts` is an Effect requiring `WebhookDeliveryHandler`.
Routes run request effects with the captured service context.

`WebhookEventProcessors` in `src/webhook-event-processors.ts` is an Effect
service containing a readonly event-kind map of `WebhookEventProcessor`
functions. Its production layer registers `issuesProcessor`. Each processor
receives the persisted `DeliveryRecord` and `DevinClient` service. It returns an
Effect with a `Skipped` or `SessionCreated` outcome and preserves
`DevinSubmissionError` classifications. The orchestrator obtains the registry
with `yield* WebhookEventProcessors` and owns all lifecycle writes. `AppLive`
provides `WebhookEventProcessors.layer`. Tests can replace the map with
`Layer.succeed(WebhookEventProcessors, processors)` without another HTTP
registration or a middleware chain.

Before submitting a matching issue, the processor looks up the exact macro
`!fix-superset-issue`. If absent, it creates **Fix Superset issue** with the
configured remediation instructions. Existing playbooks are reused without
changing their title or body. Session creation includes the resulting
`playbook_id`. Lookup and creation are serialized within the processor layer;
session requests remain concurrent. Playbook failures block session creation.
Transient failures return the job to the normal retry path, not session
recovery.

See [the playbook API notes](docs/devin-playbook-api.md) for endpoint contracts
and limits on cross-process deduplication.

`src/index.ts` composes the delivery handler, Devin client, session repository,
orchestrator, and config provider over one database layer. `runApplication`
acquires the Hono server and forks `DevinSessionOrchestrator.run` with
`Effect.forkScoped`. Both use the application's Effect context.

`tick` performs one iteration; `run` repeats it with `Effect.sleep`. Tests
normally call `tick` with a fake Devin client and a fresh migrated SQLite
database.

Drizzle ORM and Kit are pinned to `1.0.0-rc.5-5935859` for compatibility with
Effect `4.0.0-rc.115`. The `effect-sqlite-node` driver needs a `node:sqlite` API
that this project's Deno version lacks, so the app uses `effect-libsql`. On
Linux, libSQL's native loader detects glibc through `process.report.getReport`.
The run and test commands grant `--allow-sys=cpus,networkInterfaces,hostname`
for that Deno compatibility path.

### Schema decisions

- `delivery_id` is `NOT NULL UNIQUE`: it is the deduplication key and the target
  of the session's foreign key.
- Text primary keys explicitly use `NOT NULL`, which SQLite otherwise does not
  always enforce. Table-level primary key declarations preserve this constraint
  in Drizzle Kit's generated SQL. The receiver generates separate UUIDs for both
  rows.
- SQLite checks enforce the six statuses and nonnegative attempts. Drizzle's
  text enum alone only constrains TypeScript.
- Timestamps are UTC ISO strings. Both rows share the insertion time. Every
  lifecycle update sets `updated_at` using Effect's clock.
- Unique `github_delivery_id` permits one session per delivery, not per issue.
  Separate GitHub deliveries for the same issue can queue separate sessions.

Tag recovery adds `claim_version` to fence stale workers,
`recovery_empty_checks` to require repeated empty lookups, and
`recovery_blocked` to stop automatic creation after duplicate matches. Startup
applies the additive migration to existing databases.

## Check

```sh
deno task check
deno task test
```

Tests send signed requests directly to Hono and inspect migrated, in-memory
SQLite databases. They cover rollback, duplicate deliveries, HMAC failures,
constraints, and resource cleanup. Orchestrator tests cover transactional
claims, capacity, overlapping ticks, retries, stale recovery, reconciliation, PR
parsing, and the create/persist failure boundary. A restart test closes and
reopens a temporary SQLite file. A loopback HTTP test checks webhook
responsiveness during submission and application shutdown.

The test task grants filesystem access for temporary SQLite files, FFI for the
driver, loopback network access, and the driver's `LIBSQL_JS_DEV` environment
variable. Tests cannot reach the real Devin API and do not call GitHub.
`deno task check` runs formatting, lint, and TypeScript checks. There is no
separate JavaScript build step; `docker compose build` also checks the
entrypoint.
