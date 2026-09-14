import { strict as assert } from "node:assert";
import { inspect } from "node:util";
import { ConfigProvider, Effect, Redacted, Result } from "effect";
import { AppConfig } from "./config.ts";
import { githubAppEnv } from "../test/fixtures/github-app.ts";

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
      devinMaxSessionBudget: 10,
      devinMaxConcurrentSessions: 3,
      devinMaxAttempts: 3,
      devinAnalysisMaxAttempts: 12,
      devinRetainedPollIntervalMs: 60000,
      devinOrchestratorIntervalMs: 3000,
      devinSubmittingTimeoutSeconds: 60,
      githubWebhookSecret: `${key}-webhook-secret`,
      githubApp: null,
      sqliteDbFilepath: `./${key}.sqlite`,
    });
  }
});

Deno.test("GitHub App config is optional, rejects partial or invalid credentials, and redacts its key", async () => {
  const load = (settings: Record<string, string | undefined>) =>
    Effect.runPromise(
      AppConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ ...env, ...settings }),
          ),
        ),
      ),
    );
  assert.equal((await load({})).githubApp, null);
  assert.equal(
    (await load({
      GITHUB_APP_ID: "",
      GITHUB_APP_INSTALLATION_ID: "",
      GITHUB_APP_PRIVATE_KEY: "",
    })).githubApp,
    null,
  );
  const config = await load(githubAppEnv);
  assert.ok(config.githubApp);
  assert.equal(config.githubApp.appId, 101);
  assert.equal(config.githubApp.installationId, 202);
  assert.equal(
    Redacted.value(config.githubApp.privateKey),
    githubAppEnv.GITHUB_APP_PRIVATE_KEY,
  );
  assert.ok(!JSON.stringify(config).includes("BEGIN PRIVATE KEY"));
  for (const name of Object.keys(githubAppEnv)) {
    for (const value of [undefined, "", "invalid", "0", "-1", "1.5"]) {
      await assert.rejects(load({ ...githubAppEnv, [name]: value }));
    }
  }
});

Deno.test("invalid GitHub App keys report the setting and PEM requirement without leaking secrets", async () => {
  for (
    const privateKey of [
      "PRIVATE invalid key must not appear in diagnostics",
      githubAppEnv.GITHUB_APP_PRIVATE_KEY.replace(
        "BEGIN PRIVATE KEY",
        "BEGIN\n PRIVATE KEY",
      ),
    ]
  ) {
    const result = await Effect.runPromise(AppConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        ...env,
        ...githubAppEnv,
        GITHUB_APP_PRIVATE_KEY: privateKey,
      }))),
      Effect.result,
    ));
    assert.ok(Result.isFailure(result));
    assert.match(result.failure.message, /GITHUB_APP_PRIVATE_KEY/);
    assert.match(result.failure.message, /RSA private key.*PEM/);
    const diagnostics = [
      result.failure.toString(),
      JSON.stringify(result.failure),
      inspect(result.failure, { depth: null }),
    ].join("\n");
    assert.ok(!diagnostics.includes(privateKey));
    assert.ok(
      !diagnostics.includes(githubAppEnv.GITHUB_APP_PRIVATE_KEY.split("\n")[1]),
    );
  }
});

for (
  const [value, expected] of [
    [undefined, 10],
    ["", 10],
    ["1", 1],
    ["27", 27],
  ] as const
) {
  Deno.test(`session budget ${JSON.stringify(value) ?? "omitted"} resolves to ${expected} ACUs`, async () => {
    const config = await Effect.runPromise(AppConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        ...env,
        DEVIN_MAX_SESSION_BUDGET: value,
      }))),
    ));
    assert.equal(config.devinMaxSessionBudget, expected);
  });
}

for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "invalid"]) {
  Deno.test(`session budget rejects ${JSON.stringify(value)}`, async () => {
    const result = await Effect.runPromise(AppConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        ...env,
        DEVIN_MAX_SESSION_BUDGET: value,
      }))),
      Effect.result,
    ));
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure._tag, "ConfigError");
  });
}

Deno.test("orchestrator settings accept positive integers and reject invalid values", async () => {
  for (
    const [name, field] of [
      ["DEVIN_MAX_CONCURRENT_SESSIONS", "devinMaxConcurrentSessions"],
      ["DEVIN_MAX_ATTEMPTS", "devinMaxAttempts"],
      ["DEVIN_ANALYSIS_MAX_ATTEMPTS", "devinAnalysisMaxAttempts"],
      ["DEVIN_ORCHESTRATOR_INTERVAL_MS", "devinOrchestratorIntervalMs"],
      ["DEVIN_SUBMITTING_TIMEOUT_SECONDS", "devinSubmittingTimeoutSeconds"],
    ] as const
  ) {
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "invalid", "7"]) {
      const result = await Effect.runPromise(AppConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
          ...env,
          [name]: value,
        }))),
        Effect.result,
      ));
      if (value === "7") {
        assert.ok(Result.isSuccess(result));
        assert.equal(result.success[field], 7);
      } else {
        assert.ok(Result.isFailure(result), `${name}=${value}`);
      }
    }
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
