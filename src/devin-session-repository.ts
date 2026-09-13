import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { AppConfig } from "./config.ts";
import { DatabaseClient, DatabaseError } from "./database.ts";
import { observe } from "./logging.ts";
import type { SessionState } from "./devin.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";

export type SessionRecord = typeof devinSessions.$inferSelect;
export type DeliveryRecord = typeof githubWebhookDeliveries.$inferSelect;
export type SessionWork = {
  readonly session: SessionRecord;
  readonly delivery: DeliveryRecord;
};
export type RunningSession = SessionWork & {
  readonly session: SessionRecord & { readonly devinSessionId: string };
};

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const databaseError = (cause: unknown) => new DatabaseError({ cause });
const observeClaim =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>, claim: SessionRecord) =>
    effect.pipe(
      observe("DevinSessionRepository", operation),
      Effect.annotateLogs({
        session_record_id: claim.id,
        github_delivery_id: claim.githubDeliveryId,
        devin_session_id: claim.devinSessionId,
        attempt: claim.attempts,
        claim_version: claim.claimVersion,
      }),
    );
const ownsClaim = (claim: SessionRecord) =>
  and(
    eq(devinSessions.id, claim.id),
    eq(devinSessions.status, "submitting"),
    eq(devinSessions.attempts, claim.attempts),
    eq(devinSessions.claimVersion, claim.claimVersion),
    isNull(devinSessions.devinSessionId),
  );

export class DevinSessionRepository extends Context.Service<
  DevinSessionRepository,
  {
    readonly claimPending: Effect.Effect<
      ReadonlyArray<SessionWork>,
      DatabaseError
    >;
    readonly claimStale: Effect.Effect<
      ReadonlyArray<SessionWork>,
      DatabaseError
    >;
    readonly recordRecoveryMiss: (
      claim: SessionRecord,
      outcome: "empty" | "unavailable" | "duplicates",
    ) => Effect.Effect<ReadonlyArray<SessionRecord>, DatabaseError>;
    readonly findRunning: Effect.Effect<
      ReadonlyArray<RunningSession>,
      DatabaseError
    >;
    readonly markRunning: (
      claim: SessionRecord,
      devinSessionId: string,
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly markSkipped: (
      claim: SessionRecord,
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly rejectSubmission: (
      claim: SessionRecord,
      retryable: boolean,
    ) => Effect.Effect<ReadonlyArray<SessionRecord>, DatabaseError>;
    readonly finish: (
      work: RunningSession,
      state: Extract<SessionState, { status: "succeeded" | "failed" }>,
      prNumber: number | null,
    ) => Effect.Effect<boolean, DatabaseError>;
  }
>()("devin-remediator/DevinSessionRepository") {
  static readonly layer = Layer.effect(
    DevinSessionRepository,
    Effect.gen(function* () {
      const { db } = yield* DatabaseClient;
      const config = yield* AppConfig;

      const claimPending = db.transaction((tx) =>
        Effect.gen(function* () {
          const updatedAt = yield* nowIso;
          yield* tx.update(devinSessions).set({
            status: "failed",
            output: {
              outcome: "failed",
              summary: "Submission attempts exhausted before session creation.",
            },
            updatedAt,
          })
            .where(and(
              eq(devinSessions.status, "pending"),
              gte(devinSessions.attempts, config.devinMaxAttempts),
            ));
          const [active] = yield* tx.select({ count: count() })
            .from(devinSessions).where(
              inArray(devinSessions.status, ["submitting", "running"]),
            );
          const capacity = Math.max(
            0,
            config.devinMaxConcurrentSessions - active.count,
          );
          yield* Effect.logDebug("queue.capacity").pipe(Effect.annotateLogs({
            active_sessions: active.count,
            available_slots: capacity,
            max_concurrent_sessions: config.devinMaxConcurrentSessions,
          }));
          if (capacity === 0) return [];

          const pending = yield* tx.select({ id: devinSessions.id })
            .from(devinSessions).where(and(
              eq(devinSessions.status, "pending"),
              isNull(devinSessions.devinSessionId),
              lt(devinSessions.attempts, config.devinMaxAttempts),
            )).orderBy(asc(devinSessions.insertedAt), asc(devinSessions.id))
            .limit(capacity);
          if (pending.length === 0) return [];

          const claimed = yield* tx.update(devinSessions).set({
            status: "submitting",
            attempts: sql`${devinSessions.attempts} + 1`,
            claimVersion: sql`${devinSessions.claimVersion} + 1`,
            recoveryEmptyChecks: 0,
            updatedAt,
          }).where(and(
            inArray(devinSessions.id, pending.map((row) => row.id)),
            eq(devinSessions.status, "pending"),
            isNull(devinSessions.devinSessionId),
          )).returning({ id: devinSessions.id });

          return yield* tx.select({
            session: devinSessions,
            delivery: githubWebhookDeliveries,
          }).from(devinSessions).innerJoin(
            githubWebhookDeliveries,
            eq(
              devinSessions.githubDeliveryId,
              githubWebhookDeliveries.deliveryId,
            ),
          ).where(inArray(devinSessions.id, claimed.map((row) => row.id)))
            .orderBy(asc(devinSessions.insertedAt), asc(devinSessions.id));
        })
      ).pipe(
        Effect.mapError(databaseError),
        Effect.tap((rows) =>
          Effect.logDebug("queue.claimed").pipe(
            Effect.annotateLogs({ claimed_count: rows.length }),
          )
        ),
        observe("DevinSessionRepository", "claimPending"),
      );

      const claimStale = db.transaction((tx) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const claimed = yield* tx.update(devinSessions).set({
            claimVersion: sql`${devinSessions.claimVersion} + 1`,
            updatedAt: DateTime.formatIso(now),
          }).where(and(
            eq(devinSessions.status, "submitting"),
            isNull(devinSessions.devinSessionId),
            eq(devinSessions.recoveryBlocked, false),
            lt(
              devinSessions.updatedAt,
              DateTime.formatIso(DateTime.subtract(now, {
                seconds: config.devinSubmittingTimeoutSeconds,
              })),
            ),
          )).returning({ id: devinSessions.id });
          if (claimed.length === 0) return [];
          return yield* tx.select({
            session: devinSessions,
            delivery: githubWebhookDeliveries,
          }).from(devinSessions).innerJoin(
            githubWebhookDeliveries,
            eq(
              devinSessions.githubDeliveryId,
              githubWebhookDeliveries.deliveryId,
            ),
          ).where(inArray(devinSessions.id, claimed.map((row) => row.id)));
        })
      ).pipe(
        Effect.mapError(databaseError),
        Effect.tap((rows) =>
          Effect.logDebug("queue.recovery_claimed").pipe(
            Effect.annotateLogs({ claimed_count: rows.length }),
          )
        ),
        observe("DevinSessionRepository", "claimStale"),
      );

      const recordRecoveryMiss = Effect.fn(
        "DevinSessionRepository.recordRecoveryMiss",
      )(
        function* (
          claim: SessionRecord,
          outcome: "empty" | "unavailable" | "duplicates",
        ) {
          const retry = outcome === "empty" && claim.recoveryEmptyChecks >= 1;
          const status = retry
            ? claim.attempts < config.devinMaxAttempts ? "pending" : "failed"
            : "submitting";
          return yield* db.update(devinSessions).set({
            claimVersion: sql`${devinSessions.claimVersion} + 1`,
            status,
            output: status === "failed"
              ? {
                outcome: "failed",
                summary:
                  "Submission attempts exhausted after repeated empty recovery lookups.",
              }
              : null,
            recoveryEmptyChecks: outcome === "empty"
              ? claim.recoveryEmptyChecks + 1
              : 0,
            recoveryBlocked: outcome === "duplicates",
            updatedAt: yield* nowIso,
          }).where(ownsClaim(claim)).returning();
        },
        Effect.mapError(databaseError),
        observeClaim("recordRecoveryMiss"),
      );

      const findRunning = db.select({
        session: devinSessions,
        delivery: githubWebhookDeliveries,
      }).from(devinSessions).innerJoin(
        githubWebhookDeliveries,
        eq(devinSessions.githubDeliveryId, githubWebhookDeliveries.deliveryId),
      ).where(eq(devinSessions.status, "running"))
        .orderBy(asc(devinSessions.insertedAt), asc(devinSessions.id)).pipe(
          Effect.map((rows) =>
            rows.flatMap(({ session, delivery }) =>
              session.devinSessionId === null ? [] : [{
                session: { ...session, devinSessionId: session.devinSessionId },
                delivery,
              }]
            )
          ),
          Effect.mapError(databaseError),
          observe("DevinSessionRepository", "findRunning"),
        );

      const markRunning = Effect.fn("DevinSessionRepository.markRunning")(
        function* (claim: SessionRecord, devinSessionId: string) {
          const rows = yield* db.update(devinSessions).set({
            status: "running",
            devinSessionId,
            updatedAt: yield* nowIso,
          }).where(ownsClaim(claim)).returning({ id: devinSessions.id });
          yield* Effect.logDebug("session.transition").pipe(
            Effect.annotateLogs({
              status: "running",
              changed: rows.length === 1,
              devin_session_id: devinSessionId,
            }),
          );
          return rows.length === 1;
        },
        Effect.mapError(databaseError),
        observeClaim("markRunning"),
      );

      const markSkipped = Effect.fn("DevinSessionRepository.markSkipped")(
        function* (claim: SessionRecord) {
          const rows = yield* db.update(devinSessions).set({
            status: "skipped",
            updatedAt: yield* nowIso,
          }).where(ownsClaim(claim)).returning({ id: devinSessions.id });
          yield* Effect.logDebug("session.transition").pipe(
            Effect.annotateLogs({
              status: "skipped",
              changed: rows.length === 1,
            }),
          );
          return rows.length === 1;
        },
        Effect.mapError(databaseError),
        observeClaim("markSkipped"),
      );

      const rejectSubmission = Effect.fn(
        "DevinSessionRepository.rejectSubmission",
      )(
        function* (claim: SessionRecord, retryable: boolean) {
          const status = retryable && claim.attempts < config.devinMaxAttempts
            ? "pending"
            : "failed";
          return yield* db.update(devinSessions).set({
            status,
            output: status === "failed"
              ? {
                outcome: "failed",
                summary: retryable
                  ? "Submission rejected; retry attempts exhausted."
                  : "Submission permanently rejected before session creation.",
              }
              : null,
            updatedAt: yield* nowIso,
          }).where(ownsClaim(claim)).returning();
        },
        Effect.mapError(databaseError),
        observeClaim("rejectSubmission"),
      );

      const finish = Effect.fn("DevinSessionRepository.finish")(
        function* (
          work: RunningSession,
          state: Extract<SessionState, { status: "succeeded" | "failed" }>,
          prNumber: number | null,
        ) {
          const rows = yield* db.update(devinSessions).set({
            status: state.status,
            output: state.output,
            prNumber,
            updatedAt: yield* nowIso,
          }).where(and(
            eq(devinSessions.id, work.session.id),
            eq(devinSessions.status, "running"),
            eq(devinSessions.devinSessionId, work.session.devinSessionId),
          )).returning({ id: devinSessions.id });
          yield* Effect.logDebug("session.transition").pipe(
            Effect.annotateLogs({
              status: state.status,
              outcome: state.output.outcome,
              pr_number: prNumber,
              changed: rows.length === 1,
            }),
          );
          return rows.length === 1;
        },
        Effect.mapError(databaseError),
        (effect, work) => observeClaim("finish")(effect, work.session),
      );

      return DevinSessionRepository.of({
        claimPending,
        claimStale,
        recordRecoveryMiss,
        findRunning,
        markRunning,
        markSkipped,
        rejectSubmission,
        finish,
      });
    }),
  );
}
