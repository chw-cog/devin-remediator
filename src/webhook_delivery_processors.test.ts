import { strict as assert } from "node:assert";
import { Effect, Result } from "effect";
import { DevinClient, DevinSubmissionError } from "./devin.ts";
import type { DeliveryRecord } from "./devin_session_repository.ts";
import { issuesProcessor } from "./webhook_delivery_processors.ts";

const delivery: DeliveryRecord = {
  id: "row-1",
  deliveryId: "delivery-1",
  eventName: "issues",
  repo: "owner/repo",
  issueNumber: 42,
  payload: JSON.stringify({
    action: "labeled",
    label: { name: "devin" },
    issue: { number: 42, title: "Repair the build" },
  }),
  insertedAt: "2026-01-01T00:00:00.000Z",
};

Deno.test("issues processor creates a session for the exact added devin label and passes persisted delivery context", async () => {
  const requests: Parameters<DevinClient["Service"]["createSession"]>[0][] = [];
  const client = DevinClient.of({
    createSession: (request) => {
      requests.push(request);
      return Effect.succeed({
        session_id: "remote-42",
        url: "https://app.devin.ai/sessions/remote-42",
        status: "new",
        org_id: "org-test",
        created_at: 0,
        updated_at: 0,
        acus_consumed: 0,
        tags: [],
        pull_requests: [],
      });
    },
    getSession: () => Effect.die("Processor must not poll"),
    listSessions: () => Effect.die("Processor must not list sessions"),
    findSessionsByTag: () => Effect.die("Processor must not recover sessions"),
  });
  assert.deepEqual(await Effect.runPromise(issuesProcessor(delivery, client)), {
    _tag: "SessionCreated",
    devinSessionId: "remote-42",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].title, "GitHub issues: owner/repo");
  assert.deepEqual(requests[0].repos, ["owner/repo"]);
  assert.deepEqual(requests[0].tags, ["delivery-id:delivery-1", "issue:42"]);
  assert.match(requests[0].prompt, /Issue: 42/);
  assert.match(requests[0].prompt, /Delivery: delivery-1/);
  assert.ok(requests[0].prompt.endsWith(delivery.payload));
});

for (
  const [name, payload] of [
    ["different casing", '{"action":"labeled","label":{"name":"Devin"}}'],
    [
      "devin only in existing issue labels",
      '{"action":"labeled","label":{"name":"bug"},"issue":{"labels":[{"name":"devin"}]}}',
    ],
    ["non-labeled action", '{"action":"opened","label":{"name":"devin"}}'],
    ["removed devin label", '{"action":"unlabeled","label":{"name":"devin"}}'],
    ["missing label", '{"action":"labeled"}'],
    ["missing label name", '{"action":"labeled","label":{}}'],
    ["null label", '{"action":"labeled","label":null}'],
    ["missing action", '{"label":{"name":"devin"}}'],
    ["invalid stored JSON", "{"],
  ]
) {
  Deno.test(`issues processor skips ${name} without calling Devin`, async () => {
    const client = DevinClient.of({
      createSession: () => Effect.die("Skipped delivery must not create"),
      getSession: () => Effect.die("Skipped delivery must not poll"),
      listSessions: () => Effect.die("Skipped delivery must not list"),
      findSessionsByTag: () => Effect.die("Skipped delivery must not recover"),
    });
    assert.deepEqual(
      await Effect.runPromise(
        issuesProcessor({ ...delivery, payload }, client),
      ),
      { _tag: "Skipped" },
    );
  });
}

for (const disposition of ["retryable", "permanent", "ambiguous"] as const) {
  Deno.test(`issues processor preserves ${disposition} Devin submission errors`, async () => {
    const error = new DevinSubmissionError({ disposition, httpStatus: 503 });
    const client = DevinClient.of({
      createSession: () => Effect.fail(error),
      getSession: () => Effect.die("Processor must not poll"),
      listSessions: () => Effect.die("Processor must not list sessions"),
      findSessionsByTag: () =>
        Effect.die("Processor must not recover sessions"),
    });
    const result = await Effect.runPromise(
      issuesProcessor(delivery, client).pipe(Effect.result),
    );
    assert.ok(Result.isFailure(result));
    assert.equal(result.failure, error);
  });
}
