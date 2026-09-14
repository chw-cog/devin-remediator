import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { ConfigProvider, Effect, Redacted, Result } from "effect";
import { githubAppEnv } from "../test/fixtures/github-app.ts";
import { AppConfig, type Env } from "./config.ts";
import { applicationEnvironment } from "./index.ts";

const composePath = fileURLToPath(new URL("../compose.yaml", import.meta.url));
const compose = Deno.readTextFileSync(composePath);

const required = {
  DEVIN_API_KEY: "synthetic-compose-api-key",
  DEVIN_ORGANIZATION_ID: "synthetic-compose-org",
  GITHUB_WEBHOOK_SECRET: "synthetic-compose-webhook-secret",
  SQLITE_DB_FILEPATH: "/data/compose-test.sqlite",
};

const defaults = {
  DEVIN_MAX_SESSION_BUDGET: "10",
  DEVIN_MAX_CONCURRENT_SESSIONS: "3",
  DEVIN_MAX_ATTEMPTS: "3",
  DEVIN_ANALYSIS_MAX_ATTEMPTS: "12",
  DEVIN_RETAINED_POLL_INTERVAL_MS: "60000",
  DEVIN_ORCHESTRATOR_INTERVAL_MS: "3000",
  DEVIN_SUBMITTING_TIMEOUT_SECONDS: "60",
};

const optional = Object.keys(githubAppEnv);

type ContainerEnvironment = Record<string, string | null>;

type RenderEnvironment = (env: Env) => Promise<ContainerEnvironment>;

// Deliberately not a general YAML parser: reject any unreviewed mapping syntax.
const environmentBlock = compose.match(/^ {4}environment:\n((?: {6}.+\n)+)/m);

assert.ok(environmentBlock, "Compose must define app.environment");

const entries = environmentBlock[1].trimEnd().split("\n").map((line) => {
  const entry = line.match(/^ {6}([A-Z_]+):(?: (.+))?$/);
  assert.ok(entry, "Unexpected Compose environment mapping syntax");
  return [entry[1], entry[2] ?? ""] as const;
});

const forwarding = Object.fromEntries(entries);

const renderFixture: RenderEnvironment = (env) =>
  Promise.resolve(Object.fromEntries(entries.map(([name, expression]) => {
    if (expression === "") return [name, env[name] ?? null];
    const interpolation = expression.match(/^\$\{([A-Z_]+):([-?])([^}]+)\}$/);
    assert.ok(interpolation, `Unsupported interpolation for ${name}`);
    assert.equal(interpolation[1], name, `Misrouted Compose variable ${name}`);
    if (env[name]) return [name, env[name]];
    if (interpolation[2] === "?") {
      throw new Error(`Missing required Compose variable ${name}`);
    }
    return [name, interpolation[3]];
  })));

const load = (env: ContainerEnvironment) =>
  Effect.runPromise(AppConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(
      applicationEnvironment((name) => env[name] ?? undefined),
    ))),
    Effect.result,
  ));

Deno.test("Compose forwards applicationEnvironment lifecycle settings without drift", () => {
  assert.equal(entries.length, Object.keys(forwarding).length);
  assert.deepEqual(
    Object.keys(forwarding).sort(),
    // LOG_LEVEL remains a documented, manually added observability setting.
    Object.keys(applicationEnvironment(() => undefined)).filter((name) =>
      name !== "LOG_LEVEL"
    ).sort(),
  );
  for (const name of Object.keys(required)) {
    assert.equal(forwarding[name], `\${${name}:?Set ${name}}`);
  }
  for (const [name, value] of Object.entries(defaults)) {
    assert.equal(forwarding[name], `\${${name}:-${value}}`);
  }
  for (const name of optional) assert.equal(forwarding[name], "");
});

const checkEnvironments = async (
  t: Deno.TestContext,
  render: RenderEnvironment,
) => {
  await t.step(
    "absent credentials disable delivery and lifecycle defaults load",
    async () => {
      const env = await render(required);
      for (const name of optional) assert.equal(env[name] ?? null, null);
      for (const [name, value] of Object.entries(defaults)) {
        assert.equal(env[name], value);
      }
      const result = await load(env);
      assert.ok(Result.isSuccess(result));
      assert.equal(result.success.githubApp, null);
      assert.equal(result.success.devinMaxSessionBudget, 10);
      assert.equal(result.success.devinRetainedPollIntervalMs, 60000);
      assert.equal(result.success.devinMaxConcurrentSessions, 3);
      assert.equal(result.success.devinMaxAttempts, 3);
      assert.equal(result.success.devinAnalysisMaxAttempts, 12);
      assert.equal(result.success.devinOrchestratorIntervalMs, 3000);
      assert.equal(result.success.devinSubmittingTimeoutSeconds, 60);
      assert.equal(result.success.devinApiKey, required.DEVIN_API_KEY);
      assert.equal(
        result.success.devinOrganizationId,
        required.DEVIN_ORGANIZATION_ID,
      );
      assert.equal(
        result.success.githubWebhookSecret,
        required.GITHUB_WEBHOOK_SECRET,
      );
      assert.equal(
        result.success.sqliteDbFilepath,
        required.SQLITE_DB_FILEPATH,
      );
    },
  );

  await t.step(
    "empty optional values retain disabled delivery and numeric defaults",
    async () => {
      const env = await render({
        ...required,
        ...Object.fromEntries(
          [...optional, ...Object.keys(defaults)].map((name) => [name, ""]),
        ),
      });
      const result = await load(env);
      assert.ok(Result.isSuccess(result));
      assert.equal(result.success.githubApp, null);
      assert.equal(result.success.devinMaxSessionBudget, 10);
      assert.equal(result.success.devinRetainedPollIntervalMs, 60000);
      for (const [name, value] of Object.entries(defaults)) {
        assert.equal(env[name], value);
      }
    },
  );

  await t.step(
    "configured credentials, multiline RSA key, and overrides reach AppConfig",
    async () => {
      const env = await render({
        ...required,
        ...githubAppEnv,
        DEVIN_MAX_SESSION_BUDGET: "27",
        DEVIN_MAX_CONCURRENT_SESSIONS: "5",
        DEVIN_MAX_ATTEMPTS: "6",
        DEVIN_ANALYSIS_MAX_ATTEMPTS: "14",
        DEVIN_RETAINED_POLL_INTERVAL_MS: "120000",
        DEVIN_ORCHESTRATOR_INTERVAL_MS: "4000",
        DEVIN_SUBMITTING_TIMEOUT_SECONDS: "90",
      });
      const result = await load(env);
      assert.ok(Result.isSuccess(result));
      const config = result.success;
      assert.ok(config.githubApp);
      assert.equal(config.githubApp.appId, 101);
      assert.equal(config.githubApp.installationId, 202);
      assert.ok(githubAppEnv.GITHUB_APP_PRIVATE_KEY.includes("\n"));
      assert.ok(
        Redacted.value(config.githubApp.privateKey) ===
          githubAppEnv.GITHUB_APP_PRIVATE_KEY,
        "Compose must preserve the synthetic PEM exactly",
      );
      assert.ok(!JSON.stringify(config).includes("BEGIN PRIVATE KEY"));
      assert.equal(config.devinMaxSessionBudget, 27);
      assert.equal(config.devinMaxConcurrentSessions, 5);
      assert.equal(config.devinMaxAttempts, 6);
      assert.equal(config.devinAnalysisMaxAttempts, 14);
      assert.equal(config.devinRetainedPollIntervalMs, 120000);
      assert.equal(config.devinOrchestratorIntervalMs, 4000);
      assert.equal(config.devinSubmittingTimeoutSeconds, 90);
    },
  );

  await t.step(
    "every partial credential combination fails AppConfig",
    async () => {
      for (let mask = 1; mask < 7; mask++) {
        const partial = Object.fromEntries(
          Object.entries(githubAppEnv).filter(
            (_, index) => (mask & (1 << index)) !== 0,
          ),
        );
        const result = await load(await render({ ...required, ...partial }));
        assert.ok(
          Result.isFailure(result),
          `Partial credential combination ${mask}`,
        );
        assert.equal(result.failure._tag, "ConfigError");
      }
    },
  );

  await t.step(
    "invalid or empty individual credentials still fail AppConfig",
    async () => {
      for (const name of optional) {
        for (const value of ["", "invalid", "0", "-1", "1.5"]) {
          const result = await load(
            await render({
              ...required,
              ...githubAppEnv,
              [name]: value,
            }),
          );
          assert.ok(Result.isFailure(result), `Invalid ${name}`);
          assert.equal(result.failure._tag, "ConfigError");
        }
      }
    },
  );

  await t.step(
    "nonempty invalid lifecycle overrides fail AppConfig",
    async () => {
      for (
        const name of [
          "DEVIN_MAX_SESSION_BUDGET",
          "DEVIN_RETAINED_POLL_INTERVAL_MS",
        ]
      ) {
        for (const value of ["0", "-1", "1.5", "invalid"]) {
          const result = await load(
            await render({ ...required, [name]: value }),
          );
          assert.ok(Result.isFailure(result), `${name}=${value}`);
          assert.equal(result.failure._tag, "ConfigError");
        }
      }
    },
  );

  await t.step(
    "Compose still rejects absent or empty required inputs",
    async () => {
      for (const name of Object.keys(required)) {
        for (const value of [undefined, ""]) {
          await assert.rejects(async () =>
            await render({ ...required, [name]: value })
          );
        }
      }
    },
  );
};

Deno.test("Compose deterministic configuration fixtures", (t) =>
  checkEnvironments(t, renderFixture));

Deno.test({
  name:
    "Compose actual config rendering (requires --allow-run=mise --allow-env=PATH,HOME)",
  ignore: Deno.permissions.querySync({ name: "run", command: "mise" }).state !==
    "granted",
  fn: async (t) => {
    const directory = await Deno.makeTempDir({ prefix: "compose-config-" });
    try {
      const emptyEnvFile = `${directory}/empty.env`;
      await Deno.writeTextFile(emptyEnvFile, "");
      const render = async (env: Env, envFile = emptyEnvFile) => {
        const command = await new Deno.Command("mise", {
          args: [
            "x",
            "--",
            "docker",
            "compose",
            "--project-directory",
            directory,
            "--project-name",
            "compose-config-test",
            "--env-file",
            envFile,
            "--file",
            composePath,
            "config",
            "--format",
            "json",
          ],
          clearEnv: true,
          env: {
            PATH: Deno.env.get("PATH") ?? "",
            HOME: Deno.env.get("HOME") ?? directory,
            COMPOSE_DISABLE_ENV_FILE: "1",
            ...Object.fromEntries(
              Object.entries(env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          },
          stdout: "piped",
          stderr: "piped",
        }).output();
        // Never print rendered configuration, stderr, or PEM values on failure.
        assert.equal(command.code, 0, "Docker Compose config failed");
        const config = JSON.parse(new TextDecoder().decode(command.stdout));
        return config.services.app.environment as ContainerEnvironment;
      };
      await checkEnvironments(t, render);
      await t.step(
        "explicit synthetic env file preserves multiline PEM and shell precedence",
        async () => {
          const envFile = `${directory}/synthetic.env`;
          await Deno.writeTextFile(
            envFile,
            Object.entries({
              ...required,
              ...githubAppEnv,
              DEVIN_MAX_SESSION_BUDGET: "19",
              DEVIN_RETAINED_POLL_INTERVAL_MS: "90000",
            }).map(([name, value]) => `${name}='${value}'`).join("\n") + "\n",
          );
          const result = await load(
            await render({ DEVIN_MAX_SESSION_BUDGET: "21" }, envFile),
          );
          assert.ok(Result.isSuccess(result));
          assert.ok(result.success.githubApp);
          assert.ok(
            Redacted.value(result.success.githubApp.privateKey) ===
              githubAppEnv.GITHUB_APP_PRIVATE_KEY,
            "Compose must preserve the synthetic env-file PEM exactly",
          );
          assert.equal(result.success.devinMaxSessionBudget, 21);
          assert.equal(result.success.devinRetainedPollIntervalMs, 90000);
        },
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});
