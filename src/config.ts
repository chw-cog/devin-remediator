import { Config } from "effect";

export type Env = Record<string, string | undefined>;

export const AppConfig = Config.all({
  devinApiKey: Config.String("DEVIN_API_KEY"),
  devinOrganizationId: Config.String("DEVIN_ORGANIZATION_ID"),
  githubWebhookSecret: Config.String("GITHUB_WEBHOOK_SECRET"),
  sqliteDbFilepath: Config.String("SQLITE_DB_FILEPATH").pipe(
    Config.withDefault("./devin-remediator.sqlite"),
  ),
});

export type AppConfig = Config.Success<typeof AppConfig>;
