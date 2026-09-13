import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { type Env, withConfig } from "./config.ts";
import { EventHandler } from "./event_handler.ts";

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

const app = new Hono<{ Bindings: Env }>();

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

      yield* withConfig(c.env, Effect.succeed);
      const eventHandler = yield* EventHandler;

      // Payload fields use Octokit's types; only the envelope is validated.
      yield* eventHandler.receive(delivery as WebhookEvent);
      return c.body(null, 200);
    }).pipe(
      Effect.provide(EventHandler.layer),
      Effect.catchTag("ConfigError", () =>
        Effect.succeed(c.json({ error: "Invalid server configuration" }, 500))),
      Effect.catchTag("EventHandlerError", () =>
        Effect.succeed(c.json({ error: "Webhook handling failed" }, 500))),
      Effect.catch((error) =>
        Effect.succeed(c.json({ error }, 400))
      ),
    ),
  ));

export default app;
