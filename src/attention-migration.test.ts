import { strict as assert } from "node:assert";
import { createClient } from "@libsql/client";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { Effect } from "effect";
import { Reactivity } from "effect/unstable/reactivity";

Deno.test("attention upgrade backfills both current waits once without changing lifecycle, output, capacity or analysis", async () => {
  const folder = await Deno.makeTempDir();
  const client = createClient({ url: "file::memory:" });
  try {
    for (
      const name of [
        "20260913135033_initial",
        "20260913194128_fix_proposed_outcome",
        "20260913205455_session_outputs",
        "20260913212818_passive_lifecycle",
      ]
    ) {
      await Deno.mkdir(`${folder}/${name}`);
      await Deno.copyFile(
        new URL(`../migrations/${name}/migration.sql`, import.meta.url),
        `${folder}/${name}/migration.sql`,
      );
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* LibsqlClient.make({ liveClient: client });
        const db = yield* Drizzle.makeWithDefaults().pipe(
          Effect.provideService(LibsqlClient.LibsqlClient, sql),
        );
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(db, { migrationsFolder: folder });
        for (
          const [index, lifecycle] of [
            "needs_input",
            "needs_approval",
            "active",
            "completed",
            "closed",
          ].entries()
        ) {
          const id = `old-${index}`;
          yield* sql`INSERT INTO github_webhook_deliveries (id, delivery_id, event_name, repo, issue_number, payload, inserted_at) VALUES (${id}, ${id}, 'issues', 'owner/repo', 42, '{}', 'old')`;
          yield* sql`INSERT INTO devin_sessions (id, github_delivery_id, status, provider_lifecycle, active_work, devin_session_id, session_url, outputs, pr_number, analysis, analysis_status, inserted_at, updated_at) VALUES (${id}, ${id}, 'submitted', ${lifecycle}, 0, ${id}, ${`https://app.devin.ai/sessions/${id}`}, '[{"outcome":"needs_human","summary":"PRIVATE retained"}]', 8, '{"retained":true}', 'collected', 'old', 'old')`;
        }
        const before = yield* sql`SELECT * FROM devin_sessions ORDER BY id`;
        // Isolate this upgrade from later additive session migrations.
        const migrationsFolder = folder;
        yield* Effect.promise(async () => {
          const name = "20260913224511_remarkable_demogoblin";
          await Deno.mkdir(`${folder}/${name}`);
          await Deno.copyFile(
            new URL(`../migrations/${name}/migration.sql`, import.meta.url),
            `${folder}/${name}/migration.sql`,
          );
        });
        yield* migrate(db, { migrationsFolder });
        assert.deepEqual(
          yield* sql`SELECT * FROM devin_sessions ORDER BY id`,
          before,
        );
        const episodes =
          yield* sql`SELECT * FROM attention_notifications ORDER BY session_record_id`;
        assert.deepEqual(episodes.map((row) => row.reason), [
          "needs_input",
          "needs_approval",
        ]);
        assert.deepEqual(episodes.map((row) => row.sequence), [1, 1]);
        assert.ok(
          episodes.every((row) =>
            row.status === "pending" && row.body === null &&
            row.possible_send_at === null
          ),
        );
        assert.ok(
          episodes.every((row) =>
            row.session_url === `https://app.devin.ai/sessions/${row.remote_id}`
          ),
        );
        yield* migrate(db, { migrationsFolder });
        assert.deepEqual(
          yield* sql`SELECT * FROM attention_notifications ORDER BY session_record_id`,
          episodes,
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        const invalidFlight =
          yield* sql`UPDATE attention_notifications SET possible_send_at = 1, body = 'invalid', expected_app_id = NULL`
            .pipe(Effect.result);
        assert.equal(invalidFlight._tag, "Failure");
        const invalidReceipt =
          yield* sql`UPDATE attention_notifications SET status = 'delivered', comment_id = NULL`
            .pipe(Effect.result);
        assert.equal(invalidReceipt._tag, "Failure");
      }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
    );
  } finally {
    client.close();
    await Deno.remove(folder, { recursive: true });
  }
});
