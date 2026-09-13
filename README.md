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

With the same three required environment variables set, run:

```sh
docker compose up --build -d
curl --fail http://localhost:8000/health
docker compose logs -f app
```

Compose starts one app container. Its PID 1 is `deno run`, not `deno task` or a
worker launcher. The `sqlite-data` volume stores
`/data/devin-remediator.sqlite`. Startup applies migrations in the app process.
`docker compose down` preserves the volume; adding `--volumes` deletes it.

## Endpoints

`GET /health` returns `200` with `{"status":"ok"}`. This is process liveness,
not Devin availability or queue progress. It makes no database or Devin calls.

`POST /api/v1/webhook` accepts a JSON object with these headers:

- `X-GitHub-Event`: `check_run`, `dependabot_alert`, `issues`, `label`, or
  `push`.
- `X-GitHub-Delivery`: a nonempty delivery ID.
- `X-Hub-Signature-256`: GitHub's HMAC-SHA256 signature of the raw request body.

Accepted deliveries return an empty `200`. Malformed JSON, non-object payloads,
missing headers, and unsupported events return `400`.

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

All supported events queue a session, not only `issues.labeled`. The receiver
does not call Devin. The orchestrator reads the committed work independently.

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
organization API client. Create and get requests time out after 30 seconds. The
API key must permit session creation and inspection in that organization.

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
`createApp` in `src/app.ts` is an Effect requiring `EventHandler`. Routes run
request effects with the captured service context.

`src/index.ts` composes the event handler, Devin client, session repository,
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
- SQLite checks enforce the five statuses and nonnegative attempts. Drizzle's
  text enum alone only constrains TypeScript.
- Timestamps are UTC ISO strings. Both rows share the insertion time. Every
  lifecycle update sets `updated_at` using Effect's clock.
- Unique `github_delivery_id` permits one session per delivery, not per issue.
  Separate GitHub deliveries for the same issue can queue separate sessions.

The orchestrator adds no tables, columns, indexes, or migrations. `status`,
`attempts`, `updated_at`, and `devin_session_id` cover the required state.

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
