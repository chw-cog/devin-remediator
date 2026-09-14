import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { getTableConfig, SQLiteDialect } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { attentionNotifications } from "./schemas.ts";

Deno.test("startup migration preserves historical notifications, receipts, leases and schema without backfill", async () => {
  const directory = await Deno.makeTempDir();
  const client = createClient({ url: `file:${directory}/baseline.sqlite` });
  try {
    for (
      const name of [
        "20260913135033_initial",
        "20260913194128_fix_proposed_outcome",
        "20260913205455_session_outputs",
        "20260913212818_passive_lifecycle",
        "20260913224511_remarkable_demogoblin",
        "20260914000253_session_acus_analysis_generation",
        "20260914000730_session_reconciliation",
      ]
    ) {
      await Deno.mkdir(`${directory}/${name}`);
      await Deno.copyFile(
        new URL(`../migrations/${name}/migration.sql`, import.meta.url),
        `${directory}/${name}/migration.sql`,
      );
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* LibsqlClient.make({ liveClient: client });
        const db = yield* Drizzle.makeWithDefaults().pipe(
          Effect.provideService(LibsqlClient.LibsqlClient, sql),
        );
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(db, { migrationsFolder: directory });
        for (const id of ["waiting", "completed"]) {
          yield* sql`INSERT INTO github_webhook_deliveries (id, delivery_id, event_name, repo, issue_number, payload, inserted_at) VALUES (${id}, ${id}, 'issues', 'owner/repo', 42, 'PRIVATE payload', 'old')`;
          yield* sql`INSERT INTO devin_sessions (id, github_delivery_id, status, devin_session_id, session_url, provider_lifecycle, outputs, inserted_at, updated_at) VALUES (${id}, ${id}, 'submitted', ${id}, ${`https://app.devin.ai/sessions/${id}`}, ${
            id === "waiting" ? "needs_input" : "completed"
          }, '[{"outcome":"needs_human","summary":"PRIVATE retained"}]', 'old', 'old')`;
        }
        for (
          const [index, status] of [
            "pending",
            "delivered",
            "cancelled",
            "blocked",
            "pending",
          ].entries()
        ) {
          yield* sql`INSERT INTO attention_notifications (id, session_record_id, sequence, reason, repo, issue_number, remote_id, session_url, closed_at, status, due_at, version, lease_until, attempts, body, expected_app_id, expected_installation_id, possible_send_at, scan_page, scan_matches, scan_unverified, comment_id, negative_scans, last_failure) VALUES (${`notice-${index}`}, 'waiting', ${
            index + 1
          }, ${
            index % 2 === 0 ? "needs_input" : "needs_approval"
          }, 'owner/repo', 42, 'waiting', 'https://app.devin.ai/sessions/waiting', ${
            index === 2 ? 100 : null
          }, ${status}, 700, 8, 999, 3, ${
            index === 0
              ? null
              : `PRIVATE body <!-- devin-attention:notice-${index} -->`
          }, ${index === 0 ? null : 101}, ${index === 0 ? null : 202}, ${
            index === 0 ? null : 1
          }, 3, 1, 1, ${index === 0 ? null : 900 + index}, 2, ${
            index === 3 ? "unverified_attribution" : null
          })`;
        }
        yield* sql`UPDATE github_notification_gate SET version = 7, lease_until = 800, next_request_at = 900, next_report_at = 1000`;
        const sessions = yield* sql`SELECT * FROM devin_sessions ORDER BY id`;
        const deliveries =
          yield* sql`SELECT * FROM github_webhook_deliveries ORDER BY id`;
        const notifications =
          yield* sql`SELECT * FROM attention_notifications ORDER BY id`;
        const gate = yield* sql`SELECT * FROM github_notification_gate`;
        const columns = yield* sql`PRAGMA table_info(attention_notifications)`;
        const indexes =
          yield* sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attention_notifications' ORDER BY name`;
        const foreignKeys =
          yield* sql`PRAGMA foreign_key_list(attention_notifications)`;
        const migrationsFolder = fileURLToPath(
          new URL("../migrations", import.meta.url),
        );
        for (let run = 0; run < 2; run++) {
          yield* migrate(db, { migrationsFolder });
          assert.deepEqual(
            yield* sql`SELECT * FROM attention_notifications ORDER BY id`,
            notifications,
          );
          assert.deepEqual(
            yield* sql`SELECT * FROM devin_sessions ORDER BY id`,
            sessions.map((row) => ({
              ...row,
              next_submission_at: "1970-01-01T00:00:00.000Z",
              observation_requested: 0,
            })),
          );
          assert.deepEqual(
            yield* sql`SELECT * FROM github_webhook_deliveries ORDER BY id`,
            deliveries,
          );
          assert.deepEqual(
            yield* sql`SELECT * FROM github_notification_gate`,
            gate,
          );
          assert.deepEqual(
            yield* sql`PRAGMA table_info(attention_notifications)`,
            columns,
          );
          assert.deepEqual(
            yield* sql`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'attention_notifications' ORDER BY name`,
            indexes,
          );
          assert.deepEqual(
            yield* sql`PRAGMA foreign_key_list(attention_notifications)`,
            foreignKeys,
          );
          assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
          assert.equal((yield* sql`PRAGMA foreign_keys`)[0].foreign_keys, 1);
        }
        const table = getTableConfig(attentionNotifications);
        assert.deepEqual(
          columns.map((column) => ({
            name: column.name,
            type: column.type,
            notNull: column.notnull,
            primary: column.pk,
          })),
          table.columns.map((column) => ({
            name: column.name,
            type: column.getSQLType().toUpperCase(),
            notNull: Number(column.notNull),
            primary: Number(column.primary),
          })),
        );
        const [definition] =
          yield* sql`SELECT sql FROM sqlite_master WHERE name = 'attention_notifications'`;
        const normalize = (value: string) =>
          value.replaceAll("`", '"').replaceAll(
            '"attention_notifications".',
            "",
          ).replace(/\s+/g, "");
        const dialect = new SQLiteDialect();
        for (const check of table.checks) {
          assert.ok(
            normalize(String(definition.sql)).includes(normalize(
              `CONSTRAINT "${check.name}" CHECK(${
                dialect.sqlToQuery(check.value).sql
              })`,
            )),
            check.name,
          );
        }
        const start = {
          id: "startup",
          sessionRecordId: "completed",
          sequence: 0,
          reason: "session_started" as const,
          repo: "owner/repo",
          remoteId: "completed",
          sessionUrl: "https://app.devin.ai/sessions/completed",
        };
        yield* db.insert(attentionNotifications).values(start);
        assert.equal(
          (yield* sql`SELECT COUNT(*) AS count FROM attention_notifications WHERE reason = 'session_started'`)[
            0
          ].count,
          1,
        );
        for (
          const invalid of [
            { ...start, id: "duplicate" },
            { ...start, id: "start-positive", sequence: 6 },
            {
              ...start,
              id: "attention-zero",
              sessionRecordId: "waiting",
              reason: "needs_input" as const,
            },
            { ...start, id: "start-negative", sequence: -1 },
            { ...start, id: "orphan", sessionRecordId: "missing" },
          ]
        ) {
          assert.equal(
            (yield* db.insert(attentionNotifications).values(invalid).pipe(
              Effect.result,
            ))._tag,
            "Failure",
            invalid.id,
          );
        }
        for (
          const invalid of [
            sql`INSERT INTO attention_notifications (id, session_record_id, sequence, reason, repo) VALUES (NULL, 'waiting', 6, 'needs_input', 'owner/repo')`,
            sql`UPDATE attention_notifications SET reason = 'other' WHERE id = 'startup'`,
            sql`UPDATE attention_notifications SET status = 'delivered', comment_id = NULL WHERE id = 'startup'`,
            sql`UPDATE attention_notifications SET possible_send_at = 1 WHERE id = 'startup'`,
            sql`UPDATE attention_notifications SET negative_scans = 3 WHERE id = 'startup'`,
            sql`UPDATE attention_notifications SET sequence = 0 WHERE id = 'notice-0'`,
          ]
        ) {
          assert.equal((yield* invalid.pipe(Effect.result))._tag, "Failure");
        }
        yield* db.insert(attentionNotifications).values({
          ...start,
          id: "next-episode",
          sessionRecordId: "waiting",
          sequence: 6,
          reason: "needs_input",
        });
        assert.deepEqual(
          yield* sql`SELECT * FROM attention_notifications WHERE id LIKE 'notice-%' ORDER BY id`,
          notifications,
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
      }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
    );
  } finally {
    client.close();
    await Deno.remove(directory, { recursive: true });
  }
});
