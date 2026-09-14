const root = document.querySelector(".shell");
const status = document.querySelector("#refresh-status");
const refreshLink = document.querySelector("#refresh");
const lifecycles = JSON.parse(root.dataset.lifecycles);
const outcomes = JSON.parse(root.dataset.outcomes);
const interval = 30_000;
let timer;
let pending;
let stopped = false;
let loginRequired = false;

function formatNumber(value) {
  if (value === null) return "—";
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid metric");
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatDuration(value) {
  if (value === null) return "—";
  formatNumber(value);
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function link(url, text, kind, session) {
  const valid = typeof url === "string" &&
    (kind === "session"
      ? /^https:\/\/app\.devin\.ai\/sessions\/[A-Za-z0-9_-]+\/?$/.test(url) &&
        new URL(url).pathname.replace(/\/$/, "").split("/").at(-1) ===
          session.id
      : url ===
        `https://github.com/${root.dataset.repository}/issues/${session.issue.number}`);
  if (!valid) return node("span", "", text);
  const element = node("a", "", text);
  element.href = url;
  element.target = "_blank";
  element.rel = "noopener noreferrer";
  return element;
}

function sessionCard(session) {
  if (typeof session.id !== "string" || !session.issue) {
    throw new Error("Invalid session");
  }
  const card = node("article", "session");
  card.dataset.sessionId = session.id;
  card.append(
    node(
      "span",
      session.lifecycle === "active" ? "badge" : "badge attention",
      lifecycles[session.lifecycle] ?? "Status unknown",
    ),
  );
  card.append(
    node(
      "span",
      "issue-number",
      `ISSUE ${
        session.issue.number === null ? "UNKNOWN" : `#${session.issue.number}`
      }`,
    ),
  );
  const title = node("h4", "");
  title.append(
    link(
      session.issue.url,
      `${session.issue.title ?? `Issue #${session.issue.number}`} ↗`,
      "issue",
      session,
    ),
  );
  card.append(title);
  const list = node("dl", "");
  for (
    const [label, value] of [
      [
        "Devin state",
        `${session.providerStatus ?? "Unknown"}${
          session.providerStatusDetail === null
            ? ""
            : ` / ${session.providerStatusDetail}`
        }`,
      ],
      [
        "Remediation",
        outcomes[session.remediationOutcome] ?? "Not yet reported",
      ],
      ["Observed usage", `${formatNumber(session.acus)} ACUs`],
    ]
  ) {
    const row = node("div", "");
    row.append(node("dt", "", label), node("dd", "", value));
    list.append(row);
  }
  card.append(list);
  const footer = node("footer", "session-footer");
  footer.append(
    session.url === null
      ? node("span", "", "Session link unavailable")
      : link(session.url, "Open Devin session ↗", "session", session),
  );
  footer.append(
    node("span", "", `Observed ${session.observedAt ?? "time unknown"}`),
  );
  card.append(footer);
  return card;
}

function display(snapshot) {
  if (
    snapshot.repository !== root.dataset.repository ||
    !Array.isArray(snapshot.activeSessions) ||
    snapshot.activeSessions.length > 3 ||
    !Number.isFinite(Date.parse(snapshot.generatedAt))
  ) throw new Error("Invalid snapshot");
  const metricValues = [
    snapshot.issues.repositoryTotal,
    snapshot.issues.assignedToDevin,
    snapshot.issues.withDevinPr,
    snapshot.pullRequests.merged,
  ].map(formatNumber);
  const usageValues = [
    formatNumber(snapshot.usage.total),
    formatNumber(snapshot.usage.averagePerSession),
    formatDuration(snapshot.completion.medianMilliseconds),
  ];
  const cards = snapshot.activeSessions.map(sessionCard);
  const mergedNote = snapshot.pullRequests.merged === null
    ? `${snapshot.pullRequests.confirmedMerged} confirmed · ${snapshot.pullRequests.unknownMergeState} unchecked`
    : `${snapshot.pullRequests.merged} of ${snapshot.pullRequests.tracked} tracked PRs`;
  const setText = (selector, value) => {
    const element = root.querySelector(selector);
    if (element.textContent !== value) element.textContent = value;
  };
  for (const [index, value] of metricValues.entries()) {
    setText(`.metric:nth-child(${index + 1}) .metric-value`, value);
  }
  for (const [index, value] of usageValues.entries()) {
    const selector = `.usage > div:nth-child(${index + 1}) .usage-value`;
    if (index < 2) {
      root.querySelector(selector).replaceChildren(
        document.createTextNode(`${value} `),
        node("span", "", "ACUs"),
      );
    } else setText(selector, value);
  }
  setText(
    ".metric.primary p",
    `${mergedNote} · Across ${
      formatNumber(snapshot.issues.withMergedDevinPr)
    } distinct issues`,
  );
  setText(
    ".usage > div:first-child p",
    `Usage known for ${snapshot.usage.measuredSessions} of ${snapshot.usage.trackedSessions} sessions`,
  );
  setText(
    ".usage > div:last-child p",
    `First observed completion · ${snapshot.completion.sampleCount} samples`,
  );
  setText(
    ".sessions .section-heading span",
    `Showing ${cards.length} of ${snapshot.activeSessionCount} · latest observations`,
  );
  const focused = document.activeElement;
  const focusedSession = focused?.closest("[data-session-id]")?.dataset
    .sessionId;
  const focusedHref = focused?.getAttribute("href");
  const container = root.querySelector(".session-list");
  const existing = new Map(
    [...container.children].map((card) => [card.dataset.sessionId, card]),
  );
  for (const card of cards) {
    const previous = existing.get(card.dataset.sessionId);
    if (previous?.isEqualNode(card)) {
      container.append(previous);
    } else if (previous) {
      previous.replaceWith(card);
      container.append(card);
    } else {
      container.append(card);
    }
    existing.delete(card.dataset.sessionId);
  }
  for (const card of existing.values()) card.remove();
  if (focusedSession && focusedHref) {
    const replacement = [...container.querySelectorAll("a")].find((a) =>
      a.closest("[data-session-id]").dataset.sessionId === focusedSession &&
      a.getAttribute("href") === focusedHref
    );
    (replacement ?? refreshLink).focus({ preventScroll: true });
  }
  root.querySelector("#empty-sessions").hidden = cards.length !== 0;
  root.querySelector("#github-notice").hidden =
    snapshot.github.status !== "partial";
  setText("#snapshot-time", snapshot.generatedAt);
  root.querySelector("#snapshot-time").dateTime = snapshot.generatedAt;
  setText("#github-checked", snapshot.github.checkedAt);
  setText("#tracked-since", snapshot.scope.trackedSince ?? "none yet");
  setText(
    "#observation-range",
    `${snapshot.usage.oldestObservationAt ?? "unknown"} to ${
      snapshot.usage.latestObservationAt ?? "unknown"
    }`,
  );
  setText("#excluded-samples", String(snapshot.completion.excludedSessions));
}

function schedule() {
  clearTimeout(timer);
  if (!stopped && !document.hidden && !loginRequired) {
    timer = setTimeout(refresh, interval);
  }
}

async function refresh() {
  clearTimeout(timer);
  if (pending || stopped || document.hidden || loginRequired) return;
  pending = new AbortController();
  const timeout = setTimeout(() => pending?.abort(), 20_000);
  status.textContent = "Refreshing…";
  try {
    const response = await fetch("/api/v1/metrics", {
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: pending.signal,
    });
    if (response.status === 401) loginRequired = true;
    if (!response.ok) throw new Error("Refresh unavailable");
    const snapshot = await response.json();
    if (stopped) return;
    display(snapshot);
    status.textContent = snapshot.github.status === "partial"
      ? "Live · GitHub data incomplete"
      : "Live · refreshes every 30s";
  } catch {
    if (!stopped) {
      status.textContent = loginRequired
        ? "Login expired. Select Refresh to sign in again."
        : "Couldn’t refresh. Showing the last successful snapshot; retrying in 30s.";
    }
  } finally {
    clearTimeout(timeout);
    pending = undefined;
    schedule();
  }
}

refreshLink.addEventListener("click", (event) => {
  if (
    loginRequired || event.button !== 0 || event.metaKey || event.ctrlKey ||
    event.shiftKey || event.altKey
  ) return;
  event.preventDefault();
  refresh();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else refresh();
});

globalThis.addEventListener("pagehide", () => {
  stopped = true;
  clearTimeout(timer);
  pending?.abort();
});

globalThis.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    stopped = false;
    refresh();
  }
});

status.textContent = "Live · refreshes every 30s";

schedule();
