import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import app from "./app.ts";
import type { Env } from "./config.ts";

const testEnv = {
  DEVIN_API_KEY: "cog_test-key",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
};

function deliver(
  body: string,
  event = "push",
  delivery = "test-delivery",
  env: Env = testEnv,
  signature: string | null = `sha256=${
    createHmac("sha256", testEnv.GITHUB_WEBHOOK_SECRET).update(body).digest(
      "hex",
    )
  }`,
) {
  return app.request("/api/v1/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      ...(signature === null ? {} : { "x-hub-signature-256": signature }),
    },
    body,
  }, env);
}

Deno.test("missing or empty server config returns 500", async (t) => {
  for (
    const env of [
      {},
      { ...testEnv, DEVIN_API_KEY: "" },
      { ...testEnv, DEVIN_ORGANIZATION_ID: undefined },
      { ...testEnv, DEVIN_ORGANIZATION_ID: "" },
      { ...testEnv, GITHUB_WEBHOOK_SECRET: undefined },
      { ...testEnv, GITHUB_WEBHOOK_SECRET: "" },
    ]
  ) {
    await t.step(JSON.stringify(env), async () => {
      const response = await deliver("{}", "push", "test-delivery", env);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "Invalid server configuration",
      });
    });
  }
});

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

Deno.test("issues.labeled is dispatched and returns an empty 200", async () => {
  const response = await deliver(
    JSON.stringify({
      action: "labeled",
      repository: { full_name: "owner/repo" },
      issue: { number: 42 },
      label: { name: "bug" },
    }),
    "issues",
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

Deno.test("webhook callback failures return a generic 500", async () => {
  const response = await deliver('{"action":"labeled"}', "issues");
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Webhook handling failed" });
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

Deno.test("missing or empty signatures return 400", async () => {
  for (const signature of [null, ""]) {
    const response = await deliver(
      "{}",
      "push",
      "test-delivery",
      testEnv,
      signature,
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid webhook headers or payload",
    });
  }
});

Deno.test("verification uses the exact raw body, including whitespace and Unicode", async () => {
  const body = '{\n  "ref": "refs/heads/café", "commits": []\n}\n';
  const response = await deliver(body);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");

  const signature = `sha256=${
    createHmac("sha256", testEnv.GITHUB_WEBHOOK_SECRET).update(body).digest(
      "hex",
    )
  }`;
  const tampered = await deliver(
    JSON.stringify(JSON.parse(body)),
    "push",
    "test-delivery",
    testEnv,
    signature,
  );
  assert.equal(tampered.status, 500);
  assert.deepEqual(await tampered.json(), { error: "Webhook handling failed" });
});

Deno.test("invalid signatures return a generic error", async () => {
  for (const signature of ["not-a-signature", `sha256=${"0".repeat(64)}`]) {
    const response = await deliver(
      "{}",
      "push",
      "test-delivery",
      testEnv,
      signature,
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Webhook handling failed",
    });
  }
});

Deno.test("verification uses the secret from each request's environment", async () => {
  const env = { ...testEnv, GITHUB_WEBHOOK_SECRET: "another-webhook-secret" };
  const wrongSecret = await deliver("{}", "push", "test-delivery", env);
  assert.equal(wrongSecret.status, 500);
  assert.deepEqual(await wrongSecret.json(), {
    error: "Webhook handling failed",
  });

  const signature = `sha256=${
    createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update("{}").digest("hex")
  }`;
  const response = await deliver("{}", "push", "test-delivery", env, signature);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});
