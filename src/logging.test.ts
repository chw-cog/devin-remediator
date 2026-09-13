import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Logger,
  References,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { playbook } from "../test/fixtures/playbook.ts";
import { createApp } from "./app.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { AppLive } from "./index.ts";
import { errorFields, LoggingLive, observe } from "./logging.ts";

type LogEntry = ReturnType<typeof Logger.formatStructured.log>;

const env = {
  DEVIN_API_KEY: "SECRET_API_KEY",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "SECRET_WEBHOOK_KEY",
  SQLITE_DB_FILEPATH: ":memory:",
};
const body = JSON.stringify({
  action: "labeled",
  label: { name: "devin" },
  repository: { full_name: "owner/repo" },
  issue: { number: 42, body: "SECRET_ISSUE_BODY" },
});
const signature = `sha256=${
  createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(body).digest("hex")
}`;

const deliver = async (
  app: Effect.Success<typeof createApp>,
  id: string,
  event = "issues",
) =>
  await app.request("/api/v1/webhook", {
    method: "POST",
    headers: {
      "x-github-delivery": id,
      "x-github-event": event,
      "x-hub-signature-256": signature,
    },
    body,
  });

const withPipeline = (
  test: (fixture: {
    app: Effect.Success<typeof createApp>;
    orchestra: DevinSessionOrchestrator["Service"];
    logs: LogEntry[];
  }) => Effect.Effect<void, unknown>,
  status = 200,
  level: "Debug" | "Info" = "Debug",
) => {
  const logs: LogEntry[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/playbooks")) {
      return Promise.resolve(
        Response.json({ items: [playbook], has_next_page: false }),
      );
    }
    if (init?.method === "POST" && status !== 200) {
      return Promise.resolve(
        Response.json({ error: "SECRET_RESPONSE_BODY" }, { status }),
      );
    }
    if (url.pathname.endsWith("/sessions/insights")) {
      return Promise.resolve(
        Response.json({ items: [], has_next_page: false }),
      );
    }
    assert.equal(url.pathname, "/v3/organizations/org-test/sessions");
    const session = {
      session_id: "remote-42",
      url: "https://app.devin.ai/sessions/remote-42",
      status: init?.method === "POST" ? "new" : "exit",
      status_detail: "finished",
      org_id: "org-test",
      created_at: 0,
      updated_at: 0,
      acus_consumed: 0,
      tags: [],
      pull_requests: [],
    };
    return Promise.resolve(Response.json(
      init?.method === "POST"
        ? session
        : { items: [session], has_next_page: false },
    ));
  };
  return Effect.runPromise(
    Effect.gen(function* () {
      const app = yield* createApp;
      const orchestra = yield* DevinSessionOrchestrator;
      yield* test({ app, orchestra, logs });
      const serialized = JSON.stringify(logs);
      for (
        const secret of [
          env.DEVIN_API_KEY,
          env.GITHUB_WEBHOOK_SECRET,
          "SECRET_ISSUE_BODY",
          "SECRET_RESPONSE_BODY",
          signature,
          "Original webhook payload",
        ]
      ) {
        assert.ok(!serialized.includes(secret), `logs leaked ${secret}`);
      }
    }).pipe(
      Effect.provide(AppLive),
      Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (json) => {
        logs.push(JSON.parse(json));
      })])),
      Effect.provideService(References.MinimumLogLevel, level),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(env),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
};

const findLog = (logs: LogEntry[], message: string, deliveryId?: string) => {
  const log = logs.find((log) =>
    log.message === message &&
    (deliveryId === undefined ||
      log.annotations.github_delivery_id === deliveryId)
  );
  assert.ok(log, `missing log: ${message} (${deliveryId ?? "any delivery"})`);
  return log;
};

Deno.test("JSON logs correlate concurrent requests through queue, processor, client and reconciliation", () =>
  withPipeline(({ app, orchestra, logs }) =>
    Effect.gen(function* () {
      const responses = yield* Effect.promise(() =>
        Promise.all([
          deliver(app, "delivery-issues"),
          deliver(app, "delivery-push", "push"),
        ])
      );
      assert.deepEqual(responses.map((response) => response.status), [
        200,
        200,
      ]);
      const requestIds = responses.map((response) =>
        response.headers.get("x-request-id")
      );
      assert.ok(requestIds.every(Boolean));
      assert.notEqual(requestIds[0], requestIds[1]);

      for (
        const [index, id] of ["delivery-issues", "delivery-push"].entries()
      ) {
        const queued = findLog(logs, "webhook.queued", id);
        assert.equal(queued.annotations.request_id, requestIds[index]);
        assert.equal(queued.annotations.component, "WebhookDeliveryHandler");
        assert.equal(queued.annotations.repo, "owner/repo");
        assert.equal(queued.annotations.issue_number, 42);
        const completed = findLog(logs, "http.request.completed", id);
        assert.equal(completed.annotations.component, "App");
        assert.equal(completed.annotations.http_status, 200);
        assert.equal(typeof completed.annotations.duration_ms, "number");
      }

      yield* orchestra.tick;
      const missing = findLog(
        logs,
        "webhook.processor_missing",
        "delivery-push",
      );
      assert.equal(missing.level, "DEBUG");
      assert.equal(missing.annotations.github_event, "push");
      assert.equal(missing.annotations.component, "DevinSessionOrchestrator");
      assert.equal(missing.annotations.operation, "submit");
      assert.equal(missing.annotations.repo, "owner/repo");
      assert.equal(missing.annotations.issue_number, 42);
      assert.equal(missing.annotations.attempt, 1);
      assert.equal(missing.annotations.claim_version, 1);
      assert.equal(
        missing.annotations.session_record_id,
        findLog(logs, "webhook.queued", "delivery-push").annotations
          .session_record_id,
      );
      assert.equal(typeof missing.annotations.tick_id, "string");
      assert.equal(missing.annotations.request_id, undefined);

      const submitted = findLog(
        logs,
        "session.submission_started",
        "delivery-issues",
      );
      assert.equal(submitted.annotations.component, "WebhookEventProcessors");
      assert.equal(submitted.annotations.github_event, "issues");
      assert.equal(submitted.annotations.playbook_id, "playbook-test");
      const clientLog = logs.find((log) =>
        log.annotations.component === "DevinClient" &&
        log.annotations.operation === "createSession"
      );
      assert.ok(clientLog);
      assert.equal(clientLog.annotations.github_delivery_id, "delivery-issues");
      assert.equal(clientLog.annotations.devin_organization_id, "org-test");
      assert.equal(clientLog.annotations.playbook_id, "playbook-test");
      assert.equal(clientLog.annotations.http_status, 200);
      assert.ok(
        logs.some((log) =>
          log.annotations.component === "DevinSessionRepository" &&
          log.annotations.operation === "markRunning" &&
          log.annotations.session_record_id ===
            submitted.annotations.session_record_id
        ),
      );

      const created = findLog(logs, "Devin session created", "delivery-issues");
      assert.equal(created.annotations.devin_session_id, "remote-42");
      yield* orchestra.tick;
      const finished = findLog(logs, "session.finished", "delivery-issues");
      assert.equal(finished.annotations.devin_session_id, "remote-42");
      assert.equal(finished.annotations.status, "succeeded");
      assert.equal(finished.annotations.pr_number, null);
      assert.notEqual(
        finished.annotations.tick_id,
        created.annotations.tick_id,
      );
      const polls = logs.filter((log) =>
        log.message === "operation.completed" &&
        log.annotations.component === "DevinClient" &&
        log.annotations.operation === "listSessions"
      );
      assert.equal(polls.length, 1);
      assert.equal(polls[0].annotations.session_count, 1);
      assert.equal(polls[0].annotations.tick_id, finished.annotations.tick_id);
    })
  ));

Deno.test("redelivery, invalid signature, and malformed JSON have diagnostic logs without payloads", () =>
  withPipeline(({ app, logs }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => deliver(app, "duplicate"));
      yield* Effect.promise(() => deliver(app, "duplicate"));
      assert.equal(
        logs.filter((log) => log.message === "webhook.queued").length,
        1,
      );
      assert.equal(
        findLog(logs, "webhook.duplicate").annotations.github_event,
        "issues",
      );
      const rejected = yield* Effect.promise(async () =>
        await app.request("/api/v1/webhook", {
          method: "POST",
          headers: {
            "x-github-event": "issues",
            "x-github-delivery": "rejected",
            "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
          },
          body,
        })
      );
      assert.equal(rejected.status, 500);
      assert.equal(findLog(logs, "webhook.signature_rejected").level, "WARN");
      const invalid = yield* Effect.promise(async () =>
        await app.request("/api/v1/webhook", { method: "POST", body: "{" })
      );
      assert.equal(invalid.status, 400);
      assert.ok(logs.some((log) =>
        log.message === "http.request.completed" &&
        log.annotations.http_status === 400
      ));
    })
  ));

for (
  const [status, message, disposition, level] of [
    [429, "submission retry scheduled", "retryable", "WARN"],
    [403, "Devin session failed", "permanent", "ERROR"],
    [
      503,
      "submission outcome unknown; retaining submitting until recovery",
      "ambiguous",
      "WARN",
    ],
  ] as const
) {
  Deno.test(`submission HTTP ${status} logs actionable safe failure fields at Info level`, () =>
    withPipeline(
      ({ app, orchestra, logs }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => deliver(app, "failed-delivery"));
          yield* orchestra.tick;
          const failure = findLog(logs, message);
          assert.equal(failure.level, level);
          assert.equal(failure.annotations.http_status, status);
          assert.equal(failure.annotations.disposition, disposition);
          assert.equal(failure.annotations.error_type, "DevinSubmissionError");
          assert.equal(failure.annotations.github_event, "issues");
          assert.equal(
            failure.annotations.github_delivery_id,
            "failed-delivery",
          );
          assert.equal(failure.annotations.attempt, 1);
        }),
      status,
      "Info",
    ));
}

Deno.test("idle ticks do not produce Info-level polling noise", () =>
  withPipeline(
    ({ orchestra, logs }) =>
      Effect.gen(function* () {
        logs.length = 0;
        yield* orchestra.tick;
        yield* orchestra.tick;
        assert.deepEqual(logs, []);
      }),
    200,
    "Info",
  ));

Deno.test("observation preserves failures and interruption; nested errors omit sensitive data", async () => {
  const error = {
    _tag: "DatabaseError",
    cause: { _tag: "SqlError", message: "SECRET_SQL", params: [body] },
  };
  assert.deepEqual(errorFields(error), {
    error_type: "DatabaseError",
    cause_type_1: "SqlError",
  });
  const failure = await Effect.runPromiseExit(
    Effect.fail(error).pipe(observe("Test", "fail")),
  );
  assert.ok(Exit.isFailure(failure));
  assert.equal(failure.cause.reasons[0]._tag, "Fail");
  if (failure.cause.reasons[0]._tag === "Fail") {
    assert.equal(failure.cause.reasons[0].error, error);
  }
  const interrupted = await Effect.runPromiseExit(
    Effect.interrupt.pipe(observe("Test", "interrupt")),
  );
  assert.ok(Exit.isFailure(interrupted));
  assert.ok(Cause.hasInterrupts(interrupted.cause));
});

Deno.test("production logging level is configurable and invalid levels fail configuration", async () => {
  for (
    const [value, expected] of [[undefined, "Info"], [
      "Debug",
      "Debug",
    ]] as const
  ) {
    const actual = await Effect.runPromise(
      Effect.service(References.MinimumLogLevel).pipe(
        Effect.provide(LoggingLive),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ LOG_LEVEL: value }),
        ),
      ),
    );
    assert.equal(actual, expected);
  }
  const result = await Effect.runPromiseExit(Effect.void.pipe(
    Effect.provide(LoggingLive),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ LOG_LEVEL: "typo" }),
    ),
  ));
  assert.ok(Exit.isFailure(result));
});
