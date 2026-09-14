import {
  type Cause,
  Context,
  Effect,
  flow,
  Layer,
  Option,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  type HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { AppConfig } from "./config.ts";
import { observe } from "./logging.ts";
import {
  decodeRemediationOutput,
  type RemediationOutput,
} from "./remediation-output.ts";

const DevinMode = Schema.Literals([
  "normal",
  "fast",
  "lite",
  "ultra",
  "fusion",
]);

export const CreateSessionParams = Schema.Struct({
  prompt: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  repos: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  tags: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  max_acu_limit: Schema.optional(Schema.NullOr(Schema.Int)),
  devin_mode: Schema.optional(Schema.NullOr(DevinMode)),
  playbook_id: Schema.optional(Schema.NullOr(Schema.String)),
  child_playbook_id: Schema.optional(Schema.NullOr(Schema.String)),
  create_as_user_id: Schema.optional(Schema.NullOr(Schema.String)),
  knowledge_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  secret_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  session_secrets: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    value: Schema.String.check(Schema.isMaxLength(65536)),
    sensitive: Schema.optional(Schema.Boolean),
  })))),
  attachment_urls: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  session_links: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  structured_output_schema: Schema.optional(Schema.NullOr(Schema.JsonObject)),
  structured_output_required: Schema.optional(Schema.NullOr(Schema.Boolean)),
  bypass_approval: Schema.optional(Schema.NullOr(Schema.Boolean)),
  platform: Schema.optional(Schema.NullOr(Schema.String)),
  resumable: Schema.optional(Schema.Boolean),
});

export type CreateSessionParams = typeof CreateSessionParams.Type;

export const CreatePlaybookParams = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  macro: Schema.optional(Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^![A-Za-z0-9_-]+$/)),
  )),
  structured_output_schema: Schema.optional(Schema.NullOr(Schema.JsonObject)),
});

export type CreatePlaybookParams = typeof CreatePlaybookParams.Type;

export const DevinPlaybook = Schema.Struct({
  playbook_id: Schema.NonEmptyString,
  title: Schema.String,
  body: Schema.String,
  macro: Schema.NullOr(Schema.String),
  created_by: Schema.String,
  updated_by: Schema.String,
  created_at: Schema.Int,
  updated_at: Schema.Int,
  access_type: Schema.Literals(["enterprise", "org"]),
  org_id: Schema.NullOr(Schema.String),
  structured_output_schema: Schema.optional(Schema.NullOr(Schema.JsonObject)),
});

export type DevinPlaybook = typeof DevinPlaybook.Type;

export const DevinSession = Schema.Struct({
  session_id: Schema.NonEmptyString,
  url: Schema.String,
  status: Schema.Literals([
    "new",
    "claimed",
    "running",
    "exit",
    "error",
    "suspended",
    "resuming",
  ]),
  status_detail: Schema.optional(Schema.NullOr(Schema.String)),
  org_id: Schema.String,
  created_at: Schema.Int,
  updated_at: Schema.Int,
  acus_consumed: Schema.Number,
  tags: Schema.Array(Schema.String),
  pull_requests: Schema.Array(Schema.Struct({
    pr_url: Schema.String,
    pr_state: Schema.NullOr(Schema.String),
  })),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  structured_output: Schema.optional(Schema.Unknown),
  devin_mode: Schema.optional(Schema.NullOr(DevinMode)),
  is_archived: Schema.optional(Schema.Boolean),
  automation_id: Schema.optional(Schema.NullOr(Schema.String)),
  parent_session_id: Schema.optional(Schema.NullOr(Schema.String)),
  child_session_ids: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.String)),
  ),
  playbook_id: Schema.optional(Schema.NullOr(Schema.String)),
  user_id: Schema.optional(Schema.NullOr(Schema.String)),
  service_user_id: Schema.optional(Schema.NullOr(Schema.String)),
  origin: Schema.optional(Schema.NullOr(Schema.String)),
  category: Schema.optional(Schema.NullOr(Schema.String)),
  subcategory: Schema.optional(Schema.NullOr(Schema.String)),
});

export type DevinSession = typeof DevinSession.Type;

export const SessionAnalysis = Schema.JsonObject;
export type SessionAnalysis = typeof SessionAnalysis.Type;

export const DevinSessionWithInsights = Schema.Struct({
  ...DevinSession.fields,
  num_devin_messages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  num_user_messages: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  session_size: Schema.Literals(["xs", "s", "m", "l", "xl"]),
  analysis: Schema.optional(Schema.NullOr(SessionAnalysis)),
});
export type DevinSessionWithInsights = typeof DevinSessionWithInsights.Type;

export type ProviderLifecycle =
  | "active"
  | "needs_input"
  | "needs_approval"
  | "paused"
  | "needs_intervention"
  | "completed"
  | "closed";

export type SessionState = {
  readonly status: ProviderLifecycle;
  readonly activeWork: boolean | null;
  readonly output: RemediationOutput | null;
  readonly pullRequestUrls: ReadonlyArray<string>;
};

const budgetReasons = new Set([
  "usage_limit_exceeded",
  "out_of_credits",
  "out_of_quota",
  "no_quota_allocation",
  "payment_declined",
  "org_usage_limit_exceeded",
  "user_usage_limit_exceeded",
  "total_session_limit_exceeded",
]);

export function continuationWindowElapsed(
  createdAtSeconds: number | null,
  nowMillis: number,
): boolean | null {
  return createdAtSeconds === null
    ? null
    : nowMillis >= (createdAtSeconds + 30 * 24 * 60 * 60) * 1000;
}

export function interpretSession(session: DevinSession): SessionState {
  let status: ProviderLifecycle = "needs_intervention";
  let activeWork: boolean | null = null;
  const detail = session.status_detail;
  if (session.is_archived === true) {
    status = "closed";
    activeWork = false;
  } else if (["new", "claimed", "resuming"].includes(session.status)) {
    status = "active";
    activeWork = true;
  } else if (session.status === "running") {
    switch (detail) {
      case "waiting_for_user":
        status = "needs_input";
        activeWork = false;
        break;
      case "waiting_for_approval":
        status = "needs_approval";
        activeWork = false;
        break;
      case "finished":
        status = "completed";
        activeWork = false;
        break;
      case "working":
      case null:
      case undefined:
        status = "active";
        activeWork = true;
        break;
    }
  } else if (session.status === "exit" && detail === "finished") {
    status = "completed";
    activeWork = false;
  } else if (session.status === "suspended") {
    if (detail === "inactivity" || detail === "user_request") {
      status = "paused";
      activeWork = false;
    } else if (detail != null && budgetReasons.has(detail)) {
      activeWork = false;
    }
  }
  const decoded = decodeRemediationOutput(session.structured_output);
  return {
    status,
    activeWork,
    output: Option.isSome(decoded) ? decoded.value : null,
    pullRequestUrls: session.pull_requests.map((pr) => pr.pr_url),
  };
}

const PullRequestUrl = Schema.String.check(
  Schema.isPattern(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/),
);

export function findPullRequestNumber(
  urls: ReadonlyArray<string>,
  repo: string,
): number | null {
  for (const url of urls) {
    if (!Schema.is(PullRequestUrl)(url)) continue;
    const parts = new URL(url).pathname.split("/");
    if (`${parts[1]}/${parts[2]}`.toLowerCase() !== repo.toLowerCase()) {
      continue;
    }
    const number = Number(parts[4]);
    if (Schema.is(Schema.Int)(number)) return number;
  }
  return null;
}

export class DevinSubmissionError extends Schema.TaggedError<
  DevinSubmissionError
>()("DevinSubmissionError", {
  disposition: Schema.Literals(["retryable", "permanent", "ambiguous"]),
  httpStatus: Schema.optional(Schema.Int),
}) {}

function submissionError(
  error:
    | HttpBody.HttpBodyError
    | HttpClientError.HttpClientError
    | Schema.SchemaError
    | { readonly _tag: "TimeoutError" },
): DevinSubmissionError {
  if (error._tag === "HttpBodyError") {
    return new DevinSubmissionError({ disposition: "permanent" });
  }
  if (
    error._tag === "HttpClientError" &&
    error.reason._tag === "StatusCodeError"
  ) {
    const httpStatus = error.reason.response.status;
    return new DevinSubmissionError({
      httpStatus,
      disposition: httpStatus === 429
        ? "retryable"
        : httpStatus === 408 || httpStatus >= 500
        ? "ambiguous"
        : "permanent",
    });
  }
  return new DevinSubmissionError({ disposition: "ambiguous" });
}

const SessionPage = Schema.Struct({
  items: Schema.Array(DevinSession),
  has_next_page: Schema.optional(Schema.Boolean),
  end_cursor: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
  total: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RecoverySessionPage = Schema.Struct({
  items: Schema.Array(DevinSession),
  has_next_page: Schema.Boolean,
  end_cursor: Schema.NullOr(Schema.NonEmptyString),
});

const InsightsPage = Schema.Struct({
  items: Schema.Array(DevinSessionWithInsights),
  has_next_page: Schema.optional(Schema.Boolean),
  end_cursor: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});

const InsightsGeneration = Schema.Struct({
  session_id: Schema.NonEmptyString,
  status: Schema.Literals(["started", "already_exists"]),
});

const PlaybookPage = Schema.Struct({
  items: Schema.Array(DevinPlaybook),
  has_next_page: Schema.optional(Schema.Boolean),
  end_cursor: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
});

export class DevinLookupError extends Schema.TaggedError<DevinLookupError>()(
  "DevinLookupError",
  { cause: Schema.Defect() },
) {}

export type SessionDiagnostic =
  | {
    readonly outcome: "found";
    readonly session: DevinSession;
    readonly httpStatus: number;
  }
  | {
    readonly outcome:
      | "not_found"
      | "authentication"
      | "authorization"
      | "rate_limit"
      | "temporary"
      | "invalid_response";
    readonly httpStatus?: number;
  };

const decodeTag = Schema.decodeUnknownEffect(Schema.NonEmptyString);

export const sessionBatchSize = 200;

const decodeSessionIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.NonEmptyString).check(
    Schema.isMaxLength(sessionBatchSize),
  ),
);
const encodeSessionBody = HttpClientRequest.schemaBodyJson(CreateSessionParams);
const encodePlaybookBody = HttpClientRequest.schemaBodyJson(
  CreatePlaybookParams,
);

class DevinCredentials extends Context.Service<
  DevinCredentials,
  Pick<AppConfig, "devinApiKey" | "devinOrganizationId">
>()("devin-remediator/DevinCredentials") {}

export class DevinClient extends Context.Service<DevinClient, {
  readonly createPlaybook: (params: CreatePlaybookParams) => Effect.Effect<
    DevinPlaybook,
    DevinSubmissionError
  >;
  readonly findPlaybookByMacro: (macro: string) => Effect.Effect<
    DevinPlaybook | undefined,
    DevinSubmissionError
  >;
  readonly createSession: (params: CreateSessionParams) => Effect.Effect<
    DevinSession,
    DevinSubmissionError
  >;
  readonly diagnoseSession: (
    sessionId: string,
  ) => Effect.Effect<SessionDiagnostic>;
  readonly listSessions: (session_ids: ReadonlyArray<string>) => Effect.Effect<
    ReadonlyArray<DevinSession>,
    | HttpClientError.HttpClientError
    | Schema.SchemaError
    | Cause.TimeoutError
    | DevinLookupError
  >;
  readonly findSessionsByTag: (tag: string) => Effect.Effect<
    ReadonlyArray<DevinSession>,
    DevinLookupError
  >;
  readonly listSessionsWithInsights: (
    sessionIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<DevinSessionWithInsights>, DevinLookupError>;
  readonly generateSessionInsights: (
    sessionId: string,
  ) => Effect.Effect<typeof InsightsGeneration.Type, DevinLookupError>;
}>()("devin-remediator/DevinClient") {
  private static readonly clientLayer = Layer.effect(
    DevinClient,
    Effect.gen(function* () {
      const config = yield* DevinCredentials;
      const baseUrl = `https://api.devin.ai/v3/organizations/${
        encodeURIComponent(config.devinOrganizationId)
      }`;
      const observeClient = (operation: string) =>
        flow(
          observe("DevinClient", operation),
          Effect.annotateLogs({
            devin_organization_id: config.devinOrganizationId,
          }),
        );
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(flow(
          HttpClientRequest.prependUrl(baseUrl),
          HttpClientRequest.bearerToken(config.devinApiKey),
          HttpClientRequest.acceptJson,
        )),
        HttpClient.filterStatusOk,
        HttpClient.tap((response) =>
          Effect.logDebug("devin.http_response").pipe(
            Effect.annotateLogs({
              http_status: response.status,
              http_method: response.request.method,
            }),
          )
        ),
      );

      const createPlaybook = Effect.fn("DevinClient.createPlaybook")(
        (params: CreatePlaybookParams) =>
          encodePlaybookBody(HttpClientRequest.post("/playbooks"), params).pipe(
            Effect.flatMap(client.execute),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinPlaybook)),
            Effect.timeout("30 seconds"),
            Effect.mapError(submissionError),
          ),
        observeClient("createPlaybook"),
      );

      const findPlaybookByMacro = Effect.fn("DevinClient.findPlaybookByMacro")(
        function* (macro: string) {
          let match: DevinPlaybook | undefined;
          let after: string | undefined;
          const cursors = new Set<string>();
          do {
            const page = yield* client.get("/playbooks", {
              urlParams: {
                first: 200,
                ...(after === undefined ? {} : { after }),
              },
            }).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(PlaybookPage)),
              Effect.mapError(submissionError),
            );
            for (const playbook of page.items) {
              if (playbook.macro !== macro) continue;
              if (match && match.playbook_id !== playbook.playbook_id) {
                return yield* new DevinSubmissionError({
                  disposition: "permanent",
                });
              }
              match = playbook;
            }
            if (!page.has_next_page) break;
            if (page.end_cursor == null || cursors.has(page.end_cursor)) {
              return yield* new DevinSubmissionError({
                disposition: "retryable",
              });
            }
            after = page.end_cursor;
            cursors.add(after);
          } while (true);
          return match;
        },
        Effect.timeout("30 seconds"),
        Effect.catchTag(
          "TimeoutError",
          () =>
            Effect.fail(new DevinSubmissionError({ disposition: "retryable" })),
        ),
        observeClient("findPlaybookByMacro"),
      );

      const createSession = Effect.fn("DevinClient.createSession")(
        (params: CreateSessionParams) =>
          encodeSessionBody(HttpClientRequest.post("/sessions"), params).pipe(
            Effect.flatMap(client.execute),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinSession)),
            Effect.timeout("30 seconds"),
            Effect.mapError(submissionError),
          ),
        observeClient("createSession"),
        (effect, params) =>
          effect.pipe(
            Effect.annotateLogs({ playbook_id: params.playbook_id }),
          ),
      );

      const diagnoseSession = Effect.fn("DevinClient.diagnoseSession")(
        function* (sessionId: string): Effect.fn.Return<SessionDiagnostic> {
          const result = yield* decodeTag(sessionId).pipe(
            Effect.flatMap(() =>
              client.get(`/sessions/${encodeURIComponent(sessionId)}`)
            ),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinSession)),
            Effect.timeout("10 seconds"),
            Effect.result,
          );
          if (result._tag === "Success") {
            return result.success.session_id === sessionId &&
                result.success.org_id === config.devinOrganizationId
              ? { outcome: "found", session: result.success, httpStatus: 200 }
              : { outcome: "invalid_response", httpStatus: 200 };
          }
          const error = result.failure;
          if (
            error._tag === "HttpClientError" &&
            error.reason._tag === "StatusCodeError"
          ) {
            const httpStatus = error.reason.response.status;
            return {
              httpStatus,
              outcome: httpStatus === 404
                ? "not_found"
                : httpStatus === 401
                ? "authentication"
                : httpStatus === 403
                ? "authorization"
                : httpStatus === 429
                ? "rate_limit"
                : httpStatus === 408 || httpStatus >= 500
                ? "temporary"
                : "invalid_response",
            };
          }
          return {
            outcome: error._tag === "SchemaError"
              ? "invalid_response"
              : "temporary",
          };
        },
        observeClient("diagnoseSession"),
      );

      const listSessions = Effect.fn("DevinClient.listSessions")(
        function* (session_ids: ReadonlyArray<string>) {
          const ids = yield* decodeSessionIds(session_ids);
          if (ids.length === 0) return [];
          const sessions = new Map<string, DevinSession>();
          for (const is_archived of [false, true]) {
            const remaining = ids.filter((id) => !sessions.has(id));
            if (remaining.length === 0) break;
            const requestedPage = new Set(remaining);
            let after: string | undefined;
            const cursors = new Set<string>();
            do {
              const page = yield* client.get("/sessions", {
                urlParams: {
                  session_ids: remaining,
                  is_archived,
                  first: sessionBatchSize,
                  ...(after === undefined ? {} : { after }),
                },
              }).pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionPage)),
              );
              for (const session of page.items) {
                if (
                  requestedPage.has(session.session_id) &&
                  session.updated_at >=
                    (sessions.get(session.session_id)?.updated_at ?? -Infinity)
                ) {
                  sessions.set(session.session_id, session);
                }
              }
              if (!page.has_next_page) break;
              if (page.end_cursor == null || cursors.has(page.end_cursor)) {
                return yield* new DevinLookupError({
                  cause:
                    "Incomplete session lookup: missing or repeated cursor",
                });
              }
              after = page.end_cursor;
              cursors.add(after);
            } while (true);
          }
          return [...sessions.values()];
        },
        Effect.timeout("30 seconds"),
        observeClient("listSessions"),
        (effect, ids) =>
          effect.pipe(Effect.annotateLogs({ session_count: ids.length })),
      );

      const findSessionsByTag = Effect.fn("DevinClient.findSessionsByTag")(
        function* (tag: string) {
          yield* decodeTag(tag);
          const matches = new Map<string, DevinSession>();
          for (const is_archived of [false, true]) {
            let after: string | undefined;
            const cursors = new Set<string>();
            do {
              const page = yield* client.get("/sessions", {
                urlParams: {
                  tags: [tag],
                  first: 200,
                  is_archived,
                  ...(after === undefined ? {} : { after }),
                },
              }).pipe(
                Effect.flatMap(
                  HttpClientResponse.schemaBodyJson(RecoverySessionPage),
                ),
              );
              yield* Effect.logDebug("devin.recovery_page").pipe(
                Effect.annotateLogs({
                  is_archived,
                  item_count: page.items.length,
                  has_next_page: page.has_next_page,
                }),
              );
              for (const session of page.items) {
                if (session.tags.includes(tag)) {
                  matches.set(session.session_id, session);
                }
              }
              if (!page.has_next_page) break;
              if (
                page.end_cursor === null || cursors.has(page.end_cursor)
              ) {
                return yield* new DevinLookupError({
                  cause:
                    "Incomplete session lookup: missing or repeated cursor",
                });
              }
              after = page.end_cursor;
              cursors.add(after);
            } while (true);
          }
          yield* Effect.logDebug("devin.tag_lookup_completed").pipe(
            Effect.annotateLogs({ match_count: matches.size }),
          );
          return [...matches.values()];
        },
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => new DevinLookupError({ cause })),
        observeClient("findSessionsByTag"),
        (effect, tag) =>
          effect.pipe(Effect.annotateLogs({ delivery_tag: tag })),
      );

      const listSessionsWithInsights = Effect.fn(
        "DevinClient.listSessionsWithInsights",
      )(
        function* (sessionIds: ReadonlyArray<string>) {
          const ids = yield* decodeSessionIds(sessionIds);
          if (ids.length === 0) return [];
          const requested = new Set(ids);
          const matches = new Map<string, DevinSessionWithInsights>();
          let after: string | undefined;
          const cursors = new Set<string>();
          do {
            const page = yield* client.get("/sessions/insights", {
              urlParams: {
                session_ids: ids,
                first: 200,
                ...(after === undefined ? {} : { after }),
              },
            }).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(InsightsPage)),
            );
            for (const session of page.items) {
              if (requested.has(session.session_id)) {
                matches.set(session.session_id, session);
              }
            }
            if (!page.has_next_page) break;
            if (page.end_cursor == null || cursors.has(page.end_cursor)) {
              return yield* new DevinLookupError({
                cause: "Incomplete insights lookup: missing or repeated cursor",
              });
            }
            after = page.end_cursor;
            cursors.add(after);
          } while (true);
          return [...matches.values()];
        },
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => new DevinLookupError({ cause })),
        observeClient("listSessionsWithInsights"),
      );

      const generateSessionInsights = Effect.fn(
        "DevinClient.generateSessionInsights",
      )(
        (sessionId: string) =>
          client.post(
            `/sessions/${encodeURIComponent(sessionId)}/insights/generate`,
          ).pipe(
            Effect.flatMap(
              HttpClientResponse.schemaBodyJson(InsightsGeneration),
            ),
            Effect.flatMap((response) =>
              response.session_id === sessionId
                ? Effect.succeed(response)
                : Effect.fail(
                  new DevinLookupError({
                    cause:
                      "Insights generation returned a different session ID",
                  }),
                )
            ),
          ),
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => new DevinLookupError({ cause })),
        observeClient("generateSessionInsights"),
        (effect, sessionId) =>
          effect.pipe(Effect.annotateLogs({ devin_session_id: sessionId })),
      );

      return DevinClient.of({
        createPlaybook,
        findPlaybookByMacro,
        createSession,
        listSessions,
        diagnoseSession,
        findSessionsByTag,
        listSessionsWithInsights,
        generateSessionInsights,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

  static layerWithCredentials(
    config: Pick<AppConfig, "devinApiKey" | "devinOrganizationId">,
  ) {
    return DevinClient.clientLayer.pipe(
      Layer.provide(Layer.succeed(DevinCredentials, config)),
    );
  }

  static readonly layer = Layer.unwrap(AppConfig.pipe(
    Effect.map((config) => DevinClient.layerWithCredentials(config)),
  ));
}
