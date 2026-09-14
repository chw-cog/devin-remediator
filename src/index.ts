import * as DenoRuntime from "@effect/platform-deno/DenoRuntime";
import { ConfigProvider, Effect, Layer } from "effect";
import { createApp } from "./app.ts";
import { LoggingLive } from "./logging.ts";
import { DatabaseClient } from "./database.ts";
import { DevinClient } from "./devin.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { GitHubClient } from "./github.ts";
import { GitHubCommentNotifier } from "./github-comment-notifier.ts";
import { WebhookDeliveryHandler } from "./webhook-delivery-handler.ts";
import { WebhookEventProcessors } from "./webhook-event-processors.ts";
import { Metrics } from "./metrics.ts";

export const AppLive = Layer.mergeAll(
  WebhookDeliveryHandler.layer,
  Metrics.layer.pipe(Layer.provide(GitHubClient.metricsLayer)),
  DevinSessionOrchestrator.layer.pipe(
    Layer.provide(DevinSessionRepository.layer),
    Layer.provide(DevinClient.layer),
    Layer.provide(WebhookEventProcessors.layer),
    Layer.provide(GitHubCommentNotifier.layer),
  ),
).pipe(
  Layer.provide(GitHubClient.layer),
  Layer.provide(DatabaseClient.layer),
);

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

export const applicationEnvironment = (
  get: (name: string) => string | undefined,
) =>
  Object.fromEntries([
    "LOG_LEVEL",
    "DEVIN_API_KEY",
    "DEVIN_ORGANIZATION_ID",
    "DEVIN_MAX_SESSION_BUDGET",
    "DEVIN_MAX_CONCURRENT_SESSIONS",
    "DEVIN_MAX_ATTEMPTS",
    "DEVIN_ANALYSIS_MAX_ATTEMPTS",
    "DEVIN_RETAINED_POLL_INTERVAL_MS",
    "DEVIN_ORCHESTRATOR_INTERVAL_MS",
    "DEVIN_SUBMITTING_TIMEOUT_SECONDS",
    "GITHUB_WEBHOOK_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "DASHBOARD_REPOSITORY",
    "DASHBOARD_USERNAME",
    "DASHBOARD_PASSWORD",
    "SQLITE_DB_FILEPATH",
  ].map((name) => [name, get(name)]));

if (import.meta.main) {
  const env = applicationEnvironment((name) => Deno.env.get(name));
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
