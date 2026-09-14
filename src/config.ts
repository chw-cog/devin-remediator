import { createPrivateKey } from "node:crypto";
import { Config, Effect, Redacted, Schema } from "effect";

const appId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

const githubApp = Config.all({
  appId: Config.schema(appId, "GITHUB_APP_ID").pipe(Config.withDefault(0)),
  installationId: Config.schema(appId, "GITHUB_APP_INSTALLATION_ID").pipe(
    Config.withDefault(0),
  ),
  privateKey: Config.Redacted("GITHUB_APP_PRIVATE_KEY").pipe(
    Config.withDefault(Redacted.make("")),
  ),
}).pipe(Config.mapEffect((app) => {
  if (
    app.appId === 0 && app.installationId === 0 &&
    Redacted.value(app.privateKey).trim() === ""
  ) return Effect.succeed(null);
  let validKey = false;
  try {
    validKey =
      createPrivateKey(Redacted.value(app.privateKey)).asymmetricKeyType ===
        "rsa";
  } catch { /* Invalid keys are reported without their contents. */ }
  return Schema.decodeUnknownEffect(
    Schema.Struct({
      appId,
      installationId: appId,
      validKey: Schema.Literal(true),
    }),
  )({ appId: app.appId, installationId: app.installationId, validKey }).pipe(
    Effect.as(app),
    Effect.mapError((cause) => new Config.ConfigError(cause)),
  );
}));

export type Env = Record<string, string | undefined>;

const positiveInt = (name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name).pipe(
    Config.withDefault(fallback),
  );

export const AppConfig = Config.all({
  devinApiKey: Config.String("DEVIN_API_KEY"),
  devinOrganizationId: Config.String("DEVIN_ORGANIZATION_ID"),
  devinMaxSessionBudget: positiveInt("DEVIN_MAX_SESSION_BUDGET", 10),
  devinMaxConcurrentSessions: positiveInt("DEVIN_MAX_CONCURRENT_SESSIONS", 3),
  devinMaxAttempts: positiveInt("DEVIN_MAX_ATTEMPTS", 3),
  devinAnalysisMaxAttempts: positiveInt("DEVIN_ANALYSIS_MAX_ATTEMPTS", 12),
  devinRetainedPollIntervalMs: positiveInt(
    "DEVIN_RETAINED_POLL_INTERVAL_MS",
    60000,
  ),
  devinOrchestratorIntervalMs: positiveInt(
    "DEVIN_ORCHESTRATOR_INTERVAL_MS",
    3000,
  ),
  devinSubmittingTimeoutSeconds: positiveInt(
    "DEVIN_SUBMITTING_TIMEOUT_SECONDS",
    60,
  ),
  githubWebhookSecret: Config.String("GITHUB_WEBHOOK_SECRET"),
  githubApp,
  sqliteDbFilepath: Config.String("SQLITE_DB_FILEPATH").pipe(
    Config.withDefault("./devin-remediator.sqlite"),
  ),
});

export type AppConfig = Config.Success<typeof AppConfig>;

export const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
);

export const DashboardConfig = Config.all({
  repository: Config.String("DASHBOARD_REPOSITORY").pipe(
    Config.withDefault(""),
  ),
  username: Config.String("DASHBOARD_USERNAME").pipe(
    Config.withDefault("viewer"),
  ),
  password: Config.Redacted("DASHBOARD_PASSWORD").pipe(
    Config.withDefault(Redacted.make("")),
  ),
}).pipe(Config.mapEffect((config) => {
  if (config.repository === "" && Redacted.value(config.password) === "") {
    return Effect.succeed(null);
  }
  return Schema.decodeUnknownEffect(Schema.Struct({
    repository: RepositoryName,
    username: Schema.NonEmptyString.check(Schema.isPattern(/^[^:\r\n]+$/)),
    hasPassword: Schema.Literal(true),
  }))({
    repository: config.repository,
    username: config.username,
    hasPassword: Redacted.value(config.password).trim().length > 0,
  }).pipe(
    Effect.as({ ...config, repository: config.repository.toLowerCase() }),
    Effect.mapError((cause) => new Config.ConfigError(cause)),
  );
}));
