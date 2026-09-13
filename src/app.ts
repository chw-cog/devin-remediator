import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { WebhookDeliveryHandler } from "./webhook_delivery_handler.ts";

const decodeDelivery = Schema.decodeUnknownEffect(Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  signature: Schema.NonEmptyString,
}));

export const createApp = Effect.gen(function* () {
  const handler = yield* WebhookDeliveryHandler;
  const runPromise = Effect.runPromiseWith(yield* Effect.context());
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/api/v1/webhook", (c) =>
    runPromise(
      Effect.gen(function* () {
        const rawPayload = yield* Effect.tryPromise({
          try: () => c.req.text(),
          catch: () => "Invalid JSON",
        });

        const payload = yield* Effect.tryPromise({
          try: (): Promise<unknown> => c.req.json(),
          catch: () => "Invalid JSON",
        });

        const delivery = yield* decodeDelivery({
          id: c.req.header("x-github-delivery"),
          name: c.req.header("x-github-event"),
          payload,
          signature: c.req.header("x-hub-signature-256"),
        }).pipe(Effect.mapError(() => "Invalid webhook headers or payload"));

        yield* handler.receive({ ...delivery, payload: rawPayload });

        return c.body(null, 200);
      }).pipe(
        Effect.catchTag("WebhookDeliveryHandlerError", () =>
          Effect.succeed(c.json({ error: "Webhook handling failed" }, 500))),
        Effect.catch((error) =>
          Effect.succeed(c.json({ error }, 400))
        ),
      ),
    ));

  return app;
});
