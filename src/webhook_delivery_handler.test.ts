import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { DatabaseClient } from "./database.ts";
import {
  WebhookDeliveryHandler,
  WebhookDeliveryHandlerError,
} from "./webhook_delivery_handler.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";

const testEnv = {
  DEVIN_API_KEY: "cog_test-key",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  SQLITE_DB_FILEPATH: ":memory:",
};
const TestLive = WebhookDeliveryHandler.layer.pipe(
  Layer.provideMerge(DatabaseClient.layer),
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(testEnv))),
);

Deno.test("receive verifies before parsing payloads and wraps failures in WebhookDeliveryHandlerError", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const handler = yield* WebhookDeliveryHandler;
      const invalid = yield* handler.receive({
        id: "test-delivery",
        name: "push",
        payload: "{",
        signature: `sha256=${"0".repeat(64)}`,
      }).pipe(Effect.result);
      assert.ok(Result.isFailure(invalid));
      assert.ok(invalid.failure instanceof WebhookDeliveryHandlerError);
      assert.ok(invalid.failure.cause instanceof Error);
      assert.equal(invalid.failure.cause.message, "Invalid webhook signature");
      assert.deepEqual(yield* db.select().from(githubWebhookDeliveries), []);
      assert.deepEqual(yield* db.select().from(devinSessions), []);

      const payload = '{"repository":{"full_name":"owner/repo"}}';
      const result = yield* handler.receive({
        id: "test-delivery",
        name: "push",
        payload,
        signature: `sha256=${
          createHmac("sha256", testEnv.GITHUB_WEBHOOK_SECRET).update(payload)
            .digest("hex")
        }`,
      });
      assert.equal(result, undefined);
      assert.equal(
        (yield* db.select().from(githubWebhookDeliveries).get())?.payload,
        payload,
      );
      assert.equal(
        (yield* db.select().from(devinSessions).get())?.status,
        "pending",
      );
    }).pipe(Effect.provide(TestLive)),
  ));
