import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type { RemediationOutput } from "./remediation-output.ts";
import type { SessionAnalysis } from "./devin.ts";

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
      "running",
      "succeeded",
      "failed",
      "skipped",
    ],
  }).notNull(),
  output: text("output", { mode: "json" }).$type<RemediationOutput>(),
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
    sql`${table.status} IN ('pending', 'submitting', 'running', 'succeeded', 'failed', 'skipped')`,
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
    "devin_sessions_output_check",
    sql`(${table.status} IN ('succeeded', 'failed') AND ${table.output} IS NOT NULL AND CASE WHEN json_valid(${table.output}) THEN json_type(${table.output}) = 'object' AND json_type(${table.output}, '$.outcome') IS 'text' AND json_extract(${table.output}, '$.outcome') IN ('fixed', 'needs_human', 'not_reproducible', 'failed', 'already_resolved') AND json_type(${table.output}, '$.summary') IS 'text' AND length(trim(json_extract(${table.output}, '$.summary'))) > 0 ELSE 0 END) OR (${table.status} NOT IN ('succeeded', 'failed') AND ${table.output} IS NULL)`,
  ),
]);
