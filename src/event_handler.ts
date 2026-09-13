import { type EmitterWebhookEvent, Webhooks } from "@octokit/webhooks";
import { Context, Effect, Layer, Schema } from "effect";
import { AppConfig } from "./config.ts";

type WebhookDelivery = {
  id: string;
  name: string;
  payload: string;
  signature: string;
};

export class EventHandlerError extends Schema.TaggedError<EventHandlerError>()(
  "EventHandlerError",
  { cause: Schema.Defect() },
) {}

const issuesLabeled = Effect.fn("EventHandler.issuesLabeled")(
  function* ({ payload }: EmitterWebhookEvent<"issues.labeled">) {
    const { repository, issue, label } = payload;
    yield* Effect.logInfo(
      `Label ${
        label?.name ?? "(unknown)"
      } added to issue ${repository.full_name}#${issue.number}`,
    );
  },
);

export class EventHandler extends Context.Service<EventHandler, {
  readonly receive: (
    event: WebhookDelivery,
  ) => Effect.Effect<void, EventHandlerError>;
}>()("devin-remediator/EventHandler") {
  static readonly layer = Layer.effect(
    EventHandler,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const webhooks = new Webhooks({ secret: config.githubWebhookSecret });
      const runPromise = Effect.runPromiseWith(yield* Effect.context());

      webhooks.on(
        "issues.labeled",
        (event) => runPromise(issuesLabeled(event)),
      );

      const receive = Effect.fn("EventHandler.receive")(
        (event: WebhookDelivery) =>
          Effect.tryPromise({
            try: () => webhooks.verifyAndReceive(event),
            catch: (cause) => new EventHandlerError({ cause }),
          }),
      );

      return EventHandler.of({ receive });
    }),
  );
}
