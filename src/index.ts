import { ConfigProvider, Effect, Layer } from "effect";
import { createApp } from "./app.ts";
import { DatabaseClient } from "./database.ts";
import { EventHandler } from "./event_handler.ts";

if (import.meta.main) {
  const env = {
    DEVIN_API_KEY: Deno.env.get("DEVIN_API_KEY"),
    DEVIN_ORGANIZATION_ID: Deno.env.get("DEVIN_ORGANIZATION_ID"),
    GITHUB_WEBHOOK_SECRET: Deno.env.get("GITHUB_WEBHOOK_SECRET"),
    SQLITE_DB_FILEPATH: Deno.env.get("SQLITE_DB_FILEPATH"),
  };
  const ConfigLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env));
  const AppLive = EventHandler.layer.pipe(
    Layer.provide(DatabaseClient.layer),
    Layer.provide(ConfigLive),
  );
  const program = Effect.gen(function* () {
    const app = yield* createApp;
    const controller = new AbortController();
    const shutdown = () => controller.abort();
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => {
        Deno.addSignalListener("SIGINT", shutdown);
        Deno.addSignalListener("SIGTERM", shutdown);
        return Deno.serve(
          { port: 8000, signal: controller.signal },
          (request) => app.fetch(request),
        );
      }),
      () =>
        Effect.sync(() => {
          Deno.removeSignalListener("SIGINT", shutdown);
          Deno.removeSignalListener("SIGTERM", shutdown);
        }),
    );
    yield* Effect.promise(() => server.finished);
  });
  await Effect.runPromise(program.pipe(Effect.provide(AppLive), Effect.scoped));
}
