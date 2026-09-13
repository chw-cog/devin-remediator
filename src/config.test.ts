import { strict as assert } from "node:assert";
import { ConfigProvider, Effect, Result } from "effect";
import { AppConfig } from "./config.ts";

const env = {
  DEVIN_API_KEY: "cog_test-key",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
};

Deno.test("AppConfig loads settings from the supplied config layer", async () => {
  for (const key of ["cog_first-key", "cog_second-key"]) {
    const config = await Effect.runPromise(AppConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        ...env,
        DEVIN_API_KEY: key,
        GITHUB_WEBHOOK_SECRET: `${key}-webhook-secret`,
        SQLITE_DB_FILEPATH: `./${key}.sqlite`,
      }))),
    ));
    assert.deepEqual(config, {
      devinApiKey: key,
      devinOrganizationId: "org-test",
      githubWebhookSecret: `${key}-webhook-secret`,
      sqliteDbFilepath: `./${key}.sqlite`,
    });
  }
});

Deno.test("AppConfig rejects missing or empty required settings", async () => {
  for (
    const settings of [
      {},
      { ...env, DEVIN_API_KEY: undefined },
      { ...env, DEVIN_API_KEY: "" },
      { ...env, DEVIN_ORGANIZATION_ID: undefined },
      { ...env, DEVIN_ORGANIZATION_ID: "" },
      { ...env, GITHUB_WEBHOOK_SECRET: undefined },
      { ...env, GITHUB_WEBHOOK_SECRET: "" },
    ]
  ) {
    const result = await Effect.runPromise(AppConfig.pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown(settings)),
      ),
      Effect.result,
    ));
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure._tag, "ConfigError");
  }
});

Deno.test("AppConfig defaults the SQLite filepath when omitted or empty", async () => {
  for (const SQLITE_DB_FILEPATH of [undefined, ""]) {
    const config = await Effect.runPromise(AppConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        ...env,
        SQLITE_DB_FILEPATH,
      }))),
    ));
    assert.equal(config.sqliteDbFilepath, "./devin-remediator.sqlite");
  }
});
