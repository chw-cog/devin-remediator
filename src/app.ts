import {
  createEventHandler,
  type EmitterWebhookEvent,
} from "@octokit/webhooks";
import { Effect, Schema } from "effect";
import { Hono } from "hono";

const EventName = Schema.Literals([
  "check_run",
  "dependabot_alert",
  "issues",
  "label",
  "push",
]);

type WebhookEvent = EmitterWebhookEvent<typeof EventName.Type>;

const decodeDelivery = Schema.decodeUnknownEffect(Schema.Struct({
  id: Schema.NonEmptyString,
  name: EventName,
  payload: Schema.Record(Schema.String, Schema.Unknown),
}));

const webhooks = createEventHandler({});
const app = new Hono();

app.post("/api/v1/webhook", (c) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const payload = yield* Effect.tryPromise({
        try: (): Promise<unknown> => c.req.json(),
        catch: () => "Invalid JSON",
      });
      const delivery = yield* decodeDelivery({
        id: c.req.header("x-github-delivery"),
        name: c.req.header("x-github-event"),
        payload,
      }).pipe(Effect.mapError(() => "Invalid webhook headers or payload"));

      // Payload fields use Octokit's types; only the envelope is validated.
      yield* Effect.promise(() => webhooks.receive(delivery as WebhookEvent));
      return c.body(null, 200);
    }).pipe(
      Effect.catch((error) => Effect.succeed(c.json({ error }, 400))),
    ),
  ));

export default app;
