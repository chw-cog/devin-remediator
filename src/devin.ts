import { Effect, flow, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

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
  session_id: Schema.String,
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

const SessionPage = Schema.Struct({
  items: Schema.Array(DevinSession),
  has_next_page: Schema.optional(Schema.Boolean),
  end_cursor: Schema.optional(Schema.NullOr(Schema.String)),
  total: Schema.optional(Schema.NullOr(Schema.Int)),
});

const decodeSessionIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(200)),
);
const encodeSessionBody = HttpClientRequest.schemaBodyJson(CreateSessionParams);

export class DevinClient {
  readonly #client: Effect.Effect<HttpClient.HttpClient>;

  constructor(api_key: string, organization_id: string) {
    const baseUrl = `https://api.devin.ai/v3/organizations/${
      encodeURIComponent(organization_id)
    }`;
    this.#client = HttpClient.HttpClient.pipe(
      Effect.map((client) =>
        client.pipe(
          HttpClient.mapRequest(flow(
            HttpClientRequest.prependUrl(baseUrl),
            HttpClientRequest.bearerToken(api_key),
            HttpClientRequest.acceptJson,
          )),
          HttpClient.filterStatusOk,
        )
      ),
      Effect.provide(FetchHttpClient.layer),
    );
  }

  readonly #execute = (request: HttpClientRequest.HttpClientRequest) =>
    this.#client.pipe(Effect.flatMap((client) => client.execute(request)));

  readonly createSession = Effect.fn("DevinClient.createSession")(
    (params: CreateSessionParams) =>
      encodeSessionBody(HttpClientRequest.post("/sessions"), params).pipe(
        Effect.flatMap(this.#execute),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(DevinSession)),
      ),
  );

  readonly listSessions = Effect.fn("DevinClient.listSessions")(
    (session_ids: ReadonlyArray<string>) =>
      decodeSessionIds(session_ids).pipe(
        Effect.flatMap((ids) =>
          ids.length === 0
            ? Effect.succeed([])
            : this.#execute(HttpClientRequest.get("/sessions", {
              urlParams: { session_ids: ids, first: 200 },
            })).pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(SessionPage)),
              Effect.map((page) => page.items),
            )
        ),
      ),
  );
}
