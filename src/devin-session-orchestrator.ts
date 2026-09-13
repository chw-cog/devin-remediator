import { Cause, Context, Effect, Layer, Schedule, Semaphore } from "effect";
import { AppConfig } from "./config.ts";
import { type DatabaseError } from "./database.ts";
import { causeFields, errorFields, observe } from "./logging.ts";
import {
  DevinClient,
  findPullRequestNumber,
  interpretSession,
} from "./devin.ts";
import {
  analysisBatchSize,
  type AnalysisClaim,
  DevinSessionRepository,
  type RunningSession,
  type SessionWork,
} from "./devin-session-repository.ts";
import {
  deliveryTag,
  type WebhookEventOutcome,
  WebhookEventProcessors,
} from "./webhook-event-processors.ts";

const identifiers = ({ session, delivery }: SessionWork) => ({
  session_record_id: session.id,
  github_delivery_id: session.githubDeliveryId,
  repo: delivery.repo,
  issue_number: delivery.issueNumber,
  devin_session_id: session.devinSessionId,
  attempt: session.attempts,
  claim_version: session.claimVersion,
  github_event: delivery.eventName,
});

export class DevinSessionOrchestrator extends Context.Service<
  DevinSessionOrchestrator,
  {
    readonly tick: Effect.Effect<void, DatabaseError>;
    readonly run: Effect.Effect<never>;
  }
>()("devin-remediator/DevinSessionOrchestrator") {
  static readonly layer = Layer.effect(
    DevinSessionOrchestrator,
    Effect.gen(function* () {
      const repository = yield* DevinSessionRepository;
      const client = yield* DevinClient;
      const processors = yield* WebhookEventProcessors;
      const config = yield* AppConfig;
      const ticks = yield* Semaphore.make(1);

      const recover = Effect.fn("DevinSessionOrchestrator.recover")(
        function* (work: SessionWork) {
          yield* Effect.logDebug("session.recovery_started");
          const result = yield* client.findSessionsByTag(
            deliveryTag(work.delivery.deliveryId),
          ).pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* repository.recordRecoveryMiss(work.session, "unavailable");
            yield* Effect.logWarning(
              "Devin tag lookup unavailable or incomplete; retaining submitting",
            ).pipe(Effect.annotateLogs(errorFields(result.failure)));
            return;
          }
          const matches = result.success;
          if (matches.length > 1) {
            yield* repository.recordRecoveryMiss(work.session, "duplicates");
            yield* Effect.logError(
              "duplicate Devin delivery tag; automatic submission blocked",
            ).pipe(Effect.annotateLogs({
              devin_session_ids: matches.map((session) => session.session_id),
              match_count: matches.length,
              recovery_blocked: true,
            }));
            return;
          }
          if (matches.length === 0) {
            const rows = yield* repository.recordRecoveryMiss(
              work.session,
              "empty",
            );
            for (const row of rows) {
              yield* Effect.logWarning(
                row.status === "pending"
                  ? "repeated empty tag lookup; best-effort retry scheduled with duplicate risk"
                  : row.status === "failed"
                  ? "repeated empty tag lookup; submission attempts exhausted"
                  : "empty tag lookup; waiting for another lookup after grace period",
              ).pipe(Effect.annotateLogs({
                status: row.status,
                recovery_empty_checks: row.recoveryEmptyChecks,
              }));
            }
            return;
          }
          const remote = matches[0];
          const saved = yield* repository.markRunning(
            work.session,
            remote.session_id,
          );
          if (!saved) {
            yield* Effect.logDebug("session.claim_superseded");
            return;
          }
          const state = interpretSession(remote);
          if (state.status !== "running") {
            yield* repository.finish(
              {
                ...work,
                session: { ...work.session, devinSessionId: remote.session_id },
              },
              state,
              findPullRequestNumber(
                state.pullRequestUrls,
                work.delivery.repo,
              ),
            );
          }
          yield* Effect.logInfo("Devin session recovered by delivery tag").pipe(
            Effect.annotateLogs({
              devin_session_id: remote.session_id,
              remote_status: state.status,
            }),
          );
        },
        observe("DevinSessionOrchestrator", "recover"),
        (effect, work) => effect.pipe(Effect.annotateLogs(identifiers(work))),
      );

      const reconcile = Effect.fn("DevinSessionOrchestrator.reconcile")(
        function* (work: RunningSession) {
          yield* Effect.logDebug("session.reconciliation_started");
          const result = yield* client.getSession(work.session.devinSessionId)
            .pipe(
              Effect.result,
            );
          if (result._tag === "Failure") {
            yield* Effect.logWarning(
              "Devin reconciliation unavailable; retaining running session",
            ).pipe(Effect.annotateLogs(errorFields(result.failure)));
            return;
          }
          const remote = result.success;
          if (remote.status === "running") return;
          const prNumber = findPullRequestNumber(
            remote.pullRequestUrls,
            work.delivery.repo,
          );
          const changed = yield* repository.finish(
            work,
            remote,
            prNumber,
          );
          if (changed) {
            yield* Effect.logWithLevel(
              remote.status === "failed" ? "Error" : "Info",
            )(
              "session.finished",
            ).pipe(
              Effect.annotateLogs({
                status: remote.status,
                outcome: remote.output.outcome,
                pr_number: prNumber,
              }),
            );
          }
        },
        observe("DevinSessionOrchestrator", "reconcile"),
        (effect, work) => effect.pipe(Effect.annotateLogs(identifiers(work))),
      );

      const submit = Effect.fn("DevinSessionOrchestrator.submit")(
        function* (work: SessionWork) {
          yield* Effect.logInfo("session.claimed");
          const processor = processors.get(work.delivery.eventName);
          if (!processor) {
            yield* Effect.logDebug("webhook.processor_missing");
          }
          const result = yield* (processor
            ? processor(work.delivery, client)
            : Effect.succeed<WebhookEventOutcome>({ _tag: "Skipped" }))
            .pipe(Effect.interruptible, Effect.result);
          if (result._tag === "Failure") {
            const error = result.failure;
            if (error.disposition === "ambiguous") {
              yield* Effect.logWarning(
                "submission outcome unknown; retaining submitting until recovery",
              ).pipe(Effect.annotateLogs(errorFields(error)));
              return;
            }
            const rows = yield* repository.rejectSubmission(
              work.session,
              error.disposition === "retryable",
            );
            for (const row of rows) {
              yield* Effect.logWithLevel(
                row.status === "pending" ? "Warn" : "Error",
              )(
                row.status === "pending"
                  ? "submission retry scheduled"
                  : "Devin session failed",
              ).pipe(
                Effect.annotateLogs({
                  ...errorFields(error),
                  status: row.status,
                }),
              );
            }
            return;
          }

          if (result.success._tag === "Skipped") {
            const skipped = yield* repository.markSkipped(work.session);
            if (skipped) {
              yield* Effect.logInfo("webhook delivery skipped");
            }
            return;
          }

          // Retry only SQLite here. The remote POST is outside this retry boundary.
          const remoteId = result.success.devinSessionId;
          const saved = yield* repository.markRunning(work.session, remoteId)
            .pipe(
              Effect.retry({
                times: 2,
                schedule: Schedule.spaced("100 millis"),
              }),
              Effect.tapError(() =>
                Effect.logError(
                  "Devin session created but local persistence failed",
                ).pipe(
                  Effect.annotateLogs({ devin_session_id: remoteId }),
                )
              ),
            );
          yield* (saved
            ? Effect.logInfo("Devin session created")
            : Effect.logError("Devin session created for a superseded claim"))
            .pipe(
              Effect.annotateLogs({ devin_session_id: remoteId }),
            );
        },
        Effect.uninterruptible,
        observe("DevinSessionOrchestrator", "submit"),
        (effect, work) =>
          effect.pipe(Effect.annotateLogs(identifiers(work))),
      );

      const collectAnalyses = Effect.gen(function* () {
        const claims = yield* repository.claimDueAnalyses;
        if (claims.length === 0) return;
        const result = yield* client.listSessionsWithInsights(
          claims.map((claim) => claim.devinSessionId),
        ).pipe(Effect.result);
        if (result._tag === "Failure") {
          yield* Effect.logWarning("analysis.lookup_failed").pipe(
            Effect.annotateLogs(errorFields(result.failure)),
          );
          for (const claim of claims) {
            yield* repository.recordAnalysis(claim, {
              status: "pending",
              reason: "insights lookup failed",
            });
          }
          return;
        }
        const sessions = new Map(
          result.success.map((session) => [session.session_id, session]),
        );
        const toGenerate: AnalysisClaim[] = [];
        yield* Effect.forEach(claims, (claim) =>
          Effect.gen(function* () {
            const session = sessions.get(claim.devinSessionId);
            if (!session) {
              yield* repository.recordAnalysis(claim, {
                status: "pending",
                reason: "session missing from insights response",
              });
            } else if (session.analysis != null) {
              yield* repository.recordAnalysis(claim, {
                status: "collected",
                analysis: session.analysis,
              });
              yield* Effect.logInfo("analysis.collected");
            } else if (interpretSession(session).status === "running") {
              yield* repository.recordAnalysis(claim, {
                status: "pending",
                reason: "remote session is still running",
              });
            } else if (session.num_devin_messages === 0) {
              yield* repository.recordAnalysis(claim, {
                status: "unavailable",
                reason: "session has no Devin messages",
              });
              yield* Effect.logInfo("analysis.unavailable");
            } else {
              toGenerate.push(claim);
            }
          }).pipe(Effect.annotateLogs({
            session_record_id: claim.id,
            devin_session_id: claim.devinSessionId,
            analysis_attempt: claim.analysisAttempts,
          })), { discard: true });
        yield* Effect.forEach(toGenerate, (claim) =>
          Effect.gen(function* () {
            const generated = yield* client.generateSessionInsights(
              claim.devinSessionId,
            ).pipe(Effect.result);
            if (generated._tag === "Failure") {
              yield* Effect.logWarning("analysis.generation_failed").pipe(
                Effect.annotateLogs(errorFields(generated.failure)),
              );
            }
            yield* repository.recordAnalysis(claim, {
              status: "pending",
              reason: generated._tag === "Failure"
                ? "insights generation request failed"
                : "waiting for analysis",
            });
          }).pipe(Effect.annotateLogs({
            session_record_id: claim.id,
            devin_session_id: claim.devinSessionId,
            analysis_attempt: claim.analysisAttempts,
          })), { concurrency: analysisBatchSize, discard: true });
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logWarning("analysis.collection_failed").pipe(
              Effect.annotateLogs(causeFields(cause)),
            )
        ),
        observe("DevinSessionOrchestrator", "collectAnalyses"),
      );

      const tick = Effect.gen(function* () {
        for (const work of yield* repository.findRunning) {
          yield* reconcile(work);
        }
        yield* Effect.forEach(yield* repository.claimStale, recover, {
          concurrency: config.devinMaxConcurrentSessions,
          discard: true,
        });
        const claimed = yield* repository.claimPending;
        yield* Effect.forEach(claimed, submit, {
          concurrency: config.devinMaxConcurrentSessions,
          discard: true,
        });
        yield* collectAnalyses;
      }).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.void : Effect.logError(
            "Devin orchestration tick failed; retrying next interval",
          ).pipe(Effect.annotateLogs({
            ...causeFields(cause),
            retry_delay_ms: config.devinOrchestratorIntervalMs,
          }))
        ),
        observe("DevinSessionOrchestrator", "tick"),
        (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.annotateLogs({ tick_id: crypto.randomUUID() }),
            )
          ),
        ticks.withPermits(1),
      );

      const run = tick.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.void
        ),
        Effect.andThen(Effect.sleep(config.devinOrchestratorIntervalMs)),
        Effect.forever,
        (effect) =>
          Effect.logInfo("orchestrator.started").pipe(
            Effect.annotateLogs({
              max_concurrent_sessions: config.devinMaxConcurrentSessions,
              max_attempts: config.devinMaxAttempts,
              poll_interval_ms: config.devinOrchestratorIntervalMs,
              submitting_timeout_seconds: config.devinSubmittingTimeoutSeconds,
            }),
            Effect.andThen(effect),
          ),
        Effect.annotateLogs({
          component: "DevinSessionOrchestrator",
          operation: "run",
        }),
      );
      return DevinSessionOrchestrator.of({ tick, run });
    }),
  );
}
