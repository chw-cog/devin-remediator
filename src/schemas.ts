import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

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
]);
