import { strict as assert } from "node:assert";
import { eq } from "drizzle-orm";
import {
  ConfigProvider,
  Context,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Result,
} from "effect";
import { TestClock } from "effect/testing";
import { playbook } from "../test/fixtures/playbook.ts";
import { FetchHttpClient } from "effect/unstable/http";
import { type AppDatabase, DatabaseClient, DatabaseError } from "./database.ts";
import { type Env } from "./config.ts";
import {
  DevinClient,
  DevinLookupError,
  type DevinSession,
  type DevinSessionWithInsights,
  DevinSubmissionError,
} from "./devin.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import {
  type DeliveryRecord,
  DevinSessionRepository,
  type SessionRecord,
} from "./devin-session-repository.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";
import {
  type WebhookEventOutcome,
  type WebhookEventProcessor,
  WebhookEventProcessors,
} from "./webhook-event-processors.ts";

const remote: DevinSession = {
  session_id: "devin-created",
  url: "https://app.devin.ai/sessions/created",
  status: "new",
  org_id: "org-test",
  created_at: 0,
  updated_at: 0,
  acus_consumed: 0,
  tags: [],
  pull_requests: [],
};

const completedInsights = (sessionId: string): DevinSessionWithInsights => ({
  ...remote,
  session_id: sessionId,
  status: "exit",
  status_detail: "finished",
  num_devin_messages: 2,
  num_user_messages: 1,
  session_size: "xs",
  analysis: null,
});

function fakeClient() {
  const creates: Parameters<DevinClient["Service"]["createSession"]>[0][] = [];
  const lists: ReadonlyArray<string>[] = [];
  const lookups: string[] = [];
  const insights: ReadonlyArray<string>[] = [];
  const generations: string[] = [];
  const behavior = {
    findPlaybook: (): ReturnType<
      DevinClient["Service"]["findPlaybookByMacro"]
    > => Effect.succeed(playbook),
    createPlaybook: (): ReturnType<DevinClient["Service"]["createPlaybook"]> =>
      Effect.die("Playbook already exists"),
    create: (): ReturnType<DevinClient["Service"]["createSession"]> =>
      Effect.succeed({
        ...remote,
        session_id: `devin-created-${creates.length}`,
      }),
    list: (
      ids: ReadonlyArray<string>,
    ): ReturnType<DevinClient["Service"]["listSessions"]> =>
      Effect.succeed(ids.map((session_id) => ({ ...remote, session_id }))),
    lookup: (
      _tag: string,
    ): ReturnType<DevinClient["Service"]["findSessionsByTag"]> =>
      Effect.succeed([]),
    insights: (
      _ids: ReadonlyArray<string>,
    ): ReturnType<DevinClient["Service"]["listSessionsWithInsights"]> =>
      Effect.succeed([]),
    generate: (
      id: string,
    ): ReturnType<DevinClient["Service"]["generateSessionInsights"]> =>
      Effect.succeed({ session_id: id, status: "started" }),
  };
  const client = DevinClient.of({
    createPlaybook: () => behavior.createPlaybook(),
    findPlaybookByMacro: () => behavior.findPlaybook(),
    createSession: (params) =>
      Effect.suspend(() => {
        creates.push(params);
        return behavior.create();
      }),
    listSessions: (ids) =>
      Effect.suspend(() => {
        lists.push(ids);
        return behavior.list(ids);
      }),
    listSessionsWithInsights: (ids) =>
      Effect.suspend(() => {
        insights.push(ids);
        return behavior.insights(ids);
      }),
    generateSessionInsights: (id) =>
      Effect.suspend(() => {
        generations.push(id);
        return behavior.generate(id);
      }),
    findSessionsByTag: (tag) =>
      Effect.suspend(() => {
        lookups.push(tag);
        return behavior.lookup(tag);
      }),
  });
  return { creates, lists, lookups, insights, generations, behavior, client };
}

function testLayer(
  fake: ReturnType<typeof fakeClient>,
  env: Env = {},
  processors: Layer.Layer<WebhookEventProcessors> =
    WebhookEventProcessors.layer,
) {
  return DevinSessionOrchestrator.layer.pipe(
    Layer.provide(processors),
    Layer.provideMerge(DevinSessionRepository.layer),
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(Layer.succeed(DevinClient, fake.client)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEVIN_API_KEY: "test-key",
      DEVIN_ORGANIZATION_ID: "org-test",
      GITHUB_WEBHOOK_SECRET: "test-secret",
      SQLITE_DB_FILEPATH: ":memory:",
      ...env,
    }))),
  );
}

const seed = Effect.fnUntraced(function* (
  db: AppDatabase,
  id: string,
  overrides: Partial<SessionRecord> = {},
  deliveryOverrides: Partial<DeliveryRecord> = {},
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* db.insert(githubWebhookDeliveries).values({
    id: `delivery-row-${id}`,
    deliveryId: `delivery-${id}`,
    eventName: "issues",
    repo: "owner/repo",
    issueNumber: 123,
    payload:
      '{"action":"labeled","label":{"name":"devin"},"issue":{"number":123,"title":"Fix this"}}',
    insertedAt: now,
    ...deliveryOverrides,
  });
  yield* db.insert(devinSessions).values({
    id,
    githubDeliveryId: `delivery-${id}`,
    status: "pending",
    insertedAt: now,
    updatedAt: now,
    ...overrides,
  });
});

const row = Effect.fnUntraced(function* (db: AppDatabase, id: string) {
  const result = yield* db.select().from(devinSessions).where(
    eq(devinSessions.id, id),
  ).get();
  assert.ok(result);
  return result;
});

function orchestrationTest(
  name: string,
  test: (fixture: {
    db: AppDatabase;
    repository: DevinSessionRepository["Service"];
    orchestra: DevinSessionOrchestrator["Service"];
    fake: ReturnType<typeof fakeClient>;
  }) => Effect.Effect<void, unknown>,
  env: Env = {},
  processors: Layer.Layer<WebhookEventProcessors> =
    WebhookEventProcessors.layer,
) {
  Deno.test(name, () => {
    const fake = fakeClient();
    return Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        const repository = yield* DevinSessionRepository;
        const orchestra = yield* DevinSessionOrchestrator;
        yield* test({ db, repository, orchestra, fake });
      }).pipe(Effect.provide(testLayer(fake, env, processors)), Effect.scoped),
    );
  });
}

Deno.test("analysis collection resumes from a reopened SQLite database without resetting backoff", async () => {
  const directory = await Deno.makeTempDir();
  const env = { SQLITE_DB_FILEPATH: `${directory}/restart.sqlite` };
  const fake = fakeClient();
  fake.behavior.insights = () =>
    Effect.succeed([completedInsights("devin-restart")]);
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const { db } = yield* DatabaseClient;
          yield* seed(db, "restart", {
            status: "succeeded",
            devinSessionId: "devin-restart",
            output: { outcome: "fixed", summary: "Verified." },
          });
          yield* (yield* DevinSessionOrchestrator).tick;
          assert.equal((yield* row(db, "restart")).analysisAttempts, 1);
        }).pipe(Effect.provide(testLayer(fake, env)), Effect.scoped);
        yield* Effect.gen(function* () {
          const { db } = yield* DatabaseClient;
          const orchestra = yield* DevinSessionOrchestrator;
          yield* orchestra.tick;
          assert.equal(fake.insights.length, 1);
          yield* TestClock.adjust("30 seconds");
          fake.behavior.insights = () =>
            Effect.succeed([{
              ...completedInsights("devin-restart"),
              analysis: { issues: [], action_items: ["Improve setup"] },
            }]);
          yield* orchestra.tick;
          const saved = yield* row(db, "restart");
          assert.equal(saved.analysisAttempts, 2);
          assert.equal(saved.analysisStatus, "collected");
          assert.deepEqual(saved.analysis, {
            issues: [],
            action_items: ["Improve setup"],
          });
          assert.deepEqual(fake.generations, ["devin-restart"]);
        }).pipe(Effect.provide(testLayer(fake, env)), Effect.scoped);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("analysis collection runs through the real Devin client and persists generated HTTP analysis", () => {
  const requests: string[] = [];
  let generated = false;
  const analysis = {
    classification: { category: "bug_fixing", confidence: 0.95 },
    issues: [],
    timeline: [{ title: "Verified fix", description: "Tests passed." }],
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method} ${url.pathname}`);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-key",
    );
    if (url.pathname.endsWith("/insights/generate")) {
      assert.equal(init?.method, "POST");
      generated = true;
      return Promise.resolve(Response.json({
        session_id: "devin-http-analysis",
        status: "started",
      }));
    }
    assert.equal(url.pathname, "/v3/organizations/org-test/sessions/insights");
    assert.deepEqual(url.searchParams.getAll("session_ids"), [
      "devin-http-analysis",
    ]);
    return Promise.resolve(Response.json({
      items: [{
        ...completedInsights("devin-http-analysis"),
        analysis: generated ? analysis : null,
      }],
      has_next_page: false,
      end_cursor: null,
    }));
  };
  const live = DevinSessionOrchestrator.layer.pipe(
    Layer.provide(WebhookEventProcessors.layer),
    Layer.provideMerge(DevinSessionRepository.layer),
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(DevinClient.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEVIN_API_KEY: "test-key",
      DEVIN_ORGANIZATION_ID: "org-test",
      GITHUB_WEBHOOK_SECRET: "test-secret",
      SQLITE_DB_FILEPATH: ":memory:",
    }))),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const orchestra = yield* DevinSessionOrchestrator;
      yield* seed(db, "http-analysis", {
        status: "succeeded",
        devinSessionId: "devin-http-analysis",
        output: { outcome: "fixed", summary: "Verified." },
      });
      yield* orchestra.tick;
      assert.equal((yield* row(db, "http-analysis")).analysisStatus, "pending");
      yield* TestClock.adjust("30 seconds");
      yield* orchestra.tick;
      const saved = yield* row(db, "http-analysis");
      assert.equal(saved.analysisStatus, "collected");
      assert.deepEqual(saved.analysis, analysis);
      assert.deepEqual(requests, [
        "GET /v3/organizations/org-test/sessions/insights",
        "POST /v3/organizations/org-test/sessions/devin-http-analysis/insights/generate",
        "GET /v3/organizations/org-test/sessions/insights",
      ]);
    }).pipe(
      Effect.provide(live),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(TestClock.layer()),
      Effect.scoped,
    ),
  );
});

orchestrationTest(
  "analysis generation is limited to three concurrent requests independently of remediation capacity",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      for (const id of ["a", "b", "c", "d"]) {
        yield* seed(db, id, {
          status: "failed",
          devinSessionId: `devin-${id}`,
          output: { outcome: "failed", summary: "Failed." },
        });
      }
      fake.behavior.insights = (ids) =>
        Effect.succeed(ids.map(completedInsights));
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let active = 0;
      let maximum = 0;
      fake.behavior.generate = (id) =>
        Effect.gen(function* () {
          active++;
          maximum = Math.max(maximum, active);
          if (active === 3) yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return { session_id: id, status: "started" as const };
        }).pipe(Effect.ensuring(Effect.sync(() => {
          active--;
        })));
      const tick = yield* orchestra.tick.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      assert.equal(fake.generations.length, 3);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(tick);
      assert.equal(maximum, 3);
      assert.equal(fake.generations.length, 3);
      yield* orchestra.tick;
      assert.equal(fake.generations.length, 4);
      assert.equal(
        (yield* row(db, "d")).analysisReason,
        "waiting for analysis",
      );
    }).pipe(Effect.scoped),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "1" },
);

orchestrationTest(
  "analysis collection batches finished remote sessions and preserves remediation output",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      const output = {
        outcome: "fixed" as const,
        summary: "Verified fix.",
        confidence: 0.7,
      };
      for (const id of ["a", "b"]) {
        yield* seed(db, id, {
          status: id === "a" ? "succeeded" : "failed",
          devinSessionId: `devin-${id}`,
          output,
          prNumber: 17,
        });
      }
      yield* seed(db, "local-failure", { status: "failed", output });
      yield* seed(db, "skipped", { status: "skipped" });
      const before = yield* row(db, "a");
      const analysis = {
        classification: { category: "bug_fixing", confidence: 0.99 },
        action_items: [],
        future_field: ["keep", "all", "data"],
      };
      fake.behavior.insights = (ids) =>
        Effect.succeed(
          ids.map((id) => ({ ...completedInsights(id), analysis })),
        );
      yield* orchestra.tick;
      yield* orchestra.tick;
      assert.deepEqual(fake.insights, [["devin-a", "devin-b"]]);
      assert.deepEqual(fake.generations, []);
      for (const id of ["a", "b"]) {
        const saved = yield* row(db, id);
        assert.equal(saved.analysisStatus, "collected");
        assert.deepEqual(saved.analysis, analysis);
        assert.deepEqual(saved.output, output);
        assert.equal(saved.prNumber, 17);
        assert.equal(saved.status, id === "a" ? "succeeded" : "failed");
      }
      assert.equal((yield* row(db, "a")).updatedAt, before.updatedAt);
      assert.equal((yield* row(db, "local-failure")).analysisAttempts, 0);
    }),
);

orchestrationTest(
  "slow generation cannot exhaust an already available analysis behind other sessions",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
        yield* seed(db, id, {
          status: "succeeded",
          devinSessionId: `devin-${id}`,
          output: { outcome: "fixed", summary: "Verified." },
        });
      }
      fake.behavior.generate = () => Effect.never;
      for (let round = 0; round < 3; round++) {
        const started = yield* Deferred.make<void>();
        fake.behavior.insights = (ids) =>
          Deferred.succeed(started, undefined).pipe(Effect.as(
            ids.map((id) => ({
              ...completedInsights(id),
              analysis: id === "devin-g" ? { ready: true } : null,
            })),
          ));
        const tick = yield* orchestra.tick.pipe(Effect.forkScoped);
        yield* Effect.race(Deferred.await(started), Fiber.join(tick));
        yield* TestClock.adjust("15 seconds");
        yield* Fiber.join(tick);
      }
      const saved = yield* row(db, "g");
      assert.equal(saved.analysisStatus, "collected");
      assert.deepEqual(saved.analysis, { ready: true });
      assert.equal(saved.analysisAttempts, 1);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  { DEVIN_ANALYSIS_MAX_ATTEMPTS: "1" },
);

orchestrationTest(
  "missing analysis triggers generation and respects persisted exponential backoff before collection",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "small", {
        status: "succeeded",
        devinSessionId: "devin-small",
        output: { outcome: "fixed", summary: "Verified." },
      });
      fake.behavior.insights = () =>
        Effect.succeed([completedInsights("devin-small")]);
      fake.behavior.generate = (id) =>
        Effect.succeed({ session_id: id, status: "already_exists" });
      yield* orchestra.tick;
      assert.equal((yield* row(db, "small")).analysisStatus, "pending");
      assert.deepEqual(fake.generations, ["devin-small"]);
      yield* TestClock.adjust("29 seconds");
      yield* orchestra.tick;
      assert.equal(fake.insights.length, 1);
      yield* TestClock.adjust("1 second");
      yield* orchestra.tick;
      assert.equal(fake.insights.length, 2);
      yield* TestClock.adjust("59 seconds");
      yield* orchestra.tick;
      assert.equal(fake.insights.length, 2);
      fake.behavior.insights = () =>
        Effect.succeed([{
          ...completedInsights("devin-small"),
          analysis: { issues: [], timeline: [] },
        }]);
      yield* TestClock.adjust("1 second");
      yield* orchestra.tick;
      assert.equal((yield* row(db, "small")).analysisStatus, "collected");
      assert.equal(fake.insights.length, 3);
      assert.deepEqual(fake.generations, ["devin-small", "devin-small"]);
    }).pipe(Effect.provide(TestClock.layer())),
);

orchestrationTest(
  "analysis collection skips zero-message sessions and retries missing or still-running sessions",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      for (const id of ["empty", "missing", "resumed"]) {
        yield* seed(db, id, {
          status: "failed",
          devinSessionId: `devin-${id}`,
          output: { outcome: "failed", summary: "Failed." },
        });
      }
      fake.behavior.insights = () =>
        Effect.succeed([
          { ...completedInsights("devin-empty"), num_devin_messages: 0 },
          {
            ...completedInsights("devin-resumed"),
            status: "running",
            status_detail: "working",
          },
        ]);
      yield* orchestra.tick;
      assert.equal((yield* row(db, "empty")).analysisStatus, "unavailable");
      assert.equal((yield* row(db, "missing")).analysisStatus, "pending");
      assert.match((yield* row(db, "missing")).analysisReason!, /missing/);
      assert.equal((yield* row(db, "resumed")).analysisStatus, "pending");
      assert.deepEqual(fake.generations, []);
    }),
);

orchestrationTest(
  "insights failures do not block submissions and collection stops after the configured attempt limit",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "finished", {
        status: "succeeded",
        devinSessionId: "devin-finished",
        output: { outcome: "fixed", summary: "Verified." },
      });
      yield* seed(db, "new");
      fake.behavior.insights = () =>
        Effect.fail(new DevinLookupError({ cause: "503" }));
      yield* orchestra.tick;
      assert.equal((yield* row(db, "new")).status, "running");
      assert.equal((yield* row(db, "finished")).status, "succeeded");
      assert.equal((yield* row(db, "finished")).analysisStatus, "pending");
      yield* TestClock.adjust("30 seconds");
      fake.behavior.insights = () =>
        Effect.succeed([completedInsights("devin-finished")]);
      fake.behavior.generate = () =>
        Effect.fail(new DevinLookupError({ cause: "403" }));
      yield* orchestra.tick;
      yield* TestClock.adjust("60 seconds");
      yield* orchestra.tick;
      const saved = yield* row(db, "finished");
      assert.equal(saved.analysisStatus, "unavailable");
      assert.equal(saved.analysisAttempts, 2);
      assert.match(
        saved.analysisReason!,
        /Attempts exhausted: insights generation request failed/,
      );
      assert.equal(saved.analysis, null);
      assert.deepEqual(saved.output, {
        outcome: "fixed",
        summary: "Verified.",
      });
      assert.equal(fake.insights.length, 2);
      assert.equal(fake.generations.length, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  { DEVIN_ANALYSIS_MAX_ATTEMPTS: "2" },
);

orchestrationTest(
  "analysis claims are bounded, survive abandoned work, and reject stale results",
  ({ db, repository }) =>
    Effect.gen(function* () {
      for (let i = 0; i < 4; i++) {
        yield* seed(db, `finished-${String(i).padStart(2, "0")}`, {
          status: "succeeded",
          devinSessionId: `devin-${i}`,
          output: { outcome: "fixed", summary: "Verified." },
        });
      }
      const first = yield* repository.claimDueAnalyses;
      assert.equal(first.length, 3);
      const second = yield* repository.claimDueAnalyses;
      assert.equal(second.length, 1);
      assert.deepEqual(yield* repository.claimDueAnalyses, []);
      yield* TestClock.adjust("30 seconds");
      const recovered = yield* repository.claimDueAnalyses;
      assert.equal(recovered.length, 3);
      assert.equal(recovered[0].id, first[0].id);
      assert.equal(recovered[0].analysisAttempts, 2);
      yield* repository.recordAnalysis(first[0], {
        status: "collected",
        analysis: { obsolete: true },
      });
      assert.equal((yield* row(db, first[0].id)).analysis, null);
      yield* repository.recordAnalysis(recovered[0], {
        status: "collected",
        analysis: { current: true },
      });
      yield* repository.recordAnalysis(first[0], {
        status: "unavailable",
        reason: "stale error",
      });
      assert.deepEqual((yield* row(db, first[0].id)).analysis, {
        current: true,
      });
      assert.equal((yield* row(db, first[0].id)).analysisStatus, "collected");
    }).pipe(Effect.provide(TestClock.layer())),
);

orchestrationTest(
  "analysis collection timeout leaves retryable work without hanging the tick",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "timeout", {
        status: "succeeded",
        devinSessionId: "devin-timeout",
        output: { outcome: "fixed", summary: "Verified." },
      });
      const started = yield* Deferred.make<void>();
      fake.behavior.insights = () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
      const tick = yield* orchestra.tick.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* TestClock.adjust("15 seconds");
      yield* Fiber.join(tick);
      const saved = yield* row(db, "timeout");
      assert.equal(saved.analysisStatus, "pending");
      assert.equal(saved.analysisAttempts, 1);
      assert.equal(saved.status, "succeeded");
      assert.equal(saved.analysisReason, "collection interrupted");
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
);

Deno.test("issue processing recovers a lost HTTP creation response through paginated tag lookup", async () => {
  let posts = 0;
  const pages: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (new URL(String(input)).pathname.endsWith("/playbooks")) {
      assert.equal(init?.method, "GET");
      return Promise.resolve(Response.json({
        items: [playbook],
        has_next_page: false,
        end_cursor: null,
      }));
    }
    if (init?.method === "POST") {
      posts++;
      assert.ok(init.body instanceof Uint8Array);
      const request = JSON.parse(new TextDecoder().decode(init.body));
      assert.equal(request.playbook_id, "playbook-test");
      assert.deepEqual(request.tags, [
        "delivery-id:delivery-http",
        "github:owner/repo",
        "issue:123",
      ]);
      return Promise.resolve(new Response("{lost response"));
    }
    const url = new URL(String(input));
    assert.deepEqual(url.searchParams.getAll("tags"), [
      "delivery-id:delivery-http",
    ]);
    const page = `${url.searchParams.get("is_archived")}:${
      url.searchParams.get("after")
    }`;
    pages.push(page);
    return Promise.resolve(Response.json(
      page === "false:null"
        ? {
          items: [{ ...remote, tags: ["issue:123"] }],
          has_next_page: true,
          end_cursor: "next",
        }
        : {
          items: page === "false:next"
            ? [{
              ...remote,
              tags: ["delivery-id:delivery-http", "issue:123"],
              status: "exit",
              status_detail: "finished",
              structured_output: {
                outcome: "fixed",
                summary: "Regression test passes; PR opened.",
                verification: {
                  status: "passed",
                  evidence: ["deno test: passed"],
                },
                blocker: null,
                next_action: "Review https://github.com/owner/repo/pull/21",
                confidence: 0.9,
              },
              pull_requests: [{
                pr_url: "https://github.com/owner/repo/pull/21",
                pr_state: "open",
              }],
            }]
            : [],
          has_next_page: false,
          end_cursor: null,
        },
    ));
  };
  const layer = DevinSessionOrchestrator.layer.pipe(
    Layer.provide(WebhookEventProcessors.layer),
    Layer.provideMerge(DevinSessionRepository.layer),
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(DevinClient.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEVIN_API_KEY: "test-key",
      DEVIN_ORGANIZATION_ID: "org-test",
      GITHUB_WEBHOOK_SECRET: "test-secret",
      SQLITE_DB_FILEPATH: ":memory:",
    }))),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const orchestra = yield* DevinSessionOrchestrator;
      yield* seed(db, "http");
      yield* orchestra.tick;
      assert.equal((yield* row(db, "http")).status, "submitting");
      yield* db.update(devinSessions).set({
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      yield* orchestra.tick;
      const saved = yield* row(db, "http");
      assert.equal(saved.status, "succeeded");
      assert.deepEqual(saved.output, {
        outcome: "fixed",
        summary: "Regression test passes; PR opened.",
        verification: { status: "passed", evidence: ["deno test: passed"] },
        blocker: null,
        next_action: "Review https://github.com/owner/repo/pull/21",
        confidence: 0.9,
      });
      assert.equal(saved.devinSessionId, "devin-created");
      assert.equal(saved.prNumber, 21);
      assert.equal(saved.attempts, 1);
      yield* orchestra.tick;
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  assert.equal(posts, 1);
  assert.deepEqual(pages, ["false:null", "false:next", "true:null"]);
});

orchestrationTest(
  "a lost playbook response retries the prerequisite next tick and reuses it without session recovery",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      let exists = false;
      let playbookPosts = 0;
      fake.behavior.findPlaybook = () =>
        Effect.succeed(exists ? playbook : undefined);
      fake.behavior.createPlaybook = () => {
        playbookPosts++;
        exists = true;
        return Effect.fail(
          new DevinSubmissionError({
            disposition: "ambiguous",
          }),
        );
      };
      yield* seed(db, "playbook");
      yield* orchestra.tick;
      assert.equal((yield* row(db, "playbook")).status, "pending");
      assert.equal(fake.creates.length, 0);
      assert.deepEqual(fake.lookups, []);
      yield* orchestra.tick;
      const saved = yield* row(db, "playbook");
      assert.equal(saved.status, "running");
      assert.equal(saved.devinSessionId, "devin-created-1");
      assert.equal(saved.attempts, 2);
      assert.equal(playbookPosts, 1);
      assert.equal(fake.creates.length, 1);
      assert.equal(fake.creates[0].playbook_id, "playbook-test");
      assert.deepEqual(fake.lookups, []);
    }),
);

orchestrationTest(
  "pending work is committed as submitting before POST; repeated ticks do not duplicate it",
  ({ db, orchestra, repository, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      fake.behavior.create = () =>
        Effect.gen(function* () {
          const claimed = yield* row(db, "one");
          assert.equal(claimed.status, "submitting");
          assert.equal(claimed.attempts, 1);
          assert.equal(claimed.devinSessionId, null);
          assert.deepEqual(yield* repository.claimPending, []);
          return remote;
        }).pipe(Effect.orDie);
      yield* orchestra.tick;
      const saved = yield* row(db, "one");
      assert.equal(saved.status, "running");
      assert.equal(saved.devinSessionId, "devin-created");
      assert.equal(saved.attempts, 1);
      assert.deepEqual(fake.creates[0].repos, ["owner/repo"]);
      assert.deepEqual(fake.creates[0].tags, [
        "delivery-id:delivery-one",
        "github:owner/repo",
        "issue:123",
      ]);
      assert.match(fake.creates[0].prompt, /Delivery: delivery-one/);
      assert.match(fake.creates[0].prompt, /Issue: 123/);
      assert.match(fake.creates[0].prompt, /"title":"Fix this"/);
      yield* orchestra.tick;
      yield* orchestra.tick;
      assert.equal(fake.creates.length, 1);
      assert.deepEqual(fake.lists, [["devin-created"], ["devin-created"]]);
    }),
);

for (const [running, submitting, starts] of [[2, 0, 0], [1, 0, 1], [1, 1, 0]]) {
  orchestrationTest(
    `capacity includes ${running} running + ${submitting} submitting; starts ${starts}`,
    ({ db, orchestra, fake }) =>
      Effect.gen(function* () {
        for (let i = 0; i < running; i++) {
          yield* seed(db, `r${i}`, {
            status: "running",
            devinSessionId: `remote-${i}`,
          });
        }
        for (let i = 0; i < submitting; i++) {
          yield* seed(db, `s${i}`, { status: "submitting" });
        }
        for (let i = 0; i < 3; i++) yield* seed(db, `p${i}`);
        yield* orchestra.tick;
        assert.equal(fake.creates.length, starts);
        const sessions = yield* db.select().from(devinSessions);
        assert.equal(
          sessions.filter((s) => s.status === "pending").length,
          3 - starts,
        );
        assert.equal(
          sessions.filter((s) =>
            s.status === "running" || s.status === "submitting"
          ).length,
          2,
        );
      }),
    { DEVIN_MAX_CONCURRENT_SESSIONS: "2" },
  );
}

orchestrationTest(
  "concurrent repository claims count capacity transactionally and never claim an ID twice",
  ({ db, repository, fake }) =>
    Effect.gen(function* () {
      for (let i = 0; i < 6; i++) yield* seed(db, `p${i}`);
      const claims = yield* Effect.all(
        [
          repository.claimPending,
          repository.claimPending,
          repository.claimPending,
        ],
        { concurrency: "unbounded" },
      );
      const ids = claims.flat().map((work) => work.session.id);
      assert.deepEqual(ids, ["p0", "p1"]);
      assert.equal(new Set(ids).size, 2);
      assert.equal(fake.creates.length, 0);
      for (const id of ids) {
        assert.equal((yield* row(db, id)).status, "submitting");
        assert.equal((yield* row(db, id)).attempts, 1);
      }
    }),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "2" },
);

orchestrationTest(
  "overlapping ticks serialize even when a live POST exceeds the stale timeout",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      const started = yield* Deferred.make<void>();
      const response = yield* Deferred.make<DevinSession>();
      fake.behavior.create = () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(response)),
        );
      yield* Effect.gen(function* () {
        const first = yield* orchestra.tick.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const second = yield* orchestra.tick.pipe(Effect.forkScoped);
        yield* TestClock.adjust("2 minutes");
        assert.equal((yield* row(db, "one")).status, "submitting");
        assert.equal(fake.creates.length, 1);
        yield* Deferred.succeed(response, remote);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.equal(fake.creates.length, 1);
        assert.equal((yield* row(db, "one")).status, "running");
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped);
    }),
);

orchestrationTest(
  "polling batches 200 IDs, retains a failed batch, and continues with subsequent batches",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 201 }, (_, i) => `remote-${i}`);
      for (const id of ids) {
        yield* seed(db, id, { status: "running", devinSessionId: id });
      }
      yield* seed(db, "pending");
      let failBatch = true;
      fake.behavior.list = (batch) =>
        failBatch && batch.length === 200
          ? Effect.fail(new DevinLookupError({ cause: "List unavailable" }))
          : Effect.succeed(
            batch.toReversed().map((session_id) => ({
              ...remote,
              session_id,
              status: "exit" as const,
              status_detail: "finished" as const,
              structured_output: { outcome: "fixed", summary: session_id },
            })),
          );
      yield* orchestra.tick;
      assert.deepEqual(fake.lists.map((batch) => batch.length), [200, 1]);
      assert.deepEqual(new Set(fake.lists.flat()), new Set(ids));
      for (const id of fake.lists[0]) {
        const saved = yield* row(db, id);
        assert.equal(saved.status, "running");
        assert.equal(saved.devinSessionId, id);
        assert.equal(saved.output, null);
      }
      const completed = fake.lists[1][0];
      assert.equal((yield* row(db, completed)).status, "succeeded");
      assert.deepEqual((yield* row(db, completed)).output, {
        outcome: "fixed",
        summary: completed,
      });
      assert.equal((yield* row(db, "pending")).status, "running");
      assert.equal(fake.creates.length, 1);
      failBatch = false;
      yield* orchestra.tick;
      for (const id of ids) {
        const saved = yield* row(db, id);
        assert.equal(saved.status, "succeeded");
        assert.deepEqual(saved.output, { outcome: "fixed", summary: id });
      }
    }),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "201" },
);

Deno.test("polling reconciles paginated list responses through the real client without detail requests", () => {
  const requests: (string | null)[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/v3/organizations/org-test/sessions");
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init.headers).get("authorization"),
      "Bearer test-key",
    );
    assert.equal(url.searchParams.get("first"), "200");
    assert.deepEqual(
      new Set(url.searchParams.getAll("session_ids")),
      new Set(["done", "running", "missing"]),
    );
    const after = url.searchParams.get("after");
    requests.push(after);
    return Promise.resolve(Response.json(
      after === null
        ? {
          items: [{ ...remote, session_id: "running", status: "running" }],
          has_next_page: true,
          end_cursor: "page-2",
        }
        : {
          items: [{
            ...remote,
            session_id: "done",
            status: "exit",
            status_detail: "finished",
            structured_output: { outcome: "fixed", summary: "Verified fix." },
            pull_requests: [{
              pr_url: "https://github.com/owner/repo/pull/42",
              pr_state: "open",
            }],
          }],
          has_next_page: false,
          end_cursor: null,
        },
    ));
  };
  const layer = DevinSessionOrchestrator.layer.pipe(
    Layer.provide(WebhookEventProcessors.layer),
    Layer.provideMerge(DevinSessionRepository.layer),
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(DevinClient.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEVIN_API_KEY: "test-key",
      DEVIN_ORGANIZATION_ID: "org-test",
      GITHUB_WEBHOOK_SECRET: "test-secret",
      SQLITE_DB_FILEPATH: ":memory:",
    }))),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const orchestra = yield* DevinSessionOrchestrator;
      for (const id of ["done", "running", "missing"]) {
        yield* seed(db, id, {
          status: "running",
          devinSessionId: id,
          analysisNextAttemptAt: "9999-01-01T00:00:00.000Z",
        });
      }
      const running = yield* row(db, "running");
      const missing = yield* row(db, "missing");
      yield* orchestra.tick;
      assert.deepEqual(requests, [null, "page-2"]);
      const done = yield* row(db, "done");
      assert.equal(done.status, "succeeded");
      assert.equal(done.prNumber, 42);
      assert.deepEqual(done.output, {
        outcome: "fixed",
        summary: "Verified fix.",
      });
      assert.deepEqual(yield* row(db, "running"), running);
      assert.deepEqual(yield* row(db, "missing"), missing);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.scoped,
    ),
  );
});

orchestrationTest(
  "completion persists the matching repository PR and frees capacity in the same tick",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "running", {
        status: "running",
        devinSessionId: "existing",
      });
      yield* seed(db, "pending");
      fake.behavior.list = () =>
        Effect.succeed([{
          ...remote,
          session_id: "existing",
          status: "exit",
          status_detail: "finished",
          structured_output: { outcome: "fixed", summary: "Verified fix." },
          pull_requests: [
            {
              pr_url: "https://github.com/unrelated/repo/pull/12",
              pr_state: "open",
            },
            {
              pr_url: "https://github.com/owner/repo/pull/42",
              pr_state: "open",
            },
          ],
        }]);
      yield* orchestra.tick;
      assert.deepEqual(fake.lists, [["existing"]]);
      assert.equal((yield* row(db, "running")).status, "succeeded");
      assert.deepEqual((yield* row(db, "running")).output, {
        outcome: "fixed",
        summary: "Verified fix.",
      });
      assert.equal((yield* row(db, "running")).prNumber, 42);
      assert.equal((yield* row(db, "pending")).status, "running");
      assert.equal(fake.creates.length, 1);
    }),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "1" },
);

orchestrationTest(
  "terminal remediation results remain unchanged and a remote terminal failure is not retried",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "success", {
        status: "succeeded",
        output: { outcome: "fixed", summary: "Verified fix." },
        devinSessionId: "success",
        prNumber: 17,
      });
      yield* seed(db, "failed", {
        status: "failed",
        output: { outcome: "failed", summary: "Remediation failed." },
      });
      yield* seed(db, "running", {
        status: "running",
        devinSessionId: "failure",
      });
      const success = yield* row(db, "success");
      const failure = yield* row(db, "failed");
      fake.behavior.list = () =>
        Effect.succeed([{
          ...remote,
          session_id: "failure",
          status: "error",
          structured_output: {
            outcome: "failed",
            summary: "Remediation failed.",
          },
        }]);
      yield* orchestra.tick;
      yield* orchestra.tick;
      const saved = yield* row(db, "success");
      for (
        const field of [
          "status",
          "output",
          "devinSessionId",
          "prNumber",
          "attempts",
          "claimVersion",
          "recoveryEmptyChecks",
          "recoveryBlocked",
          "insertedAt",
          "updatedAt",
        ] as const
      ) {
        assert.deepEqual(saved[field], success[field], field);
      }
      assert.deepEqual(yield* row(db, "failed"), failure);
      assert.equal((yield* row(db, "running")).status, "failed");
      assert.deepEqual(fake.lists, [["failure"]]);
      assert.equal(fake.creates.length, 0);
    }),
);

orchestrationTest(
  "missing list results keep their remote identity and capacity while returned rows reconcile",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one", {
        status: "running",
        devinSessionId: "unavailable",
      });
      yield* seed(db, "two", { status: "running", devinSessionId: "done" });
      yield* seed(db, "three");
      const before = yield* row(db, "one");
      fake.behavior.list = () =>
        Effect.succeed([{
          ...remote,
          session_id: "done",
          status: "exit",
          status_detail: "finished",
          structured_output: {
            outcome: "needs_human",
            summary: "Review needed.",
          },
        }]);
      yield* orchestra.tick;
      assert.deepEqual(yield* row(db, "one"), before);
      assert.equal((yield* row(db, "two")).status, "succeeded");
      assert.equal((yield* row(db, "three")).status, "running");
      assert.equal(fake.creates.length, 1);
    }),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "2" },
);

orchestrationTest(
  "definite retryable rejection consumes one attempt per tick and eventually fails",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      fake.behavior.create = () =>
        Effect.fail(
          new DevinSubmissionError({
            disposition: "retryable",
            httpStatus: 429,
          }),
        );
      for (let attempt = 1; attempt <= 3; attempt++) {
        yield* orchestra.tick;
        const saved = yield* row(db, "one");
        assert.equal(saved.attempts, attempt);
        assert.equal(saved.status, attempt === 3 ? "failed" : "pending");
        assert.deepEqual(
          saved.output,
          attempt === 3
            ? {
              outcome: "failed",
              summary: "Submission rejected; retry attempts exhausted.",
            }
            : null,
        );
        assert.equal(saved.devinSessionId, null);
        assert.equal(fake.creates.length, attempt);
      }
      yield* orchestra.tick;
      assert.equal(fake.creates.length, 3);
    }),
);

orchestrationTest(
  "permanent submission rejection fails immediately",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      fake.behavior.create = () =>
        Effect.fail(
          new DevinSubmissionError({
            disposition: "permanent",
            httpStatus: 401,
          }),
        );
      yield* orchestra.tick;
      yield* orchestra.tick;
      assert.equal((yield* row(db, "one")).status, "failed");
      assert.deepEqual((yield* row(db, "one")).output, {
        outcome: "failed",
        summary: "Submission permanently rejected before session creation.",
      });
      assert.equal((yield* row(db, "one")).attempts, 1);
      assert.equal(fake.creates.length, 1);
    }),
);

orchestrationTest(
  "ambiguous submission waits for stale recovery rather than immediately POSTing again",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      fake.behavior.create = () =>
        Effect.fail(new DevinSubmissionError({ disposition: "ambiguous" }));
      yield* orchestra.tick;
      yield* orchestra.tick;
      assert.equal(fake.creates.length, 1);
      assert.equal((yield* row(db, "one")).status, "submitting");
      assert.equal((yield* row(db, "one")).attempts, 1);
    }),
);

orchestrationTest(
  "stale submissions need two empty lookups before retry or exhaustion; fresh claims stay active",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "stale", {
        status: "submitting",
        attempts: 1,
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      yield* seed(db, "exhausted", {
        status: "submitting",
        attempts: 3,
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      yield* seed(db, "fresh", { status: "submitting", attempts: 1 });
      yield* orchestra.tick;
      assert.equal((yield* row(db, "stale")).status, "submitting");
      assert.equal((yield* row(db, "exhausted")).status, "submitting");
      assert.equal(fake.creates.length, 0);
      assert.equal(fake.lookups.length, 2);
      yield* orchestra.tick;
      assert.equal(fake.lookups.length, 2);
      for (const id of ["stale", "exhausted"]) {
        yield* db.update(devinSessions).set({
          updatedAt: "2000-01-01T00:00:00.000Z",
        }).where(eq(devinSessions.id, id));
      }
      yield* orchestra.tick;
      assert.equal((yield* row(db, "stale")).status, "running");
      assert.equal((yield* row(db, "stale")).attempts, 2);
      assert.equal((yield* row(db, "exhausted")).status, "failed");
      assert.deepEqual((yield* row(db, "exhausted")).output, {
        outcome: "failed",
        summary:
          "Submission attempts exhausted after repeated empty recovery lookups.",
      });
      assert.equal((yield* row(db, "exhausted")).attempts, 3);
      assert.equal((yield* row(db, "fresh")).status, "submitting");
      assert.equal(fake.creates.length, 1);
    }),
);

orchestrationTest(
  "a recovery claim fences the original submitter without spending an attempt",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      const [old] = yield* repository.claimPending;
      yield* db.update(devinSessions).set({
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      const [current] = yield* repository.claimStale;
      assert.equal(current.session.attempts, 1);
      assert.deepEqual(yield* repository.claimPending, []);
      assert.equal(
        yield* repository.markRunning(old.session, "old-remote"),
        false,
      );
      assert.deepEqual(
        yield* repository.rejectSubmission(old.session, false),
        [],
      );
      assert.equal(
        yield* repository.markRunning(current.session, "new-remote"),
        true,
      );
      assert.equal((yield* row(db, "one")).devinSessionId, "new-remote");
      assert.equal(yield* repository.markSkipped(current.session), false);
      assert.equal((yield* row(db, "one")).status, "running");
    }),
);

for (
  const [status, status_detail, expected] of [
    ["running", "working", "running"],
    ["exit", "finished", "succeeded"],
    ["error", "error", "failed"],
  ] as const
) {
  orchestrationTest(
    `tag recovery associates ${expected} sessions even at the attempt limit`,
    ({ db, orchestra, fake }) =>
      Effect.gen(function* () {
        yield* seed(db, "lost", {
          status: "submitting",
          attempts: 3,
          updatedAt: "2000-01-01T00:00:00.000Z",
        });
        fake.behavior.lookup = () =>
          Effect.succeed([{
            ...remote,
            tags: ["delivery-id:delivery-lost"],
            status,
            status_detail,
            pull_requests: [{
              pr_url: "https://github.com/owner/repo/pull/17",
              pr_state: "open",
            }],
          }]);
        yield* orchestra.tick;
        const saved = yield* row(db, "lost");
        assert.equal(saved.status, expected);
        assert.equal(
          saved.output?.outcome ?? null,
          expected === "running"
            ? null
            : expected === "succeeded"
            ? "needs_human"
            : "failed",
        );
        assert.equal(saved.devinSessionId, "devin-created");
        assert.equal(saved.attempts, 3);
        assert.equal(saved.prNumber, expected === "running" ? null : 17);
        assert.deepEqual(fake.lookups, ["delivery-id:delivery-lost"]);
        assert.equal(fake.creates.length, 0);
        yield* orchestra.tick;
        assert.equal(fake.creates.length, 0);
      }),
  );
}

for (
  const outcome of [
    "fixed",
    "needs_human",
    "not_reproducible",
    "failed",
    "already_resolved",
  ] as const
) {
  orchestrationTest(
    `polling persists ${outcome} without confusing task outcome with lifecycle status`,
    ({ db, orchestra, fake }) =>
      Effect.gen(function* () {
        yield* seed(db, "result", {
          status: "running",
          devinSessionId: "result",
        });
        fake.behavior.list = () =>
          Effect.succeed([{
            ...remote,
            session_id: "result",
            status: "exit",
            status_detail: "finished",
            structured_output: {
              outcome,
              summary: "Investigation complete.",
              verification: {
                status: "partial",
                evidence: ["unit tests: passed"],
              },
              blocker: "Browser environment unavailable.",
              next_action: "Reviewer: run browser checks.",
              confidence: 0.8,
            },
          }]);
        yield* orchestra.tick;
        const saved = yield* row(db, "result");
        assert.equal(saved.status, "succeeded");
        assert.deepEqual(saved.output, {
          outcome,
          summary: "Investigation complete.",
          verification: { status: "partial", evidence: ["unit tests: passed"] },
          blocker: "Browser environment unavailable.",
          next_action: "Reviewer: run browser checks.",
          confidence: 0.8,
        });
        yield* orchestra.tick;
        assert.deepEqual(yield* row(db, "result"), saved);
      }),
  );
}

orchestrationTest(
  "pending jobs with exhausted attempts receive a failed outcome without submission",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "exhausted", { attempts: 3 });
      yield* orchestra.tick;
      const saved = yield* row(db, "exhausted");
      assert.equal(saved.status, "failed");
      assert.deepEqual(saved.output, {
        outcome: "failed",
        summary: "Submission attempts exhausted before session creation.",
      });
      assert.equal(fake.creates.length, 0);
    }),
);

orchestrationTest(
  "duplicate matches durably block creation even if later lookup would return nothing",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "duplicate", {
        status: "submitting",
        attempts: 1,
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      fake.behavior.lookup = () =>
        Effect.succeed([
          { ...remote, tags: ["delivery-id:delivery-duplicate"] },
          {
            ...remote,
            session_id: "second",
            tags: ["delivery-id:delivery-duplicate"],
          },
        ]);
      yield* orchestra.tick;
      assert.equal((yield* row(db, "duplicate")).recoveryBlocked, true);
      fake.behavior.lookup = () => Effect.succeed([]);
      yield* db.update(devinSessions).set({
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      yield* orchestra.tick;
      const saved = yield* row(db, "duplicate");
      assert.equal(saved.status, "submitting");
      assert.equal(saved.devinSessionId, null);
      assert.equal(saved.attempts, 1);
      assert.equal(fake.lookups.length, 1);
      assert.equal(fake.creates.length, 0);
    }),
);

orchestrationTest(
  "lookup failures retain exhausted submissions and reset the repeated-empty requirement",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "unavailable", {
        status: "submitting",
        attempts: 3,
        recoveryEmptyChecks: 1,
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      fake.behavior.lookup = () =>
        Effect.fail(new DevinLookupError({ cause: "403" }));
      yield* orchestra.tick;
      let saved = yield* row(db, "unavailable");
      assert.equal(saved.status, "submitting");
      assert.equal(saved.recoveryEmptyChecks, 0);
      fake.behavior.lookup = () => Effect.succeed([]);
      yield* db.update(devinSessions).set({
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      yield* orchestra.tick;
      saved = yield* row(db, "unavailable");
      assert.equal(saved.status, "submitting");
      assert.equal(saved.recoveryEmptyChecks, 1);
      assert.equal(saved.attempts, 3);
      assert.equal(fake.creates.length, 0);
    }),
);

orchestrationTest(
  "a delayed match after an empty lookup recovers without retrying creation",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "delayed", {
        status: "submitting",
        attempts: 1,
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      yield* orchestra.tick;
      fake.behavior.lookup = () => Effect.succeed([remote]);
      yield* db.update(devinSessions).set({
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      yield* orchestra.tick;
      assert.equal((yield* row(db, "delayed")).devinSessionId, "devin-created");
      assert.equal((yield* row(db, "delayed")).status, "running");
      assert.equal(fake.creates.length, 0);
    }),
);

orchestrationTest(
  "an expired recovery owner cannot retry, block, or associate after takeover",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "stale", {
        status: "submitting",
        attempts: 1,
        recoveryEmptyChecks: 1,
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      const [old] = yield* repository.claimStale;
      assert.deepEqual(yield* repository.claimStale, []);
      yield* db.update(devinSessions).set({
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      const [current] = yield* repository.claimStale;
      for (const outcome of ["empty", "unavailable", "duplicates"] as const) {
        assert.deepEqual(
          yield* repository.recordRecoveryMiss(old.session, outcome),
          [],
        );
      }
      assert.equal(yield* repository.markRunning(old.session, "late"), false);
      assert.equal(
        yield* repository.markRunning(current.session, "recovered"),
        true,
      );
      assert.equal((yield* row(db, "stale")).devinSessionId, "recovered");
      assert.equal((yield* row(db, "stale")).attempts, 1);
    }),
);

orchestrationTest(
  "best-effort retries preserve tags and wait a full grace interval between empty lookups",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      fake.behavior.create = () =>
        Effect.fail(new DevinSubmissionError({ disposition: "ambiguous" }));
      yield* orchestra.tick;
      yield* TestClock.adjust("61 seconds");
      yield* orchestra.tick;
      assert.equal(fake.lookups.length, 1);
      assert.equal(fake.creates.length, 1);
      yield* TestClock.adjust("59 seconds");
      yield* orchestra.tick;
      assert.equal(fake.lookups.length, 1);
      fake.behavior.create = () => Effect.succeed(remote);
      yield* TestClock.adjust("2 seconds");
      yield* orchestra.tick;
      assert.equal(fake.lookups.length, 2);
      assert.equal(fake.creates.length, 2);
      assert.deepEqual(fake.creates.map((request) => request.tags), [
        ["delivery-id:delivery-one", "github:owner/repo", "issue:123"],
        ["delivery-id:delivery-one", "github:owner/repo", "issue:123"],
      ]);
      assert.equal((yield* row(db, "one")).status, "running");
      assert.equal((yield* row(db, "one")).attempts, 2);
    }).pipe(Effect.provide(TestClock.layer())),
);

orchestrationTest(
  "SQL failure during claiming rolls back and never submits",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      yield* db
        .$client`CREATE TRIGGER reject_claim BEFORE UPDATE ON devin_sessions
      WHEN NEW.status = 'submitting' BEGIN SELECT RAISE(ABORT, 'claim failed'); END`;
      const result = yield* Effect.result(orchestra.tick);
      assert.ok(Result.isFailure(result));
      assert.equal(fake.creates.length, 0);
      assert.equal((yield* row(db, "one")).status, "pending");
      assert.equal((yield* row(db, "one")).attempts, 0);
    }),
);

orchestrationTest(
  "successful POST with failing persistence retries only SQL and leaves the durable claim",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      yield* db
        .$client`CREATE TRIGGER reject_running BEFORE UPDATE ON devin_sessions
      WHEN NEW.status = 'running' BEGIN SELECT RAISE(ABORT, 'persistence failed'); END`;
      const result = yield* Effect.result(orchestra.tick);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure._tag, "DatabaseError");
      assert.equal(fake.creates.length, 1);
      assert.equal((yield* row(db, "one")).status, "submitting");
      assert.equal((yield* row(db, "one")).attempts, 1);
      yield* db.$client`DROP TRIGGER reject_running`;
      yield* orchestra.tick;
      assert.equal(fake.creates.length, 1);
    }),
);

orchestrationTest(
  "a transient persistence error saves the returned remote ID without another POST",
  ({ db, repository, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      let saves = 0;
      const repo = {
        ...repository,
        markRunning: (claim: SessionRecord, id: string) =>
          Effect.suspend(() => {
            saves++;
            return saves === 1
              ? Effect.fail(
                new DatabaseError({ cause: "transient disk error" }),
              )
              : repository.markRunning(claim, id);
          }),
      };
      yield* DevinSessionOrchestrator.use((o) => o.tick).pipe(
        Effect.provide(Layer.fresh(DevinSessionOrchestrator.layer)),
        Effect.provide(WebhookEventProcessors.layer),
        Effect.provideService(DevinSessionRepository, repo),
        Effect.provideService(DevinClient, fake.client),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
          DEVIN_API_KEY: "test",
          DEVIN_ORGANIZATION_ID: "test",
          GITHUB_WEBHOOK_SECRET: "test",
        }))),
      );
      assert.equal(saves, 2);
      assert.equal(fake.creates.length, 1);
      assert.equal((yield* row(db, "one")).devinSessionId, "devin-created-1");
    }),
);

Deno.test("restart reopens SQLite and reconciles the existing remote session without resubmission", async () => {
  const directory = await Deno.makeTempDir();
  const fake = fakeClient();
  const layer = testLayer(fake, {
    SQLITE_DB_FILEPATH: `${directory}/restart.sqlite`,
  });
  try {
    await Effect.runPromise(
      DatabaseClient.use(({ db }) =>
        seed(db, "existing", {
          status: "running",
          devinSessionId: "existing-session",
        })
      ).pipe(Effect.provide(layer)),
    );
    fake.behavior.list = () =>
      Effect.succeed([{
        ...remote,
        session_id: "existing-session",
        status: "exit",
        status_detail: "finished",
        structured_output: { outcome: "fixed", summary: "Verified fix." },
      }]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const orchestra = yield* DevinSessionOrchestrator;
        const { db } = yield* DatabaseClient;
        yield* orchestra.tick;
        assert.equal((yield* row(db, "existing")).status, "succeeded");
      }).pipe(Effect.provide(layer)),
    );
    assert.deepEqual(fake.lists, [["existing-session"]]);
    assert.equal(fake.creates.length, 0);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("independent workers sharing SQLite cannot reclaim a delivery while its recovery lookup is in flight", async () => {
  const directory = await Deno.makeTempDir();
  const fake = fakeClient();
  const env = { SQLITE_DB_FILEPATH: `${directory}/workers.sqlite` };
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const left = yield* Layer.build(testLayer(fake, env));
        const right = yield* Layer.build(testLayer(fake, env));
        const { db } = Context.get(left, DatabaseClient);
        assert.notEqual(db, Context.get(right, DatabaseClient).db);
        const first = Context.get(left, DevinSessionOrchestrator);
        const second = Context.get(right, DevinSessionOrchestrator);
        assert.notEqual(first, second);
        yield* seed(db, "shared", {
          status: "submitting",
          attempts: 1,
          recoveryEmptyChecks: 1,
          updatedAt: "2000-01-01T00:00:00.000Z",
        });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        fake.behavior.lookup = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return [];
          });
        const fiber = yield* first.tick.pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* second.tick;
        assert.equal(fake.lookups.length, 1);
        assert.equal(fake.creates.length, 0);
        assert.equal((yield* row(db, "shared")).status, "submitting");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        yield* second.tick;
        const saved = yield* row(db, "shared");
        assert.equal(saved.status, "running");
        assert.equal(saved.attempts, 2);
        assert.equal(saved.devinSessionId, "devin-created-1");
        assert.deepEqual(fake.lookups, ["delivery-id:delivery-shared"]);
        assert.equal(fake.creates.length, 1);
      }).pipe(Effect.scoped),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("restart recovers a lost creation response by tag without another POST", async () => {
  const directory = await Deno.makeTempDir();
  const fake = fakeClient();
  const layer = testLayer(fake, {
    SQLITE_DB_FILEPATH: `${directory}/lost.sqlite`,
  });
  try {
    fake.behavior.create = () =>
      Effect.fail(new DevinSubmissionError({ disposition: "ambiguous" }));
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        const orchestra = yield* DevinSessionOrchestrator;
        yield* seed(db, "lost");
        yield* orchestra.tick;
        yield* db.update(devinSessions).set({
          updatedAt: "2000-01-01T00:00:00.000Z",
        });
      }).pipe(Effect.provide(layer)),
    );
    fake.behavior.lookup = () =>
      Effect.succeed([{
        ...remote,
        status: "exit",
        status_detail: "finished",
        tags: ["delivery-id:delivery-lost", "issue:123"],
      }]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        const orchestra = yield* DevinSessionOrchestrator;
        yield* orchestra.tick;
        const saved = yield* row(db, "lost");
        assert.equal(saved.status, "succeeded");
        assert.equal(saved.devinSessionId, "devin-created");
        assert.equal(saved.attempts, 1);
      }).pipe(Effect.provide(layer)),
    );
    assert.equal(fake.creates.length, 1);
    assert.deepEqual(fake.lookups, ["delivery-id:delivery-lost"]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

orchestrationTest(
  "run waits the configured interval, retries rejected work, and stops when its scope closes",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      fake.behavior.create = () =>
        Effect.fail(
          new DevinSubmissionError({
            disposition: "retryable",
            httpStatus: 429,
          }),
        );
      yield* Effect.gen(function* () {
        const fiber = yield* orchestra.run.pipe(Effect.forkScoped);
        yield* TestClock.adjust(0);
        assert.equal(fake.creates.length, 1);
        assert.equal((yield* row(db, "one")).status, "pending");
        fake.behavior.create = () => Effect.succeed(remote);
        yield* TestClock.adjust(2999);
        assert.equal(fake.creates.length, 1);
        yield* TestClock.adjust(1);
        assert.equal(fake.creates.length, 2);
        assert.equal((yield* row(db, "one")).status, "running");
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust("1 minute");
        assert.equal(fake.lists.length, 0);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped);
    }),
);

for (
  const { name, eventName, payload } of [
    {
      name: "differently cased label",
      eventName: "issues",
      payload: '{"action":"labeled","label":{"name":"Devin"}}',
    },
    {
      name: "unrelated added label despite existing devin label",
      eventName: "issues",
      payload:
        '{"action":"labeled","label":{"name":"bug"},"issue":{"labels":[{"name":"devin"}]}}',
    },
    {
      name: "non-labeled action",
      eventName: "issues",
      payload: '{"action":"opened","label":{"name":"devin"}}',
    },
    {
      name: "missing added label",
      eventName: "issues",
      payload: '{"action":"labeled"}',
    },
    {
      name: "unhandled event",
      eventName: "push",
      payload: '{"action":"labeled","label":{"name":"devin"}}',
    },
    {
      name: "object prototype name is not a processor",
      eventName: "toString",
      payload: '{"action":"labeled","label":{"name":"devin"}}',
    },
  ]
) {
  orchestrationTest(
    `${name} is terminal skipped and excluded from retries and polling`,
    ({ db, repository, orchestra, fake }) =>
      Effect.gen(function* () {
        yield* seed(db, "skip", {}, { eventName, payload });
        yield* orchestra.tick;
        const skipped = yield* row(db, "skip");
        assert.equal(skipped.status, "skipped");
        assert.equal(skipped.attempts, 1);
        assert.equal(skipped.devinSessionId, null);
        assert.equal(skipped.prNumber, null);
        yield* db.update(devinSessions).set({
          updatedAt: "2000-01-01T00:00:00.000Z",
        });
        const before = yield* row(db, "skip");
        assert.deepEqual(yield* repository.claimStale, []);
        assert.deepEqual(yield* repository.findRunning, []);
        assert.deepEqual(yield* repository.claimPending, []);
        yield* orchestra.tick;
        yield* orchestra.tick;
        assert.deepEqual(yield* row(db, "skip"), before);
        assert.deepEqual(fake.creates, []);
        assert.deepEqual(fake.lists, []);
      }),
  );
}

orchestrationTest(
  "a missing issues processor skips even a matching delivery",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "unregistered");
      yield* orchestra.tick;
      yield* orchestra.tick;
      assert.equal((yield* row(db, "unregistered")).status, "skipped");
      assert.deepEqual(fake.creates, []);
      assert.deepEqual(fake.lists, []);
    }),
  {},
  Layer.succeed(WebhookEventProcessors, new Map()),
);

orchestrationTest(
  "only the current unassigned claim can become skipped",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "one");
      const [old] = yield* repository.claimPending;
      yield* db.update(devinSessions).set({
        updatedAt: "2000-01-01T00:00:00.000Z",
      });
      const [current] = yield* repository.claimStale;
      assert.equal(current.session.attempts, 1);
      assert.equal(yield* repository.markSkipped(old.session), false);
      assert.equal((yield* row(db, "one")).status, "submitting");
      assert.equal(yield* repository.markSkipped(current.session), true);
      const skipped = yield* row(db, "one");
      assert.equal(skipped.status, "skipped");
      assert.equal(skipped.attempts, 1);
      assert.equal(skipped.devinSessionId, null);
      assert.equal(yield* repository.markSkipped(current.session), false);
      assert.equal(
        yield* repository.markRunning(current.session, "late-remote"),
        false,
      );
      assert.deepEqual(
        yield* repository.rejectSubmission(current.session, true),
        [],
      );
      assert.deepEqual(yield* row(db, "one"), skipped);
      yield* seed(db, "assigned", {
        status: "submitting",
        attempts: 1,
        devinSessionId: "existing-remote",
      });
      const assigned = yield* row(db, "assigned");
      assert.equal(yield* repository.markSkipped(assigned), false);
      assert.deepEqual(yield* row(db, "assigned"), assigned);
    }),
);

const pullRequestProcessor: WebhookEventProcessor = (delivery, client) =>
  client.createSession({
    title: `Custom processor for ${delivery.deliveryId}`,
    prompt: delivery.payload,
    repos: [delivery.repo],
  }).pipe(Effect.map((session): WebhookEventOutcome => ({
    _tag: "SessionCreated",
    devinSessionId: session.session_id,
  })));

orchestrationTest(
  "a registered event processor receives the persisted delivery and client and its outcome is persisted",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      const payload = '{"custom":"pull request payload"}';
      yield* seed(db, "custom", {}, { eventName: "pull_request", payload });
      yield* orchestra.tick;
      assert.deepEqual(fake.creates, [{
        title: "Custom processor for delivery-custom",
        prompt: payload,
        repos: ["owner/repo"],
      }]);
      assert.equal((yield* row(db, "custom")).status, "running");
      assert.equal(
        (yield* row(db, "custom")).devinSessionId,
        "devin-created-1",
      );
      yield* orchestra.tick;
      assert.equal(fake.creates.length, 1);
      assert.deepEqual(fake.lists, [["devin-created-1"]]);
    }),
  {},
  Layer.succeed(
    WebhookEventProcessors,
    new Map([
      ["pull_request", pullRequestProcessor],
      ["unused", () => Effect.die("Registry must select only one processor")],
    ]),
  ),
);
