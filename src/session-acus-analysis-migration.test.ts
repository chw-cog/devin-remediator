import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { Effect } from "effect";
import { Reactivity } from "effect/unstable/reactivity";

Deno.test("session ACU/generation upgrade preserves baseline rows and collected analysis, backfilling unknown usage as null", async () => {
  const folder = await Deno.makeTempDir();
  const client = createClient({
    url: pathToFileURL(`${folder}/baseline.sqlite`).href,
  });
  const baseline = `${folder}/migrations`;
  try {
    for (
      const name of [
        "20260913135033_initial",
        "20260913194128_fix_proposed_outcome",
        "20260913205455_session_outputs",
        "20260913212818_passive_lifecycle",
        "20260913224511_remarkable_demogoblin",
      ]
    ) {
      await Deno.mkdir(`${baseline}/${name}`, { recursive: true });
      await Deno.copyFile(
        new URL(`../migrations/${name}/migration.sql`, import.meta.url),
        `${baseline}/${name}/migration.sql`,
      );
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* LibsqlClient.make({ liveClient: client });
        const db = yield* Drizzle.makeWithDefaults().pipe(
          Effect.provideService(LibsqlClient.LibsqlClient, sql),
        );
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(db, { migrationsFolder: baseline });
        for (const status of ["pending", "collected", "unavailable"]) {
          yield* sql`INSERT INTO github_webhook_deliveries (id, delivery_id, event_name, repo, issue_number, payload, inserted_at) VALUES (${status}, ${status}, 'issues', 'owner/repo', 42, 'PRIVATE webhook', 'old')`;
          yield* sql`INSERT INTO devin_sessions (id, github_delivery_id, status, provider_lifecycle, active_work, is_archived, provider_created_at, provider_updated_at, session_url, completion_observed_at, outputs, pr_number, analysis, analysis_status, analysis_attempts, analysis_reason, analysis_next_attempt_at, devin_session_id, observation_version, observation_lease_until, claim_version, attempts, inserted_at, updated_at) VALUES (${status}, ${status}, 'submitted', 'completed', 0, 0, 1, 100, 'https://app.devin.ai/sessions/remote', 'completion', '[{"outcome":"needs_human","summary":"PRIVATE retained"}]', 7, ${
            status === "collected"
              ? '{"retained":true,"future":{"field":[1.25]}}'
              : null
          }, ${status}, 12, ${
            status === "collected"
              ? null
              : "Attempts exhausted: collection interrupted"
          }, 'next-attempt', ${status}, 8, 'lease', 9, 2, 'inserted', 'updated')`;
        }
        const before = yield* sql<
          { id: string }
        >`SELECT * FROM devin_sessions ORDER BY id`;
        const migrationsFolder = fileURLToPath(
          new URL("../migrations", import.meta.url),
        );
        yield* migrate(db, { migrationsFolder });
        const after = yield* sql`SELECT * FROM devin_sessions ORDER BY id`;
        assert.deepEqual(
          after,
          before.map((row) => ({
            ...row,
            acus_consumed: null,
            analysis_generation: 0,
            local_ownership: "tracking",
            admin_version: 0,
            lookup_failure_count: 0,
            lookup_failure_streak: 0,
            first_lookup_failure_at: null,
            last_lookup_failure_at: null,
            last_lookup_failure: null,
            reconciliation_escalated_at: null,
            next_recovery_at: "1970-01-01T00:00:00.000Z",
            recovery_candidate_ids: "[]",
          })),
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        const columns = yield* sql`PRAGMA table_info(devin_sessions)`;
        assert.equal(
          columns.find((column) => column.name === "acus_consumed")?.type,
          "REAL",
        );
        yield* sql`UPDATE devin_sessions SET acus_consumed = 3.625 WHERE id = 'collected'`;
        yield* migrate(db, { migrationsFolder });
        assert.deepEqual(
          yield* sql`SELECT * FROM devin_sessions ORDER BY id`,
          after.map((row) =>
            row.id === "collected" ? { ...row, acus_consumed: 3.625 } : row
          ),
        );
      }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
    );
  } finally {
    client.close();
    await Deno.remove(folder, { recursive: true });
  }
});
