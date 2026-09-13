# Webhook receiver

A Deno app using Hono, Effect, Octokit, and Drizzle's native Effect adapter for
local libSQL. Database files are SQLite-compatible; no remote database service
is required.

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
drains requests before closing the connection.

## Endpoint

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
does not call Devin. Worker claiming, API submission, and session updates are
not implemented.

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

`src/index.ts` composes the database, event handler, and config provider layers
once. Tests use the same layers with `SQLITE_DB_FILEPATH: ":memory:"` in their
config provider. There are no `withConfig` or `withDatabase` wrappers.

Drizzle ORM and Kit are pinned to `1.0.0-rc.5-5935859` for compatibility with
Effect `4.0.0-rc.115`. The `effect-sqlite-node` driver needs a `node:sqlite` API
that this project's Deno version lacks, so the app uses `effect-libsql`.

### Schema decisions

- `delivery_id` is `NOT NULL UNIQUE`: it is the deduplication key and the target
  of the session's foreign key.
- Text primary keys explicitly use `NOT NULL`, which SQLite otherwise does not
  always enforce. Table-level primary key declarations preserve this constraint
  in Drizzle Kit's generated SQL. The receiver generates separate UUIDs for both
  rows.
- SQLite checks enforce the five statuses and nonnegative attempts. Drizzle's
  text enum alone only constrains TypeScript.
- Timestamps are UTC ISO strings. Both rows share the insertion time. Future
  worker updates must also set `updated_at`.
- Unique `github_delivery_id` permits one session per delivery, not per issue.
  Separate GitHub deliveries for the same issue can queue separate sessions.

### Before adding the worker

Consider a claim lease (`claimed_at` or `lease_expires_at`) for recovering tasks
stuck in `submitting`, `next_attempt_at` for retry scheduling, and `last_error`
for diagnosis. Add an index matching the worker's pending-task query, such as
`(status, inserted_at)`.

A transaction cannot cover the external Devin API call. A crash after Devin
creates a session but before its ID is saved needs an API idempotency key, if
supported, or reconciliation before retrying. `attempts` alone cannot prevent
duplicate external sessions.

## Check

```sh
deno task check
deno task test
```

Tests send signed requests directly to Hono and inspect migrated, in-memory
SQLite databases. They cover rollback, duplicate deliveries, HMAC failures,
constraints, and resource cleanup. The test task grants read and FFI permissions
for migrations and the native driver, plus access to the driver's
`LIBSQL_JS_DEV` environment variable. Tests need no network permissions and do
not call GitHub or Devin.
