import { strict as assert } from "node:assert";
import { ConfigProvider, Effect } from "effect";
import { type AppDatabase, DatabaseClient } from "./database.ts";

Deno.test("DatabaseClient.layerWithPath migrates, persists, and closes without application secrets", async () => {
  const folder = await Deno.makeTempDir();
  const path = `${folder}/local.sqlite`;
  let closed: AppDatabase | undefined;
  const run = <A, E>(effect: Effect.Effect<A, E, DatabaseClient>) =>
    Effect.runPromise(effect.pipe(
      Effect.provide(DatabaseClient.layerWithPath(path)),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ));
  try {
    await run(DatabaseClient.use(({ db }) =>
      Effect.gen(function* () {
        closed = db;
        assert.deepEqual(yield* db.$client.unsafe("PRAGMA foreign_keys"), [{
          foreign_keys: 1,
        }]);
        yield* db.$client.unsafe(
          "CREATE TABLE local_probe (value TEXT NOT NULL)",
        );
        yield* db.$client.unsafe(
          "INSERT INTO local_probe VALUES ('persisted')",
        );
        const tables = yield* db.$client.unsafe(
          "SELECT name FROM sqlite_master WHERE name = 'devin_sessions'",
        );
        assert.equal(tables.length, 1);
      })
    ));
    assert.ok(closed);
    const result = await Effect.runPromise(
      closed.$client.unsafe("SELECT 1").pipe(Effect.result),
    );
    assert.equal(result._tag, "Failure");
    await run(DatabaseClient.use(({ db }) =>
      Effect.gen(function* () {
        const rows = yield* db.$client.unsafe("SELECT value FROM local_probe");
        assert.deepEqual(rows, [{ value: "persisted" }]);
        assert.deepEqual(
          yield* db.$client.unsafe("PRAGMA foreign_key_check"),
          [],
        );
      })
    ));
  } finally {
    await Deno.remove(folder, { recursive: true });
  }
});
