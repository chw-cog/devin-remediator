import { Effect, Redacted } from "effect";
import { createDashboard } from "../../src/dashboard.ts";
import type { MetricsSnapshot } from "../../src/metrics.ts";
import { paginateSnapshot } from "../../src/dashboard-pagination.ts";

const snapshot: MetricsSnapshot = {
  repository: "example/service",
  generatedAt: "2026-09-14T10:42:00.000Z",
  cacheSeconds: 30,
  scope: {
    repositoryIssues: "github_all_open_and_closed_issues",
    devinWork: "app_tracked_only",
    trackedSince: "2026-09-01T12:00:00.000Z",
    prCoverage: "one_same_repository_pr_per_session",
  },
  issues: {
    repositoryTotal: 248,
    assignedToDevin: 36,
    withDevinPr: 24,
    withMergedDevinPr: 17,
  },
  pullRequests: {
    tracked: 26,
    merged: 18,
    confirmedMerged: 18,
    unknownMergeState: 0,
  },
  usage: {
    unit: "ACU",
    total: 142.8,
    averagePerSession: 142.8 / 33,
    trackedSessions: 35,
    measuredSessions: 33,
    missingSessions: 2,
    oldestObservationAt: "2026-09-01T12:00:00.000Z",
    latestObservationAt: "2026-09-14T10:41:42.000Z",
  },
  timing: {
    fixProposed: {
      medianMilliseconds: 1420000,
      sampleCount: 28,
      excludedSessions: 7,
      definition: "session_creation_to_pr_creation",
    },
    merged: {
      medianMilliseconds: 7200000,
      sampleCount: 18,
      excludedSessions: 17,
      definition: "session_creation_to_pr_merge",
    },
  },
  github: { status: "available", checkedAt: "2026-09-14T10:42:00.000Z" },
  activeSessionCount: 3,
  activePage: { number: 1, pageCount: 1, size: 3 },
  activeSessions: [
    {
      id: "demo-1",
      url: "https://app.devin.ai/sessions/demo-1",
      issue: {
        number: 184,
        title: "Retry webhook delivery after a transient failure",
        url: "https://github.com/example/service/issues/184",
      },
      lifecycle: "active",
      providerStatus: "running",
      providerStatusDetail: "working",
      remediationOutcome: null,
      acus: 3.2,
      observedAt: "2026-09-14T10:41:42.000Z",
    },
    {
      id: "demo-2",
      url: "https://app.devin.ai/sessions/demo-2",
      issue: {
        number: 179,
        title: "Clarify expected behavior for expired tokens",
        url: "https://github.com/example/service/issues/179",
      },
      lifecycle: "needs_input",
      providerStatus: "running",
      providerStatusDetail: "waiting_for_user",
      remediationOutcome: null,
      acus: 1.8,
      observedAt: "2026-09-14T10:41:18.000Z",
    },
    {
      id: "demo-3",
      url: "https://app.devin.ai/sessions/demo-3",
      issue: {
        number: 172,
        title: "Normalize repository names before matching",
        url: "https://github.com/example/service/issues/172",
      },
      lifecycle: "needs_approval",
      providerStatus: "running",
      providerStatusDetail: "waiting_for_approval",
      remediationOutcome: "fix_proposed",
      acus: 5.4,
      observedAt: "2026-09-14T10:41:00.000Z",
    },
  ],
};

let sessions = snapshot.activeSessions;

const app = createDashboard({
  repository: snapshot.repository,
  username: "viewer",
  password: Redacted.make("browser-fixture-password"),
  snapshot: (page = 1) =>
    Effect.sync(() =>
      paginateSnapshot({
        ...snapshot,
        activeSessions: sessions,
        activeSessionCount: sessions.length,
      }, page)
    ),
});

export default app;

if (import.meta.main) {
  app.post("/__fixture/count/:count", (c) => {
    const count = Number(c.req.param("count"));
    if (![0, 1, 3, 4, 7].includes(count)) return c.body(null, 400);
    sessions = Array.from({ length: count }, (_, index) => ({
      ...snapshot.activeSessions[index % 3],
      id: `demo-${index + 1}`,
      url: `https://app.devin.ai/sessions/demo-${index + 1}`,
    }));
    return c.body(null, 204);
  });
  Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) =>
      console.log(`DASHBOARD_READY http://127.0.0.1:${port}`),
  }, app.fetch);
}
