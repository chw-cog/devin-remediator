import { strict as assert } from "node:assert";
import app from "./app.ts";

function deliver(body: string, event = "push", delivery = "test-delivery") {
  return app.request("/api/v1/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
    },
    body,
  });
}

Deno.test("supported events return an empty 200", async (t) => {
  const payloads = {
    check_run: { action: "completed", check_run: { id: 1 } },
    dependabot_alert: { action: "created", alert: { number: 1 } },
    issues: { action: "opened", issue: { number: 1, title: "Test issue" } },
    label: { action: "created", label: { name: "bug", color: "d73a4a" } },
    push: { ref: "refs/heads/main", commits: [] },
  };

  for (const [event, payload] of Object.entries(payloads)) {
    await t.step(event, async () => {
      const response = await deliver(JSON.stringify(payload), event);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
    });
  }
});

Deno.test("malformed JSON returns 400", async () => {
  const response = await deliver("{");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid JSON" });
});

Deno.test("invalid webhook envelopes return 400", async (t) => {
  const cases = [
    { name: "null payload", body: "null" },
    { name: "array payload", body: "[]" },
    { name: "scalar payload", body: '"push"' },
    { name: "unsupported event", body: "{}", event: "pull_request" },
    { name: "empty event", body: "{}", event: "" },
    { name: "empty delivery ID", body: "{}", delivery: "" },
  ];

  for (const { name, body, event, delivery } of cases) {
    await t.step(name, async () => {
      const response = await deliver(body, event, delivery);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Invalid webhook headers or payload",
      });
    });
  }
});

Deno.test("missing GitHub headers return 400", async () => {
  const response = await app.request("/api/v1/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 400);
});
