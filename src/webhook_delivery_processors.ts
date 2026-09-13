import { Context, Effect, Layer, Schema } from "effect";
import { type DevinClient, type DevinSubmissionError } from "./devin.ts";
import { buildSessionRequest } from "./devin_prompt.ts";
import type { DeliveryRecord } from "./devin_session_repository.ts";

export type WebhookDeliveryOutcome =
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "SessionCreated"; readonly devinSessionId: string };

export type WebhookDeliveryProcessor = (
  delivery: DeliveryRecord,
  client: DevinClient["Service"],
) => Effect.Effect<WebhookDeliveryOutcome, DevinSubmissionError>;

const decodeDevinLabel = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({
    action: Schema.Literal("labeled"),
    label: Schema.Struct({ name: Schema.Literal("devin") }),
  })),
);

export const issuesProcessor: WebhookDeliveryProcessor = Effect.fn(
  "issuesProcessor",
)(
  function* (
    delivery: DeliveryRecord,
    client: DevinClient["Service"],
  ): Effect.fn.Return<
    WebhookDeliveryOutcome,
    DevinSubmissionError
  > {
    const matched = yield* decodeDevinLabel(delivery.payload).pipe(
      Effect.result,
    );
    if (matched._tag === "Failure") return { _tag: "Skipped" };

    yield* Effect.logInfo("submitting session to Devin");
    const session = yield* client.createSession(buildSessionRequest(delivery));
    return { _tag: "SessionCreated", devinSessionId: session.session_id };
  },
);

export class WebhookDeliveryProcessors extends Context.Service<
  WebhookDeliveryProcessors,
  ReadonlyMap<string, WebhookDeliveryProcessor>
>()("devin-remediator/WebhookDeliveryProcessors") {
  static readonly layer = Layer.succeed(
    WebhookDeliveryProcessors,
    new Map([["issues", issuesProcessor]]),
  );
}
