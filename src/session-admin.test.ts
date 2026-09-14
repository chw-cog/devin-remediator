import { strict as assert } from "node:assert";
import { ConfigProvider, Console, Effect, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { DatabaseClient } from "./database.ts";
import { runSessionAdmin, sessionAdminEnvironment } from "./session-admin.ts";
import {
  recoveryRemote,
  seedRecovery,
} from "../test/fixtures/session-recovery.ts";

async function invoke(
  args: string[],
  options: { fetch?: typeof globalThis.fetch; env?: Record<string, string> } =
    {},
) {
  const output: string[] = [];
  const errors: string[] = [];
  const captured: Console.Console = Object.assign(Object.create(console), {
    log: (...args: unknown[]) => output.push(args.join(" ")),
    error: (...args: unknown[]) => errors.push(args.join(" ")),
  });
  const code = await Effect.runPromise(
    runSessionAdmin(args).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown(options.env ?? {})),
      ),
      Effect.provideService(Console.Console, captured),
      Effect.provideService(
        FetchHttpClient.Fetch,
        options.fetch ?? (() => {
          throw new Error("No provider request allowed");
        }),
      ),
    ),
  );
  return { code, output, errors };
}

Deno.test("session-admin real argument entrypoint supports offline list/inspect/resolve and verified diagnose/associate/resume", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/admin.sqlite`;
  try {
    await Effect.runPromise(
      DatabaseClient.use(({ db }) =>
        seedRecovery(db, "one", {
          status: "submitting",
          devinSessionId: null,
          recoveryBlocked: true,
          outputs: [{ outcome: "needs_human", summary: "PRIVATE question" }],
        })
      ).pipe(
        Effect.provide(DatabaseClient.layerWithPath(path)),
        Effect.provide(Logger.layer([])),
        Effect.scoped,
      ),
    );
    const list = await invoke(["--db", path, "list"]);
    assert.equal(list.code, 0);
    assert.equal(JSON.parse(list.output[0])[0].recoveryBlocked, true);
    assert.ok(!list.output.join().includes("PRIVATE"));
    const inspect = await invoke(["inspect", "one", "--db", path]);
    assert.equal(inspect.code, 0);
    let revision = JSON.parse(inspect.output[0]).revision;
    const requests: string[] = [];
    const online = {
      env: {
        DEVIN_API_KEY: "PRIVATE token",
        DEVIN_ORGANIZATION_ID: "org-test",
      },
      fetch: ((input, init) => {
        assert.equal(init?.method, "GET");
        requests.push(String(input));
        return Promise.resolve(Response.json(recoveryRemote()));
      }) as typeof globalThis.fetch,
    };
    const diagnosed = await invoke([
      "--db",
      path,
      "diagnose",
      "one",
      "--remote-id",
      "remote-one",
    ], online);
    assert.equal(diagnosed.code, 0);
    assert.equal(JSON.parse(diagnosed.output[0]).outcome, "found");
    assert.ok(!diagnosed.output.join().includes("PRIVATE"));
    const stale = await invoke([
      "--db",
      path,
      "associate",
      "one",
      "--remote-id",
      "remote-one",
      "--revision",
      revision,
      "--reason",
      "Selected by operator",
    ], online);
    assert.equal(stale.code, 1);
    assert.deepEqual(JSON.parse(stale.errors[0]), { error: "conflict" });
    revision = JSON.parse(diagnosed.output[0]).session.revision;
    const associated = await invoke([
      "--db",
      path,
      "associate",
      "one",
      "--remote-id",
      "remote-one",
      "--revision",
      revision,
      "--reason",
      "Selected by operator",
    ], online);
    assert.equal(associated.code, 0);
    revision = JSON.parse(associated.output[0]).session.revision;
    const resolved = await invoke([
      "--db",
      path,
      "resolve",
      "one",
      "--revision",
      revision,
      "--reason",
      "PRIVATE local reason",
    ]);
    assert.equal(resolved.code, 0);
    assert.equal(
      JSON.parse(resolved.output[0]).session.localOwnership,
      "released",
    );
    assert.match(
      JSON.parse(resolved.output[0]).warning,
      /remote execution is unchanged/,
    );
    assert.ok(!resolved.output.join().includes("PRIVATE"));
    revision = JSON.parse(resolved.output[0]).session.revision;
    const resumed = await invoke([
      "--db",
      path,
      "resume",
      "one",
      "--revision",
      revision,
      "--reason",
      "Track same remote identity",
    ], online);
    assert.equal(resumed.code, 0);
    assert.equal(
      JSON.parse(resumed.output[0]).session.localOwnership,
      "tracking",
    );
    assert.equal(requests.length, 3);
    assert.ok(requests.every((url) => url.endsWith("/sessions/remote-one")));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("session-admin rejects missing reason/revision/identity, unknown control commands, and unsafe arguments without echoing input", async () => {
  const directory = await Deno.makeTempDir();
  try {
    for (
      const args of [
        ["list"],
        ["inspect"],
        ["resolve", "one", "--revision", "revision"],
        ["resolve", "one", "--reason", "PRIVATE reason"],
        [
          "associate",
          "one",
          "--revision",
          "revision",
          "--reason",
          "PRIVATE reason",
        ],
        ["resume", "one", "--revision", "revision", "--reason", "   "],
        ["terminate", "PRIVATE identity"],
        ["message", "one", "PRIVATE message"],
        ["archive", "one"],
        ["create", "one"],
      ]
    ) {
      const result = await invoke(
        args[0] === "list"
          ? args
          : ["--db", `${directory}/should-not-exist.sqlite`, ...args],
      );
      assert.equal(result.code, 1, args.join(" "));
      assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    }
    assert.equal((await Array.fromAsync(Deno.readDir(directory))).length, 0);
    const help = await invoke(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.output.join(), /associate/);
    assert.match(help.output.join(), /resolve/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("session-admin environment reads only diagnostic credentials and the existing submission grace", () => {
  const names: string[] = [];
  assert.deepEqual(
    sessionAdminEnvironment((name) => {
      names.push(name);
      return undefined;
    }),
    {
      DEVIN_API_KEY: undefined,
      DEVIN_ORGANIZATION_ID: undefined,
      DEVIN_SUBMITTING_TIMEOUT_SECONDS: undefined,
    },
  );
  assert.deepEqual(names, [
    "DEVIN_API_KEY",
    "DEVIN_ORGANIZATION_ID",
    "DEVIN_SUBMITTING_TIMEOUT_SECONDS",
  ]);
});
