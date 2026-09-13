# Devin session polling

## API contract

The official [List Sessions schema][list] defines:

- `first`: defaults to 100, with a maximum of 200 results per page.
- `session_ids`: an optional array filter. The schema does not specify a maximum
  array length.
- `is_archived`: an optional, nullable filter, with no documented default.
- Session results include `status`, `status_detail`, `structured_output`, and
  `pull_requests`. The schema explicitly documents `status_detail` and
  `structured_output` as populated on both get and list endpoints.

[Pagination][pagination] uses `has_next_page` to indicate more results. Pass
`end_cursor` as `after` on the next request, retaining the original filters.

## Application behavior

Each orchestration tick claims due provider observations from SQLite in batches
of at most 200 session IDs. This ID batch size is an application limit, not a
provider filter limit. Each request sets `first=200` and `is_archived=false`.
Missing IDs are then queried with `is_archived=true`. Each filter has
independent pagination cursors; the complete lookup shares one 30-second
timeout.

The client follows every page, matches results by ID, and retains the newest
provider timestamp among duplicate responses. A missing or repeated continuation
cursor, invalid response, HTTP failure, or batch timeout fails the lookup
without returning partial results. Unknown status details are retained as
strings rather than rejecting a whole batch. A missing optional archive flag
does not become a fabricated observation merely because the query used an
archive filter.

The orchestrator releases failed lookup leases without erasing observations,
outputs, or remote identity and continues subsequent batches. Active and
unobserved work remains due every tick. Waiting, paused, completed, and
intervention states have a durable slower schedule. Archived sessions close
normal tracking. See [passive session tracking](passive-devin-lifecycle.md) for
capacity, result history, and observation fencing.

Polling uses only `listSessions`; the client has no single-session getter.

[list]: https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions
[pagination]: https://docs.devin.ai/api-reference/concepts/pagination
