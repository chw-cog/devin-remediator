import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LibsqlClient } from "@effect/sql-libsql";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Reactivity } from "effect/unstable/reactivity";
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
        yield* db.update(devinSessions).set({ status });
        assert.equal(
          (yield* db.select().from(devinSessions).get())?.status,
          status,
        );
      }
    }),
);

databaseTest(
  "reapplying migrations preserves existing data",
  (db) =>
    Effect.gen(function* () {
      yield* db.insert(githubWebhookDeliveries).values(delivery);
      yield* db.insert(devinSessions).values({
        id: "session-row",
        githubDeliveryId: "github-1",
        status: "pending",
        insertedAt,
        updatedAt: insertedAt,
      });
      const deliveries = yield* db.select().from(githubWebhookDeliveries);
      const sessions = yield* db.select().from(devinSessions);
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

Deno.test("forward migration preserves populated old jobs and enforces constraints with skipped enabled", async () => {
  const directory = await Deno.makeTempDir();
  const filepath = `${directory}/upgrade.sqlite`;
  const historical = "20260913080724_webhook_queue";
  const migrationsFolder = `${directory}/migrations`;
  try {
    await Deno.mkdir(`${migrationsFolder}/${historical}`, { recursive: true });
    await Deno.copyFile(
      new URL(`../migrations/${historical}/migration.sql`, import.meta.url),
      `${migrationsFolder}/${historical}/migration.sql`,
    );
    const sqlite = createClient({ url: pathToFileURL(filepath).href });
    const before = await (async () => {
      try {
        return await Effect.runPromise(
          Effect.gen(function* () {
            const client = yield* LibsqlClient.make({ liveClient: sqlite });
            const db = yield* Drizzle.makeWithDefaults().pipe(
              Effect.provideService(LibsqlClient.LibsqlClient, client),
            );
            yield* client`PRAGMA foreign_keys = ON`;
            yield* migrate(db, { migrationsFolder });
            for (
              const [index, status] of [
                "pending",
                "submitting",
                "running",
                "succeeded",
                "failed",
              ].entries()
            ) {
              yield* db.insert(githubWebhookDeliveries).values({
                ...delivery,
                id: `old-delivery-${index}`,
                deliveryId: `old-github-${index}`,
                issueNumber: 42,
                payload: `{"old":${index}}`,
              });
              yield* db.$client.unsafe(
                `INSERT INTO devin_sessions
              (id, github_delivery_id, status, devin_session_id, pr_number,
               attempts, inserted_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  `old-session-${index}`,
                  `old-github-${index}`,
                  status,
                  index >= 2 ? `old-remote-${index}` : null,
                  status === "succeeded" ? 99 : null,
                  index,
                  insertedAt,
                  "2026-02-01T00:00:00.000Z",
                ],
              );
            }
            yield* assertSqlFailure(
              db.$client`UPDATE devin_sessions SET status = 'skipped'`,
              /CHECK constraint failed/,
            );
            return {
              deliveries: yield* db.select().from(githubWebhookDeliveries),
              sessions: yield* db.select().from(devinSessions),
            };
          }).pipe(Effect.scoped, Effect.provide(Reactivity.layer)),
        );
      } finally {
        sqlite.close();
      }
    })();
    const upgrade = DatabaseClient.layer.pipe(Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({
        DEVIN_API_KEY: "test-key",
        DEVIN_ORGANIZATION_ID: "org-test",
        GITHUB_WEBHOOK_SECRET: "test-secret",
        SQLITE_DB_FILEPATH: filepath,
      })),
    ));
    await Effect.runPromise(
      DatabaseClient.use(({ db }) =>
        Effect.gen(function* () {
          assert.deepEqual(
            yield* db.select().from(githubWebhookDeliveries),
            before.deliveries,
          );
          assert.deepEqual(
            yield* db.select().from(devinSessions),
            before.sessions,
          );
          yield* db
            .$client`UPDATE devin_sessions SET status = 'skipped' WHERE id = 'old-session-0'`;
          const skipped = yield* db.select().from(devinSessions).where(
            eq(devinSessions.id, "old-session-0"),
          ).get();
          assert.equal(skipped?.status, "skipped");
          assert.equal(skipped?.devinSessionId, null);
          assert.equal(skipped?.attempts, 0);
          for (
            const [statement, message] of [
              [
                "UPDATE devin_sessions SET github_delivery_id = 'missing' WHERE id = 'old-session-0'",
                /FOREIGN KEY constraint failed/,
              ],
              [
                "UPDATE devin_sessions SET github_delivery_id = 'old-github-1' WHERE id = 'old-session-0'",
                /UNIQUE constraint failed/,
              ],
              [
                "UPDATE devin_sessions SET devin_session_id = 'old-remote-2' WHERE id = 'old-session-0'",
                /UNIQUE constraint failed/,
              ],
              [
                "UPDATE devin_sessions SET status = 'unknown'",
                /CHECK constraint failed/,
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
                "DELETE FROM github_webhook_deliveries",
                /FOREIGN KEY constraint failed/,
              ],
            ] as const
          ) {
            yield* assertSqlFailure(db.$client.unsafe(statement), message);
          }
          const upgraded = yield* db.select().from(devinSessions);
          yield* migrate(db, {
            migrationsFolder: fileURLToPath(
              new URL("../migrations", import.meta.url),
            ),
          });
          assert.deepEqual(yield* db.select().from(devinSessions), upgraded);
          assert.deepEqual(yield* db.$client`PRAGMA foreign_key_check`, []);
        })
      ).pipe(Effect.provide(upgrade)),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
