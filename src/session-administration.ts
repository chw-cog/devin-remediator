import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { type AppDatabase, DatabaseClient, DatabaseError } from "./database.ts";
import type { SessionDiagnostic } from "./devin.ts";
import type { SessionRecord } from "./devin-session-repository.ts";
import {
  attentionNotifications,
  devinSessions,
  sessionAdminEvents,
} from "./schemas.ts";
import { deliveryTag } from "./webhook-event-processors.ts";

export const localResolutionWarning =
  "LOCAL POLICY ONLY: remote execution is unchanged. No session is stopped, archived, messaged, or recreated. Analysis remains independent.";

export class SessionAdminError extends Schema.TaggedError<SessionAdminError>()(
  "SessionAdminError",
  {
    code: Schema.Literals([
      "not_found",
      "conflict",
      "busy",
      "invalid_action",
      "verification_failed",
      "identity_owned",
    ]),
  },
) {}

const Reason = Schema.String.check(
  Schema.isPattern(/\S/),
  Schema.isMaxLength(500),
);

export const SessionAdminRequest = Schema.Struct({
  id: Schema.NonEmptyString,
  action: Schema.Literals(["diagnose", "associate", "resolve", "resume"]),
  revision: Schema.optional(Schema.NonEmptyString),
  remoteId: Schema.optional(Schema.NonEmptyString),
  reason: Schema.optional(Reason),
});

export type SessionAdminRequest = typeof SessionAdminRequest.Type;

type DiagnosticGetter = (id: string) => Effect.Effect<SessionDiagnostic>;

type Transaction = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

type Snapshot = {
  session: SessionRecord;
  notifications: (typeof attentionNotifications.$inferSelect)[];
};

const revision = (snapshot: Snapshot) =>
  createHash("sha256")
    .update(JSON.stringify(snapshot)).digest("hex");

// Explicit allowlist: no raw status detail, URL, output, analysis, payload or reason.
const summary = (row: SessionRecord) => ({
  id: row.id,
  deliveryId: row.githubDeliveryId,
  remoteId: row.devinSessionId,
  status: row.status,
  localOwnership: row.localOwnership,
  providerLifecycle: row.providerLifecycle,
  activeWork: row.activeWork,
  isArchived: row.isArchived,
  lastObservedAt: row.lastObservedAt,
  nextObservationAt: row.nextObservationAt,
  nextRecoveryAt: row.nextRecoveryAt,
  observationLeaseUntil: row.observationLeaseUntil,
  attempts: row.attempts,
  recoveryBlocked: row.recoveryBlocked,
  recoveryCandidateIds: row.recoveryCandidateIds,
  lookupFailureStreak: row.lookupFailureStreak,
  lookupFailureCount: row.lookupFailureCount,
  firstLookupFailureAt: row.firstLookupFailureAt,
  lastLookupFailureAt: row.lastLookupFailureAt,
  lastLookupFailure: row.lastLookupFailure,
  reconciliationEscalatedAt: row.reconciliationEscalatedAt,
  analysisStatus: row.analysisStatus,
  updatedAt: row.updatedAt,
});

type SessionSummary = ReturnType<typeof summary>;

type Inspection = SessionSummary & {
  revision: string;
  events: ReadonlyArray<{
    id: number;
    action: string;
    remoteId: string | null;
    outcome: string;
    httpStatus: number | null;
    recordedAt: string;
    reasonRecorded: boolean;
  }>;
};

type AdminResult = { outcome: string; warning: string; session: Inspection };

const mapError = (cause: unknown) =>
  cause instanceof SessionAdminError ? cause : new DatabaseError({ cause });

export class SessionAdministration
  extends Context.Service<SessionAdministration, {
    readonly list: Effect.Effect<ReadonlyArray<SessionSummary>, DatabaseError>;
    readonly inspect: (
      id: string,
    ) => Effect.Effect<Inspection, DatabaseError | SessionAdminError>;
    readonly execute: (
      request: SessionAdminRequest,
      get?: DiagnosticGetter,
    ) => Effect.Effect<AdminResult, DatabaseError | SessionAdminError>;
  }>()("devin-remediator/SessionAdministration") {
  static layer(submissionGraceSeconds = 60) {
    return Layer.effect(
      SessionAdministration,
      Effect.gen(function* () {
        const { db } = yield* DatabaseClient;
        const snapshot = Effect.fnUntraced(
          function* (tx: Transaction, id: string) {
            const [session] = yield* tx.select().from(devinSessions).where(
              eq(devinSessions.id, id),
            );
            if (!session) {
              return yield* new SessionAdminError({ code: "not_found" });
            }
            const notifications = yield* tx.select().from(
              attentionNotifications,
            )
              .where(eq(attentionNotifications.sessionRecordId, id)).orderBy(
                asc(attentionNotifications.id),
              );
            return { session, notifications };
          },
        );
        const inspect = Effect.fn("SessionAdministration.inspect")(
          (id: string) =>
            db.transaction((tx) =>
              Effect.gen(function* () {
                const current = yield* snapshot(tx, id);
                const events = yield* tx.select({
                  id: sessionAdminEvents.id,
                  action: sessionAdminEvents.action,
                  remoteId: sessionAdminEvents.remoteId,
                  outcome: sessionAdminEvents.outcome,
                  httpStatus: sessionAdminEvents.httpStatus,
                  recordedAt: sessionAdminEvents.recordedAt,
                  reasonRecorded: sql<
                    boolean
                  >`${sessionAdminEvents.reason} IS NOT NULL`.mapWith(Boolean),
                }).from(sessionAdminEvents).where(
                  eq(sessionAdminEvents.sessionRecordId, id),
                )
                  .orderBy(asc(sessionAdminEvents.id));
                return {
                  ...summary(current.session),
                  revision: revision(current),
                  events,
                };
              })
            ),
          Effect.mapError(mapError),
        );
        const assertIdle = (current: Snapshot, now: DateTime.Utc) => {
          const row = current.session;
          const timestamp = DateTime.formatIso(now);
          // Submission has a timestamp/version grace, not a separately renewable lease.
          const submitting = row.status === "submitting" &&
            !row.recoveryBlocked &&
            row.localOwnership === "tracking" &&
            row.updatedAt > DateTime.formatIso(
                DateTime.subtract(now, {
                  seconds: Math.max(120, submissionGraceSeconds),
                }),
              );
          return submitting ||
              (row.observationLeaseUntil !== null &&
                row.observationLeaseUntil > timestamp) ||
              current.notifications.some((event) =>
                event.leaseUntil > DateTime.toEpochMillis(now)
              )
            ? Effect.fail(new SessionAdminError({ code: "busy" }))
            : Effect.void;
        };
        const execute = Effect.fn("SessionAdministration.execute")(
          function* (input: SessionAdminRequest, get?: DiagnosticGetter) {
            const request = yield* Schema.decodeUnknownEffect(
              SessionAdminRequest,
            )(input).pipe(
              Effect.mapError(() =>
                new SessionAdminError({ code: "invalid_action" })
              ),
            );
            const mutation = request.action !== "diagnose";
            if (
              mutation && (!request.revision || !request.reason) ||
              request.action === "associate" && !request.remoteId ||
              (request.action === "resolve" || request.action === "resume") &&
                request.remoteId !== undefined
            ) {
              return yield* new SessionAdminError({ code: "invalid_action" });
            }
            const before = yield* db.transaction((tx) =>
              snapshot(tx, request.id)
            );
            if (
              request.revision !== undefined &&
              request.revision !== revision(before)
            ) {
              return yield* new SessionAdminError({ code: "conflict" });
            }
            if (mutation) yield* assertIdle(before, yield* DateTime.now);
            const row = before.session;
            const remoteId = request.remoteId ?? row.devinSessionId;
            if (
              request.action === "associate" && row.devinSessionId !== null &&
              row.devinSessionId !== remoteId
            ) {
              return yield* new SessionAdminError({ code: "conflict" });
            }
            if (
              request.action === "associate" &&
                !["submitting", "submitted"].includes(row.status) ||
              request.action === "resume" && row.devinSessionId === null
            ) {
              return yield* new SessionAdminError({ code: "invalid_action" });
            }
            let diagnostic: SessionDiagnostic | undefined;
            if (request.action !== "resolve") {
              if (!remoteId || !get) {
                return yield* new SessionAdminError({ code: "invalid_action" });
              }
              diagnostic = yield* get(remoteId);
            }
            const verified = diagnostic?.outcome === "found" &&
              diagnostic.session.session_id === remoteId &&
              diagnostic.session.tags.includes(
                deliveryTag(row.githubDeliveryId),
              );
            const outcome = diagnostic?.outcome === "found" && !verified
              ? "tag_mismatch"
              : diagnostic?.outcome ?? "resolved";
            // Persist failed verification as safe diagnostic evidence, but never associate it.
            const rejected = mutation && request.action !== "resolve" &&
              !verified;
            yield* db.transaction((tx) =>
              Effect.gen(function* () {
                const current = yield* snapshot(tx, request.id);
                if (revision(current) !== revision(before)) {
                  return yield* new SessionAdminError({ code: "conflict" });
                }
                const now = yield* DateTime.now;
                if (mutation) yield* assertIdle(current, now);
                if (!rejected && request.action === "associate") {
                  const [owner] = yield* tx.select({ id: devinSessions.id })
                    .from(devinSessions)
                    .where(eq(devinSessions.devinSessionId, remoteId!));
                  if (
                    owner && owner.id !== row.id
                  ) {
                    return yield* new SessionAdminError({
                      code: "identity_owned",
                    });
                  }
                }
                yield* tx.insert(sessionAdminEvents).values({
                  sessionRecordId: row.id,
                  action: request.action,
                  reason: request.reason ?? null,
                  remoteId,
                  outcome,
                  httpStatus: diagnostic?.httpStatus ?? null,
                  recordedAt: DateTime.formatIso(now),
                });
                yield* tx.update(devinSessions).set({
                  adminVersion: sql`${devinSessions.adminVersion} + 1`,
                  ...(!mutation || rejected ? {} : {
                    localOwnership: request.action === "resolve"
                      ? "released" as const
                      : "tracking" as const,
                    recoveryBlocked: true,
                    claimVersion: sql`${devinSessions.claimVersion} + 1`,
                    observationVersion:
                      sql`${devinSessions.observationVersion} + 1`,
                    observationLeaseUntil: null,
                    updatedAt: DateTime.formatIso(now),
                    ...(request.action === "resolve" ? {} : {
                      status: "submitted" as const,
                      devinSessionId: remoteId,
                      nextObservationAt: DateTime.formatIso(now),
                    }),
                  }),
                }).where(eq(devinSessions.id, row.id));
                if (request.action === "resolve") {
                  // Preserve possible-send receipts/ownership; closedAt makes recovery read-only.
                  yield* tx.update(attentionNotifications).set({
                    closedAt: DateTime.toEpochMillis(now),
                    version: sql`${attentionNotifications.version} + 1`,
                    status:
                      sql`CASE WHEN ${attentionNotifications.possibleSendAt} IS NULL AND ${attentionNotifications.status} IN ('pending', 'blocked') THEN 'cancelled' ELSE ${attentionNotifications.status} END`,
                  }).where(
                    and(
                      eq(attentionNotifications.sessionRecordId, row.id),
                      isNull(attentionNotifications.closedAt),
                    ),
                  );
                }
              })
            );
            if (rejected) {
              return yield* new SessionAdminError({
                code: "verification_failed",
              });
            }
            return {
              outcome,
              warning: localResolutionWarning,
              session: yield* inspect(row.id),
            };
          },
          Effect.mapError(mapError),
        );
        return SessionAdministration.of({
          list: db.select().from(devinSessions).orderBy(
            asc(devinSessions.insertedAt),
            asc(devinSessions.id),
          ).pipe(
            Effect.map((rows) => rows.map(summary)),
            Effect.mapError((cause) => new DatabaseError({ cause })),
          ),
          inspect,
          execute,
        });
      }),
    );
  }
}
