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
  Logger,
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
  type ObservationClaim,
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

const completedRecord = {
  status: "submitted" as const,
  providerLifecycle: "completed" as const,
  activeWork: false,
  completionObservedAt: "1970-01-01T00:00:00.000Z",
  nextObservationAt: "9999-01-01T00:00:00.000Z",
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

orchestrationTest(
  "polling appends a result to existing outputs without duplicating it on later ticks",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      const first = {
        outcome: "needs_human" as const,
        summary: "Need integration credentials.",
      };
      const second = {
        outcome: "fix_proposed" as const,
        summary: "Credentials supplied; fix verified and PR opened.",
      };
      yield* seed(db, "history", {
        status: "submitted",
        devinSessionId: "devin-history",
        outputs: [first],
      });
      fake.behavior.list = () =>
        Effect.succeed([{
          ...remote,
          session_id: "devin-history",
          status: "running",
          status_detail: "finished",
          structured_output: second,
        }]);
      yield* orchestra.tick;
      assert.equal((yield* row(db, "history")).status, "submitted");
      assert.deepEqual((yield* row(db, "history")).outputs, [first, second]);
      yield* orchestra.tick;
      assert.deepEqual((yield* row(db, "history")).outputs, [first, second]);
    }),
);

orchestrationTest(
  "recordObservation appends to current stored outputs and fences replay",
  ({ db, repository }) =>
    Effect.gen(function* () {
      const first = { outcome: "needs_human" as const, summary: "Need input." };
      const second = {
        outcome: "needs_human" as const,
        summary: "Need approval.",
      };
      const final: DevinSession = {
        ...remote,
        session_id: "devin-stale-snapshot",
        status: "exit",
        status_detail: "finished",
        structured_output: {
          outcome: "fix_proposed",
          summary: "Verified fix.",
        },
        pull_requests: [{
          pr_url: "https://github.com/owner/repo/pull/42",
          pr_state: "open",
        }],
      };
      yield* seed(db, "stale-snapshot", {
        status: "submitted",
        devinSessionId: "devin-stale-snapshot",
        outputs: [first],
      });
      const [work] = yield* repository.claimDueObservations();
      assert.ok(work);
      yield* db.update(devinSessions).set({ outputs: [first, second] })
        .where(eq(devinSessions.id, "stale-snapshot"));
      assert.equal(yield* repository.recordObservation(work, final), true);
      assert.equal(yield* repository.recordObservation(work, final), false);
      const saved = yield* row(db, "stale-snapshot");
      assert.deepEqual(saved.outputs, [first, second, final.structured_output]);
      assert.equal(saved.prNumber, 42);
    }),
);

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
            ...completedRecord,
            devinSessionId: "devin-restart",
            outputs: [{ outcome: "fix_proposed", summary: "Verified." }],
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
        ...completedRecord,
        devinSessionId: "devin-http-analysis",
        outputs: [{ outcome: "fix_proposed", summary: "Verified." }],
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
          ...completedRecord,
          devinSessionId: `devin-${id}`,
          outputs: [{ outcome: "failed", summary: "Failed." }],
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
        outcome: "fix_proposed" as const,
        summary: "Verified fix.",
        confidence: 0.7,
      };
      for (const id of ["a", "b"]) {
        yield* seed(db, id, {
          ...completedRecord,
          devinSessionId: `devin-${id}`,
          outputs: [output],
          prNumber: 17,
        });
      }
      yield* seed(db, "local-failure", { status: "failed", outputs: [output] });
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
        assert.deepEqual(saved.outputs, [output]);
        assert.equal(saved.prNumber, 17);
        assert.equal(saved.status, "submitted");
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
          ...completedRecord,
          devinSessionId: `devin-${id}`,
          outputs: [{ outcome: "fix_proposed", summary: "Verified." }],
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
        ...completedRecord,
        devinSessionId: "devin-small",
        outputs: [{ outcome: "fix_proposed", summary: "Verified." }],
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
          ...completedRecord,
          devinSessionId: `devin-${id}`,
          outputs: [{ outcome: "failed", summary: "Failed." }],
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
        ...completedRecord,
        devinSessionId: "devin-finished",
        outputs: [{ outcome: "fix_proposed", summary: "Verified." }],
      });
      yield* seed(db, "new");
      fake.behavior.insights = () =>
        Effect.fail(new DevinLookupError({ cause: "503" }));
      yield* orchestra.tick;
      assert.equal((yield* row(db, "new")).status, "submitted");
      assert.equal((yield* row(db, "finished")).status, "submitted");
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
      assert.deepEqual(saved.outputs, [{
        outcome: "fix_proposed",
        summary: "Verified.",
      }]);
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
          ...completedRecord,
          devinSessionId: `devin-${i}`,
          outputs: [{ outcome: "fix_proposed", summary: "Verified." }],
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
        ...completedRecord,
        devinSessionId: "devin-timeout",
        outputs: [{ outcome: "fix_proposed", summary: "Verified." }],
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
      assert.equal(saved.status, "submitted");
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
                outcome: "fix_proposed",
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
      assert.equal(saved.status, "submitted");
      assert.deepEqual(saved.outputs, [{
        outcome: "fix_proposed",
        summary: "Regression test passes; PR opened.",
        verification: { status: "passed", evidence: ["deno test: passed"] },
        blocker: null,
        next_action: "Review https://github.com/owner/repo/pull/21",
        confidence: 0.9,
      }]);
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
      assert.equal(saved.status, "submitted");
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
      assert.equal(saved.status, "submitted");
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
            status: "submitted",
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
            s.status === "submitted" || s.status === "submitting"
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
        assert.equal((yield* row(db, "one")).status, "submitted");
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped);
    }),
);

orchestrationTest(
  "polling batches 200 IDs, retains a failed batch, and continues with subsequent batches",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 201 }, (_, i) => `remote-${i}`);
      for (const id of ids) {
        yield* seed(db, id, { status: "submitted", devinSessionId: id });
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
              structured_output: {
                outcome: "fix_proposed",
                summary: session_id,
              },
            })),
          );
      yield* orchestra.tick;
      assert.deepEqual(fake.lists.map((batch) => batch.length), [200, 1]);
      assert.deepEqual(new Set(fake.lists.flat()), new Set(ids));
      for (const id of fake.lists[0]) {
        const saved = yield* row(db, id);
        assert.equal(saved.status, "submitted");
        assert.equal(saved.devinSessionId, id);
        assert.deepEqual(saved.outputs, []);
      }
      const completed = fake.lists[1][0];
      assert.equal((yield* row(db, completed)).status, "submitted");
      assert.deepEqual((yield* row(db, completed)).outputs, [{
        outcome: "fix_proposed",
        summary: completed,
      }]);
      assert.equal((yield* row(db, "pending")).status, "submitted");
      assert.equal(fake.creates.length, 1);
      failBatch = false;
      yield* orchestra.tick;
      for (const id of ids) {
        const saved = yield* row(db, id);
        assert.equal(saved.status, "submitted");
        assert.deepEqual(saved.outputs, [{
          outcome: "fix_proposed",
          summary: id,
        }]);
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
    if (url.searchParams.get("is_archived") === "true") {
      assert.deepEqual(url.searchParams.getAll("session_ids"), ["missing"]);
      requests.push("archived");
      return Promise.resolve(Response.json({ items: [] }));
    }
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
            structured_output: {
              outcome: "fix_proposed",
              summary: "Verified fix.",
            },
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
          status: "submitted",
          devinSessionId: id,
          analysisNextAttemptAt: "9999-01-01T00:00:00.000Z",
        });
      }
      const running = yield* row(db, "running");
      const missing = yield* row(db, "missing");
      yield* orchestra.tick;
      assert.deepEqual(requests, [null, "page-2", "archived"]);
      const done = yield* row(db, "done");
      assert.equal(done.status, "submitted");
      assert.equal(done.prNumber, 42);
      assert.deepEqual(done.outputs, [{
        outcome: "fix_proposed",
        summary: "Verified fix.",
      }]);
      const observedRunning = yield* row(db, "running");
      assert.equal(observedRunning.providerLifecycle, "active");
      assert.deepEqual(observedRunning.outputs, running.outputs);
      assert.equal(observedRunning.devinSessionId, running.devinSessionId);
      assert.deepEqual(yield* row(db, "missing"), {
        ...missing,
        observationVersion: missing.observationVersion + 1,
      });
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.scoped,
    ),
  );
});

orchestrationTest(
  "a verified open PR persists fix_proposed without waiting for merge and frees capacity",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "running", {
        status: "submitted",
        devinSessionId: "existing",
      });
      yield* seed(db, "pending");
      fake.behavior.list = () =>
        Effect.succeed([{
          ...remote,
          session_id: "existing",
          status: "exit",
          status_detail: "finished",
          structured_output: {
            outcome: "fix_proposed",
            summary: "Verified fix.",
            verification: { status: "passed", evidence: ["deno test: passed"] },
            blocker: null,
            next_action: "Maintainer: review and merge PR #42.",
          },
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
      assert.equal((yield* row(db, "running")).status, "submitted");
      assert.deepEqual((yield* row(db, "running")).outputs, [{
        outcome: "fix_proposed",
        summary: "Verified fix.",
        verification: { status: "passed", evidence: ["deno test: passed"] },
        blocker: null,
        next_action: "Maintainer: review and merge PR #42.",
      }]);
      assert.equal((yield* row(db, "running")).prNumber, 42);
      assert.equal((yield* row(db, "pending")).status, "submitted");
      assert.equal(fake.creates.length, 1);
    }),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "1" },
);

orchestrationTest(
  "retained results and definite local failure survive provider errors without replacement",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "success", {
        ...completedRecord,
        outputs: [{ outcome: "fix_proposed", summary: "Verified fix." }],
        devinSessionId: "success",
        prNumber: 17,
      });
      yield* seed(db, "failed", {
        status: "failed",
        outputs: [{ outcome: "failed", summary: "Remediation failed." }],
      });
      yield* seed(db, "running", {
        status: "submitted",
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
          "outputs",
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
      assert.equal(
        (yield* row(db, "running")).providerLifecycle,
        "needs_intervention",
      );
      assert.deepEqual(fake.lists, [["failure"]]);
      assert.equal(fake.creates.length, 0);
    }),
);

orchestrationTest(
  "missing list results keep their remote identity and capacity while returned rows reconcile",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one", {
        status: "submitted",
        devinSessionId: "unavailable",
      });
      yield* seed(db, "two", { status: "submitted", devinSessionId: "done" });
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
      assert.deepEqual(yield* row(db, "one"), {
        ...before,
        observationVersion: before.observationVersion + 1,
      });
      assert.equal((yield* row(db, "two")).status, "submitted");
      assert.equal((yield* row(db, "three")).status, "submitted");
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
          saved.outputs,
          attempt === 3
            ? [{
              outcome: "failed",
              summary: "Submission rejected; retry attempts exhausted.",
            }]
            : [],
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
      assert.deepEqual((yield* row(db, "one")).outputs, [{
        outcome: "failed",
        summary: "Submission permanently rejected before session creation.",
      }]);
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
      assert.equal((yield* row(db, "stale")).status, "submitted");
      assert.equal((yield* row(db, "stale")).attempts, 2);
      assert.equal((yield* row(db, "exhausted")).status, "failed");
      assert.deepEqual((yield* row(db, "exhausted")).outputs, [{
        outcome: "failed",
        summary:
          "Submission attempts exhausted after repeated empty recovery lookups.",
      }]);
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
        yield* repository.markSubmitted(old.session, "old-remote"),
        false,
      );
      assert.deepEqual(
        yield* repository.rejectSubmission(old.session, false),
        [],
      );
      assert.equal(
        yield* repository.markSubmitted(current.session, "new-remote"),
        true,
      );
      assert.equal((yield* row(db, "one")).devinSessionId, "new-remote");
      assert.equal(yield* repository.markSkipped(current.session), false);
      assert.equal((yield* row(db, "one")).status, "submitted");
    }),
);

for (
  const [status, status_detail, expected] of [
    ["running", "working", "active"],
    ["exit", "finished", "completed"],
    ["error", "error", "needs_intervention"],
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
        assert.equal(saved.status, "submitted");
        assert.equal(saved.providerLifecycle, expected);
        assert.deepEqual(saved.outputs, []);
        assert.equal(saved.devinSessionId, "devin-created");
        assert.equal(saved.attempts, 3);
        assert.equal(saved.prNumber, 17);
        assert.deepEqual(fake.lookups, ["delivery-id:delivery-lost"]);
        assert.equal(fake.creates.length, 0);
        yield* orchestra.tick;
        assert.equal(fake.creates.length, 0);
      }),
  );
}

for (
  const outcome of [
    "fix_proposed",
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
          status: "submitted",
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
        assert.equal(saved.status, "submitted");
        assert.deepEqual(saved.outputs, [{
          outcome,
          summary: "Investigation complete.",
          verification: { status: "partial", evidence: ["unit tests: passed"] },
          blocker: "Browser environment unavailable.",
          next_action: "Reviewer: run browser checks.",
          confidence: 0.8,
        }]);
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
      assert.deepEqual(saved.outputs, [{
        outcome: "failed",
        summary: "Submission attempts exhausted before session creation.",
      }]);
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
      assert.equal((yield* row(db, "delayed")).status, "submitted");
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
      assert.equal(yield* repository.markSubmitted(old.session, "late"), false);
      assert.equal(
        yield* repository.markSubmitted(current.session, "recovered"),
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
      assert.equal((yield* row(db, "one")).status, "submitted");
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
      WHEN NEW.status = 'submitted' BEGIN SELECT RAISE(ABORT, 'persistence failed'); END`;
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
        markSubmitted: (claim: SessionRecord, id: string) =>
          Effect.suspend(() => {
            saves++;
            return saves === 1
              ? Effect.fail(
                new DatabaseError({ cause: "transient disk error" }),
              )
              : repository.markSubmitted(claim, id);
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
          status: "submitted",
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
        structured_output: {
          outcome: "fix_proposed",
          summary: "Verified fix.",
        },
      }]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const orchestra = yield* DevinSessionOrchestrator;
        const { db } = yield* DatabaseClient;
        yield* orchestra.tick;
        assert.equal((yield* row(db, "existing")).status, "submitted");
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
        assert.equal(saved.status, "submitted");
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
        assert.equal(saved.status, "submitted");
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
        assert.equal((yield* row(db, "one")).status, "submitted");
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
        assert.deepEqual(yield* repository.claimDueObservations(), []);
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
        yield* repository.markSubmitted(current.session, "late-remote"),
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
      assert.equal((yield* row(db, "custom")).status, "submitted");
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

orchestrationTest(
  "waiting, paused, external resume, and completion retain changed-result history on the same session",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      const a = { outcome: "needs_human", summary: "SECRET_QUESTION" };
      const b = { outcome: "fix_proposed", summary: "Verified fix." };
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      let observed: DevinSession = {
        ...remote,
        session_id: "continuable",
        status: "running",
        status_detail: "waiting_for_user",
        created_at: Math.floor(now / 1000) - 31 * 86400,
        updated_at: 1,
        structured_output: a,
        pull_requests: [{
          pr_url: "https://github.com/owner/repo/pull/42",
          pr_state: "open",
        }],
      };
      yield* seed(db, "continuable", {
        status: "submitted",
        devinSessionId: "continuable",
      });
      fake.behavior.list = () => Effect.succeed([observed]);
      yield* orchestra.tick;
      let saved = yield* row(db, "continuable");
      assert.equal(saved.status, "submitted");
      assert.equal(saved.providerLifecycle, "needs_input");
      assert.equal(saved.activeWork, false);
      assert.equal(saved.isArchived, null);
      assert.equal(saved.providerCreatedAt, observed.created_at);
      assert.deepEqual(saved.outputs, [a]);
      assert.equal(saved.prNumber, 42);
      assert.equal(fake.insights.length, 0);
      yield* TestClock.adjust("9 seconds");
      yield* orchestra.tick;
      assert.equal(fake.lists.length, 1);
      observed = {
        ...observed,
        status: "suspended",
        status_detail: "inactivity",
        updated_at: 2,
        structured_output: b,
        pull_requests: [],
      };
      yield* TestClock.adjust("1 second");
      yield* orchestra.tick;
      saved = yield* row(db, "continuable");
      assert.equal(saved.providerLifecycle, "paused");
      assert.deepEqual(saved.outputs, [a, b]);
      assert.equal(saved.prNumber, 42);
      assert.equal(saved.completionObservedAt, null);
      assert.equal(fake.generations.length, 0);
      yield* seed(db, "pending");
      observed = {
        ...observed,
        status: "resuming",
        status_detail: null,
        updated_at: 3,
      };
      yield* TestClock.adjust("10 seconds");
      yield* orchestra.tick;
      saved = yield* row(db, "continuable");
      assert.equal(saved.providerLifecycle, "active");
      assert.equal(saved.activeWork, true);
      assert.equal(saved.devinSessionId, "continuable");
      assert.equal((yield* row(db, "pending")).status, "pending");
      assert.equal(fake.creates.length, 0);
      assert.deepEqual(saved.outputs, [a, b]);
      observed = {
        ...observed,
        status: "running",
        status_detail: "finished",
        updated_at: 4,
        structured_output: a,
      };
      yield* orchestra.tick;
      saved = yield* row(db, "continuable");
      assert.equal(saved.providerLifecycle, "completed");
      assert.equal(saved.activeWork, false);
      assert.ok(saved.completionObservedAt);
      assert.deepEqual(saved.outputs, [a, b, a]);
      assert.equal(saved.prNumber, 42);
      assert.equal((yield* row(db, "pending")).status, "submitted");
      assert.equal(fake.creates.length, 1);
      assert.deepEqual(fake.insights, [["continuable"]]);
      const retainedCalls = fake.lists.filter((ids) =>
        ids.includes("continuable")
      ).length;
      yield* orchestra.tick;
      assert.equal(
        fake.lists.filter((ids) => ids.includes("continuable")).length,
        retainedCalls,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  {
    DEVIN_MAX_CONCURRENT_SESSIONS: "1",
    DEVIN_RETAINED_POLL_INTERVAL_MS: "10000",
  },
);

orchestrationTest(
  "observation claims reject stale workers, older provider snapshots, replay, and expired leases",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "fenced", {
        status: "submitted",
        devinSessionId: "fenced",
      });
      const a = { outcome: "needs_human", summary: "Need input." };
      const b = { outcome: "fix_proposed", summary: "Verified." };
      const snapshot: DevinSession = {
        ...remote,
        session_id: "fenced",
        status: "running",
        status_detail: "working",
        updated_at: 20,
        structured_output: a,
      };
      const [old] = yield* repository.claimDueObservations();
      assert.deepEqual(yield* repository.claimDueObservations(), []);
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* repository.recordObservation(old, snapshot), false);
      const [current] = yield* repository.claimDueObservations();
      assert.ok(
        current.session.observationVersion > old.session.observationVersion,
      );
      yield* repository.releaseObservation(old);
      assert.ok((yield* row(db, "fenced")).observationLeaseUntil);
      assert.equal(
        yield* repository.recordObservation(old, {
          ...snapshot,
          updated_at: 99,
          structured_output: b,
        }),
        false,
      );
      assert.equal(
        yield* repository.recordObservation(current, snapshot),
        true,
      );
      assert.equal(
        yield* repository.recordObservation(current, snapshot),
        false,
      );
      const accepted = yield* row(db, "fenced");
      const [next] = yield* repository.claimDueObservations();
      assert.equal(
        yield* repository.recordObservation(next, {
          ...snapshot,
          updated_at: 19,
          status: "suspended",
          status_detail: "inactivity",
          structured_output: b,
        }),
        false,
      );
      const rejected = yield* row(db, "fenced");
      assert.equal(rejected.providerUpdatedAt, 20);
      assert.equal(rejected.providerLifecycle, "active");
      assert.equal(rejected.lastObservedAt, accepted.lastObservedAt);
      assert.deepEqual(rejected.outputs, [a]);
      const [equalTimestamp] = yield* repository.claimDueObservations();
      assert.equal(
        yield* repository.recordObservation(equalTimestamp, {
          ...snapshot,
          structured_output: b,
        }),
        true,
      );
      assert.deepEqual((yield* row(db, "fenced")).outputs, [a, b]);
    }).pipe(Effect.provide(TestClock.layer())),
);

orchestrationTest(
  "normalized output histories ignore key order, unchanged polls, null, and invalid results but retain A to B to A",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "normalized", {
        status: "submitted",
        devinSessionId: "normalized",
      });
      const a = {
        outcome: "fix_proposed",
        summary: "Verified.",
        verification: { status: "passed", evidence: ["unit tests passed"] },
        blocker: null,
        next_action: "Review.",
        confidence: 0.9,
      };
      const reordered = {
        confidence: 0.9,
        next_action: "Review.",
        blocker: null,
        verification: { evidence: ["unit tests passed"], status: "passed" },
        summary: "Verified.",
        outcome: "fix_proposed",
      };
      const b = { ...a, next_action: "Merge." };
      for (
        const structured_output of [
          a,
          reordered,
          a,
          null,
          { outcome: "fix_proposed", summary: "" },
          b,
          a,
        ]
      ) {
        const [claim] = yield* repository.claimDueObservations();
        assert.equal(
          yield* repository.recordObservation(claim, {
            ...remote,
            session_id: "normalized",
            status: "running",
            status_detail: "working",
            structured_output,
          }),
          true,
        );
      }
      assert.deepEqual((yield* row(db, "normalized")).outputs, [a, b, a]);
    }),
);

orchestrationTest(
  "snapshot and output append roll back together and retry the same claim without duplication",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "atomic", {
        status: "submitted",
        devinSessionId: "atomic",
      });
      const [claim] = yield* repository.claimDueObservations();
      const output = { outcome: "fix_proposed", summary: "Verified." };
      const observation: DevinSession = {
        ...remote,
        session_id: "atomic",
        updated_at: 99,
        structured_output: output,
      };
      yield* db
        .$client`CREATE TRIGGER reject_observation BEFORE UPDATE ON devin_sessions WHEN NEW.provider_updated_at = 99 BEGIN SELECT RAISE(ABORT, 'observation failed'); END`;
      const result = yield* repository.recordObservation(claim, observation)
        .pipe(Effect.result);
      assert.ok(Result.isFailure(result));
      const failed = yield* row(db, "atomic");
      assert.equal(failed.providerUpdatedAt, null);
      assert.equal(failed.lastObservedAt, null);
      assert.deepEqual(failed.outputs, []);
      assert.ok(failed.observationLeaseUntil);
      yield* db.$client`DROP TRIGGER reject_observation`;
      assert.equal(
        yield* repository.recordObservation(claim, observation),
        true,
      );
      assert.equal(
        yield* repository.recordObservation(claim, observation),
        false,
      );
      const saved = yield* row(db, "atomic");
      assert.equal(saved.providerUpdatedAt, 99);
      assert.deepEqual(saved.outputs, [output]);
    }),
);

orchestrationTest(
  "retained waits free capacity, in-flight observations reserve it, and misses or lease expiry release it",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "paused", {
        status: "submitted",
        devinSessionId: "paused",
        providerLifecycle: "paused",
        activeWork: false,
      });
      yield* seed(db, "pending");
      const [claim] = yield* repository.claimDueObservations();
      assert.deepEqual(yield* repository.claimPending, []);
      yield* repository.releaseObservation(claim);
      assert.equal((yield* repository.claimPending).length, 1);
      assert.equal((yield* row(db, "paused")).lastObservedAt, null);
      yield* db.update(devinSessions).set({ status: "skipped" }).where(
        eq(devinSessions.id, "pending"),
      );
      yield* seed(db, "next");
      yield* TestClock.adjust("60 seconds");
      const [abandoned] = yield* repository.claimDueObservations();
      assert.equal(abandoned.session.id, "paused");
      assert.deepEqual(yield* repository.claimPending, []);
      yield* TestClock.adjust("60 seconds");
      assert.equal((yield* repository.claimPending).length, 1);
    }).pipe(Effect.provide(TestClock.layer())),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "1" },
);

orchestrationTest(
  "unknown provider work counts capacity while its intervention polling remains slow and preserves history on misses",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      const output = {
        outcome: "needs_human" as const,
        summary: "Investigate provider.",
      };
      yield* seed(db, "unknown", {
        status: "submitted",
        devinSessionId: "unknown",
        outputs: [output],
      });
      yield* seed(db, "pending");
      fake.behavior.list = () =>
        Effect.succeed([{
          ...remote,
          session_id: "unknown",
          status: "suspended",
          status_detail: "future_reason",
          updated_at: 2,
        }]);
      yield* orchestra.tick;
      const observed = yield* row(db, "unknown");
      assert.equal(observed.providerLifecycle, "needs_intervention");
      assert.equal(observed.providerStatusDetail, "future_reason");
      assert.equal(observed.activeWork, null);
      assert.equal(fake.creates.length, 0);
      yield* orchestra.tick;
      assert.equal(fake.lists.length, 1);
      yield* TestClock.adjust("60 seconds");
      fake.behavior.list = () => Effect.succeed([]);
      yield* orchestra.tick;
      yield* TestClock.adjust("60 seconds");
      fake.behavior.list = () =>
        Effect.fail(new DevinLookupError({ cause: "503" }));
      yield* orchestra.tick;
      const missing = yield* row(db, "unknown");
      assert.equal(missing.providerUpdatedAt, 2);
      assert.equal(missing.lastObservedAt, observed.lastObservedAt);
      assert.equal(missing.providerStatusDetail, "future_reason");
      assert.equal(missing.observationLeaseUntil, null);
      assert.deepEqual(missing.outputs, [output]);
      assert.equal(fake.creates.length, 0);
      assert.equal(fake.insights.length, 0);
    }).pipe(Effect.provide(TestClock.layer())),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "1" },
);

orchestrationTest(
  "archived completion closes tracking but permits independent insights; archive alone never fabricates completion",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      for (const id of ["complete", "pause"]) {
        yield* seed(db, id, { status: "submitted", devinSessionId: id });
      }
      fake.behavior.list = (ids) =>
        Effect.succeed(
          ids.map((session_id) => ({
            ...remote,
            session_id,
            is_archived: true,
            status: "running",
            status_detail: session_id === "complete"
              ? "finished"
              : "waiting_for_user",
          })),
        );
      fake.behavior.insights = () =>
        Effect.succeed([{
          ...completedInsights("complete"),
          is_archived: true,
        }]);
      yield* orchestra.tick;
      assert.equal((yield* row(db, "complete")).providerLifecycle, "closed");
      assert.ok((yield* row(db, "complete")).completionObservedAt);
      assert.equal((yield* row(db, "pause")).providerLifecycle, "closed");
      assert.equal((yield* row(db, "pause")).completionObservedAt, null);
      assert.deepEqual(fake.generations, ["complete"]);
      yield* TestClock.adjust("1 hour");
      yield* orchestra.tick;
      assert.equal(fake.lists.length, 1);
      assert.deepEqual((yield* row(db, "complete")).outputs, []);
    }).pipe(Effect.provide(TestClock.layer())),
);

orchestrationTest(
  "each slow observation batch gets a fresh lease and no active row repeats within a tick",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      for (let index = 0; index < 401; index++) {
        const id = `batch-${String(index).padStart(3, "0")}`;
        yield* seed(db, id, { status: "submitted", devinSessionId: id });
      }
      fake.behavior.list = (ids) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("29 seconds");
          return ids.map((session_id) => ({
            ...remote,
            session_id,
            status: "running" as const,
            status_detail: "working",
            updated_at: 1,
          }));
        });
      yield* orchestra.tick;
      assert.deepEqual(fake.lists.map((ids) => ids.length), [200, 200, 1]);
      assert.equal(new Set(fake.lists.flat()).size, 401);
      const sessions = yield* db.select().from(devinSessions);
      assert.equal(
        sessions.filter((session) => session.providerLifecycle === "active")
          .length,
        401,
      );
      assert.ok(
        sessions.every((session) => session.observationLeaseUntil === null),
      );
    }).pipe(Effect.provide(TestClock.layer())),
);

Deno.test("separate SQLite workers claim exclusively and a restart retains observations, due time, and history", async () => {
  const directory = await Deno.makeTempDir();
  const env = { SQLITE_DB_FILEPATH: `${directory}/workers.sqlite` };
  const fake = fakeClient();
  const run = <A, E>(
    effect: Effect.Effect<A, E, DevinSessionRepository | DatabaseClient>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(Layer.fresh(testLayer(fake, env))),
        Effect.scoped,
      ),
    );
  try {
    await run(
      DatabaseClient.use(({ db }) =>
        seed(db, "shared", { status: "submitted", devinSessionId: "shared" })
      ),
    );
    type WorkerReply = {
      claims?: ReadonlyArray<ObservationClaim>;
      ready?: boolean;
      closed?: boolean;
      error?: string;
    };
    const workers = [0, 1].map(() => {
      const worker = new Worker(
        new URL("../test/lifecycle-observation-worker.ts", import.meta.url),
        { type: "module" },
      );
      const request = (action: string) =>
        new Promise<WorkerReply>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`Worker ${action} timed out`)),
            15000,
          );
          worker.onmessage = (event: MessageEvent<WorkerReply>) => {
            clearTimeout(timeout);
            if (event.data.error !== undefined) {
              reject(new Error(event.data.error));
            } else resolve(event.data);
          };
          worker.onerror = (event) => {
            clearTimeout(timeout);
            event.preventDefault();
            reject(new Error(event.message));
          };
          worker.postMessage({
            action,
            env: {
              ...env,
              DEVIN_API_KEY: "test",
              DEVIN_ORGANIZATION_ID: "org",
              GITHUB_WEBHOOK_SECRET: "test",
            },
          });
        });
      return { worker, request };
    });
    const claims = [];
    try {
      for (const worker of workers) {
        assert.equal((await worker.request("initialize")).ready, true);
      }
      const results = await Promise.all(
        workers.map((worker) => worker.request("claim")),
      );
      for (const result of results) {
        assert.ok(result.claims);
        claims.push(result.claims);
      }
      for (const worker of workers) {
        assert.equal((await worker.request("close")).closed, true);
      }
    } finally {
      for (const { worker } of workers) worker.terminate();
    }
    assert.equal(claims.flat().length, 1);
    const claim = claims.flat()[0];
    const output = { outcome: "needs_human", summary: "Need input." };
    assert.equal(
      await run(
        DevinSessionRepository.use((repository) =>
          repository.recordObservation(claim, {
            ...remote,
            session_id: "shared",
            status: "running",
            status_detail: "waiting_for_user",
            updated_at: 10,
            structured_output: output,
            is_archived: false,
          })
        ),
      ),
      true,
    );
    const before = await run(DatabaseClient.use(({ db }) => row(db, "shared")));
    assert.equal(before.providerLifecycle, "needs_input");
    assert.equal(before.isArchived, false);
    assert.deepEqual(before.outputs, [output]);
    await run(Effect.gen(function* () {
      const repository = yield* DevinSessionRepository;
      const { db } = yield* DatabaseClient;
      assert.deepEqual(yield* repository.claimDueObservations(), []);
      assert.deepEqual(yield* row(db, "shared"), before);
      assert.equal(
        yield* repository.recordObservation(claim, {
          ...remote,
          session_id: "shared",
          updated_at: 20,
        }),
        false,
      );
      yield* db.update(devinSessions).set({
        nextObservationAt: "1970-01-01T00:00:00.000Z",
      }).where(eq(devinSessions.id, "shared"));
      const [next] = yield* repository.claimDueObservations();
      assert.equal(
        yield* repository.recordObservation(next, {
          ...remote,
          session_id: "shared",
          updated_at: 11,
          status: "resuming",
        }),
        true,
      );
      const resumed = yield* row(db, "shared");
      assert.equal(resumed.providerLifecycle, "active");
      assert.equal(resumed.isArchived, false);
      assert.deepEqual(resumed.outputs, [output]);
    }));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

orchestrationTest(
  "completed sessions resume under the same identity and transition logs exclude unchanged polls and question text",
  ({ db, orchestra, fake }) => {
    const logs: ReturnType<typeof Logger.formatStructured.log>[] = [];
    return Effect.gen(function* () {
      const a = { outcome: "needs_human", summary: "SECRET_QUESTION" };
      yield* seed(db, "transitions", {
        status: "submitted",
        devinSessionId: "transitions",
        analysisStatus: "collected",
        analysis: { preserved: true },
      });
      let observation: DevinSession = {
        ...remote,
        session_id: "transitions",
        status: "running",
        status_detail: "working",
        is_archived: false,
        structured_output: a,
      };
      fake.behavior.list = () => Effect.succeed([observation]);
      yield* orchestra.tick;
      observation = {
        ...observation,
        updated_at: 1,
        structured_output: { ...a, summary: "SECRET_CHANGED_QUESTION" },
      };
      yield* orchestra.tick;
      assert.equal(
        logs.filter((log) => log.message === "session.provider_transition")
          .length,
        1,
      );
      observation = {
        ...observation,
        status_detail: "finished",
        updated_at: 2,
      };
      yield* orchestra.tick;
      const completed = yield* row(db, "transitions");
      assert.equal(completed.providerLifecycle, "completed");
      yield* TestClock.adjust("60 seconds");
      observation = {
        ...observation,
        status: "resuming",
        status_detail: null,
        updated_at: 3,
      };
      yield* orchestra.tick;
      const resumed = yield* row(db, "transitions");
      assert.equal(resumed.providerLifecycle, "active");
      assert.deepEqual(resumed.outputs, completed.outputs);
      assert.deepEqual(resumed.analysis, { preserved: true });
      assert.equal(
        resumed.completionObservedAt,
        completed.completionObservedAt,
      );
      observation = { ...observation, is_archived: true, updated_at: 4 };
      yield* orchestra.tick;
      const transitions = logs.filter((log) =>
        log.message === "session.provider_transition"
      );
      assert.deepEqual(
        transitions.map((log) => log.annotations.provider_lifecycle),
        ["active", "completed", "active", "closed"],
      );
      assert.equal(transitions.at(-1)?.annotations.is_archived, true);
      assert.equal(transitions.at(-1)?.annotations.provider_status, "resuming");
      assert.equal((yield* row(db, "transitions")).providerLifecycle, "closed");
      assert.equal(fake.creates.length, 0);
      assert.equal(fake.insights.length, 0);
      assert.ok(!JSON.stringify(logs).includes("SECRET_"));
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(
        Logger.layer([
          Logger.map(Logger.formatJson, (json) => logs.push(JSON.parse(json))),
        ]),
      ),
    );
  },
);

for (const operation of ["record", "release"] as const) {
  orchestrationTest(
    `${operation} rejects an observation lease that expires while waiting for database acquisition`,
    ({ db, repository }) =>
      Effect.gen(function* () {
        yield* seed(db, "lease-wait", {
          status: "submitted",
          devinSessionId: "lease-wait",
          providerLifecycle: "paused",
          activeWork: false,
          outputs: [{ outcome: "needs_human", summary: "Retain this result." }],
        });
        const [claim] = yield* repository.claimDueObservations();
        const before = yield* row(db, "lease-wait");
        yield* TestClock.adjust("59 seconds");
        const held = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(held, undefined);
            yield* Deferred.await(release);
          })
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(held);
        const waiting = yield* (operation === "record"
          ? repository.recordObservation(claim, {
            ...remote,
            session_id: "lease-wait",
            status: "resuming",
            updated_at: 2,
            structured_output: {
              outcome: "fix_proposed",
              summary: "Must not append.",
            },
          })
          : repository.releaseObservation(claim)).pipe(Effect.forkScoped);
        yield* TestClock.adjust("2 seconds");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        const result = yield* Fiber.join(waiting);
        if (operation === "record") assert.equal(result, false);
        assert.deepEqual(yield* row(db, "lease-wait"), before);
        const [reclaimed] = yield* repository.claimDueObservations();
        assert.ok(
          reclaimed.session.observationVersion >
            claim.session.observationVersion,
        );
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );
}
