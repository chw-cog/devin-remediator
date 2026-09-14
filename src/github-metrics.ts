import { DateTime, Effect, Result, Schema } from "effect";
import { GitHubClient } from "./github.ts";

const IssueCount = Schema.Struct({
  total_count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  incomplete_results: Schema.Literal(false),
});

const PullRequest = Schema.Struct({
  created_at: Schema.DateTimeUtcFromString,
  merged_at: Schema.NullOr(Schema.DateTimeUtcFromString),
});

export interface GitHubMetrics {
  readonly checkedAt: string;
  readonly repositoryIssues: number | null;
  readonly mergedPrNumbers: ReadonlyArray<number>;
  readonly unknownPrNumbers: ReadonlyArray<number>;
  readonly pullRequests: ReadonlyMap<number, typeof PullRequest.Type>;
}

export const readGitHubMetrics = Effect.fn("readGitHubMetrics")(
  function* (repository: string, prNumbers: ReadonlyArray<number>) {
    const github = yield* GitHubClient;
    const [owner, repo] = repository.split("/");
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const auth = yield* Effect.gen(function* () {
      return (yield* github.cached) ?? (yield* github.authenticate());
    }).pipe(Effect.timeout("5 seconds"), Effect.result);
    if (Result.isFailure(auth)) {
      return {
        checkedAt,
        repositoryIssues: null,
        mergedPrNumbers: [],
        unknownPrNumbers: prNumbers,
        pullRequests: new Map<number, typeof PullRequest.Type>(),
      } satisfies GitHubMetrics;
    }
    const client = auth.success;
    const request = Effect.fn("GitHubMetrics.request")(
      function* (path: string, params: Record<string, string | number>) {
        return yield* Effect.tryPromise({
          try: (signal) =>
            client.request(path, { ...params, request: { signal } }),
          catch: () => "github_unavailable" as const,
        });
      },
      Effect.timeout("5 seconds"),
    );
    const [issues, pulls] = yield* Effect.all([
      request("GET /search/issues", {
        q: `repo:${repository} is:issue`,
        per_page: 1,
      }).pipe(
        Effect.flatMap((response) =>
          Schema.decodeUnknownEffect(IssueCount)(response.data)
        ),
        Effect.result,
      ),
      Effect.forEach(
        prNumbers,
        (number) =>
          request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner,
            repo,
            pull_number: number,
          }).pipe(
            Effect.flatMap((response) =>
              Schema.decodeUnknownEffect(PullRequest)(response.data)
            ),
            Effect.result,
            Effect.map((result) => ({ number, result })),
          ),
        { concurrency: 4 },
      ).pipe(
        Effect.timeout("10 seconds"),
        Effect.result,
      ),
    ], { concurrency: 2 });
    const mergedPrNumbers: number[] = [];
    const unknownPrNumbers: number[] = [];
    const pullRequests = new Map<number, typeof PullRequest.Type>();
    if (Result.isFailure(pulls)) {
      unknownPrNumbers.push(...prNumbers);
    } else {
      for (const { number, result } of pulls.success) {
        if (Result.isFailure(result)) unknownPrNumbers.push(number);
        else {
          pullRequests.set(number, result.success);
          if (result.success.merged_at !== null) mergedPrNumbers.push(number);
        }
      }
    }
    if (Result.isFailure(issues) || unknownPrNumbers.length > 0) {
      yield* Effect.logWarning("metrics.github_incomplete");
    }
    return {
      checkedAt,
      repositoryIssues: Result.isSuccess(issues)
        ? issues.success.total_count
        : null,
      mergedPrNumbers,
      unknownPrNumbers,
      pullRequests,
    } satisfies GitHubMetrics;
  },
);
