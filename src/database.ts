import { fileURLToPath, pathToFileURL } from "node:url";
import { LibsqlClient } from "@effect/sql-libsql";
import { createClient } from "@libsql/client";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { Context, Effect, Layer, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { AppConfig } from "./config.ts";
import { causeFields, observe } from "./logging.ts";

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
  static layerWithPath(sqliteDbFilepath: string) {
    return Layer.effect(
      DatabaseClient,
      Effect.gen(function* () {
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
        }).pipe(
          Effect.mapError((cause) => new DatabaseError({ cause })),
          observe("DatabaseClient", "migrate"),
        );

        yield* Effect.logInfo("database.ready").pipe(Effect.annotateLogs({
          storage: sqliteDbFilepath === ":memory:" ? "memory" : "file",
        }));
        return DatabaseClient.of({ db });
      }).pipe(
        Effect.tapCause((cause) =>
          Effect.logError("database.initialization_failed").pipe(
            Effect.annotateLogs(causeFields(cause)),
          )
        ),
        observe("DatabaseClient", "initialize"),
      ),
    ).pipe(Layer.provide(Reactivity.layer));
  }

  static readonly layer = Layer.unwrap(
    AppConfig.pipe(
      Effect.map(({ sqliteDbFilepath }) =>
        DatabaseClient.layerWithPath(sqliteDbFilepath)
      ),
    ),
  );
}
