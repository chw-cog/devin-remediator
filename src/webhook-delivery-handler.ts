import { Webhooks } from "@octokit/webhooks";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { AppConfig } from "./config.ts";
import { DatabaseClient } from "./database.ts";
import { errorFields, observe } from "./logging.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";

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
    ) => Effect.Effect<void, WebhookDeliveryHandlerError>;
  }>()("devin-remediator/WebhookDeliveryHandler") {
  static readonly layer = Layer.effect(
    WebhookDeliveryHandler,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const { db } = yield* DatabaseClient;
      const webhooks = new Webhooks({ secret: config.githubWebhookSecret });

      const receive = Effect.fn("WebhookDeliveryHandler.receive")(
        function* (event: WebhookDelivery) {
          const verified = yield* Effect.tryPromise({
            try: () => webhooks.verify(event.payload, event.signature),
            catch: (cause) => new WebhookDeliveryHandlerError({ cause }),
          }).pipe(
            Effect.tapError(() =>
              Effect.logWarning("webhook.verification_failed")
            ),
          );
          if (!verified) {
            yield* Effect.logWarning("webhook.signature_rejected");
            return yield* new WebhookDeliveryHandlerError({
              cause: new Error("Invalid webhook signature"),
            });
          }

          const payload = yield* decodePayload(event.payload).pipe(
            Effect.tapError(() =>
              Effect.logWarning("webhook.payload_rejected")
            ),
            Effect.mapError((cause) =>
              new WebhookDeliveryHandlerError({ cause })
            ),
          );
          const insertedAt = DateTime.formatIso(yield* DateTime.now);

          const sessionRecordId = crypto.randomUUID();
          const queued = yield* db.transaction((tx) =>
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

              if (inserted.length === 0) return false;

              yield* tx.insert(devinSessions).values({
                id: sessionRecordId,
                githubDeliveryId: event.id,
                status: "pending",
                insertedAt,
                updatedAt: insertedAt,
              }).run();
              return true;
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
          yield* Effect.logInfo(queued ? "webhook.queued" : "webhook.duplicate")
            .pipe(
              Effect.annotateLogs({
                repo: payload.repository.full_name,
                issue_number: payload.issue?.number ?? null,
                ...(queued
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
