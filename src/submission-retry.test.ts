import { strict as assert } from "node:assert";
import { DateTime, Effect, Logger } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { DatabaseClient } from "./database.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";
import {
  recoveryLayer,
  recoveryRemote,
  recoveryTest,
  seedRecovery,
} from "../test/fixtures/session-recovery.ts";
import { withPlaybookStartup } from "../test/fixtures/playbook.ts";

for (
  const [header, seconds] of [
    [undefined, 30],
    ["invalid", 30],
    ["-1", 30],
    ["1.5", 30],
    ["99999999999999999999999", 30],
    ["0", 30],
    ["2", 30],
    ["60", 60],
    ["600", 600],
    ["Thu, 01 Jan 1970 00:10:00 GMT", 600],
    ["Thu, 01 Jan 1970 00:00:10 GMT", 30],
    ["not an HTTP date", 30],
  ] as const
) {
  let creates = 0;
  recoveryTest(
    `known 429 Retry-After ${
      header ?? "absent"
    } schedules exactly ${seconds}s without premature POST`,
    Effect.gen(function* () {
      creates = 0;
      const { db } = yield* DatabaseClient;
      const orchestra = yield* DevinSessionOrchestrator;
      yield* seedRecovery(db, "one", {
        status: "pending",
        devinSessionId: null,
      });
      yield* db.update(githubWebhookDeliveries).set({
        payload: '{"action":"labeled","label":{"name":"devin"}}',
      });
      yield* orchestra.tick;
      const [rejected] = yield* db.select().from(devinSessions);
      assert.equal(rejected.attempts, 1);
      assert.equal(rejected.status, "pending");
      assert.equal(
        rejected.nextSubmissionAt,
        DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000)),
      );
      yield* orchestra.tick;
      assert.equal(creates, 1);
      yield* TestClock.adjust(`${seconds - 1} seconds`);
      yield* orchestra.tick;
      assert.equal(creates, 1);
      yield* TestClock.adjust("1 second");
      yield* orchestra.tick;
      const [submitted] = yield* db.select().from(devinSessions);
      assert.equal(creates, 2);
      assert.equal(submitted.attempts, 2);
      assert.equal(submitted.devinSessionId, "remote-one");
    }),
    (input, init) => {
      assert.ok(new URL(String(input)).pathname.endsWith("/sessions"));
      assert.equal(init?.method, "POST");
      creates++;
      return Promise.resolve(
        creates === 1
          ? new Response("PRIVATE throttle", {
            status: 429,
            headers: header === undefined ? {} : { "Retry-After": header },
          })
          : Response.json(recoveryRemote()),
      );
    },
  );
}

Deno.test("known rejection deadline and attempts survive database reopen", async () => {
  const directory = await Deno.makeTempDir();
  let creates = 0;
  const fake = withPlaybookStartup((_input, init) => {
    assert.equal(init?.method, "POST");
    creates++;
    return Promise.resolve(
      creates === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "600" } })
        : Response.json(recoveryRemote()),
    );
  });
  const run = <A, E>(
    effect: Effect.Effect<A, E, DatabaseClient | DevinSessionOrchestrator>,
  ) =>
    Effect.runPromise(effect.pipe(
      Effect.provide(recoveryLayer(`${directory}/retry.sqlite`)),
      Effect.provideService(FetchHttpClient.Fetch, fake),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([])),
      Effect.scoped,
    ));
  try {
    await run(Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      yield* seedRecovery(db, "one", {
        status: "pending",
        devinSessionId: null,
      });
      yield* db.update(githubWebhookDeliveries).set({
        payload: '{"action":"labeled","label":{"name":"devin"}}',
      });
      yield* DevinSessionOrchestrator.use((o) => o.tick);
    }));
    await run(Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const orchestra = yield* DevinSessionOrchestrator;
      const [saved] = yield* db.select().from(devinSessions);
      assert.equal(saved.attempts, 1);
      assert.equal(saved.nextSubmissionAt, "1970-01-01T00:10:00.000Z");
      yield* orchestra.tick;
      yield* TestClock.adjust("599 seconds");
      yield* orchestra.tick;
      assert.equal(creates, 1);
      yield* TestClock.adjust("1 second");
      yield* orchestra.tick;
      assert.equal(creates, 2);
      assert.equal((yield* db.select().from(devinSessions))[0].attempts, 2);
    }));
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
