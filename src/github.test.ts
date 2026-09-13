import { strict as assert } from "node:assert";
import { Octokit } from "@octokit/core";
import { ConfigProvider, DateTime, Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { githubAppEnv } from "../test/fixtures/github-app.ts";
import { GitHubClient } from "./github.ts";

const config = ConfigProvider.layer(ConfigProvider.fromUnknown({
  DEVIN_API_KEY: "synthetic-devin",
  DEVIN_ORGANIZATION_ID: "org-test",
  GITHUB_WEBHOOK_SECRET: "synthetic-webhook",
  ...githubAppEnv,
}));

Deno.test("GitHubClient supplies a cached authenticated Octokit without notification tables or implicit token refresh", async () => {
  const requests: Request[] = [];
  let expiresAt = "";
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    assert.equal(init?.redirect, "error");
    return Promise.resolve(
      Response.json(
        request.url.endsWith("/access_tokens")
          ? { token: "synthetic-installation-token", expires_at: expiresAt }
          : { id: 900 },
        { status: request.method === "POST" ? 201 : 200 },
      ),
    );
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubClient;
      assert.equal(yield* github.cached, undefined);
      expiresAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { hours: 1 }),
      );
      const client = yield* github.authenticate();
      assert.ok(client instanceof Octokit);
      assert.equal(yield* github.cached, client);
      assert.equal(requests.length, 1);
      const response = yield* Effect.tryPromise(() =>
        client.request("GET /repos/owner/repo")
      );
      assert.equal(response.data.id, 900);
      assert.equal(
        requests[1].headers.get("authorization"),
        "token synthetic-installation-token",
      );
      assert.equal(requests.length, 2);
      yield* TestClock.adjust("59 minutes");
      assert.equal(yield* github.cached, undefined);
      assert.equal(requests.length, 2);
      expiresAt = DateTime.formatIso(
        DateTime.add(yield* DateTime.now, { hours: 1 }),
      );
      assert.notEqual(yield* github.authenticate(), client);
      assert.equal(requests.length, 3);
      yield* github.invalidate;
      assert.equal(yield* github.cached, undefined);
    }).pipe(
      Effect.provide(GitHubClient.layer),
      Effect.provide(config),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provide(TestClock.layer()),
    ),
  );
});

Deno.test("GitHubClient authentication cancellation aborts the exchange and cannot populate its cache", async () => {
  let aborted = false;
  await Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHubClient;
      const started = yield* Deferred.make<void>();
      const fetch: typeof globalThis.fetch = (_input, init) => {
        assert.ok(init?.signal);
        return new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("synthetic cancellation"));
          });
          Effect.runSync(Deferred.succeed(started, undefined));
        });
      };
      const authenticating = yield* github.authenticate({ fetch }).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(authenticating);
      assert.equal(aborted, true);
      assert.equal(yield* github.cached, undefined);
    }).pipe(
      Effect.provide(GitHubClient.layer),
      Effect.provide(config),
      Effect.scoped,
    ),
  );
});
