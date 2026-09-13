import { Cause, Context, Effect, Layer, Schedule, Semaphore } from "effect";
import { AppConfig } from "./config.ts";
import { type DatabaseError } from "./database.ts";
import { DevinClient, findPullRequestNumber } from "./devin.ts";
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
        for (const row of yield* repository.recoverStale) {
          yield* Effect.logWarning("stale submitting record recovered").pipe(
            Effect.annotateLogs({
              id: row.id,
              github_delivery_id: row.githubDeliveryId,
              attempt: row.attempts,
              status: row.status,
            }),
          );
        }
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
