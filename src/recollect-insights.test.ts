import { strict as assert } from "node:assert";
import * as DenoServices from "@effect/platform-deno/DenoServices";
import { eq } from "drizzle-orm";
import { ConfigProvider, Console, Effect, Layer, Result, Stdio } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { type AppDatabase, DatabaseClient } from "./database.ts";
import { DevinClient, type DevinSession } from "./devin.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { GitHubCommentNotifier } from "./github-comment-notifier.ts";
import {
  DevinSessionRepository,
  type SessionRecord,
} from "./devin-session-repository.ts";
import { WebhookEventProcessors } from "./webhook-event-processors.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";
import {
  inspectSessionInsights,
  recollectInsights,
  runRecollectInsights,
} from "./recollect-insights.ts";

const epoch = "1970-01-01T00:00:00.000Z";
const future = "9999-01-01T00:00:00.000Z";
const remote: DevinSession = {
  session_id: "remote",
  url: "https://app.devin.ai/sessions/remote",
  status: "running",
  status_detail: "working",
  org_id: "org-test",
  created_at: 1,
  updated_at: 100,
  acus_consumed: 1.125,
  tags: [],
  pull_requests: [],
};
const completed = {
  status: "submitted" as const,
  devinSessionId: "remote",
  providerLifecycle: "completed" as const,
  completionObservedAt: epoch,
  activeWork: false,
  nextObservationAt: future,
};
const seed = Effect.fnUntraced(
  function* (
    db: AppDatabase,
    id: string,
    overrides: Partial<SessionRecord> = {},
  ) {
    yield* db.insert(githubWebhookDeliveries).values({
      id,
      deliveryId: id,
      eventName: "issues",
      repo: "owner/repo",
      issueNumber: 42,
      payload: "PRIVATE webhook",
      insertedAt: epoch,
    });
    yield* db.insert(devinSessions).values({
      id,
      githubDeliveryId: id,
      status: "pending",
      insertedAt: epoch,
      updatedAt: epoch,
      outputs: [{ outcome: "needs_human", summary: "PRIVATE output" }],
      ...overrides,
    });
  },
);
const row = Effect.fnUntraced(function* (db: AppDatabase, id = "local") {
  const saved = yield* db.select().from(devinSessions).where(
    eq(devinSessions.id, id),
  ).get();
  assert.ok(saved);
  return saved;
});

function insightsTest(
  name: string,
  test: (
    fixture: {
      db: AppDatabase;
      repository: DevinSessionRepository["Service"];
      path: string;
    },
  ) => Effect.Effect<void, unknown, DatabaseClient>,
) {
  Deno.test(name, async () => {
    const folder = await Deno.makeTempDir();
    const path = `${folder}/sessions.sqlite`;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* DatabaseClient;
          const repository = yield* DevinSessionRepository;
          yield* test({ db, repository, path });
        }).pipe(
          Effect.provide(DevinSessionRepository.layer.pipe(
            Layer.provideMerge(DatabaseClient.layerWithPath(path)),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
              DEVIN_API_KEY: "test-key",
              DEVIN_ORGANIZATION_ID: "org-test",
              GITHUB_WEBHOOK_SECRET: "test-secret",
              DEVIN_ANALYSIS_MAX_ATTEMPTS: "1",
            }))),
          )),
          Effect.provide(TestClock.layer()),
        ),
      );
    } finally {
      await Deno.remove(folder, { recursive: true });
    }
  });
}

insightsTest(
  "consumed ACUs persist fractionally on recovery and observations, fenced by identity, version, lease and timestamp",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "local");
      const [submission] = yield* repository.claimPending;
      assert.equal(
        yield* repository.markSubmitted(submission.session, "remote", remote),
        true,
      );
      assert.equal((yield* row(db)).acusConsumed, 1.125);
      assert.equal(
        yield* repository.markSubmitted(submission.session, "remote", {
          ...remote,
          acus_consumed: 900,
        }),
        false,
      );
      const [old] = yield* repository.claimDueObservations();
      yield* repository.releaseObservation(old);
      const [current] = yield* repository.claimDueObservations();
      assert.equal(
        yield* repository.recordObservation(old, {
          ...remote,
          acus_consumed: 900,
        }),
        false,
      );
      assert.equal(
        yield* repository.recordObservation(current, {
          ...remote,
          session_id: "wrong",
          acus_consumed: 900,
        }),
        false,
      );
      assert.equal((yield* row(db)).acusConsumed, 1.125);
      assert.equal(
        yield* repository.recordObservation(current, {
          ...remote,
          updated_at: 99,
          acus_consumed: 900,
        }),
        false,
      );
      assert.equal((yield* row(db)).acusConsumed, 1.125);
      const [fresh] = yield* repository.claimDueObservations();
      assert.equal(
        yield* repository.recordObservation(fresh, {
          ...remote,
          updated_at: 101,
          acus_consumed: 2.75,
        }),
        true,
      );
      assert.equal((yield* row(db)).acusConsumed, 2.75);
      const [expired] = yield* repository.claimDueObservations();
      yield* TestClock.adjust("60 seconds");
      assert.equal(
        yield* repository.recordObservation(expired, {
          ...remote,
          updated_at: 102,
          acus_consumed: 900,
        }),
        false,
      );
      assert.equal((yield* row(db)).acusConsumed, 2.75);
      const [last] = yield* repository.claimDueObservations();
      assert.equal(
        yield* repository.recordObservation(last, {
          ...remote,
          updated_at: 102,
          acus_consumed: 0,
        }),
        true,
      );
      assert.equal((yield* inspectSessionInsights("local")).acusConsumed, 0);
    }),
);

insightsTest(
  "mismatched recovery snapshots and submissions without observations leave consumed ACUs unknown",
  ({ db, repository }) =>
    Effect.gen(function* () {
      for (const id of ["mismatched", "no-observation"]) yield* seed(db, id);
      for (const claim of yield* repository.claimPending) {
        assert.equal(
          yield* repository.markSubmitted(
            claim.session,
            claim.session.id,
            claim.session.id === "mismatched" ? remote : undefined,
          ),
          true,
        );
        assert.equal((yield* row(db, claim.session.id)).acusConsumed, null);
      }
    }),
);

insightsTest(
  "recollection resets only unavailable analysis scheduling and is idempotent while pending or collected",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "local", {
        ...completed,
        acusConsumed: 8.375,
        analysisStatus: "unavailable",
        analysisAttempts: 12,
        analysisReason: "Attempts exhausted: PRIVATE reason",
        analysisNextAttemptAt: future,
      });
      const before = yield* row(db);
      const requested = yield* recollectInsights("local");
      assert.equal(requested.outcome, "rescheduled");
      assert.equal(requested.previousDiagnostic, "local_attempts_exhausted");
      assert.equal(requested.acusConsumed, 8.375);
      assert.ok(!JSON.stringify(requested).includes("PRIVATE"));
      const pending = yield* row(db);
      assert.deepEqual(pending, {
        ...before,
        analysisStatus: "pending",
        analysisAttempts: 0,
        analysisGeneration: 1,
        analysisNextAttemptAt: epoch,
        analysisReason: null,
      });
      assert.equal(
        (yield* recollectInsights("local")).outcome,
        "already_pending",
      );
      assert.deepEqual(yield* row(db), pending);
      const [claim] = yield* repository.claimDueAnalyses;
      const claimed = yield* row(db);
      assert.equal(
        (yield* recollectInsights("local")).outcome,
        "already_pending",
      );
      assert.deepEqual(yield* row(db), claimed);
      yield* repository.recordAnalysis(claim, {
        status: "collected",
        analysis: { private: "PRIVATE analysis", future_field: [1, 2] },
      });
      const collected = yield* row(db);
      assert.equal(
        (yield* recollectInsights("local")).outcome,
        "already_collected",
      );
      yield* repository.recordAnalysis(claim, {
        status: "pending",
        reason: "late recovery failure",
      });
      yield* repository.recordAnalysis(claim, {
        status: "unavailable",
        reason: "late ineligibility",
      });
      yield* TestClock.adjust("1 hour");
      assert.deepEqual(yield* repository.claimDueAnalyses, []);
      assert.deepEqual(yield* row(db), collected);
    }),
);

insightsTest(
  "a durable generation rejects old analysis claims even when reset counters and retry timestamps repeat",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db, "local", completed);
      const [old] = yield* repository.claimDueAnalyses;
      yield* TestClock.adjust("30 seconds");
      assert.deepEqual(yield* repository.claimDueAnalyses, []);
      assert.equal((yield* row(db)).analysisStatus, "unavailable");
      yield* recollectInsights("local");
      yield* TestClock.setTime(0);
      const [fresh] = yield* repository.claimDueAnalyses;
      assert.equal(fresh.analysisAttempts, old.analysisAttempts);
      assert.equal(fresh.analysisNextAttemptAt, old.analysisNextAttemptAt);
      assert.equal(fresh.analysisGeneration, old.analysisGeneration + 1);
      const pending = yield* row(db);
      for (
        const result of [
          { status: "collected" as const, analysis: { stale: true } },
          { status: "pending" as const, reason: "late failure" },
          { status: "unavailable" as const, reason: "late ineligibility" },
        ]
      ) {
        yield* repository.recordAnalysis(old, result);
        assert.deepEqual(yield* row(db), pending);
      }
      yield* repository.recordAnalysis(fresh, {
        status: "collected",
        analysis: { current: true },
      });
      assert.deepEqual((yield* row(db)).analysis, { current: true });
    }),
);

insightsTest(
  "recollection rejects missing IDs, absent rows, unassociated and never-completed sessions without writes",
  ({ db }) =>
    Effect.gen(function* () {
      yield* seed(db, "unassociated", {
        completionObservedAt: epoch,
        analysisStatus: "unavailable",
      });
      yield* seed(db, "never-completed", {
        status: "submitted",
        devinSessionId: "remote",
        providerLifecycle: "paused",
        analysisStatus: "unavailable",
      });
      const before = yield* db.select().from(devinSessions);
      for (
        const [id, message] of [
          ["", /required/],
          [" ", /required/],
          ["missing", /not found/],
          ["unassociated", /no associated remote/],
          ["never-completed", /never been observed/],
        ] as const
      ) {
        const result = yield* recollectInsights(id).pipe(Effect.result);
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure._tag, "RecollectionError");
        if (result.failure._tag === "RecollectionError") {
          assert.match(result.failure.message, message);
        }
      }
      assert.deepEqual(yield* db.select().from(devinSessions), before);
    }),
);

insightsTest(
  "safe operator diagnostics distinguish local exhaustion, observed no-message ineligibility, and unknown reasons",
  ({ db }) =>
    Effect.gen(function* () {
      yield* seed(db, "local", {
        ...completed,
        analysisStatus: "unavailable",
        analysisReason: "session has no Devin messages",
      });
      assert.equal(
        (yield* inspectSessionInsights("local")).collectionDiagnostic,
        "no_devin_messages_observed",
      );
      assert.equal((yield* recollectInsights("local")).outcome, "rescheduled");
      yield* db.update(devinSessions).set({
        analysisStatus: "unavailable",
        analysisReason: "PRIVATE provider text",
      });
      const readout = yield* inspectSessionInsights("local");
      assert.equal(readout.collectionDiagnostic, "unavailable_reason_unknown");
      assert.ok(!JSON.stringify(readout).includes("PRIVATE"));
    }),
);

const cli = (args: ReadonlyArray<string>, output: string[]) =>
  runRecollectInsights(args).pipe(
    Effect.provide(DenoServices.layer),
    Effect.provide(Stdio.layerTest({})),
    Effect.provideService(
      Console.Console,
      Object.assign(Object.create(console), {
        log: (value: string) => output.push(value),
      }),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  );

insightsTest(
  "CLI boundary validates arguments and rows; inspect is non-rescheduling and invocation requires no application secrets",
  ({ db, path }) =>
    Effect.gen(function* () {
      yield* seed(db, "local", {
        ...completed,
        analysisStatus: "unavailable",
        acusConsumed: 2.625,
      });
      const before = yield* row(db);
      const output: string[] = [];
      yield* cli(["--db", path, "--session-id", "local", "--inspect"], output);
      assert.equal(JSON.parse(output[0]).acusConsumed, 2.625);
      assert.deepEqual(yield* row(db), before);
      for (
        const args of [
          [],
          ["--db", path],
          ["--session-id", "local"],
          ["--db", path, "--session-id", ""],
          ["--db", path, "--session-id", " "],
          ["--db", path, "--session-id", "local", "--unknown"],
          ["--db", `${path}.missing`, "--session-id", "local"],
          ["--db", path, "--session-id", "missing"],
        ]
      ) {
        assert.ok(Result.isFailure(yield* cli(args, []).pipe(Effect.result)));
        assert.deepEqual(yield* row(db), before);
      }
      yield* cli(["--db", path, "--session-id", "local"], output);
      yield* cli(["--db", path, "--session-id", "local"], output);
      assert.equal(JSON.parse(output[1]).outcome, "rescheduled");
      assert.equal(JSON.parse(output[2]).outcome, "already_pending");
      assert.equal((yield* row(db)).analysisGeneration, 1);
    }),
);

Deno.test("CLI recollection survives restart and normal orchestration generates then collects insights through mocked HTTP", async () => {
  const folder = await Deno.makeTempDir();
  const path = `${folder}/sessions.sqlite`;
  const calls: string[] = [];
  const analysis = {
    summary: "PRIVATE collected",
    future: { preserved: true },
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method} ${url.pathname}`);
    if (init?.method === "POST") {
      assert.equal(
        url.pathname,
        "/v3/organizations/org-test/sessions/remote/insights/generate",
      );
      return Promise.resolve(
        Response.json({ session_id: "remote", status: "started" }),
      );
    }
    assert.equal(url.pathname, "/v3/organizations/org-test/sessions/insights");
    assert.deepEqual(url.searchParams.getAll("session_ids"), ["remote"]);
    return Promise.resolve(
      Response.json({
        items: [{
          ...remote,
          status_detail: "finished",
          num_devin_messages: 2,
          num_user_messages: 1,
          session_size: "s",
          analysis: calls.length >= 3 ? analysis : null,
        }],
      }),
    );
  };
  try {
    await Effect.runPromise(
      DatabaseClient.use(({ db }) =>
        seed(db, "local", {
          ...completed,
          analysisStatus: "unavailable",
          analysisAttempts: 12,
        })
      ).pipe(Effect.provide(DatabaseClient.layerWithPath(path))),
    );
    const output: string[] = [];
    await Effect.runPromise(
      cli(["--db", path, "--session-id", "local"], output),
    );
    assert.equal(JSON.parse(output[0]).outcome, "rescheduled");
    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        const orchestra = yield* DevinSessionOrchestrator;
        const before = yield* row(db);
        yield* orchestra.tick;
        assert.equal((yield* row(db)).analysisStatus, "pending");
        yield* TestClock.adjust("30 seconds");
        yield* orchestra.tick;
        const collected = yield* row(db);
        assert.deepEqual(collected, {
          ...before,
          analysisStatus: "collected",
          analysis,
          analysisReason: null,
          analysisAttempts: 2,
          analysisNextAttemptAt: "1970-01-01T00:01:30.000Z",
        });
        yield* orchestra.tick;
        assert.equal(calls.length, 3);
      }).pipe(
        Effect.provide(DevinSessionOrchestrator.layer.pipe(
          Layer.provide(
            Layer.succeed(GitHubCommentNotifier, { tick: Effect.void }),
          ),
          Layer.provide(WebhookEventProcessors.layer),
          Layer.provide(DevinSessionRepository.layer),
          Layer.provideMerge(DatabaseClient.layerWithPath(path)),
          Layer.provide(DevinClient.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                DEVIN_API_KEY: "test-key",
                DEVIN_ORGANIZATION_ID: "org-test",
                GITHUB_WEBHOOK_SECRET: "test-secret",
              }),
            ),
          ),
        )),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(TestClock.layer()),
      ),
    );
    await Effect.runPromise(
      cli(["--db", path, "--session-id", "local"], output),
    );
    assert.equal(JSON.parse(output[1]).outcome, "already_collected");
    assert.ok(!output.join().includes("PRIVATE"));
  } finally {
    await Deno.remove(folder, { recursive: true });
  }
});
