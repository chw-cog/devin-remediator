import { type Cause, Context, Effect, flow, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  type HttpBody,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { AppConfig } from "./config.ts";

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
  status_detail: Schema.optional(Schema.NullOr(Schema.Literals([
    "working",
    "waiting_for_user",
    "waiting_for_approval",
    "finished",
    "inactivity",
    "user_request",
    "usage_limit_exceeded",
    "out_of_credits",
    "out_of_quota",
    "no_quota_allocation",
    "payment_declined",
    "org_usage_limit_exceeded",
    "user_usage_limit_exceeded",
    "total_session_limit_exceeded",
    "error",
  ]))),
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
  structured_output: Schema.optional(Schema.NullOr(Schema.JsonObject)),
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

export type SessionState = {
  readonly status: "running" | "succeeded" | "failed";
  readonly pullRequestUrls: ReadonlyArray<string>;
};

export function interpretSession(session: DevinSession): SessionState {
  let status: SessionState["status"];
  switch (session.status) {
    case "error":
    case "suspended":
      status = "failed";
      break;
    case "exit":
      status = session.status_detail === "finished" ? "succeeded" : "failed";
      break;
    case "running":
      status = session.status_detail === "finished" ? "succeeded" : "running";
      break;
    case "new":
    case "claimed":
    case "resuming":
      status = "running";
      break;
  }
  return {
    status,
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
  end_cursor: Schema.optional(Schema.NullOr(Schema.String)),
  total: Schema.optional(Schema.NullOr(Schema.Int)),
});

const RecoverySessionPage = Schema.Struct({
  items: Schema.Array(DevinSession),
  has_next_page: Schema.Boolean,
  end_cursor: Schema.NullOr(Schema.NonEmptyString),
});

export class DevinLookupError extends Schema.TaggedError<DevinLookupError>()(
  "DevinLookupError",
  { cause: Schema.Defect() },
) {}

const decodeTag = Schema.decodeUnknownEffect(Schema.NonEmptyString);

const decodeSessionIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(200)),
);
const encodeSessionBody = HttpClientRequest.schemaBodyJson(CreateSessionParams);

export class DevinClient extends Context.Service<DevinClient, {
  readonly createSession: (params: CreateSessionParams) => Effect.Effect<
    DevinSession,
    DevinSubmissionError
  >;
  readonly getSession: (id: string) => Effect.Effect<
    SessionState,
    HttpClientError.HttpClientError | Schema.SchemaError | Cause.TimeoutError
  >;
  readonly listSessions: (session_ids: ReadonlyArray<string>) => Effect.Effect<
    ReadonlyArray<DevinSession>,
    HttpClientError.HttpClientError | Schema.SchemaError
  >;
  readonly findSessionsByTag: (tag: string) => Effect.Effect<
    ReadonlyArray<DevinSession>,
    DevinLookupError
  >;
}>()("devin-remediator/DevinClient") {
  static readonly layer = Layer.effect(
    DevinClient,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      const baseUrl = `https://api.devin.ai/v3/organizations/${
        encodeURIComponent(config.devinOrganizationId)
      }`;
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(flow(
          HttpClientRequest.prependUrl(baseUrl),
          HttpClientRequest.bearerToken(config.devinApiKey),
          HttpClientRequest.acceptJson,
        )),
        HttpClient.filterStatusOk,
      );

      const createSession = Effect.fn("DevinClient.createSession")(
        (params: CreateSessionParams) =>
          encodeSessionBody(HttpClientRequest.post("/sessions"), params).pipe(
            Effect.flatMap(client.execute),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinSession)),
            Effect.timeout("30 seconds"),
            Effect.mapError(submissionError),
          ),
      );

      const getSession = Effect.fn("DevinClient.getSession")((id: string) =>
        client.get(`/sessions/${encodeURIComponent(id)}`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinSession)),
          Effect.map(interpretSession),
          Effect.timeout("30 seconds"),
        )
      );

      const listSessions = Effect.fn("DevinClient.listSessions")(
        (session_ids: ReadonlyArray<string>) =>
          decodeSessionIds(session_ids).pipe(
            Effect.flatMap((ids) =>
              ids.length === 0 ? Effect.succeed([]) : client.get("/sessions", {
                urlParams: { session_ids: ids, first: 200 },
              }).pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionPage)),
                Effect.map((page) => page.items),
              )
            ),
          ),
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
          return [...matches.values()];
        },
        Effect.timeout("30 seconds"),
        Effect.mapError((cause) => new DevinLookupError({ cause })),
      );

      return DevinClient.of({
        createSession,
        getSession,
        listSessions,
        findSessionsByTag,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
