import { strict as assert } from "node:assert";
import { eq } from "drizzle-orm";
import { DateTime, Effect } from "effect";
import { TestClock } from "effect/testing";
import { DatabaseClient } from "./database.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { SessionAdministration } from "./session-administration.ts";
import { devinSessions } from "./schemas.ts";
import {
  missingFetch,
  recoveryRemote,
  recoveryTest,
  seedRecovery,
} from "../test/session-recovery-fixtures.ts";

recoveryTest(
  "missing reconciliation escalates durably, backs off to one hour, and never releases uncertain capacity",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const orchestra = yield* DevinSessionOrchestrator;
    const repository = yield* DevinSessionRepository;
    const admin = yield* SessionAdministration;
    const original = yield* seedRecovery(db, "one", {
      providerLifecycle: "active",
      activeWork: true,
      providerStatus: "running",
      outputs: [{ outcome: "needs_human", summary: "PRIVATE retained" }],
      analysisStatus: "collected",
      analysis: { preserved: "PRIVATE analysis" },
    });
    yield* seedRecovery(db, "pending", {
      status: "pending",
      devinSessionId: null,
    });
    yield* orchestra.tick;
    let inspected = yield* admin.inspect("one");
    assert.equal(inspected.lookupFailureCount, 1);
    assert.equal(inspected.lastLookupFailure, "missing");
    assert.equal(inspected.reconciliationEscalatedAt, null);
    assert.equal(inspected.activeWork, true);
    for (let i = 0; i < 5; i++) yield* orchestra.tick;
    assert.equal((yield* admin.inspect("one")).lookupFailureCount, 1);
    yield* TestClock.adjust("30 seconds");
    yield* orchestra.tick;
    yield* TestClock.adjust("60 seconds");
    yield* orchestra.tick;
    inspected = yield* admin.inspect("one");
    assert.equal(inspected.lookupFailureStreak, 3);
    assert.ok(inspected.reconciliationEscalatedAt);
    for (let i = 0; i < 8; i++) {
      yield* TestClock.adjust("1 hour");
      yield* orchestra.tick;
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    inspected = yield* admin.inspect("one");
    assert.equal(
      DateTime.toEpochMillis(DateTime.makeUnsafe(inspected.nextObservationAt)) -
        now,
      3600000,
    );
    assert.equal(inspected.firstLookupFailureAt, original.updatedAt);
    assert.equal(inspected.localOwnership, "tracking");
    assert.deepEqual(yield* repository.claimPending, []);
    const [row] = yield* db.select().from(devinSessions).where(
      eq(devinSessions.id, "one"),
    );
    assert.deepEqual(row.outputs, original.outputs);
    assert.deepEqual(row.analysis, original.analysis);
    assert.equal(row.devinSessionId, original.devinSessionId);
    assert.equal(row.providerLifecycle, original.providerLifecycle);
    assert.equal(row.lastObservedAt, null);
    assert.ok(!JSON.stringify(yield* admin.list).includes("PRIVATE"));
  }),
  missingFetch,
);

recoveryTest(
  "batch HTTP failure is durable unavailable evidence, not a missing or provider closure",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    yield* seedRecovery(db);
    yield* DevinSessionOrchestrator.use((orchestra) => orchestra.tick);
    const view = yield* SessionAdministration.use((admin) =>
      admin.inspect("one")
    );
    assert.equal(view.lastLookupFailure, "unavailable");
    assert.equal(view.lookupFailureCount, 1);
    assert.equal(view.providerLifecycle, null);
    assert.equal(view.activeWork, null);
  }),
  () => Promise.resolve(new Response("PRIVATE outage", { status: 503 })),
);

recoveryTest(
  "accepted observation clears only failure streak; expired missing claims cannot alter evidence",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const repository = yield* DevinSessionRepository;
    yield* seedRecovery(db);
    const [first] = yield* repository.claimDueObservations();
    yield* repository.recordLookupFailure(first, "missing");
    yield* TestClock.adjust("30 seconds");
    const [current] = yield* repository.claimDueObservations();
    assert.equal(
      yield* repository.recordObservation(current, recoveryRemote()),
      true,
    );
    yield* repository.recordLookupFailure(first, "unavailable");
    const view = yield* SessionAdministration.use((admin) =>
      admin.inspect("one")
    );
    assert.equal(view.lookupFailureStreak, 0);
    assert.equal(view.lookupFailureCount, 1);
    assert.equal(view.lastLookupFailure, "missing");
    assert.equal(view.providerLifecycle, "active");
  }),
  missingFetch,
);

recoveryTest(
  "ambiguous submission missing recovery blocks after three attempts to look up, never replacement POST",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    const orchestra = yield* DevinSessionOrchestrator;
    yield* seedRecovery(db, "one", {
      status: "submitting",
      devinSessionId: null,
      attempts: 1,
    });
    for (let i = 0; i < 3; i++) {
      yield* TestClock.adjust("61 seconds");
      yield* orchestra.tick;
    }
    const view = yield* SessionAdministration.use((admin) =>
      admin.inspect("one")
    );
    assert.equal(view.status, "submitting");
    assert.equal(view.recoveryBlocked, true);
    assert.equal(view.lookupFailureCount, 3);
    assert.equal(view.attempts, 1);
    yield* TestClock.adjust("1 day");
    yield* orchestra.tick;
    assert.equal(
      (yield* SessionAdministration.use((admin) => admin.inspect("one")))
        .lookupFailureCount,
      3,
    );
  }),
  missingFetch,
);

recoveryTest(
  "duplicate tag recovery retains candidate identities and escalates immediately without POST",
  Effect.gen(function* () {
    const { db } = yield* DatabaseClient;
    yield* seedRecovery(db, "one", {
      status: "submitting",
      devinSessionId: null,
      attempts: 1,
    });
    yield* TestClock.adjust("61 seconds");
    yield* DevinSessionOrchestrator.use((orchestra) => orchestra.tick);
    const view = yield* SessionAdministration.use((admin) =>
      admin.inspect("one")
    );
    assert.equal(view.recoveryBlocked, true);
    assert.equal(view.lastLookupFailure, "duplicates");
    assert.ok(view.reconciliationEscalatedAt);
    assert.deepEqual(view.recoveryCandidateIds, ["remote-one", "remote-two"]);
  }),
  (_input, init) => {
    assert.equal(init?.method, "GET");
    return Promise.resolve(
      Response.json({
        items: [recoveryRemote(), recoveryRemote("remote-two")],
        has_next_page: false,
        end_cursor: null,
      }),
    );
  },
);
