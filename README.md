# Webhook receiver

A Deno app using Hono, Effect, and `@octokit/webhooks@14.2.0`.

## Run locally

Set `DEVIN_API_KEY`, `DEVIN_ORGANIZATION_ID`, and `GITHUB_WEBHOOK_SECRET` in
your environment. Use the same webhook secret in GitHub's webhook settings.

```sh
deno task start
```

The server listens on `http://localhost:8000`. Use `deno task dev` for watch
mode. If Deno is managed by mise, prefix commands with `mise exec --`.

## Endpoint

`POST /api/v1/webhook` accepts a JSON object with these headers:

- `X-GitHub-Event`: `check_run`, `dependabot_alert`, `issues`, `label`, or
  `push`.
- `X-GitHub-Delivery`: a nonempty delivery ID.
- `X-Hub-Signature-256`: GitHub's HMAC-SHA256 signature of the raw request body.

Accepted deliveries return an empty `200`. Malformed JSON, non-object payloads,
missing headers, and unsupported events return `400`.

Payload types come from Octokit and correspond to
[GitHub's webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads).
Nested payload fields are not validated at runtime. The `issues.labeled` handler
logs the label, repository, and issue number.

Octokit's `Webhooks.verifyAndReceive` verifies the signature using
`GITHUB_WEBHOOK_SECRET` before dispatching events. Invalid signatures and
callback failures return a generic `500`. Missing or empty server configuration
also returns `500`.

## Check

```sh
deno task check
deno task test
```

Tests send mock requests directly to Hono without a server or network
permissions. They do not call GitHub.
