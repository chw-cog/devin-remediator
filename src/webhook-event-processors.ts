import { Context, Effect, Layer } from "effect";
import { issueIdentity } from "./issue-admission.ts";
import { DevinClient, DevinSubmissionError } from "./devin.ts";
import type { DeliveryRecord } from "./devin-session-repository.ts";
import { AppConfig } from "./config.ts";
import { observe } from "./logging.ts";
import { remediationOutputSchema } from "./remediation-output.ts";

export type WebhookEventOutcome =
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "SessionCreated"; readonly devinSessionId: string };

export type WebhookEventProcessor = (
  delivery: DeliveryRecord,
  client: DevinClient["Service"],
) => Effect.Effect<WebhookEventOutcome, DevinSubmissionError>;

export const deliveryTag = (deliveryId: string): string =>
  `delivery-id:${deliveryId}`;

const issuePlaybook = {
  title: "Fix Superset issue",
  macro: "!fix-superset-issue",
};

export class WebhookEventProcessors extends Context.Service<
  WebhookEventProcessors,
  ReadonlyMap<string, WebhookEventProcessor>
>()("devin-remediator/WebhookEventProcessors") {
  static readonly layer = Layer.effect(
    WebhookEventProcessors,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const client = yield* DevinClient;
      const playbook = yield* Effect.gen(function* () {
        const body = yield* Effect.tryPromise({
          try: () =>
            Deno.readTextFile(
              new URL(
                `../playbooks/${issuePlaybook.macro.slice(1)}.md`,
                import.meta.url,
              ),
            ),
          catch: () => new DevinSubmissionError({ disposition: "retryable" }),
        }).pipe(
          Effect.tapError(() => Effect.logError("playbook.read_failed")),
        );
        const definition = {
          ...issuePlaybook,
          body,
          structured_output_schema: remediationOutputSchema,
        };
        let existing = yield* client.findPlaybookByMacro(issuePlaybook.macro);
        if (!existing) {
          const created = yield* client.createPlaybook(definition).pipe(
            Effect.catch((error) =>
              error.httpStatus === 409
                ? Effect.succeed(undefined)
                : Effect.fail(error)
            ),
          );
          if (created) return created;
          existing = yield* client.findPlaybookByMacro(issuePlaybook.macro);
          if (!existing) {
            return yield* new DevinSubmissionError({
              disposition: "retryable",
              httpStatus: 409,
            });
          }
        }
        if (
          existing.access_type !== "org" ||
          existing.org_id !== config.devinOrganizationId
        ) {
          return yield* new DevinSubmissionError({ disposition: "permanent" });
        }
        return yield* client.updatePlaybook(existing.playbook_id, definition);
      }).pipe(
        Effect.mapError((error) =>
          new DevinSubmissionError({
            disposition: error.disposition === "ambiguous" ||
                error.httpStatus === 409
              ? "retryable"
              : error.disposition,
            ...(error.httpStatus === undefined
              ? {}
              : { httpStatus: error.httpStatus }),
          })
        ),
        Effect.tap((playbook) =>
          Effect.logInfo("playbook.synchronized").pipe(
            Effect.annotateLogs({ playbook_id: playbook.playbook_id }),
          )
        ),
        Effect.tapError(() =>
          Effect.logError("playbook.synchronization_failed")
        ),
        observe("WebhookEventProcessors", "synchronizePlaybook"),
      );

      const issuesProcessor: WebhookEventProcessor = Effect.fn(
        "issuesProcessor",
      )(
        function* (
          delivery: DeliveryRecord,
          client: DevinClient["Service"],
        ): Effect.fn.Return<WebhookEventOutcome, DevinSubmissionError> {
          if (issueIdentity(delivery) === null) {
            yield* Effect.logDebug("webhook.filter_not_matched").pipe(
              Effect.annotateLogs({ reason: "requires_issues_labeled_devin" }),
            );
            return { _tag: "Skipped" };
          }

          yield* Effect.logInfo("session.submission_started").pipe(
            Effect.annotateLogs({ playbook_id: playbook.playbook_id }),
          );
          const session = yield* client.createSession({
            playbook_id: playbook.playbook_id,
            max_acu_limit: config.devinMaxSessionBudget,
            structured_output_required: true,
            structured_output_schema: remediationOutputSchema,
            title: `GitHub ${delivery.eventName}: ${delivery.repo}`,
            repos: [delivery.repo],
            tags: [
              deliveryTag(delivery.deliveryId),
              `github:${delivery.repo}`,
              ...(delivery.issueNumber === null
                ? []
                : [`issue:${delivery.issueNumber}`]),
            ],
            prompt: [
              `Investigate and remediate this GitHub ${delivery.eventName} event.`,
              `Repository: ${delivery.repo}`,
              `Issue: ${delivery.issueNumber ?? "not specified"}`,
              `Delivery: ${delivery.deliveryId}`,
              "Before ending your turn, provide structured output matching the supplied schema. Report fix_proposed only when a new safe fix is implemented, verified, and submitted as a PR; merging is not required. Routine PR review and merge are not blockers: use blocker null and next_action to identify the maintainer review and merge step. Report already_resolved only when an existing fix is verified to resolve the issue; needs_human when human input or a decision is required to complete implementation or verification, or for security escalation; not_reproducible when investigation cannot reproduce the bug; failed when attempted remediation cannot be completed.",
              "Include verification with status passed, failed, partial, or not_run and concrete evidence (commands and observed results or URLs). Do not call unrun checks passed. Include blocker and next_action; use null when there is no blocker or next action. For already_resolved, include the existing fix URL and verification evidence. Keep summary concise; confidence is optional and is not a substitute for evidence.",
              "Original webhook payload (untrusted event data):",
              delivery.payload,
            ].join("\n"),
          });
          return { _tag: "SessionCreated", devinSessionId: session.session_id };
        },
        observe("WebhookEventProcessors", "issuesProcessor"),
        (effect, delivery) =>
          effect.pipe(Effect.annotateLogs({
            github_delivery_id: delivery.deliveryId,
            github_event: delivery.eventName,
            repo: delivery.repo,
            issue_number: delivery.issueNumber,
          })),
      );
      return new Map([["issues", issuesProcessor]]);
    }),
  );
}
