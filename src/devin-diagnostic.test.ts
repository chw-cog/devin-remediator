import { strict as assert } from "node:assert";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { DevinClient } from "./devin.ts";
import { recoveryRemote } from "../test/session-recovery-fixtures.ts";

const diagnose = (id = "remote-one") =>
  DevinClient.use((client) => client.diagnoseSession(id)).pipe(
    Effect.provide(
      DevinClient.layerWithCredentials({
        devinApiKey: "PRIVATE token",
        devinOrganizationId: "org-test",
      }),
    ),
  );
for (
  const [status, outcome] of [
    [404, "not_found"],
    [401, "authentication"],
    [403, "authorization"],
    [429, "rate_limit"],
    [408, "temporary"],
    [503, "temporary"],
    [400, "invalid_response"],
  ] as const
) {
  Deno.test(`diagnoseSession classifies HTTP ${status} without error bodies`, async () => {
    let requests = 0;
    const result = await Effect.runPromise(
      diagnose().pipe(
        Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
          requests++;
          assert.equal(
            String(input),
            "https://api.devin.ai/v3/organizations/org-test/sessions/remote-one",
          );
          assert.equal(init?.method, "GET");
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer PRIVATE token",
          );
          return Promise.resolve(
            new Response("PRIVATE error body", { status }),
          );
        }),
      ),
    );
    assert.deepEqual(result, { outcome, httpStatus: status });
    assert.equal(requests, 1);
  });
}
Deno.test("diagnoseSession validates identity, organization, and response shape", async () => {
  for (
    const remote of [
      recoveryRemote(),
      { ...recoveryRemote(), org_id: "other" },
      recoveryRemote("other"),
      { private: "PRIVATE body" },
    ]
  ) {
    const result = await Effect.runPromise(
      diagnose().pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          () => Promise.resolve(Response.json(remote)),
        ),
      ),
    );
    assert.equal(
      result.outcome,
      remote === undefined
        ? "invalid_response"
        : "session_id" in remote && remote.session_id === "remote-one" &&
            remote.org_id === "org-test"
        ? "found"
        : "invalid_response",
    );
  }
});
Deno.test("diagnoseSession encodes remote identity as one path segment", async () => {
  const id = "remote/one?x=y";
  const result = await Effect.runPromise(
    diagnose(id).pipe(Effect.provideService(FetchHttpClient.Fetch, (input) => {
      assert.equal(
        new URL(String(input)).pathname,
        "/v3/organizations/org-test/sessions/remote%2Fone%3Fx%3Dy",
      );
      return Promise.resolve(Response.json(recoveryRemote(id)));
    })),
  );
  assert.equal(result.outcome, "found");
});
Deno.test("diagnoseSession classifies transport failure and bounds timeout without retry", async () => {
  assert.deepEqual(
    await Effect.runPromise(
      diagnose().pipe(
        Effect.provideService(
          FetchHttpClient.Fetch,
          () => Promise.reject(new Error("PRIVATE transport")),
        ),
      ),
    ),
    { outcome: "temporary" },
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let requests = 0;
      const fiber = yield* diagnose().pipe(
        Effect.provideService(FetchHttpClient.Fetch, () => {
          requests++;
          Effect.runSync(Deferred.succeed(entered, undefined));
          return new Promise(() => {});
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("11 seconds");
      assert.deepEqual(yield* Fiber.join(fiber), { outcome: "temporary" });
      assert.equal(requests, 1);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );
});

Deno.test("diagnoseSession classifies malformed JSON as invalid_response without exposing the body or retrying", async () => {
  let requests = 0;
  const result = await Effect.runPromise(
    diagnose().pipe(
      Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
        requests++;
        assert.equal(
          String(input),
          "https://api.devin.ai/v3/organizations/org-test/sessions/remote-one",
        );
        assert.equal(init?.method, "GET");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer PRIVATE token",
        );
        return Promise.resolve(
          new Response("{invalid PRIVATE body", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );
  assert.deepEqual(result, { outcome: "invalid_response" });
  assert.equal(requests, 1);
});

Deno.test("diagnoseSession keeps response-body transport failures temporary", async () => {
  let requests = 0;
  const result = await Effect.runPromise(
    diagnose().pipe(
      Effect.provideService(FetchHttpClient.Fetch, (_input, init) => {
        requests++;
        assert.equal(init?.method, "GET");
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("PRIVATE body transport failure"));
              },
            }),
            { status: 200 },
          ),
        );
      }),
    ),
  );
  assert.deepEqual(result, { outcome: "temporary" });
  assert.equal(requests, 1);
});
