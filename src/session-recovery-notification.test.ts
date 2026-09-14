import { strict as assert } from "node:assert";
import { ConfigProvider, DateTime, Effect, Layer, Logger } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";
import { DatabaseClient } from "./database.ts";
import { SessionAdministration } from "./session-administration.ts";
import { GitHubCommentNotifier } from "./github-comment-notifier.ts";
import { GitHubClient } from "./github.ts";
import { attentionNotifications } from "./schemas.ts";
import { seedRecovery } from "../test/fixtures/session-recovery.ts";
import { githubAppEnv } from "../test/fixtures/github-app.ts";
for (const receipt of [false, true]) {
  Deno.test(`session recovery: local resolution reconciles historical send without repost (receipt ${receipt})`, async () => {
    const directory = await Deno.makeTempDir();
    const requests: string[] = [];
    const body = "synthetic body <!-- devin-attention:notice -->";
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { db } = yield* DatabaseClient;
          const admin = yield* SessionAdministration;
          const notifier = yield* GitHubCommentNotifier;
          yield* seedRecovery(db);
          yield* db.insert(attentionNotifications).values({
            id: "unsent",
            sessionRecordId: "one",
            sequence: 1,
            reason: "needs_input",
            repo: "owner/repo",
          });
          yield* db.insert(attentionNotifications).values({
            id: "notice",
            sessionRecordId: "one",
            sequence: 2,
            reason: "needs_input",
            repo: "owner/repo",
            issueNumber: 123,
            remoteId: "remote-one",
            sessionUrl: "https://app.devin.ai/sessions/remote-one",
            body,
            possibleSendAt: 1,
            expectedAppId: 101,
            expectedInstallationId: 202,
            negativeScans: 2,
            leaseUntil: DateTime.toEpochMillis(yield* DateTime.now) + 60000,
          });
          const busy = yield* admin.execute({
            id: "one",
            action: "resolve",
            revision: (yield* admin.inspect("one")).revision,
            reason: "synthetic local decision",
          }).pipe(Effect.result);
          assert.equal(busy._tag, "Failure");
          if (busy._tag === "Failure") {
            assert.equal(
              "code" in busy.failure ? busy.failure.code : null,
              "busy",
            );
          }
          yield* TestClock.adjust("61 seconds");
          yield* admin.execute({
            id: "one",
            action: "resolve",
            revision: (yield* admin.inspect("one")).revision,
            reason: "synthetic local decision",
          });
          yield* notifier.tick;
          yield* TestClock.adjust("3 seconds");
          yield* notifier.tick;
          yield* TestClock.adjust("2 hours");
          yield* notifier.tick;
          const rows = yield* db.select().from(attentionNotifications);
          const notice = rows.find((r) => r.id === "notice")!;
          assert.equal(
            rows.find((r) => r.id === "unsent")!.status,
            "cancelled",
          );
          assert.equal(notice.status, receipt ? "delivered" : "cancelled");
          assert.equal(notice.commentId, receipt ? 900 : null);
          assert.equal(notice.expectedAppId, 101);
          assert.equal(notice.expectedInstallationId, 202);
          assert.equal(notice.possibleSendAt, 1);
          assert.equal(notice.body, body);
          assert.ok(notice.closedAt !== null);
          assert.deepEqual(requests, [
            "POST /app/installations/202/access_tokens",
            "GET /repos/owner/repo/issues/123/comments",
          ]);
        }).pipe(
          Effect.provide(
            Layer.merge(
              SessionAdministration.layer(),
              GitHubCommentNotifier.layer,
            ).pipe(
              Layer.provide(GitHubClient.layer),
              Layer.provideMerge(
                DatabaseClient.layerWithPath(
                  `${directory}/notifications.sqlite`,
                ),
              ),
            ),
          ),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                DEVIN_API_KEY: "synthetic",
                DEVIN_ORGANIZATION_ID: "org-test",
                GITHUB_WEBHOOK_SECRET: "synthetic",
                ...githubAppEnv,
              }),
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, (input, init) => {
            const url = new URL(String(input));
            const method = init?.method ?? "GET";
            requests.push(`${method} ${url.pathname}`);
            assert.equal(url.origin, "https://api.github.com");
            if (url.pathname.endsWith("/access_tokens")) {
              assert.equal(method, "POST");
              return Promise.resolve(
                Response.json({
                  token: "synthetic",
                  expires_at: "2099-01-01T00:00:00.000Z",
                  permissions: { issues: "write" },
                }, { status: 201 }),
              );
            }
            assert.equal(method, "GET");
            return Promise.resolve(Response.json(
              receipt
                ? [{ id: 900, body, performed_via_github_app: { id: 101 } }]
                : [],
            ));
          }),
          Effect.provide(TestClock.layer()),
          Effect.provide(Logger.layer([])),
          Effect.scoped,
        ),
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
}
