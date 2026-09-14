import {
  and,
  asc,
  count,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { Context, DateTime, Effect, Layer } from "effect";
import { AppConfig } from "./config.ts";
import { DatabaseClient, DatabaseError } from "./database.ts";
import { observe } from "./logging.ts";
import {
  type LookupFailure,
  lookupFailureUpdate,
} from "./session-reconciliation.ts";
import {
  continuationWindowElapsed,
  type DevinSession,
  findPullRequestNumber,
  interpretSession,
  type ProviderLifecycle,
  type SessionAnalysis,
  sessionBatchSize,
} from "./devin.ts";
import {
  normalizedRemediationOutput,
  type RemediationOutput,
} from "./remediation-output.ts";
import {
  attentionNotifications,
  devinSessions,
  githubWebhookDeliveries,
} from "./schemas.ts";
import type { AppDatabase } from "./database.ts";

export type SessionRecord = typeof devinSessions.$inferSelect;
export type DeliveryRecord = typeof githubWebhookDeliveries.$inferSelect;
export type SessionWork = {
  readonly session: SessionRecord;
  readonly delivery: DeliveryRecord;
};
export type ObservationClaim = SessionWork & {
  readonly session: SessionRecord & { readonly devinSessionId: string };
};
export type AnalysisClaim = SessionRecord & { readonly devinSessionId: string };
export const analysisBatchSize = 3;

export type AnalysisResult =
  | { readonly status: "collected"; readonly analysis: SessionAnalysis }
  | {
    readonly status: "pending" | "unavailable";
    readonly reason: string;
  };

const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const appendOutput = (output: RemediationOutput) =>
  sql`json_insert(${devinSessions.outputs}, '$[#]', json(${
    JSON.stringify(output)
  }))`;
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
    eq(devinSessions.localOwnership, "tracking"),
    eq(devinSessions.recoveryBlocked, false),
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
      candidateIds?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<SessionRecord>, DatabaseError>;
    readonly claimDueObservations: (
      after?: Pick<SessionRecord, "insertedAt" | "id">,
    ) => Effect.Effect<
      ReadonlyArray<ObservationClaim>,
      DatabaseError
    >;
    readonly markSubmitted: (
      claim: SessionRecord,
      devinSessionId: string,
      observation?: DevinSession,
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly markSkipped: (
      claim: SessionRecord,
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly rejectSubmission: (
      claim: SessionRecord,
      retryable: boolean,
    ) => Effect.Effect<ReadonlyArray<SessionRecord>, DatabaseError>;
    readonly recordObservation: (
      claim: ObservationClaim,
      observation: DevinSession,
    ) => Effect.Effect<boolean, DatabaseError>;
    readonly recordLookupFailure: (
      claim: ObservationClaim,
      outcome: LookupFailure,
    ) => Effect.Effect<void, DatabaseError>;
    readonly releaseObservation: (
      claim: ObservationClaim,
    ) => Effect.Effect<void, DatabaseError>;
    readonly claimDueAnalyses: Effect.Effect<
      ReadonlyArray<AnalysisClaim>,
      DatabaseError
    >;
    readonly recordAnalysis: (
      claim: AnalysisClaim,
      result: AnalysisResult,
    ) => Effect.Effect<void, DatabaseError>;
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
            outputs: appendOutput({
              outcome: "failed",
              summary: "Submission attempts exhausted before session creation.",
            }),
            updatedAt,
          })
            .where(and(
              eq(devinSessions.localOwnership, "tracking"),
              eq(devinSessions.recoveryBlocked, false),
              eq(devinSessions.status, "pending"),
              gte(devinSessions.attempts, config.devinMaxAttempts),
            ));
          const [active] = yield* tx.select({ count: count() })
            .from(devinSessions).where(and(
              eq(devinSessions.localOwnership, "tracking"),
              or(
                eq(devinSessions.status, "submitting"),
                and(
                  eq(devinSessions.status, "submitted"),
                  or(
                    isNull(devinSessions.activeWork),
                    eq(devinSessions.activeWork, true),
                    gt(devinSessions.observationLeaseUntil, updatedAt),
                  ),
                ),
              ),
            ));
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
              eq(devinSessions.localOwnership, "tracking"),
              eq(devinSessions.recoveryBlocked, false),
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
            eq(devinSessions.localOwnership, "tracking"),
            lte(devinSessions.nextRecoveryAt, DateTime.formatIso(now)),
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
          candidateIds: ReadonlyArray<string> = [],
        ) {
          const now = yield* DateTime.now;
          const evidence = lookupFailureUpdate(
            claim,
            outcome === "empty" ? "missing" : outcome,
            now,
          );
          return yield* db.update(devinSessions).set({
            ...evidence,
            recoveryCandidateIds: outcome === "duplicates"
              ? [...new Set(candidateIds)].slice(0, 200)
              : claim.recoveryCandidateIds,
            claimVersion: sql`${devinSessions.claimVersion} + 1`,
            recoveryEmptyChecks: outcome === "empty"
              ? claim.recoveryEmptyChecks + 1
              : 0,
            recoveryBlocked: outcome === "duplicates" ||
              evidence.lookupFailureStreak >= 3,
            nextRecoveryAt: evidence.nextObservationAt,
            updatedAt: DateTime.formatIso(now),
          }).where(ownsClaim(claim)).returning();
        },
        Effect.mapError(databaseError),
        observeClaim("recordRecoveryMiss"),
      );

      const nextObservationAt = (
        lifecycle: ProviderLifecycle | null,
        now: DateTime.Utc,
      ) =>
        lifecycle !== null && lifecycle !== "active"
          ? DateTime.formatIso(DateTime.add(now, {
            milliseconds: Math.max(
              config.devinRetainedPollIntervalMs,
              config.devinOrchestratorIntervalMs,
            ),
          }))
          : "1970-01-01T00:00:00.000Z";

      const observationUpdate = (
        current: SessionRecord,
        remote: DevinSession,
        repo: string,
        now: DateTime.Utc,
      ) => {
        const isArchived = remote.is_archived ?? current.isArchived;
        const state = interpretSession({
          ...remote,
          ...(isArchived === null ? {} : { is_archived: isArchived }),
        });
        const latest = current.outputs.at(-1);
        const append = state.output !== null && (latest === undefined ||
          normalizedRemediationOutput(latest) !==
            normalizedRemediationOutput(state.output));
        return {
          lookupFailureStreak: 0,
          providerStatus: remote.status,
          providerStatusDetail: remote.status_detail ?? null,
          providerLifecycle: state.status,
          activeWork: state.activeWork,
          isArchived,
          providerCreatedAt: remote.created_at,
          providerUpdatedAt: remote.updated_at,
          acusConsumed: remote.acus_consumed,
          sessionUrl: remote.url,
          lastObservedAt: DateTime.formatIso(now),
          nextObservationAt: nextObservationAt(state.status, now),
          observationLeaseUntil: null,
          completionObservedAt: current.completionObservedAt ??
            (interpretSession({ ...remote, is_archived: false }).status ===
                "completed"
              ? DateTime.formatIso(now)
              : null),
          outputs: append && state.output !== null
            ? appendOutput(state.output)
            : devinSessions.outputs,
          prNumber: findPullRequestNumber(state.pullRequestUrls, repo) ??
            current.prNumber,
          updatedAt: DateTime.formatIso(now),
        };
      };

      const recordAttention = Effect.fnUntraced(function* (
        tx: Parameters<Parameters<AppDatabase["transaction"]>[0]>[0],
        before: SessionRecord,
        after: SessionRecord,
        delivery: DeliveryRecord,
        now: DateTime.Utc,
      ) {
        if (after.localOwnership !== "tracking") return;
        if (before.providerLifecycle === after.providerLifecycle) {
          if (
            before.sessionUrl === after.sessionUrl &&
            before.devinSessionId === after.devinSessionId
          ) return;
          yield* tx.update(attentionNotifications).set({
            sessionUrl: after.sessionUrl,
            remoteId: after.devinSessionId,
            body: null,
            status: "pending",
            dueAt: DateTime.toEpochMillis(now),
            lastFailure: null,
          }).where(and(
            eq(attentionNotifications.sessionRecordId, after.id),
            isNull(attentionNotifications.closedAt),
            isNull(attentionNotifications.possibleSendAt),
            inArray(attentionNotifications.status, ["pending", "blocked"]),
          ));
          return;
        }
        yield* tx.update(attentionNotifications).set({
          closedAt: DateTime.toEpochMillis(now),
          status:
            sql`CASE WHEN ${attentionNotifications.possibleSendAt} IS NULL AND ${attentionNotifications.status} IN ('pending', 'blocked') THEN 'cancelled' ELSE ${attentionNotifications.status} END`,
        }).where(and(
          eq(attentionNotifications.sessionRecordId, after.id),
          isNull(attentionNotifications.closedAt),
        ));
        const reason = after.providerLifecycle;
        if (reason !== "needs_input" && reason !== "needs_approval") return;
        const [latest] = yield* tx.select({
          sequence: sql<
            number
          >`coalesce(max(${attentionNotifications.sequence}), 0)`,
        })
          .from(attentionNotifications).where(
            eq(attentionNotifications.sessionRecordId, after.id),
          );
        yield* tx.insert(attentionNotifications).values({
          id: crypto.randomUUID(),
          sessionRecordId: after.id,
          sequence: latest.sequence + 1,
          reason,
          repo: delivery.repo,
          issueNumber: delivery.issueNumber,
          remoteId: after.devinSessionId,
          sessionUrl: after.sessionUrl,
        });
      });

      const logObservation = (
        before: SessionRecord,
        after: SessionRecord,
        now: DateTime.Utc,
      ) =>
        before.providerLifecycle === after.providerLifecycle &&
          before.providerStatus === after.providerStatus &&
          before.providerStatusDetail === after.providerStatusDetail &&
          before.isArchived === after.isArchived
          ? Effect.void
          : Effect.logInfo("session.provider_transition").pipe(
            Effect.annotateLogs({
              previous_lifecycle: before.providerLifecycle,
              provider_lifecycle: after.providerLifecycle,
              is_archived: after.isArchived,
              continuation_window_elapsed: continuationWindowElapsed(
                after.providerCreatedAt,
                DateTime.toEpochMillis(now),
              ),
            }),
          );

      const claimDueObservations = Effect.fn(
        "DevinSessionRepository.claimDueObservations",
      )(
        (after?: Pick<SessionRecord, "insertedAt" | "id">) =>
          db.transaction((tx) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const due = and(
                eq(devinSessions.status, "submitted"),
                eq(devinSessions.localOwnership, "tracking"),
                isNotNull(devinSessions.devinSessionId),
                or(
                  isNull(devinSessions.providerLifecycle),
                  sql`${devinSessions.providerLifecycle} != 'closed'`,
                ),
                lte(devinSessions.nextObservationAt, DateTime.formatIso(now)),
                or(
                  isNull(devinSessions.observationLeaseUntil),
                  lte(
                    devinSessions.observationLeaseUntil,
                    DateTime.formatIso(now),
                  ),
                ),
                after === undefined ? undefined : or(
                  gt(devinSessions.insertedAt, after.insertedAt),
                  and(
                    eq(devinSessions.insertedAt, after.insertedAt),
                    gt(devinSessions.id, after.id),
                  ),
                ),
              );
              const selected = yield* tx.select({ id: devinSessions.id }).from(
                devinSessions,
              )
                .where(due).orderBy(
                  asc(devinSessions.insertedAt),
                  asc(devinSessions.id),
                ).limit(sessionBatchSize);
              if (selected.length === 0) return [];
              const claims = yield* tx.update(devinSessions).set({
                observationVersion:
                  sql`${devinSessions.observationVersion} + 1`,
                observationLeaseUntil: DateTime.formatIso(
                  DateTime.add(now, { seconds: 60 }),
                ),
              }).where(and(
                due,
                inArray(devinSessions.id, selected.map((row) => row.id)),
              )).returning({ id: devinSessions.id });
              if (claims.length === 0) return [];
              const rows = yield* tx.select({
                session: devinSessions,
                delivery: githubWebhookDeliveries,
              })
                .from(devinSessions).innerJoin(
                  githubWebhookDeliveries,
                  eq(
                    devinSessions.githubDeliveryId,
                    githubWebhookDeliveries.deliveryId,
                  ),
                )
                .where(
                  inArray(devinSessions.id, claims.map((claim) => claim.id)),
                )
                .orderBy(asc(devinSessions.insertedAt), asc(devinSessions.id));
              return rows.flatMap(({ session, delivery }) =>
                session.devinSessionId === null ? [] : [{
                  session: {
                    ...session,
                    devinSessionId: session.devinSessionId,
                  },
                  delivery,
                }]
              );
            })
          ),
        Effect.mapError(databaseError),
        observe("DevinSessionRepository", "claimDueObservations"),
      );

      const markSubmitted = Effect.fn("DevinSessionRepository.markSubmitted")(
        function* (
          claim: SessionRecord,
          devinSessionId: string,
          observation?: DevinSession,
        ) {
          const now = yield* DateTime.now;
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const [saved] = yield* tx.update(devinSessions).set({
                status: "submitted",
                devinSessionId,
                updatedAt: DateTime.formatIso(now),
              }).where(ownsClaim(claim)).returning();
              if (!saved) return false;
              if (
                observation !== undefined &&
                observation.session_id === devinSessionId
              ) {
                const [delivery] = yield* tx.select().from(
                  githubWebhookDeliveries,
                )
                  .where(
                    eq(
                      githubWebhookDeliveries.deliveryId,
                      saved.githubDeliveryId,
                    ),
                  );
                const [observed] = yield* tx.update(devinSessions)
                  .set(
                    observationUpdate(saved, observation, delivery.repo, now),
                  )
                  .where(eq(devinSessions.id, saved.id)).returning();
                yield* recordAttention(tx, saved, observed, delivery, now);
                yield* logObservation(saved, observed, now);
              }
              return true;
            })
          );
        },
        Effect.mapError(databaseError),
        observeClaim("markSubmitted"),
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
            outputs: status === "failed"
              ? appendOutput({
                outcome: "failed",
                summary: retryable
                  ? "Submission rejected; retry attempts exhausted."
                  : "Submission permanently rejected before session creation.",
              })
              : devinSessions.outputs,
            updatedAt: yield* nowIso,
          }).where(ownsClaim(claim)).returning();
        },
        Effect.mapError(databaseError),
        observeClaim("rejectSubmission"),
      );

      const ownsObservation = (claim: ObservationClaim, now: DateTime.Utc) =>
        and(
          eq(devinSessions.id, claim.session.id),
          eq(devinSessions.status, "submitted"),
          eq(devinSessions.localOwnership, "tracking"),
          eq(devinSessions.devinSessionId, claim.session.devinSessionId),
          eq(
            devinSessions.observationVersion,
            claim.session.observationVersion,
          ),
          gt(devinSessions.observationLeaseUntil, DateTime.formatIso(now)),
        );

      const recordLookupFailure = Effect.fn(
        "DevinSessionRepository.recordLookupFailure",
      )(
        function* (claim: ObservationClaim, outcome: LookupFailure) {
          const now = yield* DateTime.now;
          yield* db.update(devinSessions).set({
            ...lookupFailureUpdate(claim.session, outcome, now),
            observationLeaseUntil: null,
            updatedAt: DateTime.formatIso(now),
          }).where(ownsObservation(claim, now));
        },
        Effect.mapError(databaseError),
        (effect, claim) =>
          observeClaim("recordLookupFailure")(effect, claim.session),
      );

      const releaseObservation = Effect.fn(
        "DevinSessionRepository.releaseObservation",
      )(
        function* (claim: ObservationClaim) {
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              yield* tx.update(devinSessions).set({
                observationLeaseUntil: null,
                nextObservationAt: nextObservationAt(
                  claim.session.providerLifecycle,
                  now,
                ),
              }).where(ownsObservation(claim, now));
            })
          );
        },
        Effect.mapError(databaseError),
        (effect, claim) =>
          observeClaim("releaseObservation")(effect, claim.session),
      );

      const recordObservation = Effect.fn(
        "DevinSessionRepository.recordObservation",
      )(
        function* (claim: ObservationClaim, remote: DevinSession) {
          if (remote.session_id !== claim.session.devinSessionId) return false;
          return yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const [current] = yield* tx.select().from(devinSessions)
                .where(ownsObservation(claim, now));
              if (!current) return false;
              if (
                current.providerUpdatedAt !== null &&
                remote.updated_at < current.providerUpdatedAt
              ) {
                yield* tx.update(devinSessions).set({
                  observationLeaseUntil: null,
                  nextObservationAt: nextObservationAt(
                    current.providerLifecycle,
                    now,
                  ),
                }).where(ownsObservation(claim, now));
                return false;
              }
              const [saved] = yield* tx.update(devinSessions)
                .set(
                  observationUpdate(current, remote, claim.delivery.repo, now),
                )
                .where(ownsObservation(claim, now)).returning();
              if (!saved) return false;
              yield* recordAttention(tx, current, saved, claim.delivery, now);
              yield* logObservation(current, saved, now);
              return true;
            })
          );
        },
        Effect.mapError(databaseError),
        (effect, claim) =>
          observeClaim("recordObservation")(effect, claim.session),
      );

      const claimDueAnalyses = db.transaction((tx) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const due = and(
            isNotNull(devinSessions.completionObservedAt),
            isNotNull(devinSessions.devinSessionId),
            eq(devinSessions.analysisStatus, "pending"),
            lte(devinSessions.analysisNextAttemptAt, DateTime.formatIso(now)),
          );
          yield* tx.update(devinSessions).set({
            analysisStatus: "unavailable",
            analysisReason:
              sql`'Attempts exhausted: ' || coalesce(${devinSessions.analysisReason}, 'collection interrupted')`,
          }).where(and(
            due,
            gte(
              devinSessions.analysisAttempts,
              config.devinAnalysisMaxAttempts,
            ),
          ));
          const rows = yield* tx.select().from(devinSessions).where(due)
            .orderBy(
              asc(devinSessions.analysisNextAttemptAt),
              asc(devinSessions.id),
            ).limit(analysisBatchSize);
          const claims: AnalysisClaim[] = [];
          for (const row of rows) {
            if (row.devinSessionId === null) continue;
            const analysisAttempts = row.analysisAttempts + 1;
            const analysisNextAttemptAt = DateTime.formatIso(DateTime.add(now, {
              seconds: Math.min(
                30 * 2 ** Math.min(row.analysisAttempts, 4),
                300,
              ),
            }));
            yield* tx.update(devinSessions).set({
              analysisAttempts,
              analysisNextAttemptAt,
              analysisReason: "collection interrupted",
            }).where(eq(devinSessions.id, row.id));
            claims.push({
              ...row,
              devinSessionId: row.devinSessionId,
              analysisAttempts,
              analysisNextAttemptAt,
            });
          }
          return claims;
        })
      ).pipe(
        Effect.mapError(databaseError),
        observe("DevinSessionRepository", "claimDueAnalyses"),
      );

      const recordAnalysis = Effect.fn("DevinSessionRepository.recordAnalysis")(
        function* (claim: AnalysisClaim, result: AnalysisResult) {
          yield* db.update(devinSessions).set(
            result.status === "collected"
              ? {
                analysisStatus: result.status,
                analysis: result.analysis,
                analysisReason: null,
              }
              : {
                analysisStatus: result.status,
                analysisReason: result.reason,
              },
          ).where(and(
            eq(devinSessions.id, claim.id),
            eq(devinSessions.devinSessionId, claim.devinSessionId),
            eq(devinSessions.analysisStatus, "pending"),
            eq(devinSessions.analysisAttempts, claim.analysisAttempts),
            eq(devinSessions.analysisGeneration, claim.analysisGeneration),
          ));
        },
        Effect.mapError(databaseError),
        observeClaim("recordAnalysis"),
      );

      return DevinSessionRepository.of({
        claimPending,
        claimStale,
        recordRecoveryMiss,
        claimDueObservations,
        markSubmitted,
        markSkipped,
        rejectSubmission,
        recordObservation,
        releaseObservation,
        recordLookupFailure,
        claimDueAnalyses,
        recordAnalysis,
      });
    }),
  );
}
