import { Config, Schema } from "effect";

export type Env = Record<string, string | undefined>;

const positiveInt = (name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name).pipe(
    Config.withDefault(fallback),
  );

export const AppConfig = Config.all({
  devinApiKey: Config.String("DEVIN_API_KEY"),
  devinOrganizationId: Config.String("DEVIN_ORGANIZATION_ID"),
  devinMaxConcurrentSessions: positiveInt("DEVIN_MAX_CONCURRENT_SESSIONS", 3),
  devinMaxAttempts: positiveInt("DEVIN_MAX_ATTEMPTS", 3),
  devinAnalysisMaxAttempts: positiveInt("DEVIN_ANALYSIS_MAX_ATTEMPTS", 12),
  devinOrchestratorIntervalMs: positiveInt(
    "DEVIN_ORCHESTRATOR_INTERVAL_MS",
    3000,
  ),
  devinSubmittingTimeoutSeconds: positiveInt(
    "DEVIN_SUBMITTING_TIMEOUT_SECONDS",
    60,
  ),
  githubWebhookSecret: Config.String("GITHUB_WEBHOOK_SECRET"),
  sqliteDbFilepath: Config.String("SQLITE_DB_FILEPATH").pipe(
    Config.withDefault("./devin-remediator.sqlite"),
  ),
});

export type AppConfig = Config.Success<typeof AppConfig>;
