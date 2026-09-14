import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { ConfigProvider, Effect, Layer, Logger, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { createApp } from "./app.ts";
import { DatabaseClient } from "./database.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { SessionAdministration } from "./session-administration.ts";
import { WebhookDeliveryHandler } from "./webhook-delivery-handler.ts";
import {
  devinSessions,
  githubWebhookDeliveries,
  issueAdmissions,
} from "./schemas.ts";
import {
  recoveryLayer,
  recoveryRemote,
  seedRecovery,
} from "../test/fixtures/session-recovery.ts";
import { withPlaybookStartup } from "../test/fixtures/playbook.ts";
import type { DevinSession } from "./devin.ts";

Deno.test("signed intake stays duplicate-safe under same-loop connection contention, replay, completion, release and reopen", async () => {
  const directory = await Deno.makeTempDir();
  const remotes: DevinSession[] = [];
  const requests: { repos: string[]; tags: string[] }[] = [];
  const fake: typeof fetch = withPlaybookStartup((input, init) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === "POST") {
      assert.ok(path.endsWith("/sessions"));
      const body = JSON.parse(String(init.body));
      requests.push(body);
      const remote = {
        ...recoveryRemote(`remote-${requests.length}`),
        tags: body.tags,
      };
      remotes.push(remote);
      return Promise.resolve(Response.json(remote));
    }
    assert.equal(init?.method ?? "GET", "GET");
    return Promise.resolve(
      Response.json({ items: remotes, has_next_page: false, end_cursor: null }),
    );
  });
  const makeRuntime = () =>
    ManagedRuntime.make(WebhookDeliveryHandler.layer.pipe(
      Layer.provideMerge(recoveryLayer(`${directory}/issues.sqlite`, 10)),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
        DEVIN_API_KEY: "synthetic",
        DEVIN_ORGANIZATION_ID: "org-test",
        GITHUB_WEBHOOK_SECRET: "synthetic-secret",
      }))),
      Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, fake)),
      Layer.provide(Logger.layer([])),
    ));
  const runtimes: ReturnType<typeof makeRuntime>[] = [];
  try {
    let first = makeRuntime();
    runtimes.push(first);
    let app = await first.runPromise(createApp);
    const second = makeRuntime();
    runtimes.push(second);
    const other = await second.runPromise(createApp);
    const deliver = (
      target: typeof app,
      id: string,
      repo = "Owner/Repo",
      issue = 42,
    ) => {
      const payload = JSON.stringify({
        repository: { full_name: repo },
        issue: { number: issue },
        action: "labeled",
        label: { name: "devin" },
      });
      return target.request("/api/v1/webhook", {
        method: "POST",
        body: payload,
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": id,
          "x-hub-signature-256": `sha256=${
            createHmac("sha256", "synthetic-secret").update(payload).digest(
              "hex",
            )
          }`,
        },
      });
    };
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        deliver(
          index % 2 ? app : other,
          `race-${index}`,
          index % 2 ? "owner/repo" : "OWNER/REPO",
        )),
    );
    assert.ok(
      responses.every((response) => [200, 500].includes(response.status)),
    );
    const stored = await first.runPromise(
      DatabaseClient.use(({ db }) => db.select().from(githubWebhookDeliveries)),
    );
    await second.dispose();
    await first.dispose();
    first = makeRuntime();
    runtimes.push(first);
    app = await first.runPromise(createApp);
    for (const [index, response] of responses.entries()) {
      if (response.status === 500) {
        assert.deepEqual(await response.json(), {
          error: "Webhook handling failed",
        });
        assert.equal(
          stored.some((row) => row.deliveryId === `race-${index}`),
          false,
          "failed transaction leaves no delivery",
        );
        assert.equal((await deliver(app, `race-${index}`)).status, 200);
      }
    }
    await first.runPromise(DevinSessionOrchestrator.use((o) => o.tick));
    assert.equal(requests.length, 1);
    assert.ok(
      requests[0].tags.some((tag) => tag.startsWith("delivery-id:race-")),
    );
    const read = DatabaseClient.use(({ db }) =>
      Effect.gen(function* () {
        return {
          sessions: yield* db.select().from(devinSessions),
          admissions: yield* db.select().from(issueAdmissions),
          deliveries: yield* db.select().from(githubWebhookDeliveries),
        };
      })
    );
    const initial = await first.runPromise(read);
    assert.equal(initial.sessions.length, 1);
    assert.equal(initial.deliveries.length, 12);
    assert.equal(initial.admissions[0].repo, "owner/repo");
    const id = initial.sessions[0].id;
    remotes[0] = {
      ...remotes[0],
      status: "exit",
      status_detail: "finished",
      updated_at: 3,
      structured_output: {
        outcome: "fix_proposed",
        summary: "Synthetic verified result",
      },
      pull_requests: [{
        pr_url: "https://github.com/owner/repo/pull/7",
        pr_state: "open",
      }],
    };
    await first.runPromise(DevinSessionOrchestrator.use((o) => o.tick));
    const completed = await first.runPromise(read);
    assert.equal(completed.sessions[0].providerLifecycle, "completed");
    assert.equal(completed.sessions[0].prNumber, 7);
    for (const deliveryId of ["after-completion", "race-1"]) {
      assert.equal((await deliver(app, deliveryId)).status, 200);
    }
    await first.runPromise(
      SessionAdministration.use((admin) =>
        Effect.gen(function* () {
          const inspected = yield* admin.inspect(id);
          yield* admin.execute({
            id,
            action: "resolve",
            revision: inspected.revision,
            reason: "Synthetic local release",
          });
        })
      ),
    );
    await first.dispose();
    await second.dispose();
    const reopened = makeRuntime();
    runtimes.push(reopened);
    const restarted = await reopened.runPromise(createApp);
    assert.equal(
      (await deliver(restarted, "after-reopen", "oWnEr/rEpO")).status,
      200,
    );
    await reopened.runPromise(DevinSessionOrchestrator.use((o) => o.tick));
    const retained = await reopened.runPromise(read);
    assert.equal(requests.length, 1);
    assert.equal(retained.sessions[0].id, id);
    assert.equal(
      retained.sessions[0].devinSessionId,
      initial.sessions[0].devinSessionId,
    );
    assert.deepEqual(
      retained.sessions[0].outputs,
      completed.sessions[0].outputs,
    );
    assert.equal(retained.sessions[0].prNumber, 7);
    assert.deepEqual(retained.admissions, initial.admissions);
    const concurrent = await Promise.all(
      Array.from(
        { length: 10 },
        (_, index) =>
          deliver(restarted, `different-issue-${index}`, "owner/repo", 43),
      ),
    );
    assert.deepEqual(
      concurrent.map((response) => response.status),
      Array(10).fill(200),
    );
    assert.equal(
      (await deliver(restarted, "different-repo", "other/repo", 42)).status,
      200,
    );
    await reopened.runPromise(DevinSessionOrchestrator.use((o) => o.tick));
    assert.equal(requests.length, 3);
    assert.equal(
      requests.filter((request) => request.tags.includes("issue:43")).length,
      1,
    );
    assert.equal((await reopened.runPromise(read)).admissions.length, 3);
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("independent worker connection and local claimer cannot both dispatch the admitted issue", async () => {
  const directory = await Deno.makeTempDir();
  const env = {
    SQLITE_DB_FILEPATH: `${directory}/race.sqlite`,
    DEVIN_API_KEY: "fake",
    DEVIN_ORGANIZATION_ID: "org-test",
    GITHUB_WEBHOOK_SECRET: "fake",
  };
  const runtime = ManagedRuntime.make(
    DevinSessionRepository.layer.pipe(
      Layer.provideMerge(DatabaseClient.layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );
  const worker = new Worker(
    new URL("../test/lifecycle-observation-worker.ts", import.meta.url).href,
    { type: "module" },
  );
  const request = (data: unknown) =>
    new Promise<{ claims?: unknown[]; error?: string }>((resolve, reject) => {
      worker.onmessage = (event) =>
        event.data.error
          ? reject(new Error(event.data.error))
          : resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage(data);
    });
  try {
    await runtime.runPromise(
      DatabaseClient.use(({ db }) =>
        seedRecovery(db, "pending", { status: "pending", devinSessionId: null })
      ),
    );
    await request({ action: "initialize", env });
    const [local, remote] = await Promise.all([
      runtime.runPromise(DevinSessionRepository.use((r) => r.claimPending)),
      request({ action: "claimPending" }),
    ]);
    assert.equal(local.length + (remote.claims?.length ?? 0), 1);
    assert.deepEqual(
      await runtime.runPromise(
        DevinSessionRepository.use((r) => r.claimPending),
      ),
      [],
    );
    assert.deepEqual((await request({ action: "claimPending" })).claims, []);
    const [saved] = await runtime.runPromise(
      DatabaseClient.use(({ db }) => db.select().from(devinSessions)),
    );
    assert.equal(saved.attempts, 1);
    assert.equal(saved.status, "submitting");
    await request({ action: "close" });
  } finally {
    worker.terminate();
    await runtime.dispose();
    await Deno.remove(directory, { recursive: true });
  }
});
