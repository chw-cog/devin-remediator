import { Webhooks } from "@octokit/webhooks";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { AppConfig } from "./config.ts";
import { and, eq } from "drizzle-orm";
import { issueIdentity } from "./issue-admission.ts";
import { DatabaseClient } from "./database.ts";
import { errorFields, observe } from "./logging.ts";
import {
  devinSessions,
  githubWebhookDeliveries,
  issueAdmissions,
} from "./schemas.ts";

type WebhookDelivery = {
  id: string;
  name: string;
  payload: string;
  signature: string;
};

export class WebhookDeliveryHandlerError
  extends Schema.TaggedError<WebhookDeliveryHandlerError>()(
    "WebhookDeliveryHandlerError",
    { cause: Schema.Defect() },
  ) {}

export class WebhookAuthenticationError
  extends Schema.TaggedError<WebhookAuthenticationError>()(
    "WebhookAuthenticationError",
    {},
  ) {}

export class WebhookPayloadError
  extends Schema.TaggedError<WebhookPayloadError>()(
    "WebhookPayloadError",
    {},
  ) {}

const decodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({
    repository: Schema.Struct({ full_name: Schema.NonEmptyString }),
    issue: Schema.optional(Schema.Struct({
      number: Schema.Int.check(Schema.isGreaterThan(0)),
    })),
  })),
);

export class WebhookDeliveryHandler
  extends Context.Service<WebhookDeliveryHandler, {
    readonly receive: (
      event: WebhookDelivery,
    ) => Effect.Effect<
      void,
      | WebhookDeliveryHandlerError
      | WebhookAuthenticationError
      | WebhookPayloadError
    >;
  }>()("devin-remediator/WebhookDeliveryHandler") {
  static readonly layer = Layer.effect(
    WebhookDeliveryHandler,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const { db } = yield* DatabaseClient;
      const webhooks = new Webhooks({ secret: config.githubWebhookSecret });

      const receive = Effect.fn("WebhookDeliveryHandler.receive")(
        function* (event: WebhookDelivery) {
          const verified = /^sha256=[a-f0-9]{64}$/.test(event.signature) &&
            (yield* Effect.tryPromise({
              try: () => webhooks.verify(event.payload, event.signature),
              catch: (cause) => new WebhookDeliveryHandlerError({ cause }),
            }).pipe(
              Effect.tapError(() =>
                Effect.logWarning("webhook.verification_failed")
              ),
            ));
          if (!verified) {
            yield* Effect.logWarning("webhook.signature_rejected");
            return yield* new WebhookAuthenticationError({});
          }

          const payload = yield* decodePayload(event.payload).pipe(
            Effect.tapError(() =>
              Effect.logWarning("webhook.payload_rejected")
            ),
            Effect.mapError(() => new WebhookPayloadError({})),
          );
          const insertedAt = DateTime.formatIso(yield* DateTime.now);

          const sessionRecordId = crypto.randomUUID();
          const identity = issueIdentity({
            eventName: event.name,
            repo: payload.repository.full_name,
            issueNumber: payload.issue?.number,
            payload: event.payload,
          });
          const outcome = yield* db.transaction((tx) =>
            Effect.gen(function* () {
              const inserted = yield* tx.insert(githubWebhookDeliveries).values(
                {
                  id: crypto.randomUUID(),
                  deliveryId: event.id,
                  eventName: event.name,
                  repo: payload.repository.full_name,
                  issueNumber: payload.issue?.number,
                  payload: event.payload,
                  insertedAt,
                },
              ).onConflictDoNothing({
                target: githubWebhookDeliveries.deliveryId,
              }).returning({ id: githubWebhookDeliveries.id });

              if (inserted.length === 0) return "duplicate";
              if (identity === null) return "ignored";
              const [existing] = yield* tx.select().from(issueAdmissions).where(
                and(
                  eq(issueAdmissions.repo, identity.repo),
                  eq(issueAdmissions.issueNumber, identity.issueNumber),
                ),
              );
              if (existing) return "duplicate";

              yield* tx.insert(devinSessions).values({
                id: sessionRecordId,
                githubDeliveryId: event.id,
                status: "pending",
                insertedAt,
                updatedAt: insertedAt,
              }).run();
              yield* tx.insert(issueAdmissions).values({
                ...identity,
                canonicalSessionId: sessionRecordId,
              });
              return "queued";
            })
          ).pipe(
            Effect.tapError((error) =>
              Effect.logError("webhook.persistence_failed").pipe(
                Effect.annotateLogs(errorFields(error)),
              )
            ),
            Effect.mapError((cause) =>
              new WebhookDeliveryHandlerError({ cause })
            ),
          );
          yield* Effect.logInfo(`webhook.${outcome}`)
            .pipe(
              Effect.annotateLogs({
                repo: payload.repository.full_name,
                issue_number: payload.issue?.number ?? null,
                ...(outcome === "queued"
                  ? { session_record_id: sessionRecordId, status: "pending" }
                  : {}),
              }),
            );
        },
        observe("WebhookDeliveryHandler", "receive"),
        (effect, event) =>
          effect.pipe(Effect.annotateLogs({
            github_delivery_id: event.id.slice(0, 200),
            github_event: event.name.slice(0, 100),
          })),
      );

      return WebhookDeliveryHandler.of({ receive });
    }),
  );
}
