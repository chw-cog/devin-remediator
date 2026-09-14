import type { MetricsSnapshot } from "./metrics.ts";

export function paginateSnapshot(
  snapshot: Omit<MetricsSnapshot, "activePage">,
  requestedPage = 1,
): MetricsSnapshot {
  const pageCount = Math.max(1, Math.ceil(snapshot.activeSessionCount / 3));
  const number = Math.min(requestedPage, pageCount);
  return {
    ...snapshot,
    activePage: { number, pageCount, size: 3 },
    activeSessions: snapshot.activeSessions.slice((number - 1) * 3, number * 3),
  };
}
