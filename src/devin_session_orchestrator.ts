import { Cause, Context, Effect, Layer, Schedule, Semaphore } from "effect";
import { AppConfig } from "./config.ts";
import { type DatabaseError } from "./database.ts";
import {
  DevinClient,
  findPullRequestNumber,
  interpretSession,
} from "./devin.ts";
import { deliveryTag } from "./devin_prompt.ts";
import {
  DevinSessionRepository,
  type RunningSession,
  type SessionWork,
} from "./devin_session_repository.ts";
import {
  type WebhookDeliveryOutcome,
  WebhookDeliveryProcessors,
} from "./webhook_delivery_processors.ts";

const identifiers = ({ session, delivery }: SessionWork) => ({
  id: session.id,
  github_delivery_id: session.githubDeliveryId,
  repo: delivery.repo,
  issue_number: delivery.issueNumber,
  devin_session_id: session.devinSessionId,
  attempt: session.attempts,
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
      const processors = yield* WebhookDeliveryProcessors;
      const config = yield* AppConfig;
      const ticks = yield* Semaphore.make(1);

      const recover = Effect.fn("DevinSessionOrchestrator.recover")(
        function* (work: SessionWork) {
          const result = yield* client.findSessionsByTag(
            deliveryTag(work.delivery.deliveryId),
          ).pipe(Effect.result);
          if (result._tag === "Failure") {
            yield* repository.recordRecoveryMiss(work.session, "unavailable");
            yield* Effect.logWarning(
              "Devin tag lookup unavailable or incomplete; retaining submitting",
            );
            return;
          }
          const matches = result.success;
          if (matches.length > 1) {
            yield* repository.recordRecoveryMiss(work.session, "duplicates");
            yield* Effect.logError(
              "duplicate Devin delivery tag; automatic submission blocked",
            ).pipe(Effect.annotateLogs({
              devin_session_ids: matches.map((session) => session.session_id),
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
              );
            }
            return;
          }
          const remote = matches[0];
          const saved = yield* repository.markRunning(
            work.session,
            remote.session_id,
          );
          if (!saved) return;
          const state = interpretSession(remote);
          if (state.status !== "running") {
            yield* repository.finish(
              {
                ...work,
                session: { ...work.session, devinSessionId: remote.session_id },
              },
              state.status,
              findPullRequestNumber(
                state.pullRequestUrls,
                work.delivery.repo,
              ),
            );
          }
          yield* Effect.logInfo("Devin session recovered by delivery tag").pipe(
            Effect.annotateLogs({ devin_session_id: remote.session_id }),
          );
        },
        (effect, work) => effect.pipe(Effect.annotateLogs(identifiers(work))),
      );

      const reconcile = Effect.fn("DevinSessionOrchestrator.reconcile")(
        function* (work: RunningSession) {
          yield* Effect.logInfo("reconciling Devin session");
          const result = yield* client.getSession(work.session.devinSessionId)
            .pipe(
              Effect.result,
            );
          if (result._tag === "Failure") {
            yield* Effect.logWarning(
              "Devin reconciliation unavailable; retaining running session",
            );
            return;
          }
          const remote = result.success;
          if (remote.status === "running") return;
          const changed = yield* repository.finish(
            work,
            remote.status,
            findPullRequestNumber(remote.pullRequestUrls, work.delivery.repo),
          );
          if (changed) yield* Effect.logInfo(`Devin session ${remote.status}`);
        },
        (effect, work) => effect.pipe(Effect.annotateLogs(identifiers(work))),
      );

      const submit = Effect.fn("DevinSessionOrchestrator.submit")(
        function* (work: SessionWork) {
          yield* Effect.logInfo("claimed Devin session record");
          const processor = processors.get(work.delivery.eventName);
          const result = yield* (processor
            ? processor(work.delivery, client)
            : Effect.succeed<WebhookDeliveryOutcome>({ _tag: "Skipped" }))
            .pipe(Effect.interruptible, Effect.result);
          if (result._tag === "Failure") {
            const error = result.failure;
            if (error.disposition === "ambiguous") {
              yield* Effect.logWarning(
                "submission outcome unknown; retaining submitting until recovery",
              );
              return;
            }
            const rows = yield* repository.rejectSubmission(
              work.session,
              error.disposition === "retryable",
            );
            for (const row of rows) {
              yield* Effect.logInfo(
                row.status === "pending"
                  ? "submission retry scheduled"
                  : "Devin session failed",
              ).pipe(Effect.annotateLogs({ http_status: error.httpStatus }));
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
        (effect, work) =>
          effect.pipe(Effect.annotateLogs(identifiers(work))),
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
      }).pipe(ticks.withPermits(1));

      const run = tick.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.logError(
            "Devin orchestration tick failed; retrying next interval",
          )
        ),
        Effect.andThen(Effect.sleep(config.devinOrchestratorIntervalMs)),
        Effect.forever,
      );
      return DevinSessionOrchestrator.of({ tick, run });
    }),
  );
}
