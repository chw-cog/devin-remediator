import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { createApp } from "./app.ts";
import { DatabaseClient } from "./database.ts";
import { WebhookDeliveryHandler } from "./webhook_delivery_handler.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";

const testEnv = {
  DEVIN_API_KEY: "cog_test-key",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
  SQLITE_DB_FILEPATH: ":memory:",
};
const pushBody = JSON.stringify({
  repository: { full_name: "owner/repo" },
  ref: "refs/heads/main",
});

function sign(body: string, secret = testEnv.GITHUB_WEBHOOK_SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function setup(app: Effect.Success<typeof createApp>) {
  const deliver = (
    body = pushBody,
    {
      event = "push",
      delivery = "test-delivery",
      signature = sign(body),
    }: {
      event?: string | null;
      delivery?: string;
      signature?: string | null;
    } = {},
  ) =>
    app.request("/api/v1/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(event === null ? {} : { "x-github-event": event }),
        "x-github-delivery": delivery,
        ...(signature === null ? {} : { "x-hub-signature-256": signature }),
      },
      body,
    });
  return { app, deliver };
}

function databaseTest(
  name: string,
  test: (
    fixture: DatabaseClient["Service"] & ReturnType<typeof setup>,
  ) => Promise<void>,
) {
  const TestLive = WebhookDeliveryHandler.layer.pipe(
    Layer.provideMerge(DatabaseClient.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(testEnv))),
  );
  Deno.test(name, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        const app = yield* createApp;
        yield* Effect.promise(() => test({ db, ...setup(app) }));
      }).pipe(Effect.provide(TestLive)),
    ));
}

databaseTest(
  "missing or empty server config prevents app construction",
  async ({ db }) => {
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
      const result = await Effect.runPromise(createApp.pipe(
        Effect.provide(WebhookDeliveryHandler.layer),
        Effect.provideService(DatabaseClient, { db }),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
        Effect.result,
      ));
      assert.ok(Result.isFailure(result));
      assert.equal(result.failure._tag, "ConfigError");
    }
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      [],
    );
    assert.deepEqual(
      await Effect.runPromise(db.select().from(devinSessions).all()),
      [],
    );
  },
);

databaseTest(
  "every supported event commits a delivery and pending session before 200",
  async ({ db, deliver }) => {
    const payloads = {
      check_run: { action: "completed", check_run: { id: 1 } },
      dependabot_alert: { action: "created", alert: { number: 1 } },
      issues: { action: "opened", issue: { number: 42, title: "Test issue" } },
      label: { action: "created", label: { name: "bug", color: "d73a4a" } },
      push: { ref: "refs/heads/main", commits: [] },
    };

    for (const [event, payload] of Object.entries(payloads)) {
      const body = JSON.stringify({
        ...payload,
        repository: { full_name: "owner/repo" },
      });
      const response = await deliver(body, { event, delivery: event });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
      const row = await Effect.runPromise(
        db.select().from(githubWebhookDeliveries).where(
          eq(githubWebhookDeliveries.deliveryId, event),
        ).get(),
      );
      assert.ok(row);
      assert.match(row.id, /^[0-9a-f-]{36}$/);
      assert.match(row.insertedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
      assert.deepEqual(row, {
        id: row.id,
        deliveryId: event,
        eventName: event,
        repo: "owner/repo",
        issueNumber: event === "issues" ? 42 : null,
        payload: body,
        insertedAt: row.insertedAt,
      });
      const session = await Effect.runPromise(
        db.select().from(devinSessions).where(
          eq(devinSessions.githubDeliveryId, event),
        ).get(),
      );
      assert.ok(session);
      assert.match(session.id, /^[0-9a-f-]{36}$/);
      assert.notEqual(session.id, row.id);
      assert.deepEqual(session, {
        id: session.id,
        githubDeliveryId: event,
        status: "pending",
        devinSessionId: null,
        prNumber: null,
        attempts: 0,
        insertedAt: row.insertedAt,
        updatedAt: row.insertedAt,
      });
    }
    assert.equal(
      (await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()))
        .length,
      5,
    );
    assert.equal(
      (await Effect.runPromise(db.select().from(devinSessions).all())).length,
      5,
    );
  },
);

databaseTest(
  "issues.labeled queues work without requiring a label",
  async ({ db, deliver }) => {
    const response = await deliver(
      JSON.stringify({
        action: "labeled",
        repository: { full_name: "owner/repo" },
        issue: { number: 42 },
      }),
      { event: "issues" },
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await Effect.runPromise(db.select().from(githubWebhookDeliveries).get()))
        ?.issueNumber,
      42,
    );
    assert.equal(
      (await Effect.runPromise(db.select().from(devinSessions).get()))?.status,
      "pending",
    );
  },
);

databaseTest(
  "malformed JSON, invalid envelopes, and missing headers return 400 without writes",
  async ({ db, app, deliver }) => {
    const malformed = await deliver("{");
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "Invalid JSON" });
    for (
      const [body, options] of [
        ["null", {}],
        ["[]", {}],
        ['"push"', {}],
        [pushBody, { event: null }],
        [pushBody, { event: "" }],
        [pushBody, { delivery: "" }],
        [pushBody, { signature: null }],
        [pushBody, { signature: "" }],
      ] as const
    ) {
      const response = await deliver(body, options);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Invalid webhook headers or payload",
      });
    }
    const response = await app.request("/api/v1/webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      [],
    );
    assert.deepEqual(
      await Effect.runPromise(db.select().from(devinSessions).all()),
      [],
    );
  },
);

databaseTest(
  "invalid repository or issue metadata fails without writes",
  async ({ db, deliver }) => {
    for (
      const payload of [
        {},
        { repository: null },
        { repository: { full_name: "" } },
        { repository: { full_name: 42 } },
        { repository: { full_name: "owner/repo" }, issue: { number: "42" } },
        { repository: { full_name: "owner/repo" }, issue: { number: 1.5 } },
        { repository: { full_name: "owner/repo" }, issue: { number: 0 } },
      ]
    ) {
      const response = await deliver(JSON.stringify(payload));
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "Webhook handling failed",
      });
    }
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      [],
    );
    assert.deepEqual(
      await Effect.runPromise(db.select().from(devinSessions).all()),
      [],
    );
  },
);

databaseTest(
  "HMAC verification and storage use the exact raw body",
  async ({ db, deliver }) => {
    const body =
      '{\n  "repository": {"full_name": "owner/repo"},\n  "ref": "refs/heads/café", "commits": []\n}\n';
    const tampered = await deliver(JSON.stringify(JSON.parse(body)), {
      signature: sign(body),
    });
    assert.equal(tampered.status, 500);
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      [],
    );
    assert.deepEqual(
      await Effect.runPromise(db.select().from(devinSessions).all()),
      [],
    );

    const response = await deliver(body);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
    assert.equal(
      (await Effect.runPromise(db.select().from(githubWebhookDeliveries).get()))
        ?.payload,
      body,
    );
    assert.equal(
      (await Effect.runPromise(db.select().from(devinSessions).get()))?.status,
      "pending",
    );
  },
);

databaseTest(
  "invalid signatures return a generic error without writes",
  async ({ db, deliver }) => {
    for (const signature of ["not-a-signature", `sha256=${"0".repeat(64)}`]) {
      const response = await deliver(pushBody, { signature });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), {
        error: "Webhook handling failed",
      });
    }
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      [],
    );
    assert.deepEqual(
      await Effect.runPromise(db.select().from(devinSessions).all()),
      [],
    );
  },
);

databaseTest(
  "verification uses the secret captured from the app's config layer",
  async ({ db }) => {
    const env = { ...testEnv, GITHUB_WEBHOOK_SECRET: "another-webhook-secret" };
    const app = await Effect.runPromise(createApp.pipe(
      Effect.provide(WebhookDeliveryHandler.layer),
      Effect.provideService(DatabaseClient, { db }),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ));
    const { deliver } = setup(app);
    const wrongSecret = await deliver(pushBody);
    assert.equal(wrongSecret.status, 500);
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      [],
    );
    const response = await deliver(pushBody, {
      signature: sign(pushBody, env.GITHUB_WEBHOOK_SECRET),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (await Effect.runPromise(db.select().from(devinSessions).get()))?.status,
      "pending",
    );
  },
);

databaseTest(
  "redelivery leaves the original payload and progressed session unchanged",
  async ({ db, deliver }) => {
    assert.equal((await deliver()).status, 200);
    await Effect.runPromise(
      db.update(devinSessions).set({
        status: "running",
        devinSessionId: "devin-123",
        attempts: 1,
        updatedAt: "2030-01-01T00:00:00.000Z",
      }).run(),
    );
    const deliveries = await Effect.runPromise(
      db.select().from(githubWebhookDeliveries).all(),
    );
    const sessions = await Effect.runPromise(
      db.select().from(devinSessions).all(),
    );

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => deliver(`${pushBody}\n`)),
    );
    assert.ok(responses.every((response) => response.status === 200));
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      deliveries,
    );
    assert.deepEqual(
      await Effect.runPromise(db.select().from(devinSessions).all()),
      sessions,
    );
    assert.equal(
      (await deliver(pushBody, { signature: sign("tampered") })).status,
      500,
    );
  },
);

databaseTest(
  "simultaneous first deliveries create exactly one pair",
  async ({ db, deliver }) => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => deliver()),
    );
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(
      (await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()))
        .length,
      1,
    );
    assert.equal(
      (await Effect.runPromise(db.select().from(devinSessions).all())).length,
      1,
    );
  },
);

databaseTest(
  "session insertion failure rolls back delivery and allows retry",
  async ({ db, deliver }) => {
    await Effect.runPromise(db.$client.unsafe(`
      CREATE TRIGGER fail_session BEFORE INSERT ON devin_sessions
      BEGIN SELECT RAISE(ABORT, 'test session insertion failure'); END;
    `));
    const response = await deliver();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: "Webhook handling failed",
    });
    assert.deepEqual(
      await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()),
      [],
    );
    assert.deepEqual(
      await Effect.runPromise(db.select().from(devinSessions).all()),
      [],
    );

    await Effect.runPromise(db.$client.unsafe("DROP TRIGGER fail_session"));
    assert.equal((await deliver()).status, 200);
    assert.equal(
      (await Effect.runPromise(db.select().from(githubWebhookDeliveries).all()))
        .length,
      1,
    );
    assert.equal(
      (await Effect.runPromise(db.select().from(devinSessions).get()))?.status,
      "pending",
    );
  },
);
