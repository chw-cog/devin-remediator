import { ConfigProvider, DateTime, Effect, Layer, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { TestClock } from "effect/testing";
import { type AppDatabase, DatabaseClient } from "../src/database.ts";
import { DevinClient, type DevinSession } from "../src/devin.ts";
import { DevinSessionOrchestrator } from "../src/devin-session-orchestrator.ts";
import {
  DevinSessionRepository,
  type SessionRecord,
} from "../src/devin-session-repository.ts";
import { SessionAdministration } from "../src/session-administration.ts";
import { devinSessions, githubWebhookDeliveries } from "../src/schemas.ts";
import { WebhookEventProcessors } from "../src/webhook-event-processors.ts";

export const recoveryRemote = (
  id = "remote-one",
  delivery = "one",
): DevinSession => ({
  session_id: id,
  org_id: "org-test",
  url: `https://app.devin.ai/sessions/${id}`,
  status: "running",
  status_detail: "working",
  created_at: 1,
  updated_at: 2,
  acus_consumed: 0,
  tags: [`delivery-id:delivery-${delivery}`],
  pull_requests: [],
  title: "PRIVATE question",
  structured_output: { outcome: "needs_human", summary: "PRIVATE question" },
});
export const seedRecovery = Effect.fnUntraced(
  function* (
    db: AppDatabase,
    id = "one",
    overrides: Partial<SessionRecord> = {},
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* db.insert(githubWebhookDeliveries).values({
      id: `delivery-${id}`,
      deliveryId: `delivery-${id}`,
      eventName: "issues",
      repo: "owner/repo",
      issueNumber: 123,
      payload: "PRIVATE payload",
      insertedAt: now,
    });
    const [row] = yield* db.insert(devinSessions).values({
      id,
      githubDeliveryId: `delivery-${id}`,
      status: "submitted",
      devinSessionId: `remote-${id}`,
      insertedAt: now,
      updatedAt: now,
      ...overrides,
    }).returning();
    return row;
  },
);
export function recoveryLayer(path: string, maxSessions = 1) {
  return DevinSessionOrchestrator.layer.pipe(
    Layer.provide(WebhookEventProcessors.layer),
    Layer.provideMerge(DevinSessionRepository.layer),
    Layer.provideMerge(SessionAdministration.layer()),
    Layer.provideMerge(DatabaseClient.layerWithPath(path)),
    Layer.provideMerge(
      DevinClient.layerWithCredentials({
        devinApiKey: "PRIVATE token",
        devinOrganizationId: "org-test",
      }),
    ),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({
      DEVIN_API_KEY: "PRIVATE token",
      DEVIN_ORGANIZATION_ID: "org-test",
      GITHUB_WEBHOOK_SECRET: "PRIVATE webhook",
      DEVIN_MAX_CONCURRENT_SESSIONS: maxSessions,
    }))),
  );
}
type RecoveryServices =
  | DatabaseClient
  | DevinClient
  | DevinSessionRepository
  | DevinSessionOrchestrator
  | SessionAdministration;
export function recoveryTest<E>(
  name: string,
  effect: Effect.Effect<void, E, RecoveryServices>,
  fetch: typeof globalThis.fetch,
) {
  Deno.test(name, async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Effect.runPromise(effect.pipe(
        Effect.provide(recoveryLayer(`${dir}/recovery.sqlite`)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([])),
        Effect.scoped,
      ));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}
export const missingFetch: typeof globalThis.fetch = (_input, init) => {
  if (init?.method !== "GET") {
    throw new Error("Remote writes forbidden in recovery tests");
  }
  return Promise.resolve(
    Response.json({ items: [], has_next_page: false, end_cursor: null }),
  );
};
