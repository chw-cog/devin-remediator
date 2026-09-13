import {
  createEventHandler,
  type EmitterWebhookEvent,
} from "@octokit/webhooks";
import { Context, Effect, Layer, Schema } from "effect";

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
    event: EmitterWebhookEvent,
  ) => Effect.Effect<void, EventHandlerError>;
}>()("devin-remediator/EventHandler") {
  static readonly layer = Layer.effect(
    EventHandler,
    Effect.gen(function* () {
      const webhooks = createEventHandler({});
      const runPromise = Effect.runPromiseWith(yield* Effect.context());

      webhooks.on(
        "issues.labeled",
        (event) => runPromise(issuesLabeled(event)),
      );

      const receive = Effect.fn("EventHandler.receive")(
        (event: EmitterWebhookEvent) =>
          Effect.tryPromise({
            try: () => webhooks.receive(event),
            catch: (cause) => new EventHandlerError({ cause }),
          }),
      );

      return EventHandler.of({ receive });
    }),
  );
}
