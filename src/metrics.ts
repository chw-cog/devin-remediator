import { eq, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { DashboardConfig } from "./config.ts";
import { DatabaseClient, DatabaseError } from "./database.ts";
import { readGitHubMetrics } from "./github-metrics.ts";
import { GitHubClient } from "./github.ts";
import type { ProviderLifecycle } from "./devin.ts";
import type { RemediationOutcome } from "./remediation-output.ts";
import { devinSessions, githubWebhookDeliveries } from "./schemas.ts";

const decodeLabel = Schema.decodeUnknownOption(Schema.fromJsonString(
  Schema.Struct({
    action: Schema.Literal("labeled"),
    label: Schema.Struct({ name: Schema.Literal("devin") }),
  }),
));

const decodeTitle = Schema.decodeUnknownOption(Schema.fromJsonString(
  Schema.Struct({ issue: Schema.Struct({ title: Schema.String }) }),
));

const sessionUrl = Schema.String.check(Schema.isPattern(
  /^https:\/\/app\.devin\.ai\/sessions\/[A-Za-z0-9_-]+\/?$/,
));

const measuredAcus = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export interface DashboardSession {
  readonly id: string;
  readonly url: string | null;
  readonly issue: {
    readonly number: number | null;
    readonly title: string | null;
    readonly url: string | null;
  };
  readonly lifecycle: ProviderLifecycle | null;
  readonly providerStatus: string | null;
  readonly providerStatusDetail: string | null;
  readonly remediationOutcome: RemediationOutcome | null;
  readonly acus: number | null;
  readonly observedAt: string | null;
}

export interface MetricsSnapshot {
  readonly repository: string;
  readonly generatedAt: string;
  readonly cacheSeconds: number;
  readonly scope: {
    readonly repositoryIssues: "github_all_open_and_closed_issues";
    readonly devinWork: "app_tracked_only";
    readonly trackedSince: string | null;
    readonly prCoverage: "one_same_repository_pr_per_session";
  };
  readonly issues: {
    readonly repositoryTotal: number | null;
    readonly assignedToDevin: number;
    readonly withDevinPr: number;
    readonly withMergedDevinPr: number | null;
  };
  readonly pullRequests: {
    readonly tracked: number;
    readonly merged: number | null;
    readonly confirmedMerged: number;
    readonly unknownMergeState: number;
  };
  readonly usage: {
    readonly unit: "ACU";
    readonly total: number | null;
    readonly averagePerSession: number | null;
    readonly trackedSessions: number;
    readonly measuredSessions: number;
    readonly missingSessions: number;
    readonly oldestObservationAt: string | null;
    readonly latestObservationAt: string | null;
  };
  readonly completion: {
    readonly medianMilliseconds: number | null;
    readonly sampleCount: number;
    readonly excludedSessions: number;
    readonly definition:
      "creation_to_first_observed_completion_including_waiting";
  };
  readonly github: {
    readonly checkedAt: string;
    readonly status: "available" | "partial";
  };
  readonly activeSessionCount: number;
  readonly activeSessions: ReadonlyArray<DashboardSession>;
}

export type Dashboard = NonNullable<Effect.Success<typeof DashboardConfig>> & {
  readonly snapshot: Effect.Effect<MetricsSnapshot, DatabaseError>;
};

export class Metrics extends Context.Service<Metrics, {
  readonly dashboard: Dashboard | null;
}>()("devin-remediator/Metrics") {
  static readonly layer = Layer.effect(
    Metrics,
    Effect.gen(function* () {
      const config = yield* DashboardConfig;
      if (config === null) return Metrics.of({ dashboard: null });
      const { db } = yield* DatabaseClient;
      const github = yield* GitHubClient;
      const snapshot = yield* Effect.gen(function* () {
        const generatedAt = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* db.select({
          delivery: githubWebhookDeliveries,
          session: devinSessions,
        }).from(githubWebhookDeliveries).leftJoin(
          devinSessions,
          eq(
            devinSessions.githubDeliveryId,
            githubWebhookDeliveries.deliveryId,
          ),
        ).where(
          sql`lower(${githubWebhookDeliveries.repo}) = ${config.repository}`,
        ).pipe(
          Effect.mapError((cause) => new DatabaseError({ cause })),
        );
        const assigned = new Set<number>();
        const issuePrs = new Map<number, Set<number>>();
        const tracked = new Map<
          string,
          {
            session: typeof devinSessions.$inferSelect;
            delivery: typeof githubWebhookDeliveries.$inferSelect;
          }
        >();
        const deliveries: string[] = [];
        for (const { delivery, session } of rows) {
          const labeled = delivery.eventName === "issues" &&
            Option.isSome(decodeLabel(delivery.payload));
          if (labeled && delivery.issueNumber !== null) {
            assigned.add(delivery.issueNumber);
            deliveries.push(delivery.insertedAt);
            if (
              session?.prNumber !== null && session?.prNumber !== undefined &&
              session.devinSessionId !== null
            ) {
              const prs = issuePrs.get(delivery.issueNumber) ??
                new Set<number>();
              prs.add(session.prNumber);
              issuePrs.set(delivery.issueNumber, prs);
            }
          }
          if (session?.devinSessionId) {
            tracked.set(session.devinSessionId, { session, delivery });
          }
        }
        const allSessions = [...tracked].map(([id, row]) => ({ id, ...row }));
        const values: number[] = [];
        const durations: number[] = [];
        const observations: string[] = [];
        for (const { session } of allSessions) {
          if (Schema.is(measuredAcus)(session.acusConsumed)) {
            values.push(session.acusConsumed);
          }
          if (session.lastObservedAt !== null) {
            observations.push(session.lastObservedAt);
          }
          if (
            session.providerCreatedAt !== null &&
            session.completionObservedAt !== null
          ) {
            const completion = DateTime.make(session.completionObservedAt);
            if (Option.isSome(completion)) {
              const elapsed = DateTime.toEpochMillis(completion.value) -
                session.providerCreatedAt * 1000;
              if (Number.isFinite(elapsed) && elapsed >= 0) {
                durations.push(elapsed);
              }
            }
          }
        }
        durations.sort((a, b) => a - b);
        observations.sort();
        deliveries.sort();
        const middle = Math.floor(durations.length / 2);
        const median = durations.length === 0
          ? null
          : durations.length % 2 === 1
          ? durations[middle]
          : (durations[middle - 1] + durations[middle]) / 2;
        const total = values.length === 0
          ? null
          : values.reduce((a, b) => a + b, 0);
        const prNumbers = [
          ...new Set([...issuePrs.values()].flatMap((prs) => [...prs])),
        ].sort((a, b) => a - b);
        const remote = yield* readGitHubMetrics(config.repository, prNumbers);
        const merged = new Set(remote.mergedPrNumbers);
        const completeMerges = remote.unknownPrNumbers.length === 0;
        const active = allSessions.filter(({ session }) =>
          session.localOwnership === "tracking" &&
          session.isArchived !== true &&
          session.providerLifecycle !== "completed" &&
          session.providerLifecycle !== "closed"
        ).sort((a, b) =>
          (b.session.lastObservedAt ?? b.session.insertedAt).localeCompare(
            a.session.lastObservedAt ?? a.session.insertedAt,
          ) ||
          a.session.id.localeCompare(b.session.id)
        );
        const activeSessions = active.slice(0, 3).map(
          ({ id, session, delivery }): DashboardSession => {
            const title = decodeTitle(delivery.payload);
            return {
              id,
              url: Schema.is(sessionUrl)(session.sessionUrl) &&
                  (session.sessionUrl ===
                      `https://app.devin.ai/sessions/${id}` ||
                    session.sessionUrl ===
                      `https://app.devin.ai/sessions/${id}/`)
                ? session.sessionUrl
                : null,
              issue: {
                number: delivery.issueNumber,
                title: Option.isSome(title)
                  ? title.value.issue.title.slice(0, 300)
                  : null,
                url: delivery.issueNumber === null
                  ? null
                  : `https://github.com/${config.repository}/issues/${delivery.issueNumber}`,
              },
              lifecycle: session.providerLifecycle,
              providerStatus: session.providerStatus?.slice(0, 80) ?? null,
              providerStatusDetail:
                session.providerStatusDetail?.slice(0, 120) ?? null,
              remediationOutcome: session.outputs.at(-1)?.outcome ?? null,
              acus: Schema.is(measuredAcus)(session.acusConsumed)
                ? session.acusConsumed
                : null,
              observedAt: session.lastObservedAt,
            };
          },
        );
        return {
          repository: config.repository,
          generatedAt,
          cacheSeconds: 30,
          scope: {
            repositoryIssues: "github_all_open_and_closed_issues",
            devinWork: "app_tracked_only",
            trackedSince: deliveries[0] ?? null,
            prCoverage: "one_same_repository_pr_per_session",
          },
          issues: {
            repositoryTotal: remote.repositoryIssues,
            assignedToDevin: assigned.size,
            withDevinPr: issuePrs.size,
            withMergedDevinPr: completeMerges
              ? [...issuePrs.values()].filter((prs) =>
                [...prs].some((pr) => merged.has(pr))
              ).length
              : null,
          },
          pullRequests: {
            tracked: prNumbers.length,
            merged: completeMerges ? merged.size : null,
            confirmedMerged: merged.size,
            unknownMergeState: remote.unknownPrNumbers.length,
          },
          usage: {
            unit: "ACU",
            total,
            averagePerSession: total === null ? null : total / values.length,
            trackedSessions: allSessions.length,
            measuredSessions: values.length,
            missingSessions: allSessions.length - values.length,
            oldestObservationAt: observations[0] ?? null,
            latestObservationAt: observations.at(-1) ?? null,
          },
          completion: {
            medianMilliseconds: median,
            sampleCount: durations.length,
            excludedSessions: allSessions.length - durations.length,
            definition:
              "creation_to_first_observed_completion_including_waiting",
          },
          github: {
            checkedAt: remote.checkedAt,
            status: remote.repositoryIssues !== null && completeMerges
              ? "available"
              : "partial",
          },
          activeSessionCount: active.length,
          activeSessions,
        } satisfies MetricsSnapshot;
      }).pipe(
        Effect.provideService(GitHubClient, github),
        Effect.cachedWithTTL("30 seconds"),
      );
      return Metrics.of({ dashboard: { ...config, snapshot } });
    }),
  );
}
