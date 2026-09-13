import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { ConfigProvider, Effect, Fiber, Layer, Result } from "effect";
import { type AppDatabase, DatabaseClient } from "./database.ts";
import { DevinClient } from "./devin.ts";
import { DevinSessionOrchestrator } from "./devin_session_orchestrator.ts";
import { DevinSessionRepository } from "./devin_session_repository.ts";
import { EventHandler } from "./event_handler.ts";
import { runApplication } from "./index.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";

Deno.test("Hono serves durable webhooks and health while the scoped orchestrator awaits Devin; shutdown joins it before closing SQLite", async () => {
  const listening = Promise.withResolvers<number>();
  const submitting = Promise.withResolvers<void>();
  let stopped = false;
  let creates = 0;
  let capturedDb: AppDatabase | undefined;
  const TestLive = Layer.merge(
    EventHandler.layer,
    DevinSessionOrchestrator.layer.pipe(
      Layer.provide(DevinSessionRepository.layer),
    ),
  ).pipe(
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(Layer.succeed(DevinClient, {
      createSession: () =>
        Effect.sync(() => {
          creates++;
          submitting.resolve();
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => {
            stopped = true;
          })),
        ),
      getSession: () => Effect.die("No running session exists"),
      listSessions: () => Effect.die("Unexpected listSessions"),
    })),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEVIN_API_KEY: "test-key",
      DEVIN_ORGANIZATION_ID: "org-test",
      DEVIN_MAX_CONCURRENT_SESSIONS: "1",
      DEVIN_ORCHESTRATOR_INTERVAL_MS: "5",
      GITHUB_WEBHOOK_SECRET: "test-secret",
      SQLITE_DB_FILEPATH: ":memory:",
    }))),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      capturedDb = db;
      const fiber = yield* runApplication({
        hostname: "127.0.0.1",
        port: 0,
        onListen: ({ port }) => listening.resolve(port),
      }).pipe(Effect.forkScoped);
      const port = yield* Effect.promise(() => listening.promise);
      const base = `http://127.0.0.1:${port}`;
      yield* Effect.promise(async () => {
        const payload = '{"repository":{"full_name":"owner/repo"}}';
        const deliver = (id: string) =>
          fetch(`${base}/api/v1/webhook`, {
            method: "POST",
            headers: {
              "x-github-event": "push",
              "x-github-delivery": id,
              "x-hub-signature-256": `sha256=${
                createHmac("sha256", "test-secret").update(payload).digest(
                  "hex",
                )
              }`,
            },
            body: payload,
            signal: AbortSignal.timeout(2000),
          });
        const first = await deliver("first");
        assert.equal(first.status, 200);
        await first.text();
        await submitting.promise;
        const health = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { status: "ok" });
        for (const id of ["first", "second"]) {
          const response = await deliver(id);
          assert.equal(response.status, 200);
          await response.text();
        }
      });
      const sessions = yield* db.select().from(devinSessions);
      assert.equal(sessions.length, 2);
      assert.equal(sessions.filter((s) => s.status === "submitting").length, 1);
      assert.equal(sessions.filter((s) => s.status === "pending").length, 1);
      assert.equal(
        (yield* db.select().from(githubWebhookDeliveries)).length,
        2,
      );
      assert.equal(creates, 1);
      yield* Fiber.interrupt(fiber);
      assert.equal(stopped, true);
      assert.equal((yield* db.select().from(devinSessions)).length, 2);
      yield* Effect.promise(() => assert.rejects(fetch(`${base}/health`)));
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  );
  assert.ok(capturedDb);
  assert.ok(
    Result.isFailure(
      await Effect.runPromise(capturedDb.$client`SELECT 1`.pipe(Effect.result)),
    ),
  );
});
