import { strict as assert } from "node:assert";
import { createPublicKey, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  ConfigProvider,
  DateTime,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Logger,
  type Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { githubAppEnv } from "../test/fixtures/github-app.ts";
import { playbook } from "../test/fixtures/playbook.ts";
import { GitHubCommentNotifier } from "./github-comment-notifier.ts";
import { GitHubAuthenticationError, GitHubClient } from "./github.ts";
import { type AppDatabase, DatabaseClient } from "./database.ts";
import { DevinClient, type DevinSession } from "./devin.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { WebhookEventProcessors } from "./webhook-event-processors.ts";
import {
  attentionNotifications as notifications,
  devinSessions,
  githubNotificationGate as gate,
  githubWebhookDeliveries,
} from "./schemas.ts";

const remote: DevinSession = {
  session_id: "session-one",
  url: "https://app.devin.ai/sessions/session-one",
  org_id: "org-test",
  status: "running",
  status_detail: "waiting_for_user",
  created_at: 1,
  updated_at: 1,
  acus_consumed: 0,
  tags: [],
  pull_requests: [],
  structured_output: {
    outcome: "needs_human",
    summary: "PRIVATE QUESTION",
    blocker: "PRIVATE BLOCKER",
    next_action: "PRIVATE ACTION",
  },
};
const config = (
  enabled = true,
  filepath = ":memory:",
  installationId = "202",
) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown({
    DEVIN_API_KEY: "synthetic-devin",
    DEVIN_ORGANIZATION_ID: "org-test",
    GITHUB_WEBHOOK_SECRET: "synthetic-webhook",
    SQLITE_DB_FILEPATH: filepath,
    ...(enabled
      ? { ...githubAppEnv, GITHUB_APP_INSTALLATION_ID: installationId }
      : {}),
  }));
const seed = Effect.fnUntraced(
  function* (
    db: AppDatabase,
    id = "local-one",
    repo = "owner/repo",
    issueNumber: number | null = 42,
  ) {
    yield* db.insert(githubWebhookDeliveries).values({
      id,
      deliveryId: id,
      eventName: "issues",
      repo,
      issueNumber,
      payload: "{}",
      insertedAt: "1970-01-01T00:00:00.000Z",
    });
    yield* db.insert(devinSessions).values({
      id,
      githubDeliveryId: id,
      status: "submitted",
      devinSessionId: id === "local-one" ? remote.session_id : id,
      insertedAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
  },
);
const observe = Effect.fnUntraced(
  function* (
    db: AppDatabase,
    repository: DevinSessionRepository["Service"],
    state: DevinSession = remote,
  ) {
    yield* db.update(devinSessions).set({
      nextObservationAt: "1970-01-01T00:00:00.000Z",
    });
    const [claim] = yield* repository.claimDueObservations();
    assert.ok(claim);
    assert.equal(yield* repository.recordObservation(claim, state), true);
  },
);
const row = Effect.fnUntraced(function* (db: AppDatabase) {
  const [value] = yield* db.select().from(notifications).orderBy(
    notifications.sequence,
  );
  assert.ok(value);
  return value;
});
const due = Effect.fnUntraced(function* (db: AppDatabase) {
  const saved = yield* row(db);
  const [slot] = yield* db.select().from(gate);
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  yield* TestClock.adjust(
    Math.max(
      0,
      saved.dueAt - now,
      slot.nextRequestAt - now,
      saved.leaseUntil - now,
      slot.leaseUntil - now,
    ),
  );
});
type Captured = {
  url: URL;
  kind: "token" | "comment" | "lookup";
  method: string;
  body: string;
  json: unknown;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
};
function http() {
  const requests: Captured[] = [];
  const behavior = {
    expiresAt: "2099-01-01T00:00:00.000Z",
    respond: (request: Captured): Response | Promise<Response> =>
      Response.json(
        request.kind === "token"
          ? {
            token: "synthetic-installation-token",
            expires_at: behavior.expiresAt,
            permissions: { issues: "write" },
          }
          : request.kind === "comment"
          ? {
            id: 900,
            body: request.body,
            performed_via_github_app: { id: 101 },
          }
          : [],
        { status: request.method === "POST" ? 201 : 200 },
      ),
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = request.method === "POST" ? await request.json() : null;
    const captured: Captured = {
      url,
      method: request.method,
      kind: url.pathname.endsWith("/access_tokens")
        ? "token"
        : request.method === "POST"
        ? "comment"
        : "lookup",
      body: json?.body ?? "",
      json,
      authorization: request.headers.get("authorization"),
      redirect: init?.redirect,
    };
    requests.push(captured);
    return behavior.respond(captured);
  };
  return {
    requests,
    behavior,
    fetch,
    posts: () => requests.filter((r) => r.kind === "comment"),
  };
}
type Fixture = {
  db: AppDatabase;
  repository: DevinSessionRepository["Service"];
  notifier: GitHubCommentNotifier["Service"];
  http: ReturnType<typeof http>;
  logs: string[];
};
function notificationTest(
  name: string,
  test: (fixture: Fixture) => Effect.Effect<void, unknown, Scope.Scope>,
  enabled = true,
) {
  Deno.test(name, async () => {
    const transport = http();
    const logs: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* test({
          db: (yield* DatabaseClient).db,
          repository: yield* DevinSessionRepository,
          notifier: yield* GitHubCommentNotifier,
          http: transport,
          logs,
        });
      }).pipe(
        Effect.provide(
          Layer.merge(GitHubCommentNotifier.layer, DevinSessionRepository.layer)
            .pipe(
              Layer.provide(GitHubClient.layer),
              Layer.provideMerge(DatabaseClient.layer),
            ),
        ),
        Effect.provide(config(enabled)),
        Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
        Effect.provide(Logger.layer([Logger.make((entry) => {
          logs.push(JSON.stringify(Logger.formatStructured.log(entry)));
        })])),
        Effect.provide(TestClock.layer()),
        Effect.scoped,
      ),
    );
  });
}
const prepare = Effect.fnUntraced(
  function* ({ db, repository, notifier }: Fixture) {
    yield* seed(db);
    yield* observe(db, repository);
    yield* notifier.tick;
    yield* due(db);
  },
);
const ambiguous = Effect.fnUntraced(function* (fixture: Fixture) {
  yield* prepare(fixture);
  const normal = fixture.http.behavior.respond;
  fixture.http.behavior.respond = (request) =>
    request.kind === "comment"
      ? Response.json({}, { status: 503 })
      : normal(request);
  yield* fixture.notifier.tick;
  yield* due(fixture.db);
});

notificationTest(
  "lifecycle persists private progress, frees capacity, signs App JWT, sends safe Octokit JSON and ignores unchanged polls",
  (f) =>
    Effect.gen(function* () {
      const { db, repository, notifier, http, logs } = f;
      yield* seed(db);
      yield* observe(db, repository, {
        ...remote,
        pull_requests: [{
          pr_url: "https://github.com/owner/repo/pull/8",
          pr_state: "open",
        }],
      });
      const [session] = yield* db.select().from(devinSessions);
      assert.equal(session.providerLifecycle, "needs_input");
      assert.equal(session.activeWork, false);
      assert.equal(session.status, "submitted");
      assert.equal(session.completionObservedAt, null);
      assert.equal(session.prNumber, 8);
      assert.equal(session.outputs[0].summary, "PRIVATE QUESTION");
      yield* seed(db, "capacity-next");
      yield* db.update(devinSessions).set({
        status: "pending",
        devinSessionId: null,
      }).where(eq(devinSessions.id, "capacity-next"));
      assert.equal((yield* repository.claimPending).length, 1);
      yield* db.update(devinSessions).set({ status: "skipped" }).where(
        eq(devinSessions.id, "capacity-next"),
      );
      yield* notifier.tick;
      assert.deepEqual(http.requests.map((r) => r.url.pathname), [
        "/app/installations/202/access_tokens",
      ]);
      assert.deepEqual(http.requests[0].json, {
        permissions: { issues: "write" },
      });
      const jwt = http.requests[0].authorization!.split(" ")[1];
      const [header, payload, signature] = jwt.split(".");
      assert.equal(
        JSON.parse(Buffer.from(header, "base64url").toString()).alg,
        "RS256",
      );
      assert.equal(
        JSON.parse(Buffer.from(payload, "base64url").toString()).iss,
        101,
      );
      assert.equal(
        verify(
          "RSA-SHA256",
          Buffer.from(`${header}.${payload}`),
          createPublicKey(githubAppEnv.GITHUB_APP_PRIVATE_KEY),
          Buffer.from(signature, "base64url"),
        ),
        true,
      );
      yield* notifier.tick;
      assert.equal(http.requests.length, 1);
      yield* due(db);
      yield* notifier.tick;
      const comment = http.posts()[0];
      assert.equal(
        comment.url.href,
        "https://api.github.com/repos/owner/repo/issues/42/comments",
      );
      assert.equal(comment.authorization, "token synthetic-installation-token");
      assert.ok(http.requests.every((r) => r.redirect === "error"));
      assert.match(
        comment.body,
        /^Devin was observed awaiting input\. Review its current state and respond in \[the authenticated Devin session\]\(https:\/\/app\.devin\.ai\/sessions\/session-one\)\. GitHub replies are not forwarded\.\n\n<!-- devin-attention:[a-f0-9-]+ -->$/,
      );
      assert.deepEqual(comment.json, { body: comment.body });
      assert.equal((yield* row(db)).status, "delivered");
      assert.equal((yield* row(db)).expectedAppId, 101);
      assert.equal((yield* row(db)).expectedInstallationId, 202);
      for (let i = 0; i < 3; i++) {
        yield* observe(db, repository, {
          ...remote,
          updated_at: i + 2,
          structured_output: {
            outcome: "needs_human",
            summary: `PRIVATE CHANGED ${i}`,
          },
        });
        yield* TestClock.adjust("1 minute");
        yield* notifier.tick;
      }
      assert.equal(http.requests.length, 2);
      assert.equal((yield* db.select().from(notifications)).length, 1);
      yield* observe(db, repository, {
        ...remote,
        updated_at: 5,
        status_detail: "waiting_for_approval",
      });
      yield* notifier.tick;
      assert.match(
        http.posts()[1].body,
        /awaiting approval\. Review its current state and approve or decline/,
      );
      assert.equal(http.requests.filter((r) => r.kind === "token").length, 1);
      yield* observe(db, repository, {
        ...remote,
        updated_at: 6,
        status_detail: "working",
      });
      yield* observe(db, repository, { ...remote, updated_at: 7 });
      assert.deepEqual(
        (yield* db.select().from(notifications).orderBy(notifications.sequence))
          .map((r) => r.reason),
        ["needs_input", "needs_approval", "needs_input"],
      );
      assert.equal(
        (yield* db.select().from(devinSessions).where(
          eq(devinSessions.id, "local-one"),
        ))[0].completionObservedAt,
        null,
      );
      assert.ok(!JSON.stringify(http.posts()).includes("PRIVATE"));
      assert.ok(!logs.join("\n").includes("PRIVATE"));
      assert.ok(!logs.join("\n").includes("synthetic-installation-token"));
      assert.ok(!logs.join("\n").includes(jwt));
    }),
);

notificationTest(
  "official Devin Common Flows prefixed session ID produces its documented safe link",
  ({ db, repository, notifier, http }) =>
    Effect.gen(function* () {
      yield* seed(db);
      yield* db.update(devinSessions).set({ devinSessionId: "devin-abc123" });
      yield* observe(db, repository, {
        ...remote,
        session_id: "devin-abc123",
        url: "https://app.devin.ai/sessions/devin-abc123",
      });
      yield* notifier.tick;
      yield* due(db);
      yield* notifier.tick;
      assert.equal((yield* row(db)).status, "delivered");
      assert.ok(
        http.posts()[0].body.includes(
          "[the authenticated Devin session](https://app.devin.ai/sessions/devin-abc123)",
        ),
      );
    }),
);

notificationTest(
  "both observation paths are atomic and stale leases cannot create episodes",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db);
      yield* db.update(devinSessions).set({
        status: "pending",
        devinSessionId: null,
      });
      const [submission] = yield* repository.claimPending;
      yield* db
        .$client`CREATE TRIGGER reject_attention BEFORE INSERT ON attention_notifications WHEN NEW.reason = 'needs_input' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`;
      assert.equal(
        (yield* repository.markSubmitted(
          submission.session,
          remote.session_id,
          remote,
        ).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* db.select().from(devinSessions))[0].status,
        "submitting",
      );
      assert.deepEqual(yield* db.select().from(notifications), []);
      yield* db.$client`DROP TRIGGER reject_attention`;
      assert.equal(
        yield* repository.markSubmitted(
          submission.session,
          remote.session_id,
          remote,
        ),
        true,
      );
      assert.equal(
        yield* repository.markSubmitted(
          submission.session,
          remote.session_id,
          remote,
        ),
        false,
      );
      yield* db.update(devinSessions).set({
        nextObservationAt: "1970-01-01T00:00:00.000Z",
      });
      const [stale] = yield* repository.claimDueObservations();
      yield* TestClock.adjust("61 seconds");
      const [fresh] = yield* repository.claimDueObservations();
      const approval = {
        ...remote,
        status_detail: "waiting_for_approval",
        updated_at: 2,
      };
      assert.equal(yield* repository.recordObservation(stale, approval), false);
      yield* db
        .$client`CREATE TRIGGER reject_attention BEFORE INSERT ON attention_notifications BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`;
      assert.equal(
        (yield* repository.recordObservation(fresh, approval).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* db.select().from(devinSessions))[0].providerLifecycle,
        "needs_input",
      );
      yield* db.$client`DROP TRIGGER reject_attention`;
      assert.equal(yield* repository.recordObservation(fresh, approval), true);
      assert.deepEqual(
        (yield* db.select().from(notifications).orderBy(notifications.sequence))
          .map((r) => [r.sequence, r.reason, r.status, r.closedAt !== null]),
        [
          [0, "session_started", "pending", false],
          [1, "needs_input", "cancelled", true],
          [2, "needs_approval", "pending", false],
        ],
      );
    }),
);

for (const recovered of [false, true]) {
  for (const githubFails of [false, true]) {
    notificationTest(
      `startup follows ${
        recovered ? "recovered" : "successful"
      } dispatch once without redispatch (GitHub failure ${githubFails})`,
      ({ db, repository, notifier, http }) =>
        Effect.gen(function* () {
          yield* seed(db);
          yield* db.update(githubWebhookDeliveries).set({
            payload:
              '{"action":"labeled","label":{"name":"devin"},"issue":{"number":42,"title":"Fix this"}}',
          });
          yield* db.update(devinSessions).set({
            status: recovered ? "submitting" : "pending",
            attempts: recovered ? 1 : 0,
            devinSessionId: null,
            updatedAt: "1969-01-01T00:00:00.000Z",
          });
          const calls: string[] = [];
          const running = {
            ...remote,
            url: "https://untrusted.example/session",
            status_detail: "working",
            structured_output: null,
          };
          const unexpected = () => Effect.die("Unexpected Devin call");
          const client = DevinClient.of({
            diagnoseSession: unexpected,
            createPlaybook: unexpected,
            findPlaybookByMacro: () => Effect.succeed(playbook),
            createSession: () =>
              Effect.sync(() => {
                calls.push("create");
                return running;
              }),
            findSessionsByTag: () =>
              Effect.sync(() => {
                calls.push("recover");
                return [running];
              }),
            listSessions: () => Effect.succeed([running]),
            listSessionsWithInsights: unexpected,
            generateSessionInsights: unexpected,
          });
          const normal = http.behavior.respond;
          yield* DevinSessionOrchestrator.use((orchestra) =>
            Effect.gen(function* () {
              yield* orchestra.tick;
              const started = yield* row(db);
              assert.equal(started.reason, "session_started");
              assert.equal(started.sequence, 0);
              assert.equal(started.remoteId, "session-one");
              assert.equal(
                started.sessionUrl,
                "https://app.devin.ai/sessions/session-one",
              );
              assert.equal(started.closedAt, null);
              assert.equal(http.requests.length, 0);
              if (githubFails) {
                http.behavior.respond = () =>
                  Response.json({}, {
                    status: 429,
                    headers: { "retry-after": "120" },
                  });
                yield* orchestra.tick;
                assert.equal((yield* row(db)).attempts, 1);
                yield* TestClock.adjust("119 seconds");
                yield* orchestra.tick;
                assert.equal(http.requests.length, 1);
                yield* due(db);
                http.behavior.respond = normal;
              }
              yield* orchestra.tick;
              yield* due(db);
              if (githubFails) {
                http.behavior.respond = () =>
                  Response.json({}, { status: 503 });
              }
              yield* orchestra.tick;
              const expected =
                `Devin has picked up this issue. [Follow the session](https://app.devin.ai/sessions/session-one).\n\n<!-- devin-attention:${started.id} -->`;
              assert.deepEqual(http.posts().map((request) => request.json), [{
                body: expected,
              }]);
              assert.equal(
                http.posts()[0].url.href,
                "https://api.github.com/repos/owner/repo/issues/42/comments",
              );
              if (githubFails) {
                assert.equal((yield* row(db)).status, "pending");
                assert.ok((yield* row(db)).possibleSendAt !== null);
                yield* due(db);
                http.behavior.respond = () =>
                  Response.json([{
                    id: 901,
                    body: expected,
                    performed_via_github_app: { id: 101 },
                  }]);
                yield* orchestra.tick;
                assert.equal(http.requests.at(-1)?.kind, "lookup");
              }
              assert.equal((yield* row(db)).status, "delivered");
              for (let i = 0; i < 3; i++) {
                yield* TestClock.adjust("1 minute");
                yield* orchestra.tick;
              }
              assert.equal(http.posts().length, 1);
              assert.equal((yield* db.select().from(notifications)).length, 1);
              const [session] = yield* db.select().from(devinSessions);
              assert.equal(session.status, "submitted");
              assert.equal(session.devinSessionId, "session-one");
              assert.deepEqual(calls, [recovered ? "recover" : "create"]);
            })
          ).pipe(
            Effect.provide(DevinSessionOrchestrator.layer),
            Effect.provideService(GitHubCommentNotifier, notifier),
            Effect.provideService(DatabaseClient, { db }),
            Effect.provideService(DevinSessionRepository, repository),
            Effect.provideService(DevinClient, client),
            Effect.provide(WebhookEventProcessors.layer),
            Effect.provide(config()),
          );
        }),
    );
  }
}

notificationTest(
  "startup enqueue rolls back submission, fences replaced claims and survives submission retries once",
  ({ db, repository }) =>
    Effect.gen(function* () {
      yield* seed(db);
      yield* db.update(devinSessions).set({
        status: "pending",
        devinSessionId: null,
      });
      const [old] = yield* repository.claimPending;
      yield* repository.rejectSubmission(old.session, true);
      assert.deepEqual(yield* db.select().from(notifications), []);
      const [current] = yield* repository.claimPending;
      assert.equal(
        yield* repository.markSubmitted(old.session, "stale"),
        false,
      );
      assert.deepEqual(yield* db.select().from(notifications), []);
      yield* db
        .$client`CREATE TRIGGER reject_startup BEFORE INSERT ON attention_notifications WHEN NEW.reason = 'session_started' BEGIN SELECT RAISE(ABORT, 'synthetic rollback'); END`;
      const [before] = yield* db.select().from(devinSessions);
      assert.equal(
        (yield* repository.markSubmitted(current.session, remote.session_id)
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.deepEqual((yield* db.select().from(devinSessions))[0], before);
      assert.deepEqual(yield* db.select().from(notifications), []);
      yield* db.$client`DROP TRIGGER reject_startup`;
      assert.equal(
        yield* repository.markSubmitted(current.session, remote.session_id),
        true,
      );
      const started = yield* row(db);
      assert.equal(started.reason, "session_started");
      assert.equal(started.sequence, 0);
      assert.equal(
        yield* repository.markSubmitted(current.session, "replacement"),
        false,
      );
      assert.deepEqual(
        yield* repository.rejectSubmission(current.session, true),
        [],
      );
      assert.deepEqual(yield* db.select().from(notifications), [started]);
      assert.deepEqual(yield* repository.claimPending, []);
    }),
);

for (
  const delivery of ["pending", "blocked", "in_flight", "delivered"] as const
) {
  notificationTest(
    `attention transitions and link repair leave ${delivery} startup snapshots untouched`,
    ({ db, repository }) =>
      Effect.gen(function* () {
        yield* seed(db);
        yield* db.update(devinSessions).set({
          status: "pending",
          devinSessionId: null,
        });
        const [claim] = yield* repository.claimPending;
        assert.equal(
          yield* repository.markSubmitted(claim.session, remote.session_id),
          true,
        );
        if (delivery !== "pending") {
          yield* db.update(notifications).set(
            delivery === "blocked"
              ? {
                status: "blocked",
                lastFailure: "unsafe_link",
                body: "frozen blocked body",
              }
              : {
                status: delivery === "delivered" ? "delivered" : "pending",
                body: "frozen sent body",
                possibleSendAt: 1,
                expectedAppId: 101,
                expectedInstallationId: 202,
                commentId: delivery === "delivered" ? 900 : null,
              },
          );
        }
        const started = yield* row(db);
        for (
          const state of [
            remote,
            {
              ...remote,
              url: "https://invalid.example/changed",
              updated_at: 2,
            },
            { ...remote, updated_at: 3 },
            { ...remote, status_detail: "waiting_for_approval", updated_at: 4 },
            { ...remote, status_detail: "working", updated_at: 5 },
            {
              ...remote,
              status: "exit",
              status_detail: "finished",
              updated_at: 6,
            },
            { ...remote, updated_at: 7 },
            { ...remote, is_archived: true, updated_at: 8 },
          ] satisfies ReadonlyArray<DevinSession>
        ) {
          yield* observe(db, repository, state);
          assert.deepEqual(yield* row(db), started);
        }
        assert.deepEqual(
          (yield* db.select().from(notifications).orderBy(
            notifications.sequence,
          ))
            .map((r) => [r.sequence, r.reason, r.status]),
          [
            [0, "session_started", started.status],
            [1, "needs_input", "cancelled"],
            [2, "needs_approval", "cancelled"],
            [3, "needs_input", "cancelled"],
          ],
        );
      }),
  );
}

notificationTest(
  "disabled delivery retains unclaimed work and reports without per-poll noise",
  ({ db, repository, notifier, http, logs }) =>
    Effect.gen(function* () {
      yield* seed(db);
      yield* observe(db, repository);
      const before = yield* row(db);
      for (let i = 0; i < 5; i++) yield* notifier.tick;
      assert.deepEqual(yield* row(db), before);
      assert.equal(http.requests.length, 0);
      assert.equal(
        logs.filter((l) => l.includes("attention.delivery_disabled")).length,
        1,
      );
      assert.equal(
        logs.filter((l) => l.includes("attention.backlog")).length,
        1,
      );
    }),
  false,
);

notificationTest(
  "ambiguous POST scans each page, ignores foreign attribution when a verified match exists, and diagnoses duplicates",
  (f) =>
    Effect.gen(function* () {
      yield* ambiguous(f);
      const { db, notifier, http, logs } = f;
      const body = http.posts()[0].body;
      http.behavior.respond = (request) =>
        request.url.searchParams.get("page") === "1"
          ? Response.json([{
            id: 1,
            body,
            performed_via_github_app: { id: 999 },
          }], {
            headers: {
              link:
                '<https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2>; rel="next"',
            },
          })
          : Response.json([{
            id: 901,
            body,
            performed_via_github_app: { id: 101 },
          }, { id: 902, body, performed_via_github_app: { id: 101 } }]);
      yield* notifier.tick;
      assert.equal((yield* row(db)).scanPage, 2);
      assert.equal((yield* row(db)).negativeScans, 0);
      yield* due(db);
      yield* notifier.tick;
      assert.equal((yield* row(db)).status, "delivered");
      assert.equal((yield* row(db)).commentId, 901);
      assert.equal((yield* row(db)).lastFailure, "duplicates");
      assert.equal(http.posts().length, 1);
      assert.ok(logs.some((l) => l.includes("attention.duplicate_comments")));
    }),
);

for (const attribution of [undefined, null, { id: 999 }]) {
  notificationTest(
    `missing or foreign App attribution blocks ambiguous retry (${
      JSON.stringify(attribution)
    })`,
    (f) =>
      Effect.gen(function* () {
        yield* ambiguous(f);
        const { db, notifier, http } = f;
        http.behavior.respond = () =>
          Response.json([{
            id: 1,
            body: http.posts()[0].body,
            performed_via_github_app: attribution,
          }]);
        yield* notifier.tick;
        assert.equal((yield* row(db)).status, "blocked");
        assert.equal((yield* row(db)).lastFailure, "unverified_attribution");
        yield* TestClock.adjust("1 day");
        yield* notifier.tick;
        assert.equal(http.posts().length, 1);
        assert.equal((yield* row(db)).negativeScans, 0);
      }),
  );
}

notificationTest(
  "two complete negative scans separated by grace precede any ambiguous retry",
  (f) =>
    Effect.gen(function* () {
      yield* ambiguous(f);
      const { db, notifier, http } = f;
      yield* notifier.tick;
      assert.equal((yield* row(db)).negativeScans, 1);
      yield* TestClock.adjust("59 seconds");
      yield* notifier.tick;
      assert.equal((yield* row(db)).negativeScans, 1);
      yield* TestClock.adjust("1 second");
      yield* notifier.tick;
      assert.equal((yield* row(db)).negativeScans, 2);
      assert.equal(http.posts().length, 1);
      http.behavior.respond = (r) =>
        Response.json({ id: 900, body: r.body }, { status: 201 });
      yield* due(db);
      yield* notifier.tick;
      assert.equal(http.posts().length, 2);
      assert.equal(http.posts()[0].body, http.posts()[1].body);
      assert.equal((yield* row(db)).status, "delivered");
    }),
);

notificationTest(
  "closed unsent episodes cancel, while closed possible sends reconcile without reposting",
  (f) =>
    Effect.gen(function* () {
      const { db, repository, notifier, http } = f;
      yield* seed(db);
      yield* observe(db, repository);
      yield* observe(db, repository, {
        ...remote,
        updated_at: 2,
        status_detail: "working",
      });
      yield* notifier.tick;
      assert.equal(http.requests.length, 0);
      assert.equal((yield* row(db)).status, "cancelled");
      yield* observe(db, repository, { ...remote, updated_at: 3 });
      yield* notifier.tick;
      yield* TestClock.adjust("3 seconds");
      http.behavior.respond = (r) =>
        r.kind === "comment"
          ? Response.json({}, { status: 500 })
          : Response.json([]);
      yield* notifier.tick;
      yield* observe(db, repository, {
        ...remote,
        updated_at: 4,
        status_detail: "working",
      });
      yield* TestClock.adjust("2 minutes");
      yield* notifier.tick;
      assert.equal(
        (yield* db.select().from(notifications)).filter((r) =>
          r.status === "cancelled"
        ).length,
        2,
      );
      assert.equal(http.posts().length, 1);
    }),
);

for (
  const link of [
    '<https://evil.test/?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/other/repo/issues/42/comments?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=1>; rel="next"',
    "broken",
  ]
) {
  notificationTest(
    `incomplete pagination cannot establish absence (${link})`,
    (f) =>
      Effect.gen(function* () {
        yield* ambiguous(f);
        f.http.behavior.respond = () =>
          Response.json([], { headers: { link } });
        yield* f.notifier.tick;
        assert.equal((yield* row(f.db)).negativeScans, 0);
        assert.equal((yield* row(f.db)).scanPage, 1);
        assert.equal(f.http.posts().length, 1);
        assert.ok(
          f.http.requests.every((r) =>
            r.url.origin === "https://api.github.com"
          ),
        );
      }),
  );
}
for (
  const [repo, issue, url] of [
    ["owner/repo", 42, "https://evil.test/PRIVATE"],
    ["owner/repo", 42, `${remote.url}?PRIVATE=1`],
    ["owner/repo", 42, "https://app.devin.ai/sessions/other"],
    [
      "owner/repo",
      42,
      "https://user:PRIVATE@app.devin.ai/sessions/session-one",
    ],
    ["owner/..", 42, remote.url],
    ["owner/repo", 0, remote.url],
  ] as const
) {
  notificationTest(
    `unsafe public target blocks without auth or comments (${repo}, ${issue}, ${url})`,
    ({ db, repository, notifier, http, logs }) =>
      Effect.gen(function* () {
        yield* seed(db, "local-one", repo, issue);
        yield* observe(db, repository, { ...remote, url });
        yield* notifier.tick;
        assert.equal((yield* row(db)).status, "blocked");
        assert.equal(http.requests.length, 0);
        yield* observe(db, repository, { ...remote, url, updated_at: 2 });
        yield* notifier.tick;
        assert.equal(
          logs.filter((l) => l.includes("attention.target_blocked")).length,
          1,
        );
        assert.ok(!logs.join("\n").includes("PRIVATE"));
      }),
  );
}
for (const alreadyBlocked of [false, true]) {
  notificationTest(
    `safe metadata repair delivers the existing ${
      alreadyBlocked ? "blocked" : "pending"
    } episode`,
    ({ db, repository, notifier, http }) =>
      Effect.gen(function* () {
        yield* seed(db);
        yield* observe(db, repository, {
          ...remote,
          url: "https://evil.test/PRIVATE",
        });
        if (alreadyBlocked) yield* notifier.tick;
        yield* observe(db, repository, { ...remote, updated_at: 2 });
        yield* notifier.tick;
        yield* due(db);
        yield* notifier.tick;
        assert.equal((yield* db.select().from(notifications)).length, 1);
        assert.equal((yield* row(db)).status, "delivered");
        assert.equal(http.posts().length, 1);
        assert.ok(http.posts()[0].body.includes(remote.url));
        assert.ok(!http.posts()[0].body.includes("PRIVATE"));
      }),
  );
}

notificationTest(
  "throttled recovery preserves its cursor and resumes without reposting",
  (f) =>
    Effect.gen(function* () {
      yield* ambiguous(f);
      const { db, notifier, http } = f;
      http.behavior.respond = () =>
        Response.json([], {
          headers: {
            link:
              '<https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2>; rel="next"',
          },
        });
      yield* notifier.tick;
      yield* due(db);
      const before = yield* row(db);
      assert.equal(before.scanPage, 2);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      http.behavior.respond = () =>
        Response.json({ message: "Secondary rate limit" }, {
          status: 403,
          headers: { "retry-after": "60" },
        });
      yield* notifier.tick;
      const throttled = yield* row(db);
      assert.equal(throttled.status, "pending");
      assert.equal(throttled.scanPage, 2);
      assert.equal(throttled.possibleSendAt, before.possibleSendAt);
      assert.ok(throttled.dueAt >= now + 60000);
      const count = http.requests.length;
      yield* notifier.tick;
      assert.equal(http.requests.length, count);
      http.behavior.respond = () =>
        Response.json([{
          id: 901,
          body: http.posts()[0].body,
          performed_via_github_app: { id: 101 },
        }]);
      yield* due(db);
      yield* notifier.tick;
      assert.equal(http.requests.at(-1)?.url.searchParams.get("page"), "2");
      assert.equal((yield* row(db)).status, "delivered");
      assert.equal((yield* row(db)).commentId, 901);
      assert.equal(http.posts().length, 1);
    }),
);
for (const status of [401, 403, 404, 422, 429, 503]) {
  notificationTest(
    `App token HTTP ${status} has no hidden retries and honors durable rate limits`,
    ({ db, repository, notifier, http }) =>
      Effect.gen(function* () {
        yield* seed(db);
        yield* observe(db, repository);
        http.behavior.respond = () =>
          Response.json({ message: "PRIVATE error" }, {
            status,
            headers: {
              "retry-after": "1800",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "9999999999",
            },
          });
        yield* notifier.tick;
        const [slot] = yield* db.select().from(gate);
        assert.ok(slot.nextRequestAt >= 9999999999000);
        assert.ok((yield* row(db)).dueAt >= slot.nextRequestAt);
        yield* TestClock.adjust("10 minutes");
        yield* notifier.tick;
        assert.equal(http.requests.length, 1);
        assert.equal((yield* row(db)).possibleSendAt, null);
      }),
  );
}
for (const status of [302, 401, 403, 422, 429, 503]) {
  notificationTest(
    `comment HTTP ${status} never redirects or retries inside its leased tick`,
    (f) =>
      Effect.gen(function* () {
        yield* prepare(f);
        f.http.behavior.respond = () =>
          new Response("PRIVATE error", {
            status,
            headers: { location: "https://evil.test/credential-leak" },
          });
        yield* f.notifier.tick;
        assert.equal(f.http.posts().length, 1);
        assert.equal(f.http.requests.length, 2);
        assert.equal(f.http.posts()[0].redirect, "error");
        assert.equal((yield* row(f.db)).status, "pending");
        assert.ok((yield* row(f.db)).possibleSendAt !== null);
        assert.ok(!f.logs.join("\n").includes("PRIVATE"));
      }),
  );
}

notificationTest(
  "malformed token success preserves rate-limit headers without caching a credential",
  ({ db, repository, notifier, http }) =>
    Effect.gen(function* () {
      yield* seed(db);
      yield* observe(db, repository);
      http.behavior.respond = () =>
        Response.json({ token: "", expires_at: "invalid" }, {
          status: 201,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "9999999999",
          },
        });
      yield* notifier.tick;
      assert.equal((yield* row(db)).lastFailure, "unavailable");
      assert.ok(
        (yield* db.select().from(gate))[0].nextRequestAt >= 9999999999000,
      );
      assert.equal(http.requests.length, 1);
      assert.equal(http.posts().length, 0);
    }),
);

notificationTest(
  "App token refresh is explicit and cached credentials expire before a subsequent POST",
  (f) =>
    Effect.gen(function* () {
      const { db, repository, notifier, http } = f;
      http.behavior.expiresAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { hours: 1 }),
      );
      yield* prepare(f);
      yield* notifier.tick;
      yield* TestClock.adjust("59 minutes");
      yield* observe(db, repository, {
        ...remote,
        status_detail: "waiting_for_approval",
        updated_at: 2,
      });
      http.behavior.expiresAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { hours: 1 }),
      );
      yield* notifier.tick;
      assert.deepEqual(http.requests.map((r) => r.kind), [
        "token",
        "comment",
        "token",
      ]);
      yield* TestClock.adjust("3 seconds");
      yield* notifier.tick;
      assert.equal(http.posts().length, 2);
    }),
);
notificationTest(
  "installation rotation never reinterprets ownership of an ambiguous flight",
  (f) =>
    Effect.gen(function* () {
      yield* ambiguous(f);
      const before = yield* row(f.db);
      const requests = f.http.requests.length;
      yield* GitHubCommentNotifier.use((n) => n.tick).pipe(
        Effect.provide(Layer.fresh(GitHubCommentNotifier.layer)),
        Effect.provide(GitHubClient.layer),
        Effect.provideService(DatabaseClient, { db: f.db }),
        Effect.provide(config(true, ":memory:", "303")),
      );
      assert.equal((yield* row(f.db)).status, "blocked");
      assert.equal((yield* row(f.db)).lastFailure, "ownership_changed");
      assert.equal(
        (yield* row(f.db)).expectedInstallationId,
        before.expectedInstallationId,
      );
      assert.equal(f.http.requests.length, requests);
    }),
);
notificationTest(
  "stale receipt fencing checks time after database acquisition",
  (f) =>
    Effect.gen(function* () {
      yield* prepare(f);
      const { db, notifier, http } = f;
      const started = yield* Deferred.make<void>();
      const respond = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      http.behavior.respond = (r) =>
        Effect.runPromise(Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(respond);
          yield* Deferred.succeed(ready, undefined);
          return Response.json({ id: 900, body: r.body }, { status: 201 });
        }));
      const sending = yield* notifier.tick.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
        })
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(held);
      yield* Deferred.succeed(respond, undefined);
      yield* Deferred.await(ready);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("61 seconds");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      yield* Fiber.join(sending);
      const stale = yield* row(db);
      assert.equal(stale.status, "pending");
      assert.equal(stale.commentId, null);
      http.behavior.respond = () =>
        Response.json([{
          id: 900,
          body: stale.body,
          performed_via_github_app: { id: 101 },
        }]);
      yield* notifier.tick;
      assert.equal((yield* row(db)).status, "delivered");
      assert.ok((yield* row(db)).version > stale.version);
      assert.equal(http.posts().length, 1);
    }),
);
notificationTest(
  "a timed-out comment aborts and retains its possible-send record",
  (f) =>
    Effect.gen(function* () {
      yield* prepare(f);
      const started = yield* Deferred.make<void>();
      let aborted = false;
      const stalled: typeof globalThis.fetch = (_input, init) => {
        Effect.runSync(Deferred.succeed(started, undefined));
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("PRIVATE timeout"));
          })
        );
      };
      const sending = yield* f.notifier.tick.pipe(
        Effect.provideService(FetchHttpClient.Fetch, stalled),
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(sending);
      assert.equal(aborted, true);
      assert.equal((yield* row(f.db)).status, "pending");
      assert.ok((yield* row(f.db)).possibleSendAt !== null);
      assert.equal((yield* row(f.db)).leaseUntil, 0);
    }),
);
notificationTest(
  "concurrent notifier instances cannot acquire another shared HTTP slot",
  (f) =>
    Effect.gen(function* () {
      yield* seed(f.db);
      yield* observe(f.db, f.repository);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const normal = f.http.behavior.respond;
      f.http.behavior.respond = (r) =>
        Effect.runPromise(Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return yield* Effect.promise(async () => await normal(r));
        }));
      const first = yield* f.notifier.tick.pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* GitHubCommentNotifier.use((n) => n.tick).pipe(
        Effect.provide(Layer.fresh(GitHubCommentNotifier.layer)),
        Effect.provide(GitHubClient.layer),
        Effect.provideService(DatabaseClient, { db: f.db }),
        Effect.provide(config()),
      );
      assert.equal(f.http.requests.length, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
    }),
);
notificationTest(
  "orchestrator performs notification work before Devin polling and never infers completion or invokes controls",
  ({ db, repository, notifier, http }) =>
    Effect.gen(function* () {
      yield* seed(db);
      yield* observe(db, repository);
      const calls: string[] = [];
      const unexpected = () => Effect.die("Unexpected control/submission");
      const client = DevinClient.of({
        diagnoseSession: () => Effect.die("Unexpected diagnostic GET"),
        createPlaybook: unexpected,
        findPlaybookByMacro: unexpected,
        createSession: unexpected,
        listSessions: () =>
          Effect.sync(() => {
            calls.push("devin-list");
            return [remote];
          }),
        findSessionsByTag: unexpected,
        listSessionsWithInsights: unexpected,
        generateSessionInsights: unexpected,
      });
      const normal = http.behavior.respond;
      http.behavior.respond = (r) => {
        calls.push(r.kind);
        return normal(r);
      };
      yield* db.update(devinSessions).set({
        nextObservationAt: "1970-01-01T00:00:00.000Z",
      });
      yield* DevinSessionOrchestrator.use((o) =>
        Effect.gen(function* () {
          yield* o.tick;
          yield* TestClock.adjust("3 seconds");
          yield* o.tick;
        })
      ).pipe(
        Effect.provide(DevinSessionOrchestrator.layer),
        Effect.provideService(GitHubCommentNotifier, notifier),
        Effect.provideService(DatabaseClient, { db }),
        Effect.provideService(DevinSessionRepository, repository),
        Effect.provideService(DevinClient, client),
        Effect.provide(WebhookEventProcessors.layer),
        Effect.provide(config()),
      );
      assert.deepEqual(calls, ["token", "devin-list", "comment"]);
      assert.equal((yield* row(db)).status, "delivered");
    }),
);

notificationTest(
  "notifier uses the injected GitHub client without initializing live authentication",
  ({ db, repository, http }) =>
    Effect.gen(function* () {
      yield* seed(db);
      yield* observe(db, repository);
      const calls: string[] = [];
      yield* GitHubCommentNotifier.use((notifier) => notifier.tick).pipe(
        Effect.provide(Layer.fresh(GitHubCommentNotifier.layer)),
        Effect.provideService(GitHubClient, {
          cached: Effect.sync(() => {
            calls.push("cached");
            return undefined;
          }),
          authenticate: () =>
            Effect.sync(() => {
              calls.push("authenticate");
            }).pipe(
              Effect.andThen(Effect.fail(new GitHubAuthenticationError())),
            ),
          invalidate: Effect.void,
        }),
        Effect.provideService(DatabaseClient, { db }),
        Effect.provide(config()),
      );
      assert.deepEqual(calls, ["cached", "authenticate"]);
      assert.equal(http.requests.length, 0);
      const saved = yield* row(db);
      assert.equal(saved.status, "pending");
      assert.equal(saved.attempts, 1);
      assert.equal(saved.lastFailure, "unavailable");
    }),
);

Deno.test("SQLite reopen preserves disabled work, failed receipts, immutable App ownership and recovery pagination", async () => {
  const directory = await Deno.makeTempDir();
  const transport = http();
  const run = (
    program: Effect.Effect<
      void,
      unknown,
      DatabaseClient | DevinSessionRepository | GitHubCommentNotifier
    >,
    enabled = true,
  ) =>
    Effect.runPromise(program.pipe(
      Effect.provide(
        Layer.merge(GitHubCommentNotifier.layer, DevinSessionRepository.layer)
          .pipe(
            Layer.provide(GitHubClient.layer),
            Layer.provideMerge(DatabaseClient.layer),
          ),
      ),
      Effect.provide(config(enabled, `${directory}/restart.sqlite`)),
      Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
      Effect.provide(TestClock.layer()),
      Effect.scoped,
    ));
  try {
    await run(
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        yield* seed(db);
        yield* observe(db, yield* DevinSessionRepository);
        yield* (yield* GitHubCommentNotifier).tick;
        assert.equal((yield* row(db)).version, 0);
        yield* db
          .$client`CREATE TRIGGER reject_receipt BEFORE UPDATE ON attention_notifications WHEN NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END`;
      }),
      false,
    );
    await assert.rejects(run(Effect.gen(function* () {
      const notifier = yield* GitHubCommentNotifier;
      yield* notifier.tick;
      yield* TestClock.adjust("3 seconds");
      yield* notifier.tick;
    })));
    const sentBody = transport.posts()[0].body;
    const normal = transport.behavior.respond;
    transport.behavior.respond = (r) =>
      r.kind === "token"
        ? normal(r)
        : r.url.searchParams.get("page") === "1"
        ? Response.json([], {
          headers: {
            link:
              '<https://api.github.com/repos/owner/repo/issues/42/comments?per_page=100&page=2>; rel="next"',
          },
        })
        : Response.json([{
          id: 900,
          body: sentBody,
          performed_via_github_app: { id: 101 },
        }]);
    await run(Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      yield* db.$client`DROP TRIGGER reject_receipt`;
      assert.equal((yield* row(db)).status, "pending");
      yield* TestClock.adjust("2 minutes");
      const notifier = yield* GitHubCommentNotifier;
      yield* notifier.tick;
      yield* TestClock.adjust("3 seconds");
      yield* notifier.tick;
      assert.equal((yield* row(db)).scanPage, 2);
    }));
    await run(Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      assert.equal((yield* row(db)).scanPage, 2);
      yield* TestClock.adjust("126 seconds");
      const notifier = yield* GitHubCommentNotifier;
      yield* notifier.tick;
      yield* TestClock.adjust("3 seconds");
      yield* notifier.tick;
      assert.equal((yield* row(db)).status, "delivered");
      assert.equal((yield* row(db)).expectedAppId, 101);
      assert.equal((yield* row(db)).expectedInstallationId, 202);
      assert.equal(
        (yield* db.select().from(devinSessions))[0].providerLifecycle,
        "needs_input",
      );
    }));
    assert.equal(transport.posts().length, 1);
    assert.deepEqual(transport.requests.map((r) => r.kind), [
      "token",
      "comment",
      "token",
      "lookup",
      "token",
      "lookup",
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
