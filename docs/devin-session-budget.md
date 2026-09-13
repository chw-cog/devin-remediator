# Devin session budget

Devin Remediator sends a per-session ACU limit when it creates an
issue-remediation session. The application default is `10`, with a
`DEVIN_MAX_SESSION_BUDGET` override for workloads that need a different limit.
See [setup instructions](../README.md#set-the-session-budget) to configure it.

## Why the default is 10

This is our conservative starting point for focused bug fixes, not a provider
API default, a completion guarantee, or an SLA.

Devin's [2025 release notes](https://docs.devin.ai/release-notes/2025.md)
recommend "Keeping sessions under 10 ACUs" because "Devin's performance degrades
in long sessions". A cap of `10` follows that guidance's scale. It does not
guarantee that every session stays strictly below 10 ACUs or finishes its
assigned work.

The
[Session Insights guide](https://docs.devin.ai/product-guides/session-insights.md)
classifies ACU usage as XS at up to 2, S at up to 5, M at up to 10, L at up to
20, and XL above 20. It flags L and XL sessions as unhealthy. Session size also
depends on user message count, so an ACU cap alone does not guarantee a healthy
classification.

Enterprise ACU thresholds are ten times larger in the same guide. For example,
Enterprise M extends to 100 ACUs. Our `10` default does not scale automatically
with the account type and may be too restrictive for Enterprise workloads.
Operators can raise it after reviewing actual session usage and outcomes.

## What the API documents

The
[v3 create-session OpenAPI schema](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions.md)
accepts `max_acu_limit` as an optional integer or `null`. It does not document a
default for that field. The existing Devin client schema keeps those options;
the issue-remediation processor supplies our configured integer explicitly.

The application's configuration is narrower than the API schema. It uses the
existing `positiveInt` helper, so an omitted or empty environment value resolves
to `10`. A positive integer overrides it. Zero, negative numbers, fractions, and
nonnumeric values fail configuration loading rather than removing the cap.

The production entrypoint forwards the setting. The Deno `start` and `dev` tasks
and the Dockerfile runtime allow access to it. Custom Compose deployments must
forward overrides into the container environment as described in the setup
instructions.

## What the budget does not guarantee

Devin's [usage documentation](https://docs.devin.ai/admin/billing/usage.md) ties
usage to the number and complexity of actions, virtual machine time, and
networking bandwidth. A budget therefore does not guarantee a fixed runtime or
enough work to reproduce, fix, test, and submit every issue.

The limit applies to each newly created issue-remediation session. It is not an
aggregate spending limit or the concurrent-session limit. Changing the setting
does not update an existing session's budget, including a session resumed in
Devin's UI. The app does not raise a budget or create a replacement session when
work reaches the configured limit.
