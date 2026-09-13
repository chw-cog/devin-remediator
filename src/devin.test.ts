import { strict as assert } from "node:assert";
import { ConfigProvider, Effect, Fiber, Result } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import type { Env } from "./config.ts";
import {
  DevinClient,
  type DevinSubmissionError,
  findPullRequestNumber,
} from "./devin.ts";
import type { Schema } from "effect";
import type { HttpClientError } from "effect/unstable/http";
import { playbook } from "../test/fixtures/playbook.ts";

const testEnv = {
  DEVIN_API_KEY: "cog_test-key",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
};
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
  effect: Effect.Effect<A, E, DevinClient>,
  fetch: typeof globalThis.fetch,
  env: Env = testEnv,
) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(DevinClient.layer),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
}

Deno.test("createSession posts authenticated JSON and returns the session", async () => {
  const params = {
    prompt: "Fix the failing CI check",
    title: "CI remediation",
    repos: ["owner/repo"],
    tags: ["remediation"],
    max_acu_limit: 5,
    playbook_id: "playbook-test",
    structured_output_schema: {
      type: "object",
      properties: { fixed: { type: "boolean" } },
    },
  };
  let calls = 0;
  const result = await runWithFetch(
    Effect.gen(function* () {
      const client = yield* DevinClient;
      return yield* client.createSession(params);
    }),
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

Deno.test("createPlaybook posts the documented authenticated v3 request and decodes the playbook", async () => {
  const params = {
    title: "fix-superset-issue",
    body: "Fix the issue.\nVerify the change.",
    macro: "!fix-superset-issue",
    structured_output_schema: { type: "object" },
  };
  const expected = { ...playbook, ...params };
  let calls = 0;
  const result = await runWithFetch(
    Effect.flatMap(DevinClient, (client) => client.createPlaybook(params)),
    (input, init) => {
      calls++;
      assert.equal(
        String(input),
        "https://api.devin.ai/v3/organizations/org-test/playbooks",
      );
      assert.equal(init?.method, "POST");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer cog_test-key");
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.get("accept"), "application/json");
      assert.ok(init.body instanceof Uint8Array);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(init.body)), params);
      return Promise.resolve(Response.json(expected));
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, expected);
});

Deno.test("createPlaybook rejects a macro without the required ! before HTTP", async () => {
  const result = await runWithFetch(
    Effect.flatMap(DevinClient, (client) =>
      client.createPlaybook({
        title: "Fix issue",
        body: "Fix",
        macro: "fix-superset-issue",
      }).pipe(Effect.result)),
    () => {
      throw new Error("Invalid macro must not reach HTTP");
    },
  );
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.disposition, "permanent");
});

for (
  const [status, disposition] of [
    [403, "permanent"],
    [409, "permanent"],
    [422, "permanent"],
    [429, "retryable"],
    [503, "ambiguous"],
  ] as const
) {
  Deno.test(`createPlaybook preserves HTTP ${status} without retrying POST`, async () => {
    let calls = 0;
    const result = await runWithFetch(
      Effect.flatMap(
        DevinClient,
        (client) =>
          client.createPlaybook({ title: "Fix", body: "Fix" }).pipe(
            Effect.result,
          ),
      ),
      () => {
        calls++;
        return Promise.resolve(new Response("", { status }));
      },
    );
    assert.equal(calls, 1);
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure.httpStatus, status);
    assert.equal(result.failure.disposition, disposition);
  });
}

Deno.test("createPlaybook rejects a malformed successful response", async () => {
  const result = await runWithFetch(
    Effect.flatMap(
      DevinClient,
      (client) =>
        client.createPlaybook({ title: "Fix", body: "Fix" }).pipe(
          Effect.result,
        ),
    ),
    () => Promise.resolve(Response.json({ ...playbook, playbook_id: "" })),
  );
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure.disposition, "ambiguous");
});

Deno.test("findPlaybookByMacro follows cursors and matches the exact macro rather than title", async () => {
  const cursors: (string | null)[] = [];
  const result = await runWithFetch(
    Effect.flatMap(
      DevinClient,
      (client) => client.findPlaybookByMacro("!fix-superset-issue"),
    ),
    (input, init) => {
      const url = new URL(String(input));
      assert.equal(
        url.origin + url.pathname,
        "https://api.devin.ai/v3/organizations/org-test/playbooks",
      );
      assert.equal(init?.method, "GET");
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer cog_test-key",
      );
      assert.equal(url.searchParams.get("first"), "200");
      assert.equal(url.searchParams.has("macro"), false);
      cursors.push(url.searchParams.get("after"));
      return Promise.resolve(Response.json(
        cursors.length === 1
          ? {
            items: [{
              ...playbook,
              title: "fix-superset-issue",
              macro: "!fix-superset-issue-other",
            }],
            has_next_page: true,
            end_cursor: "next?/&",
          }
          : { items: [playbook], has_next_page: false, end_cursor: null },
      ));
    },
  );
  assert.deepEqual(cursors, [null, "next?/&"]);
  assert.deepEqual(result, playbook);
});

Deno.test("findPlaybookByMacro returns absent when the documented optional pagination fields are omitted", async () => {
  const result = await runWithFetch(
    Effect.flatMap(
      DevinClient,
      (client) => client.findPlaybookByMacro("!fix-superset-issue"),
    ),
    () => Promise.resolve(Response.json({ items: [] })),
  );
  assert.equal(result, undefined);
});

for (
  const [name, page] of [
    ["missing cursor", { items: [], has_next_page: true }],
    ["null cursor", { items: [], has_next_page: true, end_cursor: null }],
    ["repeated cursor", { items: [], has_next_page: true, end_cursor: "loop" }],
    ["malformed page", { items: null }],
    ["invalid playbook", { items: [{ ...playbook, macro: 42 }] }],
    ["duplicate macro", {
      items: [playbook, { ...playbook, playbook_id: "another-playbook" }],
    }],
  ]
) {
  Deno.test(`findPlaybookByMacro fails closed on ${name}`, async () => {
    let calls = 0;
    const result = await runWithFetch(
      Effect.flatMap(
        DevinClient,
        (client) =>
          client.findPlaybookByMacro("!fix-superset-issue").pipe(Effect.result),
      ),
      () => {
        calls++;
        assert.ok(calls <= 2);
        return Promise.resolve(Response.json(page));
      },
    );
    assert.ok(Result.isFailure(result));
    assert.equal(
      result.failure.disposition,
      name === "duplicate macro"
        ? "permanent"
        : name === "malformed page" || name === "invalid playbook"
        ? "ambiguous"
        : "retryable",
    );
  });
}

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
  const result = await runWithFetch(
    Effect.gen(function* () {
      const client = yield* DevinClient;
      return yield* client.listSessions(ids);
    }),
    (input, init) => {
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
    },
  );
  assert.deepEqual(result, sessions);
});

Deno.test("listSessions accepts 200 IDs without truncating or splitting", async () => {
  const ids = Array.from({ length: 200 }, (_, i) => `devin-${i}`);
  const sessions = ids.map((session_id) => ({ ...session, session_id }));
  let calls = 0;
  const result = await runWithFetch(
    Effect.gen(function* () {
      const client = yield* DevinClient;
      return yield* client.listSessions(ids);
    }),
    (input) => {
      calls++;
      assert.equal(new URL(String(input)).searchParams.get("first"), "200");
      assert.deepEqual(
        new URL(String(input)).searchParams.getAll("session_ids"),
        ids,
      );
      return Promise.resolve(Response.json({ items: sessions }));
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, sessions);
});

Deno.test("listSessions with no IDs returns an empty array without HTTP", async () => {
  const result = await runWithFetch(
    Effect.gen(function* () {
      const client = yield* DevinClient;
      return yield* client.listSessions([]);
    }),
    () => {
      assert.fail("An empty filter must not fetch every session");
    },
  );
  assert.deepEqual(result, []);
});

Deno.test("tag recovery scans every active and archived page, exact-matches tags, and deduplicates session IDs", async () => {
  const tag = "delivery-id:uuid:/?&";
  const match = { ...session, tags: [tag, "issue:42"] };
  const archived = {
    ...match,
    session_id: "archived",
    is_archived: true,
    status: "exit",
    status_detail: "finished",
  };
  const requests: string[] = [];
  const result = await runWithFetch(
    DevinClient.use((client) => client.findSessionsByTag(tag)),
    (input, init) => {
      const url = new URL(String(input));
      assert.deepEqual(url.searchParams.getAll("tags"), [tag]);
      assert.equal(url.searchParams.get("first"), "200");
      assert.equal(init?.method, "GET");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer cog_test-key",
      );
      const page = `${url.searchParams.get("is_archived")}:${
        url.searchParams.get("after")
      }`;
      requests.push(page);
      switch (page) {
        case "false:null":
          return Promise.resolve(Response.json({
            items: [
              { ...session, tags: [tag.toUpperCase()] },
              { ...session, tags: [`${tag}-suffix`] },
              { ...session, tags: ["issue:42"] },
            ],
            has_next_page: true,
            end_cursor: "next/?&",
          }));
        case "false:next/?&":
          return Promise.resolve(Response.json({
            items: [match],
            has_next_page: false,
            end_cursor: null,
          }));
        case "true:null":
          return Promise.resolve(Response.json({
            items: [match],
            has_next_page: true,
            end_cursor: "archived-next",
          }));
        case "true:archived-next":
          return Promise.resolve(Response.json({
            items: [archived],
            has_next_page: false,
            end_cursor: null,
          }));
        default:
          assert.fail(`Unexpected page: ${page}`);
      }
    },
  );
  assert.deepEqual(requests, [
    "false:null",
    "false:next/?&",
    "true:null",
    "true:archived-next",
  ]);
  assert.deepEqual(result, [match, archived]);
});

Deno.test("tag recovery rejects incomplete results instead of returning absence or a partial match", async (t) => {
  for (
    const failure of [
      "missing metadata",
      "missing cursor",
      "empty cursor",
      "cursor cycle",
      "later HTTP failure",
      "archived HTTP failure",
      "malformed session",
    ]
  ) {
    await t.step(failure, async () => {
      let calls = 0;
      const result = await runWithFetch(
        DevinClient.use((client) =>
          client.findSessionsByTag("delivery-id:one").pipe(Effect.result)
        ),
        () => {
          calls++;
          if (calls === 1) {
            return Promise.resolve(Response.json({
              items: [{ ...session, tags: ["delivery-id:one"] }],
              has_next_page: failure !== "archived HTTP failure",
              end_cursor: "next",
            }));
          }
          switch (failure) {
            case "missing metadata":
              return Promise.resolve(Response.json({ items: [] }));
            case "missing cursor":
              return Promise.resolve(Response.json({
                items: [],
                has_next_page: true,
                end_cursor: null,
              }));
            case "empty cursor":
              return Promise.resolve(Response.json({
                items: [],
                has_next_page: true,
                end_cursor: "",
              }));
            case "cursor cycle":
              return Promise.resolve(Response.json({
                items: [],
                has_next_page: true,
                end_cursor: "next",
              }));
            case "malformed session":
              return Promise.resolve(Response.json({
                items: [null],
                has_next_page: false,
                end_cursor: null,
              }));
            default:
              return Promise.resolve(
                new Response("unavailable", { status: 403 }),
              );
          }
        },
      );
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure._tag, "DevinLookupError");
      assert.equal(calls, 2);
    });
  }
});

Deno.test("complete tag lookup returns no matches only after both archive filters finish", async () => {
  let calls = 0;
  const result = await runWithFetch(
    DevinClient.use((client) => client.findSessionsByTag("delivery-id:one")),
    () => {
      calls++;
      return Promise.resolve(Response.json({
        items: [session],
        has_next_page: false,
        end_cursor: null,
      }));
    },
  );
  assert.deepEqual(result, []);
  assert.equal(calls, 2);
});

Deno.test("tag recovery has an overall timeout", async () => {
  await runWithFetch(
    Effect.gen(function* () {
      const client = yield* DevinClient;
      const fiber = yield* client.findSessionsByTag("delivery-id:one").pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(fiber);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure._tag, "DevinLookupError");
    }).pipe(Effect.provide(TestClock.layer())),
    (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")));
      }),
  );
});

Deno.test("listSessions rejects over 200 IDs and empty IDs without HTTP", async (t) => {
  for (
    const ids of [Array.from({ length: 201 }, (_, i) => `devin-${i}`), [""]]
  ) {
    await t.step(`${ids.length} IDs`, async () => {
      let calls = 0;
      const result = await runWithFetch(
        Effect.gen(function* () {
          const client = yield* DevinClient;
          return yield* Effect.result(client.listSessions(ids));
        }),
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
        [
          "create",
          Effect.gen(function* () {
            const client = yield* DevinClient;
            yield* client.createSession({ prompt: "Fix CI" });
          }),
        ],
        [
          "list",
          Effect.gen(function* () {
            const client = yield* DevinClient;
            yield* client.listSessions(["devin-test"]);
          }),
        ],
      ] as const
    ) {
      await t.step(`${name} ${status}`, async () => {
        let calls = 0;
        const request: Effect.Effect<
          void,
          | DevinSubmissionError
          | HttpClientError.HttpClientError
          | Schema.SchemaError,
          DevinClient
        > = effect;
        const result = await runWithFetch(Effect.result(request), () => {
          calls++;
          return Promise.resolve(new Response("API error", { status }));
        });
        assert.ok(Result.isFailure(result));
        if (result.failure._tag === "DevinSubmissionError") {
          assert.equal(result.failure.httpStatus, status);
          assert.equal(
            result.failure.disposition,
            status === 429
              ? "retryable"
              : status >= 500
              ? "ambiguous"
              : "permanent",
          );
        } else {
          assert.equal(result.failure._tag, "HttpClientError");
          if (result.failure._tag !== "HttpClientError") {
            assert.fail("Expected HTTP error");
          }
          assert.equal(result.failure.reason._tag, "StatusCodeError");
          if (result.failure.reason._tag !== "StatusCodeError") {
            assert.fail("Expected status error");
          }
          assert.equal(result.failure.reason.response.status, status);
        }
        assert.equal(calls, 1);
      });
    }
  }
});

Deno.test("invalid JSON, invalid session data, and network errors fail", async (t) => {
  for (
    const [name, fetch] of [
      [
        "invalid JSON",
        () => Promise.resolve(new Response("{")),
      ],
      [
        "invalid session",
        () => Promise.resolve(Response.json({ session_id: 42 })),
      ],
      [
        "network error",
        () => Promise.reject(new TypeError("Network unavailable")),
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const result = await runWithFetch(
        Effect.gen(function* () {
          const client = yield* DevinClient;
          return yield* Effect.result(
            client.createSession({ prompt: "Fix CI" }),
          );
        }),
        fetch,
      );
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure._tag, "DevinSubmissionError");
      assert.equal(result.failure.disposition, "ambiguous");
    });
  }
  const result = await runWithFetch(
    Effect.gen(function* () {
      const client = yield* DevinClient;
      return yield* Effect.result(client.listSessions(["devin-test"]));
    }),
    () => Promise.resolve(Response.json({ items: [null] })),
  );
  assert.ok(Result.isFailure(result));
  assert.equal(result.failure._tag, "SchemaError");
});

Deno.test("getSession encodes IDs, authenticates, and interprets provider states", async () => {
  for (
    const [status, detail, expected] of [
      ["new", null, "running"],
      ["claimed", null, "running"],
      ["resuming", null, "running"],
      ["running", "working", "running"],
      ["running", "waiting_for_user", "running"],
      ["running", "waiting_for_approval", "running"],
      ["running", "finished", "succeeded"],
      ["exit", "finished", "succeeded"],
      ["exit", null, "failed"],
      ["suspended", "out_of_credits", "failed"],
      ["error", "finished", "failed"],
    ]
  ) {
    const result = await runWithFetch(
      DevinClient.use((client) => client.getSession("devin-/?#")),
      (input, init) => {
        assert.equal(
          String(input),
          "https://api.devin.ai/v3/organizations/org-test/sessions/devin-%2F%3F%23",
        );
        assert.equal(init?.method, "GET");
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer cog_test-key",
        );
        return Promise.resolve(Response.json({
          ...session,
          status,
          status_detail: detail,
          pull_requests: [{
            pr_url: "https://github.com/owner/repo/pull/42",
            pr_state: "open",
          }],
        }));
      },
    );
    assert.deepEqual(result, {
      status: expected,
      output: expected === "running" ? null : {
        outcome: expected === "succeeded" ? "needs_human" : "failed",
        summary: expected === "succeeded"
          ? "Session completed without a valid structured remediation result."
          : "Session failed without a valid structured remediation result.",
      },
      pullRequestUrls: ["https://github.com/owner/repo/pull/42"],
    });
  }
});

Deno.test("getSession validates terminal outcomes and ignores intermediate output", async () => {
  for (
    const [status, status_detail, fallback] of [
      ["running", "working", null],
      ["running", "finished", "needs_human"],
      ["exit", "finished", "needs_human"],
      ["error", "error", "failed"],
      ["suspended", "out_of_credits", "failed"],
    ] as const
  ) {
    for (
      const outcome of [
        "fixed",
        "needs_human",
        "not_reproducible",
        "failed",
        "already_resolved",
      ]
    ) {
      for (const confidence of [undefined, 0, 0.7, 1]) {
        const output = {
          outcome,
          summary: "Verified result",
          ...(confidence === undefined ? {} : { confidence }),
        };
        const result = await runWithFetch(
          DevinClient.use((client) => client.getSession("devin-test")),
          () =>
            Promise.resolve(Response.json({
              ...session,
              status,
              status_detail,
              structured_output: output,
            })),
        );
        assert.deepEqual(result.output, fallback === null ? null : output);
      }
    }
    for (
      const structured_output of [
        undefined,
        null,
        "not an object",
        [],
        {},
        { outcome: "unknown", summary: "Result" },
        { outcome: "fixed" },
        { outcome: "fixed", summary: "" },
        { outcome: "fixed", summary: " \n\t" },
        { outcome: "fixed", summary: 123 },
        { outcome: "fixed", summary: "Result", confidence: -0.1 },
        { outcome: "fixed", summary: "Result", confidence: 1.1 },
        { outcome: "fixed", summary: "Result", confidence: "high" },
        { outcome: "fixed", summary: "Result", confidence: null },
        { outcome: "fixed", summary: "Result", extra: true },
      ]
    ) {
      const result = await runWithFetch(
        DevinClient.use((client) => client.getSession("devin-test")),
        () =>
          Promise.resolve(Response.json({
            ...session,
            status,
            status_detail,
            structured_output,
          })),
      );
      assert.deepEqual(
        result.output,
        fallback === null ? null : {
          outcome: fallback,
          summary: fallback === "needs_human"
            ? "Session completed without a valid structured remediation result."
            : "Session failed without a valid structured remediation result.",
        },
        JSON.stringify(structured_output),
      );
    }
  }
});

Deno.test("getSession preserves full evidence and rejects malformed evidence fields", async () => {
  const base = {
    outcome: "already_resolved",
    summary: "Existing fix verified.",
  };
  for (const status of ["passed", "failed", "partial", "not_run"]) {
    const output = {
      ...base,
      verification: {
        status,
        evidence: status === "not_run" ? [] : [
          "https://github.com/owner/repo/pull/42",
          "deno test: passed",
        ],
      },
      blocker: status === "passed" ? null : "Browser verification unavailable.",
      next_action: status === "passed" ? null : "Reviewer: run browser checks.",
      confidence: 0.75,
    };
    const result = await runWithFetch(
      DevinClient.use((client) => client.getSession("devin-test")),
      () =>
        Promise.resolve(Response.json({
          ...session,
          status: "exit",
          status_detail: "finished",
          structured_output: output,
        })),
    );
    assert.deepEqual(result.output, output);
  }
  for (
    const fields of [
      { verification: null },
      { verification: {} },
      { verification: { status: "unknown", evidence: [] } },
      { verification: { status: "passed" } },
      { verification: { status: "passed", evidence: "passed" } },
      { verification: { status: "passed", evidence: [" "] } },
      { verification: { status: "passed", evidence: [42] } },
      { verification: { status: "passed", evidence: [], extra: true } },
      { blocker: "" },
      { blocker: 42 },
      { next_action: " \n" },
      { next_action: [] },
    ]
  ) {
    const result = await runWithFetch(
      DevinClient.use((client) => client.getSession("devin-test")),
      () =>
        Promise.resolve(Response.json({
          ...session,
          status: "exit",
          status_detail: "finished",
          structured_output: { ...base, ...fields },
        })),
    );
    assert.deepEqual(result.output, {
      outcome: "needs_human",
      summary:
        "Session completed without a valid structured remediation result.",
    });
  }
});

Deno.test("PR extraction ignores invalid, unrelated, and unsafe numbers", () => {
  assert.equal(
    findPullRequestNumber([
      "https://evil.example/owner/repo/pull/1",
      "https://github.com/other/repo/pull/2",
      "https://github.com/owner/repo/issues/3",
      "https://github.com/owner/repo/pull/0",
      "https://github.com/owner/repo/pull/9007199254740992",
      "https://github.com/OWNER/REPO/pull/42",
    ], "owner/repo"),
    42,
  );
  assert.equal(findPullRequestNumber(["not a URL"], "owner/repo"), null);
});

Deno.test("createSession timeout aborts the request and reports an ambiguous outcome without retrying", async () => {
  const started = Promise.withResolvers<void>();
  let calls = 0;
  let aborted = false;
  await runWithFetch(
    Effect.gen(function* () {
      const client = yield* DevinClient;
      const fiber = yield* client.createSession({ prompt: "Fix CI" }).pipe(
        Effect.result,
        Effect.forkScoped,
      );
      yield* Effect.promise(() => started.promise);
      yield* TestClock.adjust("30 seconds");
      const result = yield* Fiber.join(fiber);
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure.disposition, "ambiguous");
      assert.equal(aborted, true);
      assert.equal(calls, 1);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    (_input, init) => {
      calls++;
      started.resolve();
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
  );
});

Deno.test("DevinClient.layer uses config for authentication and organization URLs", async () => {
  for (
    const [apiKey, organizationId, encodedId] of [
      ["cog_first-key", "org-first", "org-first"],
      ["cog_second-key", "org/with ?#", "org%2Fwith%20%3F%23"],
    ]
  ) {
    let calls = 0;
    const result = await runWithFetch(
      Effect.gen(function* () {
        const client = yield* DevinClient;
        assert.equal(yield* DevinClient, client);
        return yield* client.createSession({ prompt: "Fix CI" });
      }),
      (input, init) => {
        calls++;
        assert.equal(
          String(input),
          `https://api.devin.ai/v3/organizations/${encodedId}/sessions`,
        );
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          `Bearer ${apiKey}`,
        );
        return Promise.resolve(Response.json(session));
      },
      {
        ...testEnv,
        DEVIN_API_KEY: apiKey,
        DEVIN_ORGANIZATION_ID: organizationId,
      },
    );
    assert.deepEqual(result, session);
    assert.equal(calls, 1);
  }
});

Deno.test("DevinClient.layer rejects missing config before running the consumer", async () => {
  for (
    const env of [
      { ...testEnv, DEVIN_API_KEY: undefined },
      { ...testEnv, DEVIN_ORGANIZATION_ID: undefined },
    ]
  ) {
    let ran = false;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DevinClient;
        ran = true;
        return yield* client.listSessions([]);
      }).pipe(
        Effect.provide(DevinClient.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(env),
        ),
        Effect.result,
      ),
    );
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure._tag, "ConfigError");
    assert.equal(ran, false);
  }
});
