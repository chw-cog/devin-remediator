import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import * as LibsqlClient from "@effect/sql-libsql/LibsqlClient";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { type AppDatabase, DatabaseClient } from "./database.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";

const TestLive = DatabaseClient.layer.pipe(Layer.provide(
  ConfigProvider.layer(ConfigProvider.fromUnknown({
    DEVIN_API_KEY: "cog_test-key",
    DEVIN_ORGANIZATION_ID: "org-test",
    GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
    SQLITE_DB_FILEPATH: ":memory:",
  })),
));
const insertedAt = "2026-01-01T00:00:00.000Z";
const delivery = {
  id: "delivery-row",
  deliveryId: "github-1",
  eventName: "push",
  repo: "owner/repo",
  payload: "{}",
  insertedAt,
};

function databaseTest(
  name: string,
  test: (db: AppDatabase) => Effect.Effect<void, unknown>,
) {
  Deno.test(name, () =>
    Effect.runPromise(
      DatabaseClient.use(({ db }) => test(db)).pipe(Effect.provide(TestLive)),
    ));
}

const assertSqlFailure = Effect.fnUntraced(function* (
  query: Effect.Effect<unknown, SqlError>,
  message: RegExp,
) {
  const result = yield* query.pipe(Effect.result);
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure.reason.cause instanceof Error);
  assert.match(result.failure.reason.cause.message, message);
});

databaseTest(
  "analysis constraints require a JSON object exactly when collected",
  (db) =>
    Effect.gen(function* () {
      yield* db.insert(githubWebhookDeliveries).values(delivery);
      yield* db.insert(devinSessions).values({
        id: "analysis-row",
        githubDeliveryId: delivery.deliveryId,
        status: "succeeded",
        output: { outcome: "fix_proposed", summary: "Verified." },
        devinSessionId: "devin-analysis",
        insertedAt,
        updatedAt: insertedAt,
      });
      for (
        const statement of [
          "UPDATE devin_sessions SET analysis_status = 'unknown'",
          "UPDATE devin_sessions SET analysis_attempts = -1",
          "UPDATE devin_sessions SET analysis_status = 'collected'",
          "UPDATE devin_sessions SET analysis = '{}'",
          "UPDATE devin_sessions SET analysis_status = 'collected', analysis = '[]'",
          "UPDATE devin_sessions SET analysis_status = 'collected', analysis = 'invalid'",
        ]
      ) {
        yield* assertSqlFailure(
          db.$client.unsafe(statement),
          /CHECK constraint failed/,
        );
      }
      yield* db.update(devinSessions).set({
        analysisStatus: "collected",
        analysis: { timeline: [], future_field: { preserved: true } },
      });
      const saved = yield* db.select().from(devinSessions).get();
      assert.deepEqual(saved?.analysis, {
        timeline: [],
        future_field: { preserved: true },
      });
      assert.deepEqual(saved?.output, {
        outcome: "fix_proposed",
        summary: "Verified.",
      });
    }),
);

databaseTest(
  "migrations enforce foreign keys, uniqueness, nullability, defaults, and checks",
  (db) =>
    Effect.gen(function* () {
      yield* db.insert(githubWebhookDeliveries).values([
        delivery,
        { ...delivery, id: "delivery-row-2", deliveryId: "github-2" },
      ]);
      const insertSession = (
        id: string | null,
        deliveryId: string | null,
        status: string,
      ) =>
        db.$client.unsafe(
          `INSERT INTO devin_sessions
          (id, github_delivery_id, status, inserted_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`,
          [id, deliveryId, status, insertedAt, insertedAt],
        );
      yield* assertSqlFailure(
        insertSession("orphan", "missing", "pending"),
        /FOREIGN KEY constraint failed/,
      );
      yield* assertSqlFailure(
        insertSession("bad-status", "github-1", "unknown"),
        /CHECK constraint failed/,
      );
      yield* assertSqlFailure(
        insertSession(null, "github-1", "pending"),
        /NOT NULL constraint failed/,
      );
      yield* assertSqlFailure(
        insertSession("null-fk", null, "pending"),
        /NOT NULL constraint failed/,
      );
      yield* insertSession("session-1", "github-1", "pending");
      yield* insertSession("session-2", "github-2", "pending");
      const sessions = yield* db.select().from(devinSessions);
      assert.deepEqual(
        sessions.map((row) => ({
          attempts: row.attempts,
          prNumber: row.prNumber,
          devinSessionId: row.devinSessionId,
        })),
        [
          { attempts: 0, prNumber: null, devinSessionId: null },
          { attempts: 0, prNumber: null, devinSessionId: null },
        ],
      );
      yield* assertSqlFailure(
        insertSession("duplicate", "github-1", "pending"),
        /UNIQUE constraint failed/,
      );
      for (
        const [statement, error] of [
          [
            "UPDATE github_webhook_deliveries SET delivery_id = 'github-1'",
            /UNIQUE constraint failed/,
          ],
          [
            "UPDATE github_webhook_deliveries SET delivery_id = NULL",
            /NOT NULL constraint failed/,
          ],
          [
            "UPDATE github_webhook_deliveries SET id = NULL",
            /NOT NULL constraint failed/,
          ],
          [
            "UPDATE devin_sessions SET attempts = -1",
            /CHECK constraint failed/,
          ],
          [
            "UPDATE devin_sessions SET inserted_at = NULL",
            /NOT NULL constraint failed/,
          ],
          [
            "UPDATE devin_sessions SET updated_at = NULL",
            /NOT NULL constraint failed/,
          ],
          [
            "UPDATE devin_sessions SET devin_session_id = 'devin-1'",
            /UNIQUE constraint failed/,
          ],
          [
            "DELETE FROM github_webhook_deliveries",
            /FOREIGN KEY constraint failed/,
          ],
        ] as const
      ) {
        yield* assertSqlFailure(db.$client.unsafe(statement), error);
      }
      for (
        const status of [
          "submitting",
          "running",
          "succeeded",
          "failed",
          "skipped",
        ] as const
      ) {
        yield* db.update(devinSessions).set({
          status,
          output: status === "succeeded" || status === "failed"
            ? { outcome: "failed", summary: "Remediation failed." }
            : null,
        });
        assert.equal(
          (yield* db.select().from(devinSessions).get())?.status,
          status,
        );
      }
    }),
);

databaseTest(
  "output is a JSON result exactly for succeeded and failed rows",
  (db) =>
    Effect.gen(function* () {
      yield* db.insert(githubWebhookDeliveries).values(delivery);
      yield* db.insert(devinSessions).values({
        id: "outcome-row",
        githubDeliveryId: delivery.deliveryId,
        status: "pending",
        insertedAt,
        updatedAt: insertedAt,
      });
      for (
        const status of [
          "pending",
          "submitting",
          "running",
          "succeeded",
          "failed",
          "skipped",
        ]
      ) {
        for (
          const outcome of [
            null,
            "fix_proposed",
            "needs_human",
            "not_reproducible",
            "failed",
            "already_resolved",
            "invalid",
          ]
        ) {
          const output = outcome === null ? null : {
            outcome,
            summary: "Investigation complete.",
          };
          const update = db.$client.unsafe(
            "UPDATE devin_sessions SET status = ?, output = ? WHERE id = ?",
            [
              status,
              output === null ? null : JSON.stringify(output),
              "outcome-row",
            ],
          );
          const terminal = status === "succeeded" || status === "failed";
          const valid = terminal
            ? outcome !== null && outcome !== "invalid"
            : outcome === null;
          if (valid) {
            yield* update;
            const saved = yield* db.select().from(devinSessions).get();
            assert.equal(saved?.status, status);
            assert.deepEqual(saved?.output, output);
          } else {
            yield* assertSqlFailure(update, /CHECK constraint failed/);
          }
        }
      }
      for (
        const output of [
          "invalid json",
          "null",
          "[]",
          '"fix_proposed"',
          "{}",
          '{"outcome":"fix_proposed"}',
          '{"summary":"Result"}',
          '{"outcome":null,"summary":"Result"}',
          '{"outcome":"fix_proposed","summary":null}',
          '{"outcome":"fix_proposed","summary":42}',
          '{"outcome":"fix_proposed","summary":""}',
          '{"outcome":"fix_proposed","summary":" "}',
          '{"outcome":"fixed","summary":"Legacy outcome"}',
        ]
      ) {
        yield* assertSqlFailure(
          db.$client.unsafe(
            "UPDATE devin_sessions SET status = 'succeeded', output = ?",
            [output],
          ),
          /CHECK constraint failed/,
        );
      }
      yield* assertSqlFailure(
        db.$client`UPDATE devin_sessions SET status = NULL`,
        /NOT NULL constraint failed/,
      );
    }),
);

databaseTest(
  "reapplying migrations preserves results, analyses, and recovery state",
  (db) =>
    Effect.gen(function* () {
      const cases = [
        ["pending", null],
        ["submitting", null],
        ["running", null],
        ["skipped", null],
        ["succeeded", "fix_proposed"],
        ["succeeded", "needs_human"],
        ["succeeded", "not_reproducible"],
        ["succeeded", "already_resolved"],
        ["failed", "failed"],
      ] as const;
      for (const [index, [status, outcome]] of cases.entries()) {
        const deliveryId = `github-${index}`;
        yield* db.insert(githubWebhookDeliveries).values({
          ...delivery,
          id: `delivery-${index}`,
          deliveryId,
        });
        const output = outcome === null ? null : {
          outcome,
          summary: "Recorded remediation result.",
          verification: {
            status: "partial" as const,
            evidence: ["Unit tests passed; integration credentials missing."],
          },
          blocker: "Integration credentials missing",
          next_action: "Maintainer to run integration tests",
          confidence: 0.6,
        };
        yield* db.insert(devinSessions).values({
          id: `session-${index}`,
          githubDeliveryId: deliveryId,
          status,
          output,
          analysis: outcome === null
            ? null
            : { timeline: [], extra: { kept: true } },
          analysisStatus: outcome === null ? "pending" : "collected",
          analysisAttempts: 2,
          analysisNextAttemptAt: "2026-02-01T00:00:00.000Z",
          devinSessionId: `devin-${index}`,
          prNumber: index + 1,
          attempts: 3,
          claimVersion: 9,
          recoveryEmptyChecks: 2,
          recoveryBlocked: true,
          insertedAt,
          updatedAt: insertedAt,
        });
      }
      const deliveries = yield* db.select().from(githubWebhookDeliveries);
      const sessions = yield* db.select().from(devinSessions);
      assert.equal(sessions.length, cases.length);
      yield* migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL("../migrations", import.meta.url),
        ),
      });
      assert.deepEqual(
        yield* db.select().from(githubWebhookDeliveries),
        deliveries,
      );
      assert.deepEqual(yield* db.select().from(devinSessions), sessions);
      assert.deepEqual(yield* db.$client`PRAGMA foreign_key_check`, []);
      const columns = yield* db.$client`PRAGMA table_info(devin_sessions)`;
      assert.ok(columns.some((column) => column.name === "output"));
      assert.ok(!columns.some((column) => column.name === "outcome"));
    }),
);

databaseTest(
  "separate in-memory layers isolate their data",
  (db) =>
    Effect.gen(function* () {
      yield* db.insert(githubWebhookDeliveries).values(delivery);
      const otherRows = yield* DatabaseClient.use(({ db }) =>
        db.select().from(githubWebhookDeliveries)
      ).pipe(Effect.provide(Layer.fresh(TestLive)));
      assert.deepEqual(otherRows, []);
      assert.equal(
        (yield* db.select().from(githubWebhookDeliveries)).length,
        1,
      );
    }),
);

Deno.test("outcome migration renames legacy fixed results and preserves all other session data", async () => {
  const folder = await Deno.makeTempDir();
  const initial = "20260913135033_initial";
  const client = createClient({ url: "file::memory:" });
  try {
    await Deno.mkdir(`${folder}/${initial}`);
    await Deno.copyFile(
      new URL(`../migrations/${initial}/migration.sql`, import.meta.url),
      `${folder}/${initial}/migration.sql`,
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* LibsqlClient.make({ liveClient: client });
        const db = yield* Drizzle.makeWithDefaults().pipe(
          Effect.provideService(LibsqlClient.LibsqlClient, sql),
        );
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(db, { migrationsFolder: folder });
        const cases = [
          ["pending", null],
          ["submitting", null],
          ["running", null],
          ["skipped", null],
          ["succeeded", "fixed"],
          ["succeeded", "needs_human"],
          ["succeeded", "not_reproducible"],
          ["succeeded", "already_resolved"],
          ["failed", "failed"],
        ] as const;
        for (const [index, [status, outcome]] of cases.entries()) {
          const id = `legacy-${index}`;
          yield* db.insert(githubWebhookDeliveries).values({
            ...delivery,
            id,
            deliveryId: id,
          });
          yield* sql.unsafe(
            `INSERT INTO devin_sessions
              (id, github_delivery_id, status, output, analysis, analysis_status,
               analysis_attempts, analysis_next_attempt_at, analysis_reason,
               devin_session_id, pr_number, attempts, claim_version,
               recovery_empty_checks, recovery_blocked, inserted_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?, 42, 3, 9, 2, 1, ?, ?)`,
            [
              id,
              id,
              status,
              outcome === null ? null : JSON.stringify({
                outcome,
                summary: "The word fixed in evidence must stay fixed.",
                verification: {
                  status: "passed",
                  evidence: ["deno test: passed"],
                },
                blocker: null,
                next_action: "Maintainer: review and merge PR #42.",
                confidence: 0.9,
              }),
              outcome === null ? null : '{"timeline":[],"extra":{"kept":true}}',
              outcome === null ? "pending" : "collected",
              insertedAt,
              "Preserve analysis reason",
              `devin-${id}`,
              insertedAt,
              insertedAt,
            ],
          );
        }
        const before = yield* sql`SELECT * FROM devin_sessions ORDER BY id`;
        const deliveries = yield* db.select().from(githubWebhookDeliveries);
        const migrationsFolder = fileURLToPath(
          new URL("../migrations", import.meta.url),
        );
        yield* migrate(db, { migrationsFolder });
        const expected = before.map((row) => {
          if (typeof row.output !== "string") return row;
          const output = JSON.parse(row.output);
          return output.outcome === "fixed"
            ? {
              ...row,
              output: JSON.stringify({ ...output, outcome: "fix_proposed" }),
            }
            : row;
        });
        assert.deepEqual(
          yield* sql`SELECT * FROM devin_sessions ORDER BY id`,
          expected,
        );
        yield* migrate(db, { migrationsFolder });
        assert.deepEqual(
          yield* sql`SELECT * FROM devin_sessions ORDER BY id`,
          expected,
        );
        assert.deepEqual(
          yield* db.select().from(githubWebhookDeliveries),
          deliveries,
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.equal((yield* sql`PRAGMA foreign_keys`)[0].foreign_keys, 1);
      }).pipe(Effect.scoped, Effect.provide(Reactivity.layer)),
    );
  } finally {
    client.close();
    await Deno.remove(folder, { recursive: true });
  }
});

Deno.test("DatabaseClient.layer closes the connection after success", async () => {
  const db = await Effect.runPromise(
    DatabaseClient.use(({ db }) =>
      Effect.gen(function* () {
        assert.deepEqual(yield* db.select().from(githubWebhookDeliveries), []);
        return db;
      })
    ).pipe(Effect.provide(TestLive)),
  );
  const result = await Effect.runPromise(
    db.$client`SELECT 1`.pipe(Effect.result),
  );
  assert.ok(Result.isFailure(result));
  assert.ok(result.failure.reason.cause instanceof Error);
  assert.match(result.failure.reason.cause.message, /closed/i);
});

Deno.test("DatabaseClient.layer closes the connection after failure", async () => {
  let db: AppDatabase | undefined;
  const result = await Effect.runPromise(
    DatabaseClient.use((client) => {
      db = client.db;
      return Effect.fail("consumer failed");
    }).pipe(Effect.provide(TestLive), Effect.result),
  );
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure, "consumer failed");
  assert.ok(db);
  const after = await Effect.runPromise(
    db.$client`SELECT 1`.pipe(Effect.result),
  );
  assert.ok(Result.isFailure(after));
  assert.ok(after.failure.reason.cause instanceof Error);
  assert.match(after.failure.reason.cause.message, /closed/i);
});
