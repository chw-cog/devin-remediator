import * as DenoServices from "@effect/platform-deno/DenoServices";
import {
  Config,
  ConfigProvider,
  Console,
  Effect,
  Layer,
  Logger,
  Option,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { DatabaseClient } from "./database.ts";
import { DevinClient } from "./devin.ts";
import {
  SessionAdminError,
  SessionAdministration,
  type SessionAdminRequest,
} from "./session-administration.ts";

const root = Command.make("session-admin").pipe(
  Command.withSharedFlags({
    db: Flag.String("db").pipe(Flag.withSchema(Schema.NonEmptyString)),
  }),
  Command.withDescription(
    "Local reconciliation only. Remote execution is unchanged; no remote control operations.",
  ),
);
const id = Argument.String("id").pipe(
  Argument.withSchema(Schema.NonEmptyString),
);
const reason = Flag.String("reason").pipe(Flag.withSchema(
  Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(500)),
));
const revision = Flag.String("revision").pipe(
  Flag.withSchema(Schema.NonEmptyString),
);
const remoteId = Flag.String("remote-id").pipe(
  Flag.withSchema(Schema.NonEmptyString),
);

const withAdministration = Effect.fnUntraced(function* <A, E>(
  effect: Effect.Effect<A, E, SessionAdministration>,
) {
  const { db } = yield* root;
  const grace = yield* Config.schema(
    Schema.Int.check(Schema.isGreaterThan(0)),
    "DEVIN_SUBMITTING_TIMEOUT_SECONDS",
  ).pipe(Config.withDefault(60));
  return yield* effect.pipe(
    Effect.provide(
      SessionAdministration.layer(grace).pipe(
        Layer.provide(DatabaseClient.layerWithPath(db)),
      ),
    ),
  );
});
const print = (value: unknown) => Console.log(JSON.stringify(value));
const execute = Effect.fnUntraced(function* (request: SessionAdminRequest) {
  const operation = SessionAdministration.use((admin) => {
    if (request.action === "resolve") return admin.execute(request);
    return Effect.gen(function* () {
      const devinApiKey = yield* Config.String("DEVIN_API_KEY");
      const devinOrganizationId = yield* Config.String("DEVIN_ORGANIZATION_ID");
      return yield* DevinClient.use((client) =>
        admin.execute(request, client.diagnoseSession)
      ).pipe(
        Effect.provide(
          DevinClient.layerWithCredentials({
            devinApiKey,
            devinOrganizationId,
          }),
        ),
      );
    });
  });
  yield* print(yield* withAdministration(operation));
});

export const sessionAdminCommand = root.pipe(Command.withSubcommands([
  Command.make(
    "list",
    {},
    () =>
      withAdministration(SessionAdministration.use((admin) => admin.list)).pipe(
        Effect.flatMap(print),
      ),
  ),
  Command.make(
    "inspect",
    { id },
    ({ id }) =>
      withAdministration(
        SessionAdministration.use((admin) => admin.inspect(id)),
      ).pipe(Effect.flatMap(print)),
  ),
  Command.make(
    "diagnose",
    { id, remoteId: remoteId.pipe(Flag.optional) },
    ({ id, remoteId }) =>
      execute({
        action: "diagnose",
        id,
        remoteId: Option.getOrUndefined(remoteId),
      }),
  ),
  Command.make(
    "associate",
    { id, revision, remoteId, reason },
    (input) => execute({ action: "associate", ...input }),
  ),
  Command.make(
    "resolve",
    { id, revision, reason },
    (input) => execute({ action: "resolve", ...input }),
  ),
  Command.make(
    "resume",
    { id, revision, reason },
    (input) => execute({ action: "resume", ...input }),
  ),
]));

// Shared entrypoint for real argument parsing and test execution; errors never echo inputs.
export const runSessionAdmin = (args: ReadonlyArray<string>) =>
  Command.runWith(sessionAdminCommand, {
    version: "1.0.0",
    renderErrors: false,
  })(args).pipe(
    Effect.as(0),
    Effect.catch((error) =>
      Console.error(JSON.stringify({
        error: error instanceof SessionAdminError
          ? error.code
          : "command_failed",
      })).pipe(Effect.as(1))
    ),
    Effect.provide(DenoServices.layer),
    Effect.provide(Logger.layer([])),
  );

export const sessionAdminEnvironment = (
  get: (name: string) => string | undefined,
) =>
  Object.fromEntries(
    [
      "DEVIN_API_KEY",
      "DEVIN_ORGANIZATION_ID",
      "DEVIN_SUBMITTING_TIMEOUT_SECONDS",
    ].map((name) => [name, get(name)]),
  );

if (import.meta.main) {
  const env = sessionAdminEnvironment((name) => Deno.env.get(name));
  Deno.exitCode = await Effect.runPromise(
    runSessionAdmin(Deno.args).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
    ),
  );
}
