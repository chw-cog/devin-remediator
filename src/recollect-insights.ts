import * as DenoRuntime from "@effect/platform-deno/DenoRuntime";
import * as DenoServices from "@effect/platform-deno/DenoServices";
import { and, eq } from "drizzle-orm";
import { Console, Effect, References, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { type AppDatabase, DatabaseClient, DatabaseError } from "./database.ts";
import type { SessionRecord } from "./devin-session-repository.ts";
import { devinSessions } from "./schemas.ts";

export class RecollectionError extends Schema.TaggedError<RecollectionError>()(
  "RecollectionError",
  { message: Schema.String },
) {}

const sessionId = Schema.String.check(Schema.isPattern(/^\S+$/, {
  message: "Expected a nonempty local session record ID without whitespace",
}));

const readSession = Effect.fnUntraced(function* (
  db: Pick<AppDatabase, "select">,
  sessionRecordId: string,
) {
  const id = yield* Schema.decodeUnknownEffect(sessionId)(sessionRecordId).pipe(
    Effect.mapError(() =>
      new RecollectionError({
        message:
          "A nonempty local session record ID without whitespace is required.",
      })
    ),
  );
  const [session] = yield* db.select().from(devinSessions).where(
    eq(devinSessions.id, id),
  );
  if (!session) {
    return yield* new RecollectionError({
      message: "Local session record not found.",
    });
  }
  return session;
});

const readout = (session: SessionRecord) => ({
  sessionRecordId: session.id,
  devinSessionId: session.devinSessionId,
  acusConsumed: session.acusConsumed,
  completionObservedAt: session.completionObservedAt,
  analysisStatus: session.analysisStatus,
  analysisAttempts: session.analysisAttempts,
  analysisGeneration: session.analysisGeneration,
  analysisNextAttemptAt: session.analysisNextAttemptAt,
  collectionDiagnostic: session.completionObservedAt === null
    ? "completion_not_observed"
    : session.analysisStatus !== "unavailable"
    ? session.analysisStatus
    : session.analysisReason?.startsWith("Attempts exhausted:")
    ? "local_attempts_exhausted"
    : session.analysisReason === "session has no Devin messages"
    ? "no_devin_messages_observed"
    : "unavailable_reason_unknown",
});

export const inspectSessionInsights = Effect.fn("inspectSessionInsights")(
  function* (sessionRecordId: string) {
    const { db } = yield* DatabaseClient;
    return readout(yield* readSession(db, sessionRecordId));
  },
  Effect.mapError((cause) =>
    cause._tag === "RecollectionError" ? cause : new DatabaseError({ cause })
  ),
);

export const recollectInsights = Effect.fn("recollectInsights")(
  function* (sessionRecordId: string) {
    const { db } = yield* DatabaseClient;
    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const session = yield* readSession(tx, sessionRecordId);
        if (session.devinSessionId === null) {
          return yield* new RecollectionError({
            message: "Session has no associated remote Devin session.",
          });
        }
        if (session.completionObservedAt === null) {
          return yield* new RecollectionError({
            message:
              "Session completion has never been observed; insights cannot be recollected.",
          });
        }
        const previousDiagnostic = readout(session).collectionDiagnostic;
        if (session.analysisStatus !== "unavailable") {
          return {
            ...readout(session),
            outcome: session.analysisStatus === "pending"
              ? "already_pending" as const
              : "already_collected" as const,
            previousDiagnostic,
          };
        }
        // A new generation prevents old claims matching the reset attempt counter (ABA).
        const [updated] = yield* tx.update(devinSessions).set({
          analysisStatus: "pending",
          analysisAttempts: 0,
          analysisGeneration: session.analysisGeneration + 1,
          analysisNextAttemptAt: "1970-01-01T00:00:00.000Z",
          analysisReason: null,
        }).where(and(
          eq(devinSessions.id, session.id),
          eq(devinSessions.analysisStatus, "unavailable"),
          eq(devinSessions.analysisGeneration, session.analysisGeneration),
        )).returning();
        if (!updated) {
          return yield* new RecollectionError({
            message:
              "Analysis changed concurrently; inspect the session and retry.",
          });
        }
        return {
          ...readout(updated),
          outcome: "rescheduled" as const,
          previousDiagnostic,
        };
      })
    );
  },
  Effect.mapError((cause) =>
    cause._tag === "RecollectionError" ? cause : new DatabaseError({ cause })
  ),
);

export const recollectInsightsCommand = Command.make(
  "recollect-insights",
  {
    databasePath: Flag.File("db", { mustExist: true }).pipe(
      Flag.withDescription("Existing local SQLite database file"),
    ),
    sessionRecordId: Flag.String("session-id").pipe(
      Flag.withSchema(sessionId),
      Flag.withDescription(
        "Local devin_sessions.id, not the provider session ID",
      ),
    ),
    inspect: Flag.Boolean("inspect").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Show safe usage and collection state without rescheduling",
      ),
    ),
  },
  Effect.fnUntraced(function* ({ databasePath, sessionRecordId, inspect }) {
    const result = yield* (inspect
      ? inspectSessionInsights(sessionRecordId)
      : recollectInsights(sessionRecordId)).pipe(
        Effect.provide(DatabaseClient.layerWithPath(databasePath)),
        Effect.provideService(References.MinimumLogLevel, "None"),
      );
    yield* Console.log(JSON.stringify(result));
  }),
).pipe(Command.withDescription(
  "Restore one bounded local insights collection opportunity. Local exhaustion or observed ineligibility is not proof of permanent provider ineligibility.",
));

export const runRecollectInsights = Command.runWith(recollectInsightsCommand, {
  version: "1.0.0",
});

if (import.meta.main) {
  runRecollectInsights(Deno.args).pipe(
    Effect.provide(DenoServices.layer),
    Effect.catchTag(
      "RecollectionError",
      (error) =>
        Console.error(error.message).pipe(Effect.andThen(Effect.sync(() => {
          Deno.exitCode = 1;
        }))),
    ),
    Effect.catchTag(
      "DatabaseError",
      () =>
        Console.error(
          "Local database operation failed; check the file, permissions, and migrations.",
        ).pipe(
          Effect.andThen(Effect.sync(() => {
            Deno.exitCode = 1;
          })),
        ),
    ),
    DenoRuntime.runMain,
  );
}
