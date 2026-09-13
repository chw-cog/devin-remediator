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
import { FetchHttpClient } from "effect/unstable/http";
import { type AppDatabase, DatabaseClient, DatabaseError } from "./database.ts";
import { type Env } from "./config.ts";
import {
  DevinClient,
  DevinLookupError,
  type DevinSession,
  DevinSubmissionError,
  type SessionState,
} from "./devin.ts";
import { DevinSessionOrchestrator } from "./devin_session_orchestrator.ts";
import {
  type DeliveryRecord,
  DevinSessionRepository,
  type SessionRecord,
} from "./devin_session_repository.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";
import {
  type WebhookDeliveryOutcome,
  type WebhookDeliveryProcessor,
  WebhookDeliveryProcessors,
} from "./webhook_delivery_processors.ts";

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

function fakeClient() {
  const creates: Parameters<DevinClient["Service"]["createSession"]>[0][] = [];
  const gets: string[] = [];
  const lookups: string[] = [];
  const behavior = {
    create: (): ReturnType<DevinClient["Service"]["createSession"]> =>
      Effect.succeed({
        ...remote,
        session_id: `devin-created-${creates.length}`,
      }),
    get: (_id: string): ReturnType<DevinClient["Service"]["getSession"]> =>
      Effect.succeed({ status: "running", pullRequestUrls: [] }),
    lookup: (
      _tag: string,
    ): ReturnType<DevinClient["Service"]["findSessionsByTag"]> =>
      Effect.succeed([]),
  };
  const client = DevinClient.of({
    createSession: (params) =>
      Effect.suspend(() => {
        creates.push(params);
        return behavior.create();
      }),
    getSession: (id) =>
      Effect.suspend(() => {
        gets.push(id);
        return behavior.get(id);
      }),
    listSessions: () => Effect.die("Orchestration must use getSession"),
    findSessionsByTag: (tag) =>
      Effect.suspend(() => {
        lookups.push(tag);
        return behavior.lookup(tag);
      }),
  });
  return { creates, gets, lookups, behavior, client };
}

function testLayer(
  fake: ReturnType<typeof fakeClient>,
  env: Env = {},
  processors: Layer.Layer<WebhookDeliveryProcessors> =
    WebhookDeliveryProcessors.layer,
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
  processors: Layer.Layer<WebhookDeliveryProcessors> =
    WebhookDeliveryProcessors.layer,
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

Deno.test("issue processing recovers a lost HTTP creation response through paginated tag lookup", async () => {
  let posts = 0;
  const pages: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (init?.method === "POST") {
      posts++;
      assert.ok(init.body instanceof Uint8Array);
      const request = JSON.parse(new TextDecoder().decode(init.body));
      assert.deepEqual(request.tags, [
        "delivery-id:delivery-http",
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
    Layer.provide(WebhookDeliveryProcessors.layer),
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
        "issue:123",
      ]);
      assert.match(fake.creates[0].prompt, /Delivery: delivery-one/);
      assert.match(fake.creates[0].prompt, /Issue: 123/);
      assert.match(fake.creates[0].prompt, /"title":"Fix this"/);
      yield* orchestra.tick;
      yield* orchestra.tick;
      assert.equal(fake.creates.length, 1);
      assert.deepEqual(fake.gets, ["devin-created", "devin-created"]);
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
  "completion persists the matching repository PR and frees capacity in the same tick",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "running", {
        status: "running",
        devinSessionId: "existing",
      });
      yield* seed(db, "pending");
      fake.behavior.get = () =>
        Effect.succeed({
          status: "succeeded",
          pullRequestUrls: [
            "https://github.com/unrelated/repo/pull/12",
            "https://github.com/owner/repo/pull/42",
          ],
        });
      yield* orchestra.tick;
      assert.deepEqual(fake.gets, ["existing"]);
      assert.equal((yield* row(db, "running")).status, "succeeded");
      assert.equal((yield* row(db, "running")).prNumber, 42);
      assert.equal((yield* row(db, "pending")).status, "running");
      assert.equal(fake.creates.length, 1);
    }),
  { DEVIN_MAX_CONCURRENT_SESSIONS: "1" },
);

orchestrationTest(
  "terminal rows remain unchanged and a remote terminal failure is not retried",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "success", {
        status: "succeeded",
        devinSessionId: "success",
        prNumber: 17,
      });
      yield* seed(db, "failed", { status: "failed" });
      yield* seed(db, "running", {
        status: "running",
        devinSessionId: "failure",
      });
      const success = yield* row(db, "success");
      const failure = yield* row(db, "failed");
      fake.behavior.get = () =>
        Effect.succeed({ status: "failed", pullRequestUrls: [] });
      yield* orchestra.tick;
      yield* orchestra.tick;
      assert.deepEqual(yield* row(db, "success"), success);
      assert.deepEqual(yield* row(db, "failed"), failure);
      assert.equal((yield* row(db, "running")).status, "failed");
      assert.deepEqual(fake.gets, ["failure"]);
      assert.equal(fake.creates.length, 0);
    }),
);

orchestrationTest(
  "polling failure keeps the remote identity and capacity while other rows reconcile",
  ({ db, orchestra, fake }) =>
    Effect.gen(function* () {
      yield* seed(db, "one", {
        status: "running",
        devinSessionId: "unavailable",
      });
      yield* seed(db, "two", { status: "running", devinSessionId: "done" });
      yield* seed(db, "three");
      const before = yield* row(db, "one");
      fake.behavior.get = (id) =>
        id === "unavailable"
          ? Effect.never.pipe(Effect.timeout(0))
          : Effect.succeed({ status: "succeeded", pullRequestUrls: [] });
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
        ["delivery-id:delivery-one", "issue:123"],
        ["delivery-id:delivery-one", "issue:123"],
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
        Effect.provide(WebhookDeliveryProcessors.layer),
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
    fake.behavior.get = () =>
      Effect.succeed<SessionState>({
        status: "succeeded",
        pullRequestUrls: [],
      });
    await Effect.runPromise(
      Effect.gen(function* () {
        const orchestra = yield* DevinSessionOrchestrator;
        const { db } = yield* DatabaseClient;
        yield* orchestra.tick;
        assert.equal((yield* row(db, "existing")).status, "succeeded");
      }).pipe(Effect.provide(layer)),
    );
    assert.deepEqual(fake.gets, ["existing-session"]);
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
        assert.equal(fake.gets.length, 0);
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
        assert.deepEqual(fake.gets, []);
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
      assert.deepEqual(fake.gets, []);
    }),
  {},
  Layer.succeed(WebhookDeliveryProcessors, new Map()),
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

const pullRequestProcessor: WebhookDeliveryProcessor = (delivery, client) =>
  client.createSession({
    title: `Custom processor for ${delivery.deliveryId}`,
    prompt: delivery.payload,
    repos: [delivery.repo],
  }).pipe(Effect.map((session): WebhookDeliveryOutcome => ({
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
      assert.deepEqual(fake.gets, ["devin-created-1"]);
    }),
  {},
  Layer.succeed(
    WebhookDeliveryProcessors,
    new Map([
      ["pull_request", pullRequestProcessor],
      ["unused", () => Effect.die("Registry must select only one processor")],
    ]),
  ),
);
