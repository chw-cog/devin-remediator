import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { RemediationOutput } from "./remediation-output.ts";
import type { ProviderLifecycle, SessionAnalysis } from "./devin.ts";

export const githubWebhookDeliveries = sqliteTable(
  "github_webhook_deliveries",
  {
    id: text("id").notNull(),
    deliveryId: text("delivery_id").notNull().unique(),
    eventName: text("event_name").notNull(),
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number"),
    payload: text("payload").notNull(),
    insertedAt: text("inserted_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const devinSessions = sqliteTable("devin_sessions", {
  id: text("id").notNull(),
  githubDeliveryId: text("github_delivery_id").notNull().unique().references(
    () => githubWebhookDeliveries.deliveryId,
  ),
  status: text("status", {
    enum: [
      "pending",
      "submitting",
      "submitted",
      "failed",
      "skipped",
    ],
  }).notNull(),
  providerStatus: text("provider_status"),
  providerStatusDetail: text("provider_status_detail"),
  providerLifecycle: text("provider_lifecycle").$type<ProviderLifecycle>(),
  activeWork: integer("active_work", { mode: "boolean" }),
  isArchived: integer("is_archived", { mode: "boolean" }),
  providerCreatedAt: integer("provider_created_at"),
  providerUpdatedAt: integer("provider_updated_at"),
  sessionUrl: text("session_url"),
  lastObservedAt: text("last_observed_at"),
  nextObservationAt: text("next_observation_at").notNull()
    .default("1970-01-01T00:00:00.000Z"),
  observationVersion: integer("observation_version").notNull().default(0),
  observationLeaseUntil: text("observation_lease_until"),
  completionObservedAt: text("completion_observed_at"),
  outputs: text("outputs", { mode: "json" })
    .$type<ReadonlyArray<RemediationOutput>>().notNull().default([]),
  analysis: text("analysis", { mode: "json" }).$type<SessionAnalysis>(),
  analysisStatus: text("analysis_status", {
    enum: ["pending", "collected", "unavailable"],
  }).notNull().default("pending"),
  analysisAttempts: integer("analysis_attempts").notNull().default(0),
  analysisNextAttemptAt: text("analysis_next_attempt_at").notNull()
    .default("1970-01-01T00:00:00.000Z"),
  analysisReason: text("analysis_reason"),
  devinSessionId: text("devin_session_id").unique(),
  prNumber: integer("pr_number"),
  attempts: integer("attempts").notNull().default(0),
  claimVersion: integer("claim_version").notNull().default(0),
  recoveryEmptyChecks: integer("recovery_empty_checks").notNull().default(0),
  recoveryBlocked: integer("recovery_blocked", { mode: "boolean" }).notNull()
    .default(false),
  insertedAt: text("inserted_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.id] }),
  check(
    "devin_sessions_status_check",
    sql`${table.status} IN ('pending', 'submitting', 'submitted', 'failed', 'skipped')`,
  ),
  check(
    "devin_sessions_provider_lifecycle_check",
    sql`${table.providerLifecycle} IS NULL OR ${table.providerLifecycle} IN ('active', 'needs_input', 'needs_approval', 'paused', 'needs_intervention', 'completed', 'closed')`,
  ),
  index("devin_sessions_observation_due_idx").on(
    table.status,
    table.nextObservationAt,
  ),
  check("devin_sessions_attempts_check", sql`${table.attempts} >= 0`),
  index("devin_sessions_analysis_due_idx").on(
    table.analysisStatus,
    table.analysisNextAttemptAt,
  ),
  check(
    "devin_sessions_analysis_attempts_check",
    sql`${table.analysisAttempts} >= 0`,
  ),
  check(
    "devin_sessions_analysis_check",
    sql`(${table.analysisStatus} = 'collected' AND ${table.analysis} IS NOT NULL AND CASE WHEN json_valid(${table.analysis}) THEN json_type(${table.analysis}) = 'object' ELSE 0 END) OR (${table.analysisStatus} IN ('pending', 'unavailable') AND ${table.analysis} IS NULL)`,
  ),
  check(
    "devin_sessions_outputs_check",
    sql`CASE WHEN json_valid(${table.outputs}) THEN json_type(${table.outputs}) = 'array' ELSE 0 END`,
  ),
]);

export const attentionNotifications = sqliteTable("attention_notifications", {
  id: text("id").primaryKey().notNull(),
  sessionRecordId: text("session_record_id").notNull().references(() =>
    devinSessions.id
  ),
  sequence: integer("sequence").notNull(),
  reason: text("reason", { enum: ["needs_input", "needs_approval"] }).notNull(),
  repo: text("repo").notNull(),
  issueNumber: integer("issue_number"),
  remoteId: text("remote_id"),
  sessionUrl: text("session_url"),
  closedAt: integer("closed_at"),
  status: text("status", {
    enum: ["pending", "delivered", "cancelled", "blocked"],
  }).notNull().default("pending"),
  dueAt: integer("due_at").notNull().default(0),
  version: integer("version").notNull().default(0),
  leaseUntil: integer("lease_until").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  body: text("body"),
  expectedAppId: integer("expected_app_id"),
  expectedInstallationId: integer("expected_installation_id"),
  possibleSendAt: integer("possible_send_at"),
  scanPage: integer("scan_page").notNull().default(1),
  scanMatches: integer("scan_matches").notNull().default(0),
  scanUnverified: integer("scan_unverified", { mode: "boolean" }).notNull()
    .default(false),
  commentId: integer("comment_id"),
  negativeScans: integer("negative_scans").notNull().default(0),
  lastFailure: text("last_failure", {
    enum: [
      "invalid_target",
      "unsafe_link",
      "http",
      "unavailable",
      "duplicates",
      "ownership_changed",
      "unverified_attribution",
      "inaccessible",
    ],
  }),
}, (table) => [
  uniqueIndex("attention_episode_idx").on(
    table.sessionRecordId,
    table.sequence,
  ),
  index("attention_due_idx").on(table.status, table.dueAt),
  check(
    "attention_reason_check",
    sql`${table.reason} IN ('needs_input', 'needs_approval')`,
  ),
  check(
    "attention_status_check",
    sql`${table.status} IN ('pending', 'delivered', 'cancelled', 'blocked')`,
  ),
  check(
    "attention_flight_check",
    sql`${table.possibleSendAt} IS NULL OR (${table.body} IS NOT NULL AND ${table.expectedAppId} IS NOT NULL AND ${table.expectedAppId} > 0 AND ${table.expectedInstallationId} IS NOT NULL AND ${table.expectedInstallationId} > 0)`,
  ),
  check(
    "attention_receipt_check",
    sql`${table.status} != 'delivered' OR (${table.commentId} IS NOT NULL AND ${table.commentId} > 0)`,
  ),
  check(
    "attention_counters_check",
    sql`${table.sequence} > 0 AND ${table.version} >= 0 AND ${table.attempts} >= 0 AND ${table.scanPage} > 0 AND ${table.scanMatches} >= 0 AND ${table.negativeScans} BETWEEN 0 AND 2`,
  ),
]);

export const githubNotificationGate = sqliteTable("github_notification_gate", {
  id: integer("id").primaryKey().default(1),
  version: integer("version").notNull().default(0),
  leaseUntil: integer("lease_until").notNull().default(0),
  nextRequestAt: integer("next_request_at").notNull().default(0),
  nextReportAt: integer("next_report_at").notNull().default(0),
}, (table) => [check("github_notification_singleton", sql`${table.id} = 1`)]);
