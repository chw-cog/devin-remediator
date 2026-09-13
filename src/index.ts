import * as DenoRuntime from "@effect/platform-deno/DenoRuntime";
import { ConfigProvider, Effect, Layer } from "effect";
import { createApp } from "./app.ts";
import { LoggingLive } from "./logging.ts";
import { DatabaseClient } from "./database.ts";
import { DevinClient } from "./devin.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { WebhookDeliveryHandler } from "./webhook-delivery-handler.ts";
import { WebhookEventProcessors } from "./webhook-event-processors.ts";

export const AppLive = Layer.merge(
  WebhookDeliveryHandler.layer,
  DevinSessionOrchestrator.layer.pipe(
    Layer.provide(DevinSessionRepository.layer),
    Layer.provide(DevinClient.layer),
    Layer.provide(WebhookEventProcessors.layer),
  ),
).pipe(Layer.provide(DatabaseClient.layer));

export const runApplication = (
  options: Deno.ServeTcpOptions = { port: 8000 },
) =>
  Effect.scoped(Effect.gen(function* () {
    const app = yield* createApp;
    const orchestrator = yield* DevinSessionOrchestrator;
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => Deno.serve(options, (request) => app.fetch(request))),
      (server) =>
        Effect.promise(() => server.shutdown()).pipe(
          Effect.andThen(Effect.logInfo("application.stopped")),
        ),
    );
    yield* Effect.logInfo("application.started").pipe(Effect.annotateLogs({
      port: server.addr.port,
    }));
    yield* orchestrator.run.pipe(Effect.forkScoped);
    yield* Effect.promise(() => server.finished);
  })).pipe(Effect.annotateLogs({ component: "Application" }));

if (import.meta.main) {
  const env = {
    LOG_LEVEL: Deno.env.get("LOG_LEVEL"),
    DEVIN_API_KEY: Deno.env.get("DEVIN_API_KEY"),
    DEVIN_ORGANIZATION_ID: Deno.env.get("DEVIN_ORGANIZATION_ID"),
    DEVIN_MAX_CONCURRENT_SESSIONS: Deno.env.get(
      "DEVIN_MAX_CONCURRENT_SESSIONS",
    ),
    DEVIN_MAX_ATTEMPTS: Deno.env.get("DEVIN_MAX_ATTEMPTS"),
    DEVIN_ORCHESTRATOR_INTERVAL_MS: Deno.env.get(
      "DEVIN_ORCHESTRATOR_INTERVAL_MS",
    ),
    DEVIN_SUBMITTING_TIMEOUT_SECONDS: Deno.env.get(
      "DEVIN_SUBMITTING_TIMEOUT_SECONDS",
    ),
    GITHUB_WEBHOOK_SECRET: Deno.env.get("GITHUB_WEBHOOK_SECRET"),
    SQLITE_DB_FILEPATH: Deno.env.get("SQLITE_DB_FILEPATH"),
  };
  const ConfigLive = ConfigProvider.layer(ConfigProvider.fromUnknown(env));
  DenoRuntime.runMain(
    runApplication().pipe(
      Effect.provide(AppLive),
      Effect.provide(LoggingLive),
      Effect.provide(ConfigLive),
      Effect.annotateLogs({ service: "devin-remediator" }),
    ),
  );
}
