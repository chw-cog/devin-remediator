import { DateTime } from "effect";
import type { SessionRecord } from "./devin-session-repository.ts";

export type LookupFailure = "missing" | "unavailable" | "duplicates";

// Three consecutive failures escalate; evidence survives successful observations.
export function lookupFailureUpdate(
  current: SessionRecord,
  outcome: LookupFailure,
  now: DateTime.Utc,
) {
  const streak = Math.min(current.lookupFailureStreak + 1, 1_000_000);
  const timestamp = DateTime.formatIso(now);
  return {
    lookupFailureStreak: streak,
    lookupFailureCount: current.lookupFailureCount + 1,
    firstLookupFailureAt: current.firstLookupFailureAt ?? timestamp,
    lastLookupFailureAt: timestamp,
    lastLookupFailure: outcome,
    reconciliationEscalatedAt: current.reconciliationEscalatedAt ??
      (streak >= 3 || outcome === "duplicates" ? timestamp : null),
    nextObservationAt: DateTime.formatIso(DateTime.add(now, {
      seconds: Math.min(30 * 2 ** Math.min(streak - 1, 7), 3600),
    })),
  };
}
