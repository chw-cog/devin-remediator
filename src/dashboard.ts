import { Cause, Effect, Redacted } from "effect";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { html } from "hono/html";
import { secureHeaders } from "hono/secure-headers";
import type {
  Dashboard,
  DashboardSession,
  MetricsSnapshot,
} from "./metrics.ts";
import type { ProviderLifecycle } from "./devin.ts";
import type { RemediationOutcome } from "./remediation-output.ts";

const lifecycleLabels: Record<ProviderLifecycle, string> = {
  active: "Working",
  needs_input: "Needs your input",
  needs_approval: "Needs approval",
  paused: "Paused",
  needs_intervention: "Needs intervention",
  completed: "Completed",
  closed: "Closed",
};

const outcomeLabels: Record<RemediationOutcome, string> = {
  fix_proposed: "Fix proposed",
  needs_human: "Needs human",
  not_reproducible: "Not reproducible",
  failed: "Failed",
  already_resolved: "Already resolved",
};

const number = (value: number | null) =>
  value === null
    ? "—"
    : value.toLocaleString("en-US", { maximumFractionDigits: 2 });

const duration = (milliseconds: number | null) => {
  if (milliseconds === null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
};

const sessionCard = (session: DashboardSession) =>
  html`
    <article class="session" data-session-id="${session.id}">
      <span class="${session.lifecycle === "active"
        ? "badge"
        : "badge attention"}">${session.lifecycle === null
        ? "Status unknown"
        : lifecycleLabels[session.lifecycle]}</span>
      <span class="issue-number">ISSUE ${session.issue.number === null
        ? "UNKNOWN"
        : `#${session.issue.number}`}</span>
      <h4>${session.issue.url === null
        ? session.issue.title ?? "Issue details unavailable"
        : html`<a href="${session.issue.url}" target="_blank" rel="noreferrer">${
          session.issue.title ?? `Issue #${session.issue.number}`
        } ↗</a>`}</h4>
      <dl>
        <div>
          <dt>Devin state</dt>
          <dd>${session.providerStatus ??
            "Unknown"}${session.providerStatusDetail === null
            ? ""
            : ` / ${session.providerStatusDetail}`}</dd>
        </div>
        <div>
          <dt>Remediation</dt>
          <dd>${session.remediationOutcome === null
            ? "Not yet reported"
            : outcomeLabels[session.remediationOutcome]}</dd>
        </div>
        <div>
          <dt>Observed usage</dt>
          <dd>${number(session.acus)} ACUs</dd>
        </div>
      </dl>
      <footer class="session-footer">
        ${session.url === null
          ? html`<span>Session link unavailable</span>`
          : html`<a href="${session.url}" target="_blank" rel="noreferrer">Open Devin session ↗</a>`}
        <span>Observed ${session.observedAt === null
          ? "time unknown"
          : html`<time datetime="${session.observedAt}">${session.observedAt}</time>`}</span>
      </footer>
    </article>
  `;

export const renderDashboard = (snapshot: MetricsSnapshot) =>
  html`
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>${snapshot.repository} · Devin Remediator</title>
        <link rel="stylesheet" href="/dashboard/styles.css">
        <script type="module" src="/dashboard/client.js"></script>
      </head>
      <body>
        <div class="shell" data-repository="${snapshot.repository}"
          data-lifecycles="${JSON.stringify(
            lifecycleLabels,
          )}" data-outcomes="${JSON.stringify(outcomeLabels)}">
          <header class="app-header">
            <div
              class="brand"><span class="brand-mark" aria-hidden="true">/d</span>Devin Remediator</div>
            <div
              class="header-actions"><a class="repo" href="https://github.com/${snapshot
                .repository}" target="_blank" rel="noreferrer">${snapshot
                .repository}</a><a id="refresh" class="button" href="/dashboard">↻ Refresh</a></div>
          </header>
          <main>
            <div
              class="page-heading"><div><h1>From issue to resolution.</h1><p>Repository context. Tracked outcomes. Work in motion.</p></div>
        <span class="asof">Snapshot <time id="snapshot-time" datetime="${snapshot
          .generatedAt}">${snapshot
          .generatedAt}</time><br><span id="refresh-status" role="status">Manual refresh · cached for ${snapshot
          .cacheSeconds}s</span></span></div>
            <div id="github-notice" class="notice" ${snapshot.github.status ===
                "partial"
              ? ""
              : html`hidden`}
              role="status"><strong>GitHub data is incomplete.</strong> Unavailable repository or merge counts appear as —, not zero. Timing medians include only available PR timestamps. Local session observations remain available.</div>
            <section aria-labelledby="outcomes">
              <div
                class="section-heading"><h2 id="outcomes">Outcomes at a glance</h2><span>All time · scoped below</span></div>
              <div class="metrics">
                <div
                  class="metric"><div class="metric-name">Repository issues</div><strong class="metric-value">${number(
                    snapshot.issues.repositoryTotal,
                  )}</strong><p>Issues · open + closed<br>Repository-wide, from GitHub</p></div>
                <div
                  class="metric"><div class="metric-name">Assigned to Devin</div><strong class="metric-value">${number(
                    snapshot.issues.assignedToDevin,
                  )}</strong><p>Distinct issues<br>Devin-label events seen by this app</p></div>
                <div
                  class="metric"><div class="metric-name">Issues with a PR</div><strong class="metric-value">${number(
                    snapshot.issues.withDevinPr,
                  )}</strong><p>Distinct issues<br>PR linked by a tracked session</p></div>
                <div
                  class="metric primary"><div class="metric-name">Merged PRs</div><strong class="metric-value">${number(
                    snapshot.pullRequests.merged,
                  )}</strong><p>${snapshot.pullRequests.merged === null
                    ? `${snapshot.pullRequests.confirmedMerged} confirmed · ${snapshot.pullRequests.unknownMergeState} unchecked`
                    : `${snapshot.pullRequests.merged} of ${snapshot.pullRequests.tracked} tracked PRs`}<br>Across ${number(
                      snapshot.issues.withMergedDevinPr,
                    )} distinct issues</p></div>
              </div>
              <p
                class="scope-note">Repository total is context; Devin counts cover this app only. Issues and PRs are different units—not one conversion funnel.</p>
              <div class="usage">
                <div><div class="metric-name">Total observed usage</div><strong class="usage-value">${number(
                  snapshot.usage.total,
                )} <span>ACUs</span></strong><p>Usage known for ${snapshot.usage
                  .measuredSessions} of ${snapshot.usage
                  .trackedSessions} sessions</p></div>
                <div><div class="metric-name">Average per session</div><strong class="usage-value">${number(
                  snapshot.usage.averagePerSession,
                )} <span>ACUs</span></strong><p>Known-usage sessions only</p></div>
                <div
                  id="fix-proposed-timing"><div class="metric-name">Median time until fix proposed</div><strong class="usage-value">${duration(
                    snapshot.timing.fixProposed.medianMilliseconds,
                  )}</strong><p>Session start → PR opened · ${snapshot.timing
                    .fixProposed.sampleCount} samples</p></div>
                <div
                  id="merged-timing"><div class="metric-name">Median time until merged</div><strong class="usage-value">${duration(
                    snapshot.timing.merged.medianMilliseconds,
                  )}</strong><p>Session start → PR merged · ${snapshot.timing
                    .merged.sampleCount} samples</p></div>
              </div>
            </section>
            <section class="sessions" aria-labelledby="sessions">
              <div
                class="section-heading"><h2 id="sessions">In progress &amp; needs attention</h2><span>Showing ${snapshot
                  .activeSessions.length} of ${snapshot
                  .activeSessionCount} · latest observations</span></div>
              <div id="empty-sessions" class="empty"
                ${snapshot.activeSessions.length === 0
                  ? ""
                  : html`hidden`}><strong>Nothing in motion.</strong><p>Apply the <code>devin</code> label to an issue to start tracking work here.<br>Active sessions and requests for input appear as they are observed.</p></div>
              <div class="session-list">${snapshot.activeSessions.map(
                sessionCard,
              )}</div>
            </section>
            <details>
              <summary>How these numbers are counted</summary>
              <ul>
                <li>Repository issues include open and closed issues, not pull requests. GitHub Search is indexed and may lag recent changes. Last check: <span id="github-checked">${snapshot
                  .github.checkedAt}</span>.</li>
                <li>Assigned issues are distinct issues with a matching <code>devin</code> label event received by this app. Reapplying or removing the label does not multiply the count. Earliest observed assignment: <span id="tracked-since">${snapshot
                  .scope.trackedSince ?? "none yet"}</span>.</li>
                <li>Tracked PRs are linked by this app’s Devin sessions, not inferred from bot authorship. The current app retains one same-repository PR per session; additional PRs may not be represented.</li>
                <li>Issues and PRs are separate units. Merge counts require GitHub confirmation. Closed without merging does not count. Unknown merge states make the total unavailable; confirmed merges are shown separately.</li>
                <li>ACUs sum the latest known usage of tracked remote sessions, including failed, released and archived sessions. Missing usage is excluded from the average, not treated as zero. No remote session means no usage sample. Spawned sessions not tracked by this app are not separately counted. ACUs are not a dollar bill.</li>
                <li>Usage observations range from <span id="observation-range">${snapshot
                  .usage.oldestObservationAt ??
                  "unknown"} to ${snapshot.usage.latestObservationAt ??
                  "unknown"}</span>. Observations can lag or stop for released sessions.</li>
                <li>Both timing medians start at Devin session creation and use GitHub timestamps, not Devin’s finished state. “Fix proposed” means the linked PR was opened (including drafts), not that CI passed. Time until merged includes review and waiting; neither metric is active execution time. Each tracked session contributes at most one sample per milestone, including released and archived sessions. Missing or invalid timestamps are excluded: <span id="excluded-proposed-samples">${snapshot
                  .timing.fixProposed
                  .excludedSessions}</span> sessions without a proposal sample; <span id="excluded-merged-samples">${snapshot
                  .timing.merged
                  .excludedSessions}</span> without a merge sample. Unmerged PRs have no merge sample. Medians describe separate cohorts; subtracting them does not give median review time.</li>
                <li>Ongoing, paused, unknown and attention-needed sessions may appear, up to three, ordered by latest observation. Provider state and remediation outcome are separate; “Fix proposed” does not mean merged. Issue titles come from received webhooks, not a current GitHub lookup.</li>
              </ul>
            </details>
            <footer
              class="app-footer"><span>Tracked work only · No historical backfill</span><a href="/api/v1/metrics">View metrics JSON ↗</a></footer>
          </main>
        </div>
      </body>
    </html>
  `;

const dashboardCss = `
*{box-sizing:border-box}[hidden]{display:none!important} :root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#24332c;background:#eef1ea}
body{margin:0;padding:28px} a{color:inherit;text-underline-offset:4px} :focus-visible{outline:3px solid #bc6b30;outline-offset:4px}
p,h1,h2,h4,dd,span,a,time{overflow-wrap:anywhere} .shell{max-width:1256px;margin:auto;background:#fbfcf8;border:1px solid #cbd4c9;border-radius:12px;overflow:hidden}
.app-header{padding:22px 32px;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid #dce3d8}
.brand,.header-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.brand{font-size:14px;font-weight:650}
.brand-mark{display:inline-grid;place-items:center;background:#24332c;color:#fbfcf8;border-radius:7px;width:29px;height:29px;font-family:ui-monospace,monospace}
.repo{font-family:ui-monospace,monospace;font-size:12px;color:#586c60}.button{background:#fff;border:1px solid #dce3d8;border-radius:7px;padding:8px 12px;font-size:12px;text-decoration:none}
main{padding:32px}.page-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:28px;flex-wrap:wrap}
h1{font-size:clamp(25px,3vw,34px);letter-spacing:-.05em;font-weight:550;margin:0 0 7px}.page-heading p{color:#586c60;font-size:13px;margin:0;line-height:1.6}
.asof{color:#586c60;font-size:11px;line-height:1.7}.section-heading{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:14px}
h2{margin:0;font-size:14px;font-weight:650}.section-heading span,.scope-note{color:#586c60;font-size:11px;line-height:1.6}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric{min-width:0;padding:19px 18px;border:1px solid #dce3d8;border-radius:9px;background:#fff}
.primary{background:#eaf2e7}.metric-name{font-size:12px;color:#586c60}.metric-value{display:block;font-size:37px;font-weight:550;letter-spacing:-.06em;line-height:1.5;margin:12px 0;font-variant-numeric:tabular-nums}
.metric p,.usage p{font-size:11px;color:#586c60;line-height:1.5;margin:6px 0 0}.scope-note{margin:10px 0 0}
.usage{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-top:20px;border:1px solid #dce3d8;border-radius:9px;background:#fff}.usage>div{padding:20px;min-width:0}
.usage>div+div{border-left:1px solid #dce3d8}.usage-value{display:block;font-size:26px;font-weight:550;letter-spacing:-.04em;margin:8px 0;font-variant-numeric:tabular-nums}.usage-value span{font-size:12px;font-weight:400;letter-spacing:0;color:#586c60}
.sessions{margin-top:28px}.session-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.session{min-width:0;border:1px solid #dce3d8;border-radius:9px;background:#fff;padding:20px}
.badge{display:inline-block;border-radius:5px;padding:4px 7px;font-size:10px;font-weight:650;background:#eaf2e7;color:#326e50}.badge.attention{color:#82532c;background:#fbeddc}
.issue-number{display:block;font:11px ui-monospace,monospace;color:#586c60;margin:18px 0 7px}h4{font-size:14px;line-height:1.5;font-weight:600;margin:0 0 17px;min-height:42px}
h4 a{text-decoration:none}h4 a:hover{text-decoration:underline}dl{margin:0}dl>div{display:flex;gap:8px;justify-content:space-between;padding:6px 0;font-size:11px}dt{color:#586c60;flex-shrink:0}dd{margin:0;text-align:right;min-width:0}
.session-footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid #dce3d8;padding-top:13px;margin-top:13px;font-size:11px;line-height:1.6}.session-footer a{font-weight:600;color:#326e50}.session-footer span{color:#586c60}
.notice{background:#eaf2e7;border:1px solid #dce3d8;border-radius:7px;padding:12px 15px;font-size:12px;margin-bottom:22px;line-height:1.6}
.empty{padding:34px;text-align:center;border:1px dashed #dce3d8;border-radius:9px}.empty p{color:#586c60;font-size:13px;line-height:1.6}
details{margin-top:24px;color:#586c60;font-size:11px;line-height:1.7}summary{cursor:pointer}details ul{padding-left:20px;max-width:860px}
.app-footer{margin-top:23px;padding-top:18px;border-top:1px solid #dce3d8;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#586c60;font-size:11px}
@media(max-width:800px){body{padding:12px}main,.app-header{padding:22px}.metrics,.usage{grid-template-columns:repeat(2,minmax(0,1fr))}.usage>div:nth-child(3){border-left:0}.usage>div:nth-child(n+3){border-top:1px solid #dce3d8}.session-list{grid-template-columns:minmax(0,1fr)}h4{min-height:0}}
@media(max-width:480px){.usage{grid-template-columns:minmax(0,1fr)}.usage>div+div{border-left:0;border-top:1px solid #dce3d8}main{padding:18px}.metric{padding:14px}.metric-value{font-size:31px}}
`;

export function createDashboard(dashboard: Dashboard) {
  const app = new Hono();
  for (const path of ["/dashboard", "/dashboard/*", "/api/v1/metrics"]) {
    app.use(
      path,
      secureHeaders({
        contentSecurityPolicy: {
          defaultSrc: ["'none'"],
          styleSrc: ["'self'"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
          formAction: ["'self'"],
        },
        referrerPolicy: "no-referrer",
      }),
    );
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    });
    app.use(
      path,
      basicAuth({
        username: dashboard.username,
        password: Redacted.value(dashboard.password),
      }),
    );
  }
  app.get("/dashboard/styles.css", (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    return c.body(dashboardCss);
  });
  app.get("/dashboard/client.js", (c) => {
    c.header("Content-Type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(
      new URL("./dashboard-client.js", import.meta.url),
      "utf8",
    ));
  });
  for (const path of ["/dashboard", "/api/v1/metrics"]) {
    app.get(path, (c) =>
      Effect.runPromise(dashboard.snapshot.pipe(
        Effect.map((snapshot) =>
          path === "/dashboard"
            ? c.html(renderDashboard(snapshot))
            : c.json(snapshot)
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.gen(function* () {
              yield* Effect.logError("metrics.snapshot_failed");
              return path === "/dashboard"
                ? c.html(
                  html`
                    <!doctype html>
                    <html lang="en">
                      <head>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width,initial-scale=1">
                        <title>Metrics unavailable</title>
                        <link rel="stylesheet" href="/dashboard/styles.css">
                      </head>
                      <body>
                        <main
                          class="shell"><h1>Metrics are temporarily unavailable.</h1><p>No counts are available from local storage. Try again shortly.</p><a href="/dashboard">Retry</a></main>
                      </body>
                    </html>
                  `,
                  503,
                )
                : c.json({ error: "Metrics temporarily unavailable" }, 503);
            })
        ),
      )));
  }
  return app;
}
