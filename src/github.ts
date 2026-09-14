import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { Context, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AppConfig } from "./config.ts";

const Token = Schema.Struct({
  token: Schema.NonEmptyString,
  expiresAt: Schema.String,
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };

export class GitHubAuthenticationError
  extends Schema.TaggedError<GitHubAuthenticationError>()(
    "GitHubAuthenticationError",
    {},
  ) {}

export class GitHubClient extends Context.Service<GitHubClient, {
  readonly cached: Effect.Effect<Octokit | undefined>;
  readonly authenticate: (
    options?: { readonly fetch?: typeof globalThis.fetch },
  ) => Effect.Effect<Octokit, GitHubAuthenticationError>;
  readonly invalidate: Effect.Effect<void>;
}>()("devin-remediator/GitHubClient") {
  static readonly layer = Layer.effect(
    GitHubClient,
    Effect.gen(function* () {
      const { githubApp } = yield* AppConfig;
      const fetch = yield* FetchHttpClient.Fetch;
      let cached:
        | { readonly client: Octokit; readonly expiresAt: number }
        | undefined;
      const secureFetch =
        (transport: typeof globalThis.fetch): typeof globalThis.fetch =>
        (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : input.toString(),
          );
          if (
            url.origin !== "https://api.github.com" || url.username ||
            url.password || url.hash
          ) return Promise.reject(new GitHubAuthenticationError());
          return transport(input, { ...init, redirect: "error" });
        };
      const authenticate = Effect.fn("GitHubClient.authenticate")(
        function* (options?: { readonly fetch?: typeof globalThis.fetch }) {
          if (githubApp === null) return yield* new GitHubAuthenticationError();
          const token = yield* Effect.tryPromise({
            try: async (signal) => {
              const octokit = new Octokit({
                baseUrl: "https://api.github.com",
                request: {
                  fetch: secureFetch(options?.fetch ?? fetch),
                  signal,
                },
                log: silent,
              });
              const auth = createAppAuth({
                appId: githubApp.appId,
                installationId: githubApp.installationId,
                privateKey: Redacted.value(githubApp.privateKey),
                request: octokit.request,
                log: silent,
              });
              return Schema.decodeUnknownSync(Token)(
                await auth({
                  type: "installation",
                  refresh: true,
                  permissions: { issues: "write" },
                }),
              );
            },
            catch: () => new GitHubAuthenticationError(),
          });
          const expiresAt = yield* Effect.try({
            try: () =>
              DateTime.toEpochMillis(DateTime.makeUnsafe(token.expiresAt)),
            catch: () => new GitHubAuthenticationError(),
          });
          if (
            expiresAt <= DateTime.toEpochMillis(yield* DateTime.now) + 60000
          ) return yield* new GitHubAuthenticationError();
          const client = new Octokit({
            auth: token.token,
            baseUrl: "https://api.github.com",
            request: { fetch: secureFetch(fetch) },
            log: silent,
          });
          cached = { client, expiresAt };
          return client;
        },
      );
      return GitHubClient.of({
        cached: DateTime.now.pipe(
          Effect.map((now) =>
            cached && cached.expiresAt > DateTime.toEpochMillis(now) + 60000
              ? cached.client
              : undefined
          ),
        ),
        authenticate,
        invalidate: Effect.sync(() => {
          cached = undefined;
        }),
      });
    }),
  );
}
