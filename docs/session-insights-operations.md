# Local session insights operations

## Design sketch and invariant

```ts
DatabaseClient.layerWithPath(sqliteDbFilepath: string) // scoped DB + migrations only
recollectInsights(sessionRecordId: string)
// Effect<RecollectionReadout, RecollectionError | DatabaseError, DatabaseClient>
// outcome: rescheduled | already_pending | already_collected
```

The explicit local record ID selects one remote-associated row with a durable
completion observation. Only unavailable analysis starts a new collection cycle;
pending is unchanged and collected data is preserved. The response exposes IDs,
consumed ACUs (number or null), analysis scheduling, and a bounded diagnostic,
never outputs, analysis content, webhook payloads, or raw provider text.

Two reset designs were considered: use the existing retry count and timestamp as
the claim identity, or add a durable analysis generation. Retrying resets the
count, and clocks/timestamps can repeat, so the first design admits ABA. Choose
one integer `analysisGeneration`, incremented atomically only on recollection;
analysis writes compare generation as well as the existing identity, pending
status, and attempt count. The existing next-attempt time remains the
retry/lease schedule, not cycle identity. A late failure cannot replace
collected analysis. A database-only exported operation owns this transition; no
new service or provider control authority is needed.

For local initialization, duplicating SQLite setup or supplying fake provider
configuration would obscure resource ownership. `DatabaseClient.layerWithPath`
is the single scoped initializer (including migrations, pragmas, cleanup).
`DatabaseClient.layer` keeps the existing application-config entry point and
behavior. Local commands need no application secrets.
