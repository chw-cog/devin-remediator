import { fileURLToPath, pathToFileURL } from "node:url";
import { LibsqlClient } from "@effect/sql-libsql";
import { createClient } from "@libsql/client";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { Context, Effect, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { AppConfig } from "./config.ts";

export type AppDatabase = Effect.Success<
  ReturnType<typeof Drizzle.makeWithDefaults>
>;

export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  { cause: Schema.Defect() },
) {}

export class DatabaseClient extends Context.Service<DatabaseClient, {
  readonly db: AppDatabase;
}>()("devin-remediator/DatabaseClient") {
  static readonly layer = Layer.effect(
    DatabaseClient,
    Effect.gen(function* () {
      const { sqliteDbFilepath } = yield* AppConfig;
      const sqlite = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            createClient({
              url: sqliteDbFilepath === ":memory:"
                ? "file::memory:"
                : pathToFileURL(sqliteDbFilepath).href,
            }),
          catch: (cause) => new DatabaseError({ cause }),
        }),
        (sqlite) => Effect.sync(() => sqlite.close()),
      );
      const client = yield* LibsqlClient.make({ liveClient: sqlite });
      const db = yield* Drizzle.makeWithDefaults().pipe(
        Effect.provideService(LibsqlClient.LibsqlClient, client),
      );
      yield* Effect.gen(function* () {
        yield* client`PRAGMA foreign_keys = ON`;
        yield* client`PRAGMA journal_mode = WAL`;
        yield* client`PRAGMA busy_timeout = 5000`;
        yield* migrate(db, {
          migrationsFolder: fileURLToPath(
            new URL("../migrations", import.meta.url),
          ),
        });
      }).pipe(Effect.mapError((cause) => new DatabaseError({ cause })));

      return DatabaseClient.of({ db });
    }),
  ).pipe(Layer.provide(Reactivity.layer));
}
