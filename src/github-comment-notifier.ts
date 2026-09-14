import { and, asc, count, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Random, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AppConfig } from "./config.ts";
import { GitHubClient } from "./github.ts";
import { DatabaseClient, DatabaseError } from "./database.ts";
import {
  attentionNotifications as notifications,
  githubNotificationGate as gate,
} from "./schemas.ts";

const leaseMs = 60000;
const spacingMs = 3000;
const graceMs = 60000;
const positiveId = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Comment = Schema.Struct({
  id: positiveId,
  body: Schema.String,
  performed_via_github_app: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: positiveId })),
  ),
});
const Target = Schema.Struct({
  repo: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/),
  ),
  issueNumber: positiveId,
});
const RemoteId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const epoch = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
type Notification = typeof notifications.$inferSelect;
type Action = "token" | "post" | "lookup";
type Claim = {
  readonly row: Notification;
  readonly gateVersion: number;
  readonly action: Action;
};
type Outcome =
  | { readonly kind: "token"; readonly cooldown: number }
  | {
    readonly kind: "receipt";
    readonly commentId: number;
    readonly cooldown: number;
  }
  | {
    readonly kind: "page";
    readonly nextPage: number | null;
    readonly matches: ReadonlyArray<number>;
    readonly unverified: boolean;
    readonly cooldown: number;
  }
  | {
    readonly kind: "retry";
    readonly failure: "http" | "unavailable";
    readonly cooldown: number;
    readonly httpStatus: number;
    readonly rateLimited: boolean;
  };
const marker = (row: Notification) => `<!-- devin-attention:${row.id} -->`;
const render = (row: Notification): string | null => {
  if (!Schema.is(RemoteId)(row.remoteId)) return null;
  const url = `https://app.devin.ai/sessions/${row.remoteId}`;
  if (row.sessionUrl !== url) return null;
  if (row.reason === "session_started") {
    return `Devin has picked up this issue. [Follow the session](${url}).\n\n${
      marker(row)
    }`;
  }
  const direction = row.reason === "needs_input"
    ? "awaiting input. Review its current state and respond"
    : "awaiting approval. Review its current state and approve or decline";
  return `Devin was observed ${direction} in [the authenticated Devin session](${url}). GitHub replies are not forwarded.\n\n${
    marker(row)
  }`;
};
const commentPath = (row: Notification) =>
  `/repos/${row.repo}/issues/${row.issueNumber}/comments`;
const nextPage = (link: string | null, row: Notification): number | null => {
  if (!link) return null;
  let next: number | null = null;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="([a-z]+)"\s*$/.exec(part);
    if (!match) throw new Error("Invalid pagination");
    const url = new URL(match[1]);
    if (
      url.origin !== "https://api.github.com" || url.username || url.password ||
      url.hash ||
      url.pathname !== commentPath(row) ||
      url.searchParams.get("per_page") !== "100" ||
      [...url.searchParams.keys()].some((key) =>
        key !== "page" && key !== "per_page"
      )
    ) throw new Error("Unsafe pagination");
    const page = Number(url.searchParams.get("page"));
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error("Invalid page");
    }
    if (match[2] === "next") {
      if (next !== null || page !== row.scanPage + 1) {
        throw new Error("Nonadvancing page");
      }
      next = page;
    }
  }
  return next;
};
const cooldownUntil = (headers: Headers, status: number, now: number) => {
  let until = now + spacingMs;
  const retry = headers.get("retry-after");
  if (retry !== null) {
    const seconds = Number(retry);
    const parsed = Number.isFinite(seconds)
      ? now + Math.max(0, seconds) * 1000
      : Date.parse(retry);
    if (Number.isFinite(parsed)) until = Math.max(until, parsed);
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset)) until = Math.max(until, reset * 1000 + 1000);
  }
  if ([401, 403, 404, 422].includes(status)) {
    until = Math.max(until, now + 15 * 60000);
  }
  if (status === 429) until = Math.max(until, now + 60000);
  return Math.ceil(until);
};
export class GitHubCommentNotifier
  extends Context.Service<GitHubCommentNotifier, {
    readonly tick: Effect.Effect<void, DatabaseError>;
  }>()("devin-remediator/GitHubCommentNotifier") {
  static readonly layer = Layer.effect(
    GitHubCommentNotifier,
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const { githubApp } = yield* AppConfig;
      const github = yield* GitHubClient;
      if (githubApp === null) {
        yield* Effect.logWarning("attention.delivery_disabled");
      }

      const claim = db.transaction((tx) =>
        Effect.gen(function* () {
          const now = yield* epoch;
          const [report] = yield* tx.update(gate).set({
            nextReportAt: now + 5 * 60000,
          })
            .where(and(eq(gate.id, 1), lte(gate.nextReportAt, now)))
            .returning();
          if (report) {
            const backlog = yield* tx.select({
              status: notifications.status,
              count: count(),
            })
              .from(notifications).where(
                sql`${notifications.status} IN ('pending', 'blocked')`,
              ).groupBy(notifications.status);
            if (backlog.length > 0) {
              yield* Effect.logInfo("attention.backlog").pipe(
                Effect.annotateLogs({
                  delivery_enabled: githubApp !== null,
                  pending: backlog.find((row) =>
                    row.status === "pending"
                  )?.count ?? 0,
                  blocked: backlog.find((row) =>
                    row.status === "blocked"
                  )?.count ?? 0,
                }),
              );
            }
          }
          if (githubApp === null) return;
          const [available] = yield* tx.select().from(gate).where(
            and(
              eq(gate.id, 1),
              lte(gate.nextRequestAt, now),
              lte(gate.leaseUntil, now),
            ),
          );
          if (!available) return;
          const [row] = yield* tx.select().from(notifications).where(and(
            eq(notifications.status, "pending"),
            lte(notifications.dueAt, now),
            lte(notifications.leaseUntil, now),
          )).orderBy(asc(notifications.dueAt), asc(notifications.id)).limit(1);
          if (!row) return;
          if (row.closedAt !== null && row.possibleSendAt === null) {
            yield* tx.update(notifications).set({ status: "cancelled" }).where(
              eq(notifications.id, row.id),
            );
            return;
          }
          const target = Schema.is(Target)({
            repo: row.repo,
            issueNumber: row.issueNumber,
          });
          const body = row.body ?? render(row);
          const changedOwner = row.possibleSendAt !== null &&
            (row.expectedAppId !== githubApp.appId ||
              row.expectedInstallationId !== githubApp.installationId);
          if (!target || body === null || changedOwner) {
            const failure = changedOwner
              ? "ownership_changed"
              : target
              ? "unsafe_link"
              : "invalid_target";
            yield* tx.update(notifications).set({
              status: "blocked",
              lastFailure: failure,
            }).where(eq(notifications.id, row.id));
            yield* Effect.logWarning("attention.target_blocked").pipe(
              Effect.annotateLogs({ reason: failure }),
            );
            return;
          }
          const action: Action = (yield* github.cached) === undefined
            ? "token"
            : row.possibleSendAt !== null &&
                (row.negativeScans < 2 || row.closedAt !== null)
            ? "lookup"
            : "post";
          const [claimedGate] = yield* tx.update(gate).set({
            version: available.version + 1,
            leaseUntil: now + leaseMs,
            nextRequestAt: now + spacingMs,
          })
            .where(eq(gate.id, 1)).returning();
          const [claimed] = yield* tx.update(notifications).set({
            body,
            version: row.version + 1,
            leaseUntil: now + leaseMs,
            ...(action === "post"
              ? {
                possibleSendAt: row.possibleSendAt ?? now,
                expectedAppId: row.expectedAppId ?? githubApp.appId,
                expectedInstallationId: row.expectedInstallationId ??
                  githubApp.installationId,
                negativeScans: 0,
                scanPage: 1,
                scanMatches: 0,
                scanUnverified: false,
                commentId: null,
              }
              : {}),
          }).where(eq(notifications.id, row.id)).returning();
          return {
            row: claimed,
            gateVersion: claimedGate.version,
            action,
          } satisfies Claim;
        })
      ).pipe(Effect.mapError((cause) => new DatabaseError({ cause })));

      const request = Effect.fnUntraced(
        function* (claim: Claim): Effect.fn.Return<Outcome> {
          const fetch = yield* FetchHttpClient.Fetch;
          let headers = new Headers();
          let status = 0;
          let requests = 0;
          const { row, action } = claim;
          const app = githubApp;
          const result = yield* Effect.gen(function* () {
            if (!app) return yield* Effect.fail(undefined);
            const path = action === "token"
              ? `/app/installations/${app.installationId}/access_tokens`
              : commentPath(row);
            const guardedFetch: typeof globalThis.fetch = async (
              input,
              init,
            ) => {
              const url = new URL(
                input instanceof Request ? input.url : input.toString(),
              );
              if (
                ++requests > 1 || url.origin !== "https://api.github.com" ||
                url.pathname !== path || url.username || url.password ||
                url.hash
              ) throw new Error("Unsafe request");
              const response = await fetch(input, {
                ...init,
                redirect: "error",
              });
              headers = response.headers;
              status = response.status;
              return response;
            };
            if (action === "token") {
              yield* github.authenticate({ fetch: guardedFetch });
              return { kind: "token" } as const;
            }
            const octokit = yield* github.cached;
            if (!octokit) return yield* Effect.fail(undefined);
            return yield* Effect.tryPromise({
              try: async (signal) => {
                const response = await octokit.request(
                  action === "post" ? `POST ${path}` : `GET ${path}`,
                  {
                    ...(action === "post"
                      ? { body: row.body }
                      : { per_page: 100, page: row.scanPage }),
                    headers: {
                      accept: "application/vnd.github+json",
                      "x-github-api-version": "2022-11-28",
                    },
                    request: { fetch: guardedFetch, signal },
                  },
                );
                if (action === "post") {
                  const comment = Schema.decodeUnknownSync(Comment)(
                    response.data,
                  );
                  if (status !== 201 || comment.body !== row.body) {
                    throw new Error("Invalid receipt");
                  }
                  return { kind: "receipt", commentId: comment.id } as const;
                }
                if (status !== 200) throw new Error("Invalid page status");
                const comments = Schema.decodeUnknownSync(
                  Schema.Array(Comment),
                )(response.data);
                const matching = comments.filter((comment) =>
                  comment.body.includes(marker(row))
                );
                return {
                  kind: "page",
                  nextPage: nextPage(headers.get("link"), row),
                  matches: [
                    ...new Set(
                      matching.filter((comment) =>
                        comment.performed_via_github_app?.id ===
                          row.expectedAppId
                      ).map((comment) => comment.id),
                    ),
                  ],
                  unverified: matching.some((comment) =>
                    comment.performed_via_github_app?.id !== row.expectedAppId
                  ),
                } as const;
              },
              catch: () => undefined,
            });
          }).pipe(Effect.timeout("10 seconds"), Effect.result);
          const now = yield* epoch;
          const cooldown = cooldownUntil(headers, status, now);
          if (result._tag === "Failure") {
            return {
              kind: "retry",
              failure: status >= 400 ? "http" : "unavailable",
              cooldown,
              httpStatus: status,
              rateLimited: status === 429 ||
                (status === 403 &&
                  (headers.has("retry-after") ||
                    headers.get("x-ratelimit-remaining") === "0")),
            };
          }
          return { ...result.success, cooldown };
        },
      );

      const finish = Effect.fnUntraced(
        function* (claim: Claim, outcome: Outcome) {
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const now = yield* epoch;
              const [ownedGate] = yield* tx.select().from(gate).where(
                and(
                  eq(gate.id, 1),
                  eq(gate.version, claim.gateVersion),
                  gt(gate.leaseUntil, now),
                ),
              );
              const [current] = yield* tx.select().from(notifications).where(
                and(
                  eq(notifications.id, claim.row.id),
                  eq(notifications.version, claim.row.version),
                  gt(notifications.leaseUntil, now),
                ),
              );
              if (!ownedGate || !current) return;
              const changes: Partial<typeof notifications.$inferInsert> = {
                leaseUntil: 0,
                dueAt: now,
                lastFailure: null,
              };
              if (outcome.kind === "receipt") {
                changes.status = "delivered";
                changes.commentId = outcome.commentId;
              } else if (outcome.kind === "retry") {
                if (outcome.httpStatus === 401) yield* github.invalidate;
                const jitter = 0.8 + (yield* Random.next) * 0.4;
                changes.attempts = current.attempts + 1;
                changes.dueAt = Math.ceil(
                  Math.max(
                    outcome.cooldown,
                    now +
                      Math.min(
                        3600000,
                        60000 * 2 ** Math.min(current.attempts, 6) * jitter,
                      ),
                  ),
                );
                changes.lastFailure = outcome.failure;
                if (
                  claim.action === "lookup" &&
                  !outcome.rateLimited &&
                  [401, 403, 404].includes(outcome.httpStatus)
                ) {
                  changes.status = "blocked";
                  changes.lastFailure = "inaccessible";
                }
                yield* Effect.logWarning("attention.delivery_retry").pipe(
                  Effect.annotateLogs({
                    reason: changes.lastFailure,
                    attempt: changes.attempts,
                    retry_at_ms: changes.dueAt,
                  }),
                );
              } else if (outcome.kind === "page") {
                const matches = current.scanMatches +
                  outcome.matches.filter((id) => id !== current.commentId)
                    .length;
                changes.scanMatches = matches;
                changes.scanUnverified = current.scanUnverified ||
                  outcome.unverified;
                changes.commentId = current.commentId ?? outcome.matches[0] ??
                  null;
                if (outcome.nextPage !== null) {
                  changes.scanPage = outcome.nextPage;
                } else if (matches > 0) {
                  changes.status = "delivered";
                  if (matches > 1) {
                    changes.lastFailure = "duplicates";
                    yield* Effect.logError("attention.duplicate_comments").pipe(
                      Effect.annotateLogs({ match_count: matches }),
                    );
                  }
                } else if (changes.scanUnverified) {
                  changes.status = "blocked";
                  changes.lastFailure = "unverified_attribution";
                  yield* Effect.logWarning("attention.recovery_blocked").pipe(
                    Effect.annotateLogs({ reason: changes.lastFailure }),
                  );
                } else if (current.closedAt !== null) {
                  changes.status = "cancelled";
                } else {
                  changes.negativeScans = Math.min(
                    2,
                    current.negativeScans + 1,
                  );
                  changes.scanPage = 1;
                  changes.dueAt = now + graceMs;
                  if (changes.negativeScans === 2) {
                    yield* Effect.logWarning(
                      "attention.ambiguous_retry_duplicate_risk",
                    );
                  }
                }
              }
              yield* tx.update(notifications).set(changes).where(
                eq(notifications.id, current.id),
              );
              yield* tx.update(gate).set({
                leaseUntil: 0,
                nextRequestAt: Math.max(
                  ownedGate.nextRequestAt,
                  outcome.cooldown,
                  now + spacingMs,
                ),
              }).where(eq(gate.id, 1));
            })
          ).pipe(Effect.mapError((cause) => new DatabaseError({ cause })));
        },
      );
      const tick = Effect.gen(function* () {
        const work = yield* claim;
        if (!work) return;
        // A process can stall after committing its claim. Check again before HTTP.
        const owned = yield* db.transaction((tx) =>
          Effect.gen(function* () {
            const now = yield* epoch;
            const [row] = yield* tx.select({ id: notifications.id }).from(
              notifications,
            ).where(and(
              eq(notifications.id, work.row.id),
              eq(notifications.version, work.row.version),
              gt(notifications.leaseUntil, now),
              work.action === "post"
                ? isNull(notifications.closedAt)
                : undefined,
            ));
            const [slot] = yield* tx.select({ id: gate.id }).from(gate).where(
              and(
                eq(gate.id, 1),
                eq(gate.version, work.gateVersion),
                gt(gate.leaseUntil, now),
              ),
            );
            return row !== undefined && slot !== undefined;
          })
        ).pipe(Effect.mapError((cause) => new DatabaseError({ cause })));
        if (owned) yield* finish(work, yield* request(work));
      });
      return GitHubCommentNotifier.of({ tick });
    }),
  );
}
