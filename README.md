# Devin Remediator

Devin Remediator turns GitHub issues labeled `devin` into Devin sessions that
investigate and fix bugs. It tracks each session and keeps remediation results,
linked pull requests, and session analysis.

The webhook server and background worker run in one Deno process. SQLite keeps
queued work and session results across restarts, without a separate queue
service.

## Quickstart

You need Docker with Compose. The optional local webhook forwarder also requires
`mise`.

Export these environment variables in your shell, or put them in a `.env` file
in the repository root:

```dotenv
# Devin API key with access to sessions, playbooks, and insights.
DEVIN_API_KEY=<your-api-key>
# Devin organization where remediation sessions run.
DEVIN_ORGANIZATION_ID=<your-organization-id>
# Shared secret for verifying GitHub webhooks; use the same value in GitHub.
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>
# Database path inside the container; keep it under /data for persistence.
SQLITE_DB_FILEPATH=/data/db.sql
```

Compose reads these values and the optional budget and GitHub App settings below
from `.env` or your shell. Exported shell variables take precedence. `.env` is
ignored by Git. For other deployments, pass these settings to the app's
environment.

Start the app:

```sh
docker compose up
```

The server listens on `http://localhost:8000`. Migrations run automatically, and
SQLite data persists in a Docker volume. Recreate the app container after
changing its environment settings.

### Connect GitHub and trigger remediation

For local webhook forwarding through [Smee](https://smee.io), run:

```sh
MISE_ENV=local mise run webhook-forwarder
```

Use the channel URL printed by Smee, or pass `--url <channel-url>` to reuse one.
In your GitHub repository's webhook settings, use that URL, select
`application/json` and **Issues** events, and set the same webhook secret as
above. For a public deployment, use `https://<your-host>/api/v1/webhook`
instead.

Add the `devin` label to an issue to start remediation.

### Set the session budget

New remediation sessions have a default budget of 10 ACUs. To change the budget,
set `DEVIN_MAX_SESSION_BUDGET` to a positive integer before starting the app:

```sh
export DEVIN_MAX_SESSION_BUDGET=20
```

This setting applies only to new sessions. It is not a total spending limit or a
guarantee that the issue will be fixed. See the
[session budget guide](docs/devin-session-budget.md) for workload guidance,
including Enterprise considerations.

<a id="enable-issue-attention-comments-with-a-github-app"></a>

## Enable issue comments with a GitHub App

After dispatch, the App posts "Devin has picked up this issue." with a session
link. It also comments when Devin needs input or approval, without copying
questions or work details to GitHub. **Respond, approve, or decline in Devin's
UI.** GitHub replies are not forwarded.

1. Create a GitHub App with repository **Issues** permission set to **Read and
   write**.
2. Configure its webhook URL as above and use `GITHUB_WEBHOOK_SECRET` as its
   webhook secret.
3. Subscribe the App to **Issues** events and install it on the selected
   repositories. Use this webhook instead of a duplicate repository webhook.
4. Set all three application environment variables below.

```dotenv
GITHUB_APP_ID=<positive-app-id>
GITHUB_APP_INSTALLATION_ID=<positive-installation-id>
GITHUB_APP_PRIVATE_KEY=<complete-RSA-private-key-PEM>
```

Only one installation is supported per deployment. No OAuth client secret or
personal access token is used. The webhook secret is separate from the App
private key. For a multiline PEM in `.env`, enclose the complete value in single
quotes and preserve its actual line breaks.

Leave all three credentials unset to disable comments without disabling
remediation. Startup logs `attention.delivery_disabled` in this case. Partial or
invalid credentials prevent startup.

Comment delivery is best-effort. Polling can miss brief waits, and duplicate
comments are possible. Access or ownership failures can block delivery and
require operator investigation.

## Follow and manage sessions

Use Devin's UI to follow and continue work. Waiting, paused, and completed
sessions remain tracked. The service detects resumed work on its next poll and
stops tracking archived sessions. It does not send messages, approve actions,
change existing budgets, or create replacement sessions when a lookup fails.

A proposed fix still needs normal pull request review and merge.

For operational tasks, see these guides:

- [Local session administration](docs/session-operations.md) covers stalled
  sessions and reconciliation without remote control writes.
- [Passive session tracking](docs/passive-devin-lifecycle.md) covers lifecycle,
  polling, and operational limits.
- [Compose configuration checks](docs/lifecycle-compose.md) explains how to
  verify environment forwarding.

## Enable the metrics dashboard

1. Add **Pull requests: Read-only** to the GitHub App permissions and approve
   the updated installation permissions. Keep **Issues: Read and write**.
2. Set these environment variables:

   ```dotenv
   DASHBOARD_REPOSITORY=owner/repo
   DASHBOARD_USERNAME=viewer
   DASHBOARD_PASSWORD=<strong-shared-password>
   ```

3. Recreate the app container to apply the settings.
4. Open `https://<your-host>/dashboard` and sign in with the configured
   credentials. Use HTTPS when deployed because Basic auth does not encrypt
   credentials.

The dashboard shows issue and PR counts, ACU usage, observed completion times,
and up to three ongoing or attention-needed sessions. Repository totals come
from GitHub. Devin metrics cover work tracked by this app only.

A small script refreshes the numbers and session cards every 30 seconds while
the tab is visible. The page also works without JavaScript.
`GET /api/v1/metrics` returns the same snapshot using the same login.

Leave the repository and password unset to disable the dashboard. See
[metric definitions and dashboard configuration](docs/metrics-dashboard.md) for
coverage, caching, and failure behavior.

## View logs

The app emits structured JSON logs for webhook receipt, session creation,
provider transitions, retries, and analysis collection. Correlate events with
`github_delivery_id`, `session_record_id`, and `devin_session_id` as they become
available.

```sh
docker compose logs -f app
```

The default log level is `Info`. For debug logs with Compose, add
`LOG_LEVEL: Debug` to `app.environment` in `compose.yaml`.
