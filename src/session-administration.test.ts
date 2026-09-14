import { strict as assert } from "node:assert";
import { eq } from "drizzle-orm";
import { DateTime, Deferred, Effect, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { DatabaseClient } from "./database.ts";
import { DevinClient } from "./devin.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import {
  localResolutionWarning,
  SessionAdminError,
  SessionAdministration,
} from "./session-administration.ts";
import {
  attentionNotifications,
  devinSessions,
  sessionAdminEvents,
} from "./schemas.ts";
import {
  missingFetch,
  recoveryLayer,
  recoveryRemote,
  recoveryTest,
  seedRecovery,
} from "../test/fixtures/session-recovery.ts";

const failed = Effect.fnUntraced(
  function* <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    code: SessionAdminError["code"],
  ) {
    const result = yield* effect.pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.ok(result.failure instanceof SessionAdminError);
      assert.equal(result.failure.code, code);
    }
  },
);

const foundFetch: typeof globalThis.fetch = (input, init) => {
  assert.equal(init?.method, "GET");
  const id = decodeURIComponent(
    new URL(String(input)).pathname.split("/").at(-1)!,
  );
  return Promise.resolve(Response.json(recoveryRemote(id)));
};

recoveryTest(
  "operator association verifies exact identity/tag/org, preserves history, and permanently blocks automated resubmission",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const repository = yield* DevinSessionRepository;
    const admin = yield* SessionAdministration;
    const client = yield* DevinClient;
    const original = yield* seedRecovery(db, "one", {
      status: "submitting",
      devinSessionId: null,
      recoveryBlocked: true,
      attempts: 2,
      outputs: [{ outcome: "needs_human", summary: "PRIVATE retained" }],
    });
    const before = yield* admin.inspect("one");
    const result = yield* admin.execute({
      id: "one",
      action: "associate",
      remoteId: "remote-one",
      revision: before.revision,
      reason: "Operator selected existing tagged session",
    }, client.diagnoseSession);
    assert.equal(result.session.remoteId, "remote-one");
    assert.equal(result.session.status, "submitted");
    assert.equal(result.session.attempts, 2);
    assert.equal(result.session.recoveryBlocked, true);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    const [row] = yield* db.select().from(devinSessions);
    assert.deepEqual(row.outputs, original.outputs);
    assert.equal(row.providerLifecycle, null); // Verification is not a fabricated provider observation.
    assert.equal((yield* repository.claimDueObservations()).length, 1);
    yield* failed(
      admin.execute({
        id: "one",
        action: "associate",
        remoteId: "other",
        revision: result.session.revision,
        reason: "Do not reassign",
      }, client.diagnoseSession),
      "conflict",
    );
  }),
  foundFetch,
);

recoveryTest(
  "operator association rejects another row owning the ID and exact-tag mismatches",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const admin = yield* SessionAdministration;
    const client = yield* DevinClient;
    yield* seedRecovery(db, "one", {
      status: "submitting",
      devinSessionId: null,
      recoveryBlocked: true,
    });
    yield* seedRecovery(db, "owner", { devinSessionId: "remote-one" });
    yield* failed(
      admin.execute({
        id: "one",
        action: "associate",
        remoteId: "remote-one",
        revision: (yield* admin.inspect("one")).revision,
        reason: "Explicit selection",
      }, client.diagnoseSession),
      "identity_owned",
    );
    yield* failed(
      admin.execute({
        id: "one",
        action: "associate",
        remoteId: "wrong-tag",
        revision: (yield* admin.inspect("one")).revision,
        reason: "Explicit selection",
      }, client.diagnoseSession),
      "verification_failed",
    );
    assert.equal((yield* admin.inspect("one")).remoteId, null);
    assert.equal(
      (yield* admin.inspect("one")).events.at(-1)?.outcome,
      "tag_mismatch",
    );
  }),
  (input, init) => {
    assert.equal(init?.method, "GET");
    const id = new URL(String(input)).pathname.split("/").at(-1)!;
    return Promise.resolve(
      Response.json({
        ...recoveryRemote(id),
        tags: id === "wrong-tag"
          ? ["delivery-id:delivery-one-suffix"]
          : recoveryRemote().tags,
      }),
    );
  },
);

recoveryTest(
  "single diagnostic 404 remains durable evidence without changing ownership, capacity or provider state",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const admin = yield* SessionAdministration;
    const client = yield* DevinClient;
    yield* seedRecovery(db, "one", {
      providerLifecycle: "active",
      activeWork: true,
    });
    const before = yield* admin.inspect("one");
    const diagnosed = yield* admin.execute(
      { id: "one", action: "diagnose" },
      client.diagnoseSession,
    );
    assert.equal(diagnosed.outcome, "not_found");
    assert.equal(diagnosed.session.activeWork, true);
    assert.equal(diagnosed.session.localOwnership, "tracking");
    assert.equal(diagnosed.session.providerLifecycle, "active");
    assert.equal(diagnosed.session.remoteId, before.remoteId);
    assert.equal(diagnosed.session.events[0].httpStatus, 404);
    assert.equal(
      diagnosed.session.events[0].recordedAt,
      DateTime.formatIso(yield* DateTime.now),
    );
    assert.ok(!JSON.stringify(diagnosed).includes("PRIVATE"));
    yield* failed(
      admin.execute({
        id: "one",
        action: "resolve",
        revision: before.revision,
        reason: "stale decision",
      }),
      "conflict",
    );
  }),
  (_input, init) => {
    assert.equal(init?.method, "GET");
    return Promise.resolve(new Response("PRIVATE body", { status: 404 }));
  },
);

recoveryTest(
  "local resolution releases only local capacity and resumes only a verified same identity",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const repository = yield* DevinSessionRepository;
    const admin = yield* SessionAdministration;
    const client = yield* DevinClient;
    const original = yield* seedRecovery(db, "one", {
      providerLifecycle: "active",
      activeWork: true,
      outputs: [{ outcome: "needs_human", summary: "PRIVATE output" }],
      analysisStatus: "collected",
      analysis: { retained: true },
      providerStatusDetail: "PRIVATE detail",
    });
    yield* seedRecovery(db, "two", { status: "pending", devinSessionId: null });
    assert.deepEqual(yield* repository.claimPending, []);
    yield* failed(
      admin.execute({
        id: "one",
        action: "resolve",
        revision: (yield* admin.inspect("one")).revision,
      }),
      "invalid_action",
    );
    const result = yield* admin.execute({
      id: "one",
      action: "resolve",
      revision: (yield* admin.inspect("one")).revision,
      reason: "PRIVATE operator reason",
    });
    assert.equal(result.warning, localResolutionWarning);
    assert.equal(result.session.localOwnership, "released");
    assert.equal(result.session.status, "submitted");
    assert.equal(result.session.activeWork, true);
    assert.ok(!JSON.stringify(result).includes("PRIVATE"));
    assert.deepEqual(yield* repository.claimDueObservations(), []);
    assert.equal((yield* repository.claimPending).length, 1);
    const [resolved] = yield* db.select().from(devinSessions).where(
      eq(devinSessions.id, "one"),
    );
    for (
      const key of [
        "providerLifecycle",
        "providerStatusDetail",
        "activeWork",
        "devinSessionId",
        "outputs",
        "analysis",
        "analysisStatus",
      ] as const
    ) assert.deepEqual(resolved[key], original[key]);
    const repeated = yield* admin.execute({
      id: "one",
      action: "resolve",
      revision: result.session.revision,
      reason: "Confirm release",
    });
    assert.equal(repeated.session.localOwnership, "released");
    const resumed = yield* admin.execute({
      id: "one",
      action: "resume",
      revision: repeated.session.revision,
      reason: "Resume observation",
    }, client.diagnoseSession);
    assert.equal(resumed.session.localOwnership, "tracking");
    assert.equal(resumed.session.remoteId, "remote-one");
    assert.equal(resumed.session.recoveryBlocked, true);
    assert.equal((yield* repository.claimDueObservations()).length, 1);
  }),
  foundFetch,
);

recoveryTest(
  "operator mutation rejects live submission and observation leases; expiry plus resolution fences old writers",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const repository = yield* DevinSessionRepository;
    const admin = yield* SessionAdministration;
    yield* seedRecovery(db, "one", { status: "pending", devinSessionId: null });
    const [submission] = yield* repository.claimPending;
    yield* failed(
      admin.execute({
        id: "one",
        action: "resolve",
        revision: (yield* admin.inspect("one")).revision,
        reason: "Do not interrupt POST",
      }),
      "busy",
    );
    yield* TestClock.adjust("121 seconds");
    yield* admin.execute({
      id: "one",
      action: "resolve",
      revision: (yield* admin.inspect("one")).revision,
      reason: "Abandon local ambiguous work",
    });
    assert.equal(
      yield* repository.markSubmitted(submission.session, "late-remote"),
      false,
    );
    assert.deepEqual(
      yield* repository.recordRecoveryMiss(submission.session, "empty"),
      [],
    );
    yield* failed(
      admin.execute({
        id: "one",
        action: "resume",
        revision: (yield* admin.inspect("one")).revision,
        reason: "No identity",
      }),
      "invalid_action",
    );
    yield* seedRecovery(db, "observed");
    const [observation] = yield* repository.claimDueObservations();
    yield* failed(
      admin.execute({
        id: "observed",
        action: "resolve",
        revision: (yield* admin.inspect("observed")).revision,
        reason: "Do not interrupt GET",
      }),
      "busy",
    );
    yield* TestClock.adjust("61 seconds");
    yield* admin.execute({
      id: "observed",
      action: "resolve",
      revision: (yield* admin.inspect("observed")).revision,
      reason: "Local release",
    });
    assert.equal(
      yield* repository.recordObservation(observation, {
        ...recoveryRemote("remote-observed", "observed"),
        status_detail: "waiting_for_user",
      }),
      false,
    );
    yield* repository.recordLookupFailure(observation, "missing");
    assert.equal((yield* admin.inspect("observed")).lookupFailureCount, 0);
    assert.deepEqual(yield* db.select().from(attentionNotifications), []);
  }),
  missingFetch,
);

recoveryTest(
  "operator resolution closes unsent startup and attention notifications and preserves possible sends even with notifications disabled",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const repository = yield* DevinSessionRepository;
    const admin = yield* SessionAdministration;
    yield* seedRecovery(db);
    const [claim] = yield* repository.claimDueObservations();
    yield* repository.recordObservation(claim, {
      ...recoveryRemote(),
      status_detail: "waiting_for_user",
    });
    yield* db.insert(attentionNotifications).values({
      id: "startup",
      sessionRecordId: "one",
      sequence: 0,
      reason: "session_started",
      repo: "owner/repo",
      issueNumber: 123,
      remoteId: "remote-one",
      sessionUrl: recoveryRemote().url,
    });
    yield* db.insert(attentionNotifications).values({
      id: "possible",
      sessionRecordId: "one",
      sequence: 2,
      reason: "needs_input",
      repo: "owner/repo",
      issueNumber: 123,
      remoteId: "remote-one",
      sessionUrl: recoveryRemote().url,
      possibleSendAt: 1,
      expectedAppId: 42,
      expectedInstallationId: 43,
      body: "PRIVATE immutable body",
      leaseUntil: DateTime.toEpochMillis(yield* DateTime.now) + 60000,
    });
    yield* failed(
      admin.execute({
        id: "one",
        action: "resolve",
        revision: (yield* admin.inspect("one")).revision,
        reason: "Wait for lease",
      }),
      "busy",
    );
    yield* TestClock.adjust("61 seconds");
    yield* admin.execute({
      id: "one",
      action: "resolve",
      revision: (yield* admin.inspect("one")).revision,
      reason: "Local policy",
    });
    const events = yield* db.select().from(attentionNotifications);
    assert.ok(events.every((event) => event.closedAt !== null));
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.filter((event) => event.id !== "possible").map((event) =>
        event.status
      ),
      ["cancelled", "cancelled"],
    );
    assert.equal(events.find((event) => event.id === "startup")?.version, 1);
    const possible = events.find((event) => event.id === "possible")!;
    assert.equal(possible.status, "pending");
    assert.equal(possible.body, "PRIVATE immutable body");
    assert.equal(possible.expectedAppId, 42);
    assert.equal(possible.possibleSendAt, 1);
    assert.equal(possible.version, 1);
  }),
  missingFetch,
);

for (
  const intervening of [
    "recovery",
    "observation",
    "analysis",
    "notification",
    "operator",
  ] as const
) {
  recoveryTest(
    `operator diagnostic CAS rejects intervening ${intervening} work`,
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const repository = yield* DevinSessionRepository;
      const admin = yield* SessionAdministration;
      const client = yield* DevinClient;
      yield* seedRecovery(
        db,
        "one",
        intervening === "recovery"
          ? { status: "submitting", devinSessionId: null, attempts: 1 }
          : { completionObservedAt: "1970-01-01T00:00:00.000Z" },
      );
      yield* TestClock.adjust("121 seconds");
      const before = yield* admin.inspect("one");
      const get = Effect.fnUntraced(function* (id: string) {
        switch (intervening) {
          case "recovery":
            yield* repository.claimStale;
            break;
          case "observation":
            yield* repository.claimDueObservations();
            break;
          case "analysis": {
            const [claim] = yield* repository.claimDueAnalyses;
            yield* repository.recordAnalysis(claim, {
              status: "collected",
              analysis: { valid: true },
            });
            break;
          }
          case "notification":
            yield* db.insert(attentionNotifications).values({
              id: "notice",
              sessionRecordId: "one",
              sequence: 1,
              reason: "needs_input",
              repo: "owner/repo",
            }).pipe(Effect.orDie);
            break;
          case "operator":
            yield* admin.execute({
              id: "one",
              action: "resolve",
              revision: before.revision,
              reason: "Intervening decision",
            }).pipe(Effect.orDie);
            break;
        }
        return yield* client.diagnoseSession(id);
      }, Effect.orDie);
      yield* failed(
        admin.execute(
          { id: "one", action: "diagnose", remoteId: "remote-one" },
          get,
        ),
        "conflict",
      );
      assert.equal(
        (yield* db.select().from(sessionAdminEvents)).filter((event) =>
          event.action === "diagnose"
        ).length,
        0,
      );
    }),
    foundFetch,
  );
}

Deno.test("local ownership and diagnostic evidence persist across independent SQLite reopen without provider credentials", async () => {
  const directory = await Deno.makeTempDir();
  const path = `${directory}/restart.sqlite`;
  const layer = SessionAdministration.layer().pipe(
    Layer.provideMerge(DatabaseClient.layerWithPath(path)),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, SessionAdministration | DatabaseClient>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(layer),
        Effect.provide(Logger.layer([])),
        Effect.scoped,
      ),
    );
  try {
    const first = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        const admin = yield* SessionAdministration;
        yield* seedRecovery(db);
        yield* DevinSessionOrchestrator.use((orchestra) => orchestra.tick);
        yield* admin.execute(
          { id: "one", action: "diagnose" },
          () => Effect.succeed({ outcome: "authorization", httpStatus: 403 }),
        );
        return yield* admin.execute({
          id: "one",
          action: "resolve",
          revision: (yield* admin.inspect("one")).revision,
          reason: "Recorded local decision",
        });
      }).pipe(
        Effect.provide(recoveryLayer(path)),
        Effect.provideService(FetchHttpClient.Fetch, missingFetch),
        Effect.provide(Logger.layer([])),
        Effect.scoped,
      ),
    );
    const reopened = await run(
      SessionAdministration.use((admin) => admin.inspect("one")),
    );
    assert.deepEqual(reopened, first.session);
    assert.deepEqual(reopened.events.map((event) => event.outcome), [
      "authorization",
      "resolved",
    ]);
    assert.equal(reopened.lookupFailureCount, 1);
    assert.equal(reopened.lastLookupFailure, "missing");
    assert.ok(reopened.firstLookupFailureAt);
    assert.equal(reopened.localOwnership, "released");
    assert.equal(reopened.remoteId, "remote-one");
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

recoveryTest(
  "concurrent operator association has exactly one local owner of a verified remote identity",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const admin = yield* SessionAdministration;
    const client = yield* DevinClient;
    yield* seedRecovery(db, "one", {
      status: "submitting",
      devinSessionId: null,
      recoveryBlocked: true,
    });
    yield* seedRecovery(db, "two", {
      status: "submitting",
      devinSessionId: null,
      recoveryBlocked: true,
    });
    const one = yield* admin.inspect("one");
    const two = yield* admin.inspect("two");
    const ready = yield* Deferred.make<void>();
    let arrivals = 0;
    const get = Effect.fnUntraced(function* (id: string) {
      arrivals++;
      if (arrivals === 2) yield* Deferred.succeed(ready, undefined);
      yield* Deferred.await(ready);
      return yield* client.diagnoseSession(id);
    });
    const results = yield* Effect.all(
      [one, two].map((row) =>
        admin.execute({
          id: row.id,
          action: "associate",
          remoteId: "shared",
          revision: row.revision,
          reason: "Explicit concurrent selection",
        }, get).pipe(Effect.result)
      ),
      { concurrency: 2 },
    );
    assert.equal(
      results.filter((result) => result._tag === "Success").length,
      1,
    );
    const rejected = results.find((result) => result._tag === "Failure");
    assert.ok(rejected && rejected.failure instanceof SessionAdminError);
    assert.equal(rejected.failure.code, "identity_owned");
    assert.equal(
      (yield* db.select().from(devinSessions).where(
        eq(devinSessions.devinSessionId, "shared"),
      )).length,
      1,
    );
  }),
  (_input, init) => {
    assert.equal(init?.method, "GET");
    return Promise.resolve(
      Response.json({
        ...recoveryRemote("shared"),
        tags: ["delivery-id:delivery-one", "delivery-id:delivery-two"],
      }),
    );
  },
);

recoveryTest(
  "local resolution does not invalidate in-flight valid analysis for the immutable identity",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const repository = yield* DevinSessionRepository;
    const admin = yield* SessionAdministration;
    yield* seedRecovery(db, "one", {
      completionObservedAt: "1970-01-01T00:00:00.000Z",
    });
    const [claim] = yield* repository.claimDueAnalyses;
    yield* admin.execute({
      id: "one",
      action: "resolve",
      revision: (yield* admin.inspect("one")).revision,
      reason: "Analysis independent of local capacity",
    });
    yield* repository.recordAnalysis(claim, {
      status: "collected",
      analysis: { preserved: true },
    });
    const [row] = yield* db.select().from(devinSessions);
    assert.equal(row.localOwnership, "released");
    assert.equal(row.analysisStatus, "collected");
    assert.deepEqual(row.analysis, { preserved: true });
    assert.equal(row.analysisAttempts, claim.analysisAttempts);
  }),
  missingFetch,
);
