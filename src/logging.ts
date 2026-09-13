import {
  Cause,
  Clock,
  Config,
  Effect,
  Exit,
  Layer,
  Logger,
  Predicate,
  References,
  Schema,
} from "effect";

export const LoggingLive = Layer.unwrap(
  Config.schema(
    Schema.Literals(["Debug", "Info", "Warn", "Error", "Fatal", "None"]),
    "LOG_LEVEL",
  ).pipe(
    Config.withDefault("Info"),
    Effect.map((level) =>
      Layer.merge(
        Logger.layer([Logger.consoleJson]),
        Layer.succeed(References.MinimumLogLevel, level),
      )
    ),
  ),
);

// Error messages/causes may contain SQL parameters, HTTP headers, or bodies.
// Only copy diagnostic classifications, never serialize the original error.
export const errorFields = (error: unknown): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (
      Predicate.hasProperty(current, "_tag") && typeof current._tag === "string"
    ) {
      fields[depth === 0 ? "error_type" : `cause_type_${depth}`] = current._tag;
    }
    if (
      Predicate.hasProperty(current, "disposition") &&
      (current.disposition === "retryable" ||
        current.disposition === "permanent" ||
        current.disposition === "ambiguous")
    ) {
      fields.disposition = current.disposition;
    }
    if (
      Predicate.hasProperty(current, "httpStatus") &&
      typeof current.httpStatus === "number"
    ) {
      fields.http_status = current.httpStatus;
    }
    if (
      Predicate.hasProperty(current, "reason") &&
      Predicate.hasProperty(current.reason, "_tag") &&
      typeof current.reason._tag === "string"
    ) {
      fields.error_reason = current.reason._tag;
      if (
        Predicate.hasProperty(current.reason, "response") &&
        Predicate.hasProperty(current.reason.response, "status") &&
        typeof current.reason.response.status === "number"
      ) {
        fields.http_status = current.reason.response.status;
      }
    }
    if (!Predicate.hasProperty(current, "cause")) break;
    current = current.cause;
  }
  return fields;
};

export const causeFields = (cause: Cause.Cause<unknown>) => ({
  failure_kind: Cause.hasDies(cause)
    ? "defect"
    : Cause.hasInterrupts(cause)
    ? "interrupted"
    : "failure",
  ...cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" ? [errorFields(reason.error)] : []
  ).reduce((fields, next) => ({ ...fields, ...next }), {}),
});

export const observe =
  (component: string, operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const duration_ms = (yield* Clock.currentTimeMillis) - started;
            yield* Effect.logDebug("operation.completed").pipe(
              Effect.annotateLogs({
                duration_ms,
                outcome: Exit.isSuccess(exit) ? "success" : "failure",
                ...(Exit.isFailure(exit) ? causeFields(exit.cause) : {}),
              }),
            );
          })
        ),
      );
    }).pipe(Effect.annotateLogs({ component, operation }));
