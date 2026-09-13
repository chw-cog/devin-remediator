import { strict as assert } from "node:assert";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { Effect, Logger, Result } from "effect";
import { EventHandler, EventHandlerError } from "./event_handler.ts";

// As at the HTTP boundary, fixtures omit GitHub fields unused by the handler.
function delivery(payload: Record<string, unknown>) {
  return {
    id: "test-delivery",
    name: "issues",
    payload,
  } as EmitterWebhookEvent<"issues">;
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
      Effect.result,
    ),
  );

  assert.ok(Result.isFailure(result));
  assert.ok(result.failure instanceof EventHandlerError);
  assert.ok(result.failure.cause instanceof AggregateError);
  assert.equal(result.failure.cause.errors.length, 1);
});
