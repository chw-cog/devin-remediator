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

Each orchestration tick reads running sessions from SQLite and queries Devin in
batches of at most 200 session IDs. This ID batch size is an application limit,
not a documented API filter limit. Each request sets `first=200` and leaves
`is_archived` unset.

The client follows every page, matches results by ID, and deduplicates returned
sessions. A missing or repeated continuation cursor, invalid response, HTTP
failure, or 30-second batch timeout fails the lookup without returning partial
results. The orchestrator leaves that batch running and continues with
subsequent batches. Sessions absent from a successful lookup also remain running
for retry.

Polling uses only `listSessions`; the client has no single-session getter.

[list]: https://docs.devin.ai/api-reference/v3/sessions/organizations-sessions
[pagination]: https://docs.devin.ai/api-reference/concepts/pagination
