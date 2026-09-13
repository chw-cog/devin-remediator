import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { ConfigProvider, Effect, Fiber, Layer, Result } from "effect";
import { createApp } from "./app.ts";
import { type AppDatabase, DatabaseClient } from "./database.ts";
import { DevinClient } from "./devin.ts";
import { playbook } from "../test/fixtures/playbook.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { WebhookDeliveryHandler } from "./webhook-delivery-handler.ts";
import { AppConfig } from "./config.ts";
import { applicationEnvironment, runApplication } from "./index.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";
import {
  type WebhookEventOutcome,
  type WebhookEventProcessor,
  WebhookEventProcessors,
} from "./webhook-event-processors.ts";

Deno.test("Hono serves durable webhooks and health while the scoped orchestrator awaits Devin; shutdown joins it before closing SQLite", async () => {
  const listening = Promise.withResolvers<number>();
  const submitting = Promise.withResolvers<void>();
  let stopped = false;
  let creates = 0;
  let capturedDb: AppDatabase | undefined;
  const TestLive = Layer.merge(
    WebhookDeliveryHandler.layer,
    DevinSessionOrchestrator.layer.pipe(
      Layer.provide(DevinSessionRepository.layer),
      Layer.provide(WebhookEventProcessors.layer),
    ),
  ).pipe(
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(Layer.succeed(DevinClient, {
      createPlaybook: () => Effect.die("Playbook already exists"),
      findPlaybookByMacro: () => Effect.succeed(playbook),
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
      listSessions: () => Effect.die("Unexpected listSessions"),
      findSessionsByTag: () => Effect.die("Unexpected tag lookup"),
      listSessionsWithInsights: () => Effect.die("Unexpected insights lookup"),
      generateSessionInsights: () =>
        Effect.die("Unexpected insights generation"),
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
        const payload =
          '{"repository":{"full_name":"owner/repo"},"issue":{"number":42},"action":"labeled","label":{"name":"devin"}}';
        const deliver = (id: string) =>
          fetch(`${base}/api/v1/webhook`, {
            method: "POST",
            headers: {
              "x-github-event": "issues",
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

Deno.test("signed HTTP deliveries route through SQLite once per delivery ID and skip nonmatching events without Devin calls", async () => {
  const creates: Parameters<DevinClient["Service"]["createSession"]>[0][] = [];
  const gets: string[] = [];
  const client = DevinClient.of({
    createPlaybook: () => Effect.die("Playbook already exists"),
    findPlaybookByMacro: () => Effect.succeed(playbook),
    createSession: (request) =>
      Effect.sync(() => {
        creates.push(request);
        return {
          session_id: `http-remote-${creates.length}`,
          url: `https://app.devin.ai/sessions/http-${creates.length}`,
          status: "new",
          org_id: "org-test",
          created_at: 0,
          updated_at: 0,
          acus_consumed: 0,
          tags: [],
          pull_requests: [],
        };
      }),
    listSessions: (ids) =>
      Effect.sync(() => {
        gets.push(...ids);
        return ids.map((session_id) => ({
          session_id,
          url: `https://app.devin.ai/sessions/${session_id}`,
          status: "running" as const,
          org_id: "org-test",
          created_at: 0,
          updated_at: 0,
          acus_consumed: 0,
          tags: [],
          pull_requests: [],
        }));
      }),
    findSessionsByTag: () => Effect.die("Unexpected tag lookup"),
    listSessionsWithInsights: () => Effect.die("Unexpected insights lookup"),
    generateSessionInsights: () => Effect.die("Unexpected insights generation"),
  });
  const pullRequestProcessor: WebhookEventProcessor = (delivery, client) =>
    client.createSession({
      title: `Custom processor for ${delivery.deliveryId}`,
      prompt: delivery.payload,
      repos: [delivery.repo],
    }).pipe(Effect.map((session): WebhookEventOutcome => ({
      _tag: "SessionCreated",
      devinSessionId: session.session_id,
    })));
  const TestLive = Layer.merge(
    WebhookDeliveryHandler.layer,
    DevinSessionOrchestrator.layer.pipe(
      Layer.provide(DevinSessionRepository.layer),
      Layer.provide(
        Layer.effect(
          WebhookEventProcessors,
          Effect.gen(function* () {
            const processors = yield* WebhookEventProcessors;
            return new Map([
              ...processors,
              ["pull_request", pullRequestProcessor],
            ]);
          }),
        ).pipe(Layer.provide(WebhookEventProcessors.layer)),
      ),
    ),
  ).pipe(
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(Layer.succeed(DevinClient, client)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEVIN_API_KEY: "test-key",
      DEVIN_ORGANIZATION_ID: "org-test",
      DEVIN_MAX_CONCURRENT_SESSIONS: "20",
      GITHUB_WEBHOOK_SECRET: "test-secret",
      SQLITE_DB_FILEPATH: ":memory:",
    }))),
  );
  const matching =
    '{ "repository": {"full_name":"owner/repo"}, "issue":{"number":42}, "action":"labeled", "label":{"name":"devin"} }';
  const envelope = {
    repository: { full_name: "owner/repo" },
    issue: { number: 42, labels: [{ name: "devin" }] },
  };
  const cases = [
    { id: "matching", event: "issues", payload: matching, status: "submitted" },
    {
      id: "different-case",
      event: "issues",
      payload: JSON.stringify({
        ...envelope,
        action: "labeled",
        label: { name: "Devin" },
      }),
      status: "skipped",
    },
    {
      id: "unrelated-label",
      event: "issues",
      payload: JSON.stringify({
        ...envelope,
        action: "labeled",
        label: { name: "bug" },
      }),
      status: "skipped",
    },
    {
      id: "wrong-action",
      event: "issues",
      payload: JSON.stringify({
        ...envelope,
        action: "opened",
        label: { name: "devin" },
      }),
      status: "skipped",
    },
    {
      id: "missing-label",
      event: "issues",
      payload: JSON.stringify({ ...envelope, action: "labeled" }),
      status: "skipped",
    },
    { id: "unhandled", event: "push", payload: matching, status: "skipped" },
    {
      id: "unknown-kind",
      event: "not_registered",
      payload: matching,
      status: "skipped",
    },
  ];
  await Effect.runPromise(
    Effect.gen(function* () {
      const app = yield* createApp;
      const orchestra = yield* DevinSessionOrchestrator;
      const { db } = yield* DatabaseClient;
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Deno.serve(
            { hostname: "127.0.0.1", port: 0, onListen: () => {} },
            (request) => app.fetch(request),
          )
        ),
        (server) => Effect.promise(() => server.shutdown()),
      );
      const deliver = Effect.fn("deliver")(
        (id: string, event: string, payload: string) =>
          Effect.promise(async () => {
            const response = await fetch(
              `http://127.0.0.1:${server.addr.port}/api/v1/webhook`,
              {
                method: "POST",
                headers: {
                  "x-github-event": event,
                  "x-github-delivery": id,
                  "x-hub-signature-256": `sha256=${
                    createHmac("sha256", "test-secret").update(payload).digest(
                      "hex",
                    )
                  }`,
                },
                body: payload,
                signal: AbortSignal.timeout(2000),
              },
            );
            await response.text();
            assert.equal(response.status, 200);
          }),
      );
      for (const entry of cases) {
        yield* deliver(entry.id, entry.event, entry.payload);
      }
      yield* deliver("matching", "push", JSON.stringify(envelope));
      const queued = yield* db.select().from(devinSessions);
      assert.equal(queued.length, cases.length);
      assert.ok(queued.every((session) => session.status === "pending"));
      assert.equal(creates.length, 0);
      yield* orchestra.tick;
      const first = yield* db.select().from(devinSessions);
      for (const entry of cases) {
        assert.equal(
          first.find((session) => session.githubDeliveryId === entry.id)
            ?.status,
          entry.status,
        );
      }
      assert.equal(creates.length, 1);
      const skipped = first.filter((session) => session.status === "skipped");
      yield* deliver("matching", "issues", matching);
      yield* deliver("new-delivery-same-issue", "issues", matching);
      yield* orchestra.tick;
      yield* orchestra.tick;
      const sessions = yield* db.select().from(devinSessions);
      const deliveries = yield* db.select().from(githubWebhookDeliveries);
      assert.equal(sessions.length, cases.length + 1);
      assert.equal(deliveries.length, cases.length + 1);
      assert.deepEqual(
        sessions.filter((session) => session.status === "skipped"),
        skipped,
      );
      assert.equal(creates.length, 2);
      assert.equal(
        new Set(
          sessions.filter((session) => session.status === "submitted")
            .map((session) => session.devinSessionId),
        ).size,
        2,
      );
      assert.deepEqual([...gets].sort(), [
        "http-remote-1",
        "http-remote-1",
        "http-remote-2",
      ]);
      for (
        const entry of [...cases, {
          id: "new-delivery-same-issue",
          event: "issues",
          payload: matching,
        }]
      ) {
        const saved = deliveries.find((row) => row.deliveryId === entry.id);
        assert.equal(saved?.eventName, entry.event);
        assert.equal(saved?.payload, entry.payload);
        assert.equal(saved?.repo, "owner/repo");
        assert.equal(saved?.issueNumber, 42);
      }
      assert.match(creates[0].prompt, /Delivery: matching/);
      assert.match(creates[1].prompt, /Delivery: new-delivery-same-issue/);
      for (const request of creates) {
        assert.deepEqual(request.repos, ["owner/repo"]);
        assert.match(request.prompt, /Issue: 42/);
        assert.ok(request.prompt.endsWith(matching));
      }
      const customPayload = JSON.stringify(envelope);
      yield* deliver("custom", "pull_request", customPayload);
      yield* orchestra.tick;
      assert.equal(creates.length, 3);
      assert.deepEqual(creates[2], {
        title: "Custom processor for custom",
        prompt: customPayload,
        repos: ["owner/repo"],
      });
      const customSession = (yield* db.select().from(devinSessions))
        .find((session) => session.githubDeliveryId === "custom");
      assert.equal(customSession?.status, "submitted");
      assert.equal(customSession?.devinSessionId, "http-remote-3");
      const customDelivery = (yield* db.select().from(githubWebhookDeliveries))
        .find((delivery) => delivery.deliveryId === "custom");
      assert.equal(customDelivery?.eventName, "pull_request");
      assert.equal(customDelivery?.payload, customPayload);
    }).pipe(Effect.scoped, Effect.provide(TestLive)),
  );
});

Deno.test("production environment forwarding honors retained polling and analysis bounds", async () => {
  const env = applicationEnvironment((name) =>
    ({
      DEVIN_API_KEY: "test",
      DEVIN_ORGANIZATION_ID: "org",
      GITHUB_WEBHOOK_SECRET: "test",
      DEVIN_RETAINED_POLL_INTERVAL_MS: "12345",
      DEVIN_ANALYSIS_MAX_ATTEMPTS: "7",
    } as Record<string, string>)[name]
  );
  const config = await Effect.runPromise(
    AppConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );
  assert.equal(config.devinRetainedPollIntervalMs, 12345);
  assert.equal(config.devinAnalysisMaxAttempts, 7);
  for (const entry of ["start", "dev"]) {
    const tasks = JSON.parse(
      await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
    ).tasks;
    assert.ok(tasks[entry].includes("DEVIN_RETAINED_POLL_INTERVAL_MS"));
    assert.ok(tasks[entry].includes("DEVIN_ANALYSIS_MAX_ATTEMPTS"));
  }
});
