import { strict as assert } from "node:assert";
import { Octokit } from "@octokit/core";
import { ConfigProvider, Effect, Layer, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import { createApp } from "./app.ts";
import { DashboardConfig } from "./config.ts";
import { createDashboard } from "./dashboard.ts";
import { DatabaseClient, DatabaseError } from "./database.ts";
import { GitHubClient } from "./github.ts";
import { Metrics } from "./metrics.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";
import { WebhookDeliveryHandler } from "./webhook-delivery-handler.ts";

const env = {
  DEVIN_API_KEY: "synthetic-devin",
  DEVIN_ORGANIZATION_ID: "synthetic-org",
  GITHUB_WEBHOOK_SECRET: "synthetic-webhook",
  SQLITE_DB_FILEPATH: ":memory:",
  DASHBOARD_REPOSITORY: "Owner/Repo",
  DASHBOARD_PASSWORD: "synthetic-dashboard-password",
};

const auth = {
  authorization: `Basic ${btoa(`viewer:${env.DASHBOARD_PASSWORD}`)}`,
};

function testLayer(
  respond: (request: Request) => Response = (request) =>
    Response.json(
      request.url.includes("/search/issues")
        ? { total_count: 1248, incomplete_results: false }
        : {
          created_at: request.url.endsWith("/100")
            ? "2026-09-14T00:01:00Z"
            : "2026-09-14T00:03:00Z",
          merged_at: request.url.endsWith("/100")
            ? "2026-09-14T00:10:00Z"
            : null,
        },
    ),
) {
  const requests: Request[] = [];
  const client = new Octokit({
    request: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return Promise.resolve(respond(request));
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const layer = Layer.mergeAll(Metrics.layer, WebhookDeliveryHandler.layer)
    .pipe(
      Layer.provideMerge(DatabaseClient.layer),
      Layer.provide(Layer.succeed(GitHubClient, {
        cached: Effect.succeed(client),
        authenticate: () => Effect.succeed(client),
        invalidate: Effect.void,
      })),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    );
  return { layer, requests };
}

const seed = Effect.fn("metricsTest.seed")(function* (
  id: string,
  issue: number,
  fields: Partial<typeof devinSessions.$inferInsert> = {},
  delivery: {
    repo?: string;
    label?: string;
    action?: string;
    title?: string;
    event?: string;
  } = {},
) {
  const { db } = yield* DatabaseClient;
  const insertedAt = "2026-09-14T00:00:00.000Z";
  yield* db.insert(githubWebhookDeliveries).values({
    id,
    deliveryId: id,
    eventName: delivery.event ?? "issues",
    repo: delivery.repo ?? "owner/repo",
    issueNumber: issue,
    payload: JSON.stringify({
      action: delivery.action ?? "labeled",
      label: { name: delivery.label ?? "devin" },
      issue: { title: delivery.title ?? `Issue ${issue}` },
      privatePayload: "never-display-this-payload",
    }),
    insertedAt,
  });
  yield* db.insert(devinSessions).values({
    id,
    githubDeliveryId: id,
    status: "submitted",
    devinSessionId: `remote-${id}`,
    providerLifecycle: "active",
    providerStatus: "running",
    providerStatusDetail: "working",
    sessionUrl: `https://app.devin.ai/sessions/remote-${id}`,
    providerCreatedAt: 1789344000,
    lastObservedAt: insertedAt,
    insertedAt,
    updatedAt: insertedAt,
    ...fields,
  });
});

Deno.test("metrics deduplicate issue/PR lookups and include inactive sessions in PR milestone medians", async () => {
  const { layer, requests } = testLayer();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed("a", 1, {
        prNumber: 100,
        acusConsumed: 0,
        completionObservedAt: "2026-09-14T00:01:00.000Z",
        providerLifecycle: "completed",
      });
      yield* seed("b", 1, {
        prNumber: 101,
        acusConsumed: 2.5,
        completionObservedAt: "2026-09-14T00:03:00.000Z",
        localOwnership: "released",
      });
      yield* seed("c", 2, {
        prNumber: 100,
        acusConsumed: 5,
        completionObservedAt: "2026-09-14T00:05:00.000Z",
        isArchived: true,
      });
      yield* seed("d", 3, {
        acusConsumed: null,
        completionObservedAt: "2026-09-14T00:07:00.000Z",
      });
      yield* seed("e", 4, {
        acusConsumed: 1,
        completionObservedAt: "2026-09-13T00:00:00.000Z",
      });
      yield* seed("f", 5, { status: "skipped", devinSessionId: null }, {
        label: "Devin",
      });
      yield* seed("g", 6, { status: "skipped", devinSessionId: null }, {
        action: "unlabeled",
      });
      yield* seed("h", 7, { prNumber: 900, acusConsumed: 999 }, {
        repo: "elsewhere/repo",
      });
      yield* seed("i", 8, { status: "pending", devinSessionId: null });
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const snapshot = yield* metrics.dashboard.snapshot;
      assert.deepEqual(snapshot.issues, {
        repositoryTotal: 1248,
        assignedToDevin: 5,
        withDevinPr: 2,
        withMergedDevinPr: 2,
      });
      assert.deepEqual(snapshot.pullRequests, {
        tracked: 2,
        merged: 1,
        confirmedMerged: 1,
        unknownMergeState: 0,
      });
      assert.equal(snapshot.usage.total, 8.5);
      assert.equal(snapshot.usage.averagePerSession, 2.125);
      assert.equal(snapshot.usage.measuredSessions, 4);
      assert.equal(snapshot.usage.missingSessions, 1);
      assert.equal(snapshot.usage.trackedSessions, 5);
      assert.deepEqual(snapshot.timing, {
        fixProposed: {
          medianMilliseconds: 60000,
          sampleCount: 3,
          excludedSessions: 2,
          definition: "session_creation_to_pr_creation",
        },
        merged: {
          medianMilliseconds: 600000,
          sampleCount: 2,
          excludedSessions: 3,
          definition: "session_creation_to_pr_merge",
        },
      });
      assert.equal(snapshot.activeSessionCount, 2);
      assert.deepEqual(snapshot.activeSessions.map((s) => s.id), [
        "remote-d",
        "remote-e",
      ]);
      const search = requests.find((r) => r.url.includes("/search/issues"));
      assert.ok(search);
      assert.equal(
        new URL(search.url).searchParams.get("q"),
        "repo:owner/repo is:issue",
      );
      assert.deepEqual(
        requests.filter((r) => r.url.includes("/pulls/")).map((r) =>
          new URL(r.url).pathname
        ).sort(),
        [
          "/repos/owner/repo/pulls/100",
          "/repos/owner/repo/pulls/101",
        ],
      );
      const app = yield* createApp;
      const response = yield* Effect.promise(async () =>
        await app.request("/api/v1/metrics", { headers: auth })
      );
      assert.equal(response.status, 200);
      assert.deepEqual(yield* Effect.promise(() => response.json()), snapshot);
      assert.equal(
        requests.length,
        3,
        "HTML/JSON reads should reuse one cached snapshot",
      );
    }).pipe(Effect.provide(layer)),
  );
});

Deno.test("GitHub partial failures remain unknown while local metrics and confirmed merges survive", async () => {
  const { layer } = testLayer((request) => {
    if (request.url.includes("/search/issues")) {
      return Response.json({ total_count: 2, incomplete_results: true });
    }
    if (request.url.endsWith("/100")) {
      return Response.json({
        created_at: "2026-09-14T00:01:00Z",
        merged_at: "2026-09-14T00:10:00Z",
      });
    }
    return Response.json({ message: "unavailable" }, { status: 403 });
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed("one", 1, { prNumber: 100, acusConsumed: 0 });
      yield* seed("two", 2, { prNumber: 101 });
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const snapshot = yield* metrics.dashboard.snapshot;
      assert.equal(snapshot.github.status, "partial");
      assert.equal(snapshot.issues.repositoryTotal, null);
      assert.equal(snapshot.issues.assignedToDevin, 2);
      assert.equal(snapshot.issues.withDevinPr, 2);
      assert.equal(snapshot.issues.withMergedDevinPr, null);
      assert.deepEqual(snapshot.pullRequests, {
        tracked: 2,
        merged: null,
        confirmedMerged: 1,
        unknownMergeState: 1,
      });
      assert.equal(snapshot.usage.total, 0);
      assert.equal(snapshot.usage.averagePerSession, 0);
      assert.equal(snapshot.timing.fixProposed.medianMilliseconds, 60000);
      assert.equal(snapshot.timing.merged.medianMilliseconds, 600000);
      assert.equal(snapshot.timing.fixProposed.sampleCount, 1);
      assert.equal(snapshot.timing.merged.sampleCount, 1);
      assert.equal(snapshot.timing.fixProposed.excludedSessions, 1);
      assert.equal(snapshot.timing.merged.excludedSessions, 1);
      const app = yield* createApp;
      const response = yield* Effect.promise(async () =>
        await app.request("/dashboard", { headers: auth })
      );
      const text = yield* Effect.promise(() => response.text());
      assert.equal(response.status, 200);
      assert.match(text, /GitHub data is incomplete/);
      assert.match(text, /1 confirmed · 1 unchecked/);
      assert.match(text, /Timing medians include only available PR timestamps/);
      assert.match(text, /Median time until fix proposed/);
      assert.match(text, /Median time until merged/);
      assert.doesNotMatch(text, /Median time to completion/);
      assert.ok(
        text.indexOf("Median time until fix proposed") <
          text.indexOf("Median time until merged"),
      );
    }).pipe(Effect.provide(layer)),
  );
});

Deno.test("active session cap, safe links, escaping and auth are enforced on real dashboard routes", async () => {
  const { layer, requests } = testLayer();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed("oldest", 1, { lastObservedAt: "2026-09-14T00:00:00Z" });
      yield* seed("input", 2, {
        providerLifecycle: "needs_input",
        lastObservedAt: "2026-09-14T00:02:00Z",
      });
      yield* seed("approval", 3, {
        providerLifecycle: "needs_approval",
        lastObservedAt: "2026-09-14T00:03:00Z",
      });
      yield* seed("unsafe", 4, {
        sessionUrl: "javascript:alert(1)",
        providerStatusDetail: "<script>steal()</script>",
        lastObservedAt: "2026-09-14T00:04:00Z",
        outputs: [{
          outcome: "needs_human",
          summary: "private-output-summary",
        }],
      }, { title: '<img src=x onerror="steal()">' });
      const app = yield* createApp;
      for (
        const path of [
          "/dashboard",
          "/dashboard/",
          "/dashboard/styles.css",
          "/dashboard/client.js",
          "/dashboard/missing",
          "/api/v1/metrics",
        ]
      ) {
        for (
          const headers of [
            new Headers(),
            new Headers({ authorization: `Basic ${btoa("viewer:incorrect")}` }),
          ]
        ) {
          const response = yield* Effect.promise(async () =>
            await app.request(path, { headers })
          );
          assert.equal(response.status, 401);
          assert.match(response.headers.get("www-authenticate") ?? "", /Basic/);
          assert.equal(response.headers.get("cache-control"), "no-store");
        }
      }
      assert.equal(
        requests.length,
        0,
        "unauthenticated callers must not trigger remote reads",
      );
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const snapshot = yield* metrics.dashboard.snapshot;
      assert.equal(snapshot.activeSessionCount, 4);
      assert.deepEqual(snapshot.activeSessions.map((s) => s.id), [
        "remote-unsafe",
        "remote-approval",
        "remote-input",
      ]);
      assert.equal(snapshot.activeSessions[0].url, null);
      const response = yield* Effect.promise(async () =>
        await app.request("/dashboard", { headers: auth })
      );
      const text = yield* Effect.promise(() => response.text());
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /default-src 'none'/,
      );
      assert.match(text, /&lt;img/);
      assert.match(text, /&lt;script&gt;/);
      assert.doesNotMatch(
        text,
        /<script>|<img|javascript:|private-output-summary|never-display-this-payload/,
      );
      assert.match(text, /Needs your input/);
      assert.match(text, /Needs approval/);
      const css = yield* Effect.promise(async () =>
        await app.request("/dashboard/styles.css", { headers: auth })
      );
      assert.equal(css.status, 200);
      assert.match(css.headers.get("content-type") ?? "", /text\/css/);
      assert.match(yield* Effect.promise(() => css.text()), /@media/);
      const script = yield* Effect.promise(async () =>
        await app.request("/dashboard/client.js", { headers: auth })
      );
      assert.equal(script.status, 200);
      assert.match(
        script.headers.get("content-type") ?? "",
        /text\/javascript/,
      );
      assert.match(
        yield* Effect.promise(() => script.text()),
        /visibilitychange/,
      );
      const health = yield* Effect.promise(async () =>
        await app.request("/health")
      );
      assert.equal(health.status, 200);
    }).pipe(Effect.provide(layer)),
  );
});

Deno.test("PR milestones work while Devin waits and a later merge changes only the merge cohort", async () => {
  let merged = false;
  const { layer } = testLayer((request) =>
    Response.json(
      request.url.includes("/search/issues")
        ? { total_count: 1, incomplete_results: false }
        : {
          created_at: "2026-09-14T00:04:00Z",
          merged_at: merged ? "2026-09-14T00:20:00Z" : null,
        },
    )
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed("waiting", 1, {
        prNumber: 100,
        providerLifecycle: "needs_input",
        providerStatusDetail: "waiting_for_user",
        completionObservedAt: null,
      });
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const before = yield* metrics.dashboard.snapshot;
      assert.equal(before.timing.fixProposed.medianMilliseconds, 240000);
      assert.equal(before.timing.fixProposed.sampleCount, 1);
      assert.equal(before.timing.merged.medianMilliseconds, null);
      assert.equal(before.timing.merged.sampleCount, 0);
      assert.equal(before.timing.merged.excludedSessions, 1);
      merged = true;
      yield* TestClock.adjust("31 seconds");
      const after = yield* metrics.dashboard.snapshot;
      assert.deepEqual(after.timing.fixProposed, before.timing.fixProposed);
      assert.equal(after.timing.merged.medianMilliseconds, 1200000);
      assert.equal(after.timing.merged.sampleCount, 1);
      assert.equal(after.timing.merged.excludedSessions, 0);
      assert.equal(after.activeSessions[0].lifecycle, "needs_input");
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
  );
});

Deno.test("invalid, missing and pre-session PR timestamps cannot fabricate duration samples", async () => {
  const prs: Record<string, unknown> = {
    "100": {
      created_at: "2026-09-14T00:00:00Z",
      merged_at: "2026-09-14T00:00:00Z",
    },
    "101": {
      created_at: "2026-09-13T23:59:00Z",
      merged_at: "2026-09-14T00:10:00Z",
    },
    "102": { created_at: "not-a-date", merged_at: null },
    "103": { merged_at: "2026-09-14T00:10:00Z" },
    "104": {
      created_at: "2026-09-14T00:02:00Z",
      merged_at: "2026-09-14T00:01:00Z",
    },
    "105": {
      created_at: "2026-09-14T00:01:00Z",
      merged_at: "2026-09-14T00:10:00Z",
    },
    "106": {
      created_at: "2026-09-14T00:01:00Z",
      merged_at: "invalid",
    },
    "107": {
      created_at: "2026-09-14T00:04:00Z",
      merged_at: null,
      state: "closed",
    },
  };
  const { layer } = testLayer((request) =>
    Response.json(
      request.url.includes("/search/issues")
        ? { total_count: 8, incomplete_results: false }
        : prs[new URL(request.url).pathname.split("/").at(-1) ?? ""],
    )
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let number = 100; number <= 107; number++) {
        yield* seed(String(number), number, {
          prNumber: number,
          ...(number === 105 ? { providerCreatedAt: null } : {}),
          completionObservedAt: "2026-09-14T00:30:00Z",
        });
      }
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const snapshot = yield* metrics.dashboard.snapshot;
      assert.deepEqual(snapshot.timing.fixProposed, {
        medianMilliseconds: 120000,
        sampleCount: 3,
        excludedSessions: 5,
        definition: "session_creation_to_pr_creation",
      });
      assert.deepEqual(snapshot.timing.merged, {
        medianMilliseconds: 0,
        sampleCount: 1,
        excludedSessions: 7,
        definition: "session_creation_to_pr_merge",
      });
      assert.equal(snapshot.github.status, "partial");
      assert.equal(snapshot.pullRequests.unknownMergeState, 3);
    }).pipe(Effect.provide(layer)),
  );
});

Deno.test("unavailable GitHub timestamps yield unknown timing even when Devin completed", async () => {
  const { layer } = testLayer(() =>
    Response.json({ message: "unavailable" }, { status: 403 })
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed("completed", 1, {
        prNumber: 100,
        completionObservedAt: "2026-09-14T00:01:00Z",
        providerLifecycle: "completed",
      });
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const snapshot = yield* metrics.dashboard.snapshot;
      for (const milestone of Object.values(snapshot.timing)) {
        assert.equal(milestone.medianMilliseconds, null);
        assert.equal(milestone.sampleCount, 0);
        assert.equal(milestone.excludedSessions, 1);
      }
    }).pipe(Effect.provide(layer)),
  );
});

Deno.test("empty metrics distinguish no observations from measured zero", async () => {
  const { layer } = testLayer();
  await Effect.runPromise(
    Effect.gen(function* () {
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const snapshot = yield* metrics.dashboard.snapshot;
      assert.equal(snapshot.usage.total, null);
      assert.equal(snapshot.usage.averagePerSession, null);
      assert.equal(snapshot.timing.fixProposed.medianMilliseconds, null);
      assert.equal(snapshot.timing.merged.medianMilliseconds, null);
      assert.equal(snapshot.timing.fixProposed.sampleCount, 0);
      assert.equal(snapshot.timing.merged.sampleCount, 0);
      assert.equal(snapshot.issues.assignedToDevin, 0);
      assert.equal(snapshot.pullRequests.merged, 0);
      assert.deepEqual(snapshot.activeSessions, []);
      const app = yield* createApp;
      const response = yield* Effect.promise(async () =>
        await app.request("/dashboard", { headers: auth })
      );
      assert.match(
        yield* Effect.promise(() => response.text()),
        /Nothing in motion/,
      );
    }).pipe(Effect.provide(layer)),
  );
});

Deno.test("dashboard configuration is opt-in, validates scope and redacts credentials", async () => {
  for (
    const config of [
      {},
      { DASHBOARD_USERNAME: "viewer" },
      { DASHBOARD_REPOSITORY: "" },
      { DASHBOARD_REPOSITORY: "", DASHBOARD_PASSWORD: "" },
    ]
  ) {
    const result = await Effect.runPromise(DashboardConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
    ));
    assert.equal(result, null);
  }
  for (
    const config of [
      { DASHBOARD_REPOSITORY: "owner/repo" },
      { DASHBOARD_PASSWORD: "secret" },
      {
        DASHBOARD_REPOSITORY: "owner/repo is:pr",
        DASHBOARD_PASSWORD: "secret",
      },
      { DASHBOARD_REPOSITORY: "../repo", DASHBOARD_PASSWORD: "secret" },
      { ...env, DASHBOARD_USERNAME: "name:password" },
      { ...env, DASHBOARD_PASSWORD: " " },
    ]
  ) {
    const result = await Effect.runPromise(DashboardConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
      Effect.result,
    ));
    assert.ok(Result.isFailure(result));
    assert.doesNotMatch(JSON.stringify(result), /synthetic-dashboard-password/);
  }
  const config = await Effect.runPromise(DashboardConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  ));
  assert.ok(config);
  assert.equal(config.repository, "owner/repo");
  assert.equal(config.username, "viewer");
  assert.equal(Redacted.value(config.password), env.DASHBOARD_PASSWORD);
  assert.doesNotMatch(JSON.stringify(config), /synthetic-dashboard-password/);
});

Deno.test("database failure returns a safe retry page and JSON 503, not fabricated zeros", async () => {
  const app = createDashboard({
    repository: "owner/repo",
    username: "viewer",
    password: Redacted.make(env.DASHBOARD_PASSWORD),
    snapshot: Effect.fail(
      new DatabaseError({ cause: "private database path" }),
    ),
  });
  for (const path of ["/dashboard", "/api/v1/metrics"]) {
    const response = await app.request(path, { headers: auth });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /temporarily unavailable/);
    assert.doesNotMatch(text, /private database path/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

Deno.test("concurrent readers share a snapshot and see new observations after cache expiry", async () => {
  const { layer, requests } = testLayer();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* seed("first", 1, {
        acusConsumed: 1,
        prNumber: 100,
      });
      const metrics = yield* Metrics;
      assert.ok(metrics.dashboard);
      const snapshots = yield* Effect.all([
        metrics.dashboard.snapshot,
        metrics.dashboard.snapshot,
        metrics.dashboard.snapshot,
      ], { concurrency: 3 });
      assert.equal(requests.length, 2);
      assert.equal(snapshots[0].timing.fixProposed.medianMilliseconds, 60000);
      yield* seed("second", 2, { acusConsumed: 2, prNumber: 101 });
      assert.equal(
        (yield* metrics.dashboard.snapshot).issues.assignedToDevin,
        1,
      );
      yield* TestClock.adjust("31 seconds");
      const refreshed = yield* metrics.dashboard.snapshot;
      assert.equal(refreshed.issues.assignedToDevin, 2);
      assert.equal(refreshed.usage.total, 3);
      assert.equal(refreshed.usage.averagePerSession, 1.5);
      assert.equal(refreshed.timing.fixProposed.medianMilliseconds, 120000);
      assert.equal(refreshed.timing.merged.medianMilliseconds, 600000);
      assert.equal(refreshed.timing.merged.sampleCount, 1);
      assert.equal(requests.length, 5);
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
  );
});

Deno.test("disabled dashboard exposes no page, API or assets while health remains available", async () => {
  const disabled = Layer.mergeAll(Metrics.layer, WebhookDeliveryHandler.layer)
    .pipe(
      Layer.provide(GitHubClient.layer),
      Layer.provide(DatabaseClient.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        DEVIN_API_KEY: "synthetic",
        DEVIN_ORGANIZATION_ID: "synthetic",
        GITHUB_WEBHOOK_SECRET: "synthetic",
        SQLITE_DB_FILEPATH: ":memory:",
      }))),
    );
  await Effect.runPromise(
    Effect.gen(function* () {
      const metrics = yield* Metrics;
      assert.equal(metrics.dashboard, null);
      const app = yield* createApp;
      for (
        const path of [
          "/dashboard",
          "/dashboard/styles.css",
          "/dashboard/client.js",
          "/api/v1/metrics",
        ]
      ) {
        const response = yield* Effect.promise(async () =>
          await app.request(path)
        );
        assert.equal(response.status, 404);
      }
      const response = yield* Effect.promise(async () =>
        await app.request("/health")
      );
      assert.equal(response.status, 200);
    }).pipe(Effect.provide(disabled)),
  );
});
