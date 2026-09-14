# Lightweight metrics dashboard research

## Confirmed scope

- **ACUs only; no USD conversion.**
- Total issues cover the configured GitHub repository, including closed issues.
- Devin usage, outcomes, and duration cover **this app’s tracked work only**,
  with **no historical backfill**.
- Duration means **observed time to first completion**, including waiting and
  observation lag—not active runtime.

## Recommended minimal stack

Add a read-only JSON endpoint and one HTML page to the existing Hono app. Reuse
the existing database and provider observations; do not introduce a SPA,
frontend build, separate metrics service, or another Devin polling loop.

The repository already uses Deno, Hono, Effect, and Drizzle/libSQL. Session
records contain ACUs, provider timestamps/status, session URL, and first
completion-observed time. Raw GitHub deliveries are retained, but there is no
repository-wide issue inventory or current merge-state store. See
[dependencies](../../deno.json), [routes](../../src/app.ts),
[schema](../../src/schemas.ts), and
[observation persistence](../../src/devin-session-repository.ts).

### Styling options

| Option               | Loading/build tradeoff                                                                                                                                                                                                | Recommendation                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Small custom CSS** | No library dependency or build; only the styles this page needs. Accessibility, responsive layout, and focus styling remain our responsibility.                                                                       | **Preferred** for four counts and a session table. Use system fonts and one same-origin stylesheet.                                                                                                                                                   |
| **Pico CSS**         | Maintainer supplies precompiled CSS, CDN/manual installation, and classless variants. Semantic HTML, responsive defaults, and light/dark styling reduce initial styling work. Dashboard-specific CSS is still needed. | Good fallback if visual polish would otherwise consume disproportionate effort. Pin and self-host a release. [Pico](https://github.com/picocss/pico#readme)                                                                                           |
| **Simple.css**       | Mostly classless, with responsive defaults, local fonts, and automatic dark mode. Supports a stylesheet link or self-hosting; no build required. Its hosted CDN tracks updates automatically.                         | Genuinely minimal alternative, but introduces another opinionated stylesheet without a clear advantage for this page. [Overview](https://simplecss.org/), [installation](https://github.com/kevquirk/simple.css/wiki/Getting-Started-With-Simple.css) |

No numeric bundle comparison is claimed: compressed transfer size depends on the
selected release, distribution, and serving configuration.

### Four-count visualization

**Use ordinary text counts with decorative CSS bars.** Server-rendered labels
and numbers remain useful without JavaScript; bars should not be the only way to
understand the values.

- **Native inline SVG:** also needs no chart library or build. Useful if a
  precise diagram is genuinely required, but adds geometry and
  accessible-description work. Keep an adjacent textual representation.
- **Chart.js:** supports a no-build UMD script, but introduces JavaScript
  loading, execution, and canvas initialization. Its documented tree-shaking
  approach requires importing/registering selected components with a bundler; a
  plain script-tag deployment does not gain that optimization automatically.
  Canvas content is not inherently screen-reader accessible, so accessible names
  and equivalent textual data remain necessary. Excessive for four counts.
  [Integration](https://github.com/chartjs/Chart.js/blob/master/docs/getting-started/integration.md),
  [accessibility](https://github.com/chartjs/Chart.js/blob/master/docs/general/accessibility.md)
- W3C guidance recommends textual equivalents conveying chart values and
  relationships. Visible counts or a table provide a straightforward baseline.
  [W3C charts guidance](https://www.w3.org/WAI/tutorials/images/complex/)

Prefer manual refresh initially. If needed, add a small same-origin fetch
enhancement—not a client application framework.

## Verified Devin API facts

The local client **already calls v3**; this feature does not require a
migration. See [client](../../src/devin.ts).

| Concern            | v1                                                                                                                                | v3                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-session usage  | Documented get/list session schemas expose **no consumed-ACU or currency amount field**.                                          | Session responses contain numeric `acus_consumed`.                                                                                                 |
| Times              | `created_at` and `updated_at` are date-time strings.                                                                              | `created_at` and `updated_at` are integers. The inspected schema does not explicitly declare their units.                                          |
| Completion/runtime | No explicit started-working timestamp, completion timestamp, or accumulated active-runtime field in the inspected session schema. | Likewise absent from the inspected session schema.                                                                                                 |
| Provider status    | `status` plus optional `status_enum`, including `working`, `blocked`, `expired`, and `finished`.                                  | `status`: `new`, `claimed`, `running`, `exit`, `error`, `suspended`, `resuming`; optional `status_detail` explains current activity or suspension. |
| Session link       | Create returns `url`; get/list schemas do not expose a session URL field.                                                         | Session response includes `url`.                                                                                                                   |
| PR association     | Optional `pull_request.url`.                                                                                                      | `pull_requests[]` contains `pr_url` and nullable `pr_state`.                                                                                       |

Sources:
[v1 get](https://docs.devin.ai/api-reference/v1/sessions/retrieve-details-about-an-existing-session.md),
[v1 list](https://docs.devin.ai/api-reference/v1/sessions/list-sessions.md),
[v1 create](https://docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session.md),
[v3 get](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md).

### Usage and scope

- Report the **latest observed ACUs summed once per distinct tracked Devin
  session ID**. Include known usage from failed, completed, archived, or locally
  released work—not just currently active sessions.
- Missing observations are **unknown**, not zero. Return known-session count,
  missing-usage count, and observation timestamps alongside the aggregate.
- `max_acu_limit` is a spending ceiling, not consumption. Do not calculate usage
  as session count × budget.
  [v1 creation schema](https://docs.devin.ai/api-reference/v1/sessions/create-a-new-devin-session.md)
- v3 organization/session daily-consumption endpoints return `total_acus` and
  `consumption_by_date`; organization results include product breakdowns. These
  endpoints are documented as **Enterprise-only**, require `ViewOrgConsumption`,
  and use a fixed **08:00 UTC** billing-day boundary. They are unnecessary for
  the initial tracked-session dashboard.
  [Organization consumption](https://docs.devin.ai/api-reference/v3/consumption/organizations-consumption-daily.md),
  [session consumption](https://docs.devin.ai/api-reference/v3/consumption/organizations-consumption-daily-sessions.md)
- Organization consumption is **not this app’s consumption**: it includes other
  work/products. Likewise, selecting sessions created in a date range and
  summing their lifetime ACUs does not measure ACUs consumed during that range.
- No currency conversion should be added. Current billing docs distinguish
  Enterprise ACUs priced by contract from self-serve quota/on-demand credits; a
  universal historical dollars-per-ACU assumption would be unsafe.
  [Enterprise billing](https://docs.devin.ai/admin/billing/enterprise.md),
  [self-serve billing](https://docs.devin.ai/admin/billing/self-serve.md)

v3 listing supports `session_ids`, tags, and other filters, with
`first`/`after`, `has_next_page`, and `end_cursor`; its optional `total` may be
omitted. If refreshing provider data, restrict it to tracked IDs and finish
pagination.
[v3 list](https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions.md)

### Duration and status presentation

Recommended calculation:

**First completion-observed timestamp − provider creation timestamp**, after
verified timestamp normalization.

Label it **“Observed time to first completion”** and disclose:

- Includes startup, waiting, pauses, and observation lag.
- Completion is first observed task completion, not final termination or PR
  merge.
- Existing `completionObservedAt` is retained after resumption; it must not be
  presented as the session’s final completion.
- Aggregate only records with both valid timestamps; disclose eligible/measured
  counts and exclude ongoing or unknown-duration sessions rather than assigning
  zero.

`running` does not necessarily mean actively working: v3 documents `working`,
`waiting_for_user`, `waiting_for_approval`, and `finished` details under that
status. Preserve raw status/detail alongside any local lifecycle label. Archive
and suspension are not successful remediation.
[v3 status definitions](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session.md)

Do not derive active runtime from ACUs or elapsed time. Usage depends on actual
work and infrastructure, and sleeping consumes no usage. Insights add message
counts, size classification, and AI-generated analysis—not an authoritative
active-runtime clock.
[Usage mechanics](https://docs.devin.ai/admin/billing/usage.md),
[insights schema](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-insights.md)

## GitHub counts and attribution

### Repository-wide total issues

For a lightweight implementation, cache a repository-scoped Search request:

`repo:OWNER/REPO is:issue`

Read `total_count`, omit an open-only state restriction, and require
`incomplete_results=false`. Describe it as an indexed GitHub count with its
fetch time.

For exhaustive enumeration instead, use
`GET /repos/{owner}/{repo}/issues?state=all` and exclude records containing
`pull_request`. Issues endpoints include PRs; their default state is open.
Paginate fully before claiming a complete count. This read need not backfill app
history.
[Search](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests),
[repository issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues)

### “Ever labeled” versus current labels

- GitHub `labels` filtering and Search `label:devin` describe current
  membership, not historical assignment.
- Historical `labeled`/`unlabeled` events are available through issue
  events/timelines. Reconstructing earlier history would require additional
  retrieval and is **out of scope**.
  [Event meanings](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#labeled),
  [timeline endpoint](https://docs.github.com/en/rest/issues/timeline#list-timeline-events-for-an-issue)
- Count distinct issues with a locally recorded `issues` → `labeled` → `devin`
  delivery. Label this **“Issues with Devin-label events observed by this
  app”**, not “all issues ever assigned to Devin.”
- Repeated label applications and webhook deliveries must not multiply the
  unique-issue count, even when they produce multiple sessions.

### App PRs and merges

Use the explicit **tracked issue → session → PR association**, validate
repository/PR identity, and query GitHub for current state.

Do **not** rely solely on bot-author searches, branch names, commit authors, or
text mentioning Devin. Official Devin settings allow PRs to be opened as linked
human users.
[Devin GitHub identity settings](https://docs.devin.ai/integrations/gh.md#user-linking)

A session-associated PR is not necessarily a newly created fix; it may reference
existing work. Prefer **“Tracked PRs”** unless creation attribution is
established.

GitHub PR responses expose `merged_at`; PR detail also exposes merge
information. `state=closed` alone does not prove a merge, and `mergeable` or a
non-null `merge_commit_sha` does not prove it either. Query errors mean
unknown—not unmerged.
[PR endpoints](https://docs.github.com/en/rest/pulls/pulls)

**Local limitation:** persistence retains one same-repository `prNumber` per
session, although Devin returns an array. Initial counts must disclose that
association coverage rather than imply exhaustive multi-PR attribution.

### Pagination and funnel caveats

- REST pagination uses response `Link` URLs; relevant list endpoints allow up to
  100 items per page. Never infer totals from one page or
  `last page × page size`.
  [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- Search exposes at most **1,000 result items per query**, has separate rate
  limits, and can return incomplete results. That item-enumeration limit is
  distinct from reading `total_count`. Respect access scope and show
  stale/unavailable state on failure.
  [Search limitations](https://docs.github.com/en/rest/search/search)
- Repository-wide issues, app-observed labeled issues, tracked PRs, and merged
  PRs mix scope and counting units. Present four labeled counts—not a
  mathematically guaranteed conversion funnel. A true funnel would instead count
  the same issue cohort at every stage.

## Remaining implementation decisions

1. Confirm whether outcome cards count **distinct PRs** or **distinct issues
   with qualifying PRs**.
2. Verify v3 timestamp units against a permitted, sanitized response before
   implementing duration arithmetic.
3. Define whether tracked-session usage excludes spawned child sessions;
   inspected schemas do not establish parent/child ACU roll-up semantics.
4. Choose cache freshness and dashboard access control. Both HTML and JSON
   should expose only allowlisted metrics/link fields—not raw webhook payloads,
   prompts, or insights.

**Research method:** Started with four varied web queries; the search engine
returned challenge pages. Used official provider documentation and maintainer
repositories directly. No production implementation or authenticated provider
requests were performed.

🌱 graft saved ~135,782 tokens this turn.
