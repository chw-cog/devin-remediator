import { strict as assert } from "node:assert";
import { Effect, Result } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { DevinClient } from "./devin.ts";

const client = new DevinClient("cog_test-key", "org-test");
const session = {
  session_id: "devin-test",
  url: "https://app.devin.ai/sessions/test",
  status: "new",
  org_id: "org-test",
  created_at: 1700000000,
  updated_at: 1700000000,
  acus_consumed: 0,
  tags: ["remediation"],
  pull_requests: [],
};

function runWithFetch<A, E>(
  effect: Effect.Effect<A, E>,
  fetch: typeof globalThis.fetch,
) {
  return Effect.runPromise(
    effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  );
}

Deno.test("createSession posts authenticated JSON and returns the session", async () => {
  const params = {
    prompt: "Fix the failing CI check",
    title: "CI remediation",
    repos: ["owner/repo"],
    tags: ["remediation"],
    max_acu_limit: 5,
    structured_output_schema: {
      type: "object",
      properties: { fixed: { type: "boolean" } },
    },
  };
  let calls = 0;
  const result = await runWithFetch(
    client.createSession(params),
    (input, init) => {
      calls++;
      assert.equal(
        String(input),
        "https://api.devin.ai/v3/organizations/org-test/sessions",
      );
      assert.equal(init?.method, "POST");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer cog_test-key");
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("accept"), "application/json");
      const body = init?.body;
      assert.ok(body instanceof Uint8Array);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(body)), params);
      return Promise.resolve(Response.json(session));
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, session);
});

Deno.test("listSessions filters by IDs and returns session details", async () => {
  const ids = ["devin-test", "devin-?/&second"];
  const sessions = [
    {
      ...session,
      status: "running",
      status_detail: "finished",
      structured_output: { fixed: true },
      pull_requests: [{
        pr_url: "https://github.com/owner/repo/pull/1",
        pr_state: "open",
      }],
    },
    { ...session, session_id: ids[1], title: null },
  ];
  const result = await runWithFetch(client.listSessions(ids), (input, init) => {
    const url = new URL(String(input));
    assert.equal(
      url.origin + url.pathname,
      "https://api.devin.ai/v3/organizations/org-test/sessions",
    );
    assert.deepEqual(url.searchParams.getAll("session_ids"), ids);
    assert.equal(url.searchParams.get("first"), "200");
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer cog_test-key",
    );
    return Promise.resolve(Response.json({
      items: sessions,
      has_next_page: false,
      end_cursor: null,
      total: 2,
    }));
  });
  assert.deepEqual(result, sessions);
});

Deno.test("listSessions accepts 200 IDs without truncating or splitting", async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `devin-${i}`);
  const sessions = ids.map((session_id) => ({ ...session, session_id }));
  let calls = 0;
  const result = await runWithFetch(client.listSessions(ids), (input) => {
    calls++;
    assert.equal(new URL(String(input)).searchParams.get("first"), "200");
    assert.deepEqual(
      new URL(String(input)).searchParams.getAll("session_ids"),
      ids,
    );
    return Promise.resolve(Response.json({ items: sessions }));
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, sessions);
});

Deno.test("listSessions with no IDs returns an empty array without HTTP", async () => {
  const result = await runWithFetch(client.listSessions([]), () => {
    assert.fail("An empty filter must not fetch every session");
  });
  assert.deepEqual(result, []);
});

Deno.test("listSessions rejects over 200 IDs and empty IDs without HTTP", async (t) => {
  for (
    const ids of [Array.from({ length: 201 }, (_, i) => `devin-${i}`), [""]]
  ) {
    await t.step(`${ids.length} IDs`, async () => {
      let calls = 0;
      const result = await runWithFetch(
        Effect.result(client.listSessions(ids)),
        () => {
          calls++;
          return Promise.resolve(Response.json({ items: [] }));
        },
      );
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure._tag, "SchemaError");
      assert.equal(calls, 0);
    });
  }
});

Deno.test("both methods surface HTTP failures without retrying", async (t) => {
  for (const status of [401, 403, 404, 422, 429, 500]) {
    for (
      const [name, effect] of [
        ["create", Effect.asVoid(client.createSession({ prompt: "Fix CI" }))],
        ["list", Effect.asVoid(client.listSessions(["devin-test"]))],
      ] as const
    ) {
      await t.step(`${name} ${status}`, async () => {
        let calls = 0;
        const result = await runWithFetch(Effect.result(effect), () => {
          calls++;
          return Promise.resolve(new Response("API error", { status }));
        });
        assert.ok(Result.isFailure(result));
        assert.equal(result.failure._tag, "HttpClientError");
        if (result.failure._tag !== "HttpClientError") {
          assert.fail("Expected HTTP error");
        }
        assert.equal(result.failure.reason._tag, "StatusCodeError");
        if (result.failure.reason._tag !== "StatusCodeError") {
          assert.fail("Expected status error");
        }
        assert.equal(result.failure.reason.response.status, status);
        assert.equal(calls, 1);
      });
    }
  }
});

Deno.test("invalid JSON, invalid session data, and network errors fail", async (t) => {
  for (
    const [name, fetch, tag] of [
      [
        "invalid JSON",
        () => Promise.resolve(new Response("{")),
        "HttpClientError",
      ],
      [
        "invalid session",
        () => Promise.resolve(Response.json({ session_id: 42 })),
        "SchemaError",
      ],
      [
        "network error",
        () => Promise.reject(new TypeError("Network unavailable")),
        "HttpClientError",
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await runWithFetch(
        Effect.result(client.createSession({ prompt: "Fix CI" })),
        fetch,
      );
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure._tag, tag);
    });
  }
  const result = await runWithFetch(
    Effect.result(client.listSessions(["devin-test"])),
    () => Promise.resolve(Response.json({ items: [null] })),
  );
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure._tag, "SchemaError");
});
