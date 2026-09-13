import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { ConfigProvider, Effect, Logger, Result } from "effect";
import { EventHandler, EventHandlerError } from "./event_handler.ts";

const testEnv = {
  DEVIN_API_KEY: "cog_test-key",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
};
const provideConfig = Effect.provideService(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromUnknown(testEnv),
);

function delivery(data: Record<string, unknown>) {
  const payload = JSON.stringify(data);
  return {
    id: "test-delivery",
    name: "issues",
    payload,
    signature: `sha256=${
      createHmac("sha256", testEnv.GITHUB_WEBHOOK_SECRET).update(payload)
        .digest(
          "hex",
        )
    }`,
  };
}

Deno.test("receive awaits issues.labeled logic using the layer's logging context", async () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));

  await Effect.runPromise(
    Effect.gen(function* () {
      const handler = yield* EventHandler;
      for (const [number, name] of [[42, "bug"], [43, "security"]] as const) {
        const result = yield* handler.receive(delivery({
          action: "labeled",
          repository: { full_name: "owner/repo" },
          issue: { number, labels: [{ name: "existing-label" }] },
          label: { name },
        }));
        assert.equal(result, undefined);
        assert.deepEqual(messages.at(-1), [
          `Label ${name} added to issue owner/repo#${number}`,
        ]);
      }
    }).pipe(
      Effect.provide(EventHandler.layer),
      provideConfig,
      Effect.provide(Logger.layer([logger])),
    ),
  );

  assert.equal(messages.length, 2);
});

Deno.test("receive ignores unregistered actions and handles Octokit's optional label", async () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));

  await Effect.runPromise(
    Effect.gen(function* () {
      const handler = yield* EventHandler;
      yield* handler.receive(delivery({ action: "unlabeled" }));
      assert.deepEqual(messages, []);
      yield* handler.receive(delivery({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        issue: { number: 7 },
      }));
    }).pipe(
      Effect.provide(EventHandler.layer),
      provideConfig,
      Effect.provide(Logger.layer([logger])),
    ),
  );

  assert.deepEqual(messages, [
    ["Label (unknown) added to issue owner/repo#7"],
  ]);
});

Deno.test("receive wraps callback failures in EventHandlerError", async () => {
  const result = await Effect.runPromise(
    EventHandler.use((handler) =>
      handler.receive(delivery({ action: "labeled" }))
    ).pipe(
      Effect.provide(EventHandler.layer),
      provideConfig,
      Effect.result,
    ),
  );

  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EventHandlerError);
  assert.ok(result.failure.cause instanceof AggregateError);
  assert.equal(result.failure.cause.errors.length, 1);
});

Deno.test("receive rejects unsigned and tampered deliveries without dispatching", async () => {
  const messages: Array<unknown> = [];
  const logger = Logger.make(({ message }) => messages.push(message));
  const signed = delivery({
    action: "labeled",
    repository: { full_name: "owner/repo" },
    issue: { number: 42 },
    label: { name: "bug" },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const handler = yield* EventHandler;
      for (
        const event of [
          { ...signed, signature: "" },
          { ...signed, signature: "not-a-signature" },
          { ...signed, signature: `sha256=${"0".repeat(64)}` },
          { ...signed, payload: signed.payload.replace("bug", "security") },
        ]
      ) {
        const result = yield* handler.receive(event).pipe(Effect.result);
        assert.ok(Result.isFailure(result));
        assert.ok(result.failure instanceof EventHandlerError);
        assert.deepEqual(messages, []);
      }

      yield* handler.receive(signed);
      assert.deepEqual(messages, [["Label bug added to issue owner/repo#42"]]);
    }).pipe(
      Effect.provide(EventHandler.layer),
      provideConfig,
      Effect.provide(Logger.layer([logger])),
    ),
  );
});
