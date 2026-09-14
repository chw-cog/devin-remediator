import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createClient } from "@libsql/client";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { Effect, Logger } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { DevinSessionOrchestrator } from "./devin-session-orchestrator.ts";
import { SessionAdministration } from "./session-administration.ts";
import {
  missingFetch,
  recoveryLayer,
} from "../test/fixtures/session-recovery.ts";
import { Reactivity } from "effect/unstable/reactivity";

Deno.test("ACU/generation then session_reconciliation migrate populated baseline with foreign keys and immutable evidence intact", async () => {
  const directory = await Deno.makeTempDir();
  const client = createClient({ url: `file:${directory}/baseline.sqlite` });
  try {
    for (
      const name of [
        "20260913135033_initial",
        "20260913194128_fix_proposed_outcome",
        "20260913205455_session_outputs",
        "20260913212818_passive_lifecycle",
        "20260913224511_remarkable_demogoblin",
      ]
    ) {
      await Deno.mkdir(`${directory}/${name}`);
      await Deno.copyFile(
        new URL(`../migrations/${name}/migration.sql`, import.meta.url),
        `${directory}/${name}/migration.sql`,
      );
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* LibsqlClient.make({ liveClient: client });
        const db = yield* Drizzle.makeWithDefaults().pipe(
          Effect.provideService(LibsqlClient.LibsqlClient, sql),
        );
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* migrate(db, { migrationsFolder: directory });
        yield* sql`INSERT INTO github_webhook_deliveries (id, delivery_id, event_name, repo, payload, inserted_at) VALUES ('one', 'one', 'issues', 'owner/repo', 'PRIVATE payload', 'old')`;
        yield* sql`INSERT INTO devin_sessions (id, github_delivery_id, status, devin_session_id, provider_lifecycle, active_work, outputs, analysis, analysis_status, claim_version, observation_version, inserted_at, updated_at) VALUES ('one', 'one', 'submitted', 'remote-one', 'needs_input', 0, '[{"outcome":"needs_human","summary":"PRIVATE retained"}]', '{"retained":true}', 'collected', 7, 9, 'old', 'old')`;
        yield* sql`INSERT INTO attention_notifications (id, session_record_id, sequence, reason, repo, body, possible_send_at, expected_app_id, expected_installation_id) VALUES ('notice', 'one', 1, 'needs_input', 'owner/repo', 'PRIVATE body', 1, 42, 43)`;
        for (
          const [id, checks] of [["ambiguous", 2], ["retryable", 0]] as const
        ) {
          yield* sql`INSERT INTO github_webhook_deliveries (id, delivery_id, event_name, repo, payload, inserted_at) VALUES (${id}, ${id}, 'issues', 'owner/repo', 'PRIVATE payload', 'old')`;
          yield* sql`INSERT INTO devin_sessions (id, github_delivery_id, status, attempts, recovery_empty_checks, outputs, inserted_at, updated_at) VALUES (${id}, ${id}, 'pending', 1, ${checks}, '[{"outcome":"needs_human","summary":"PRIVATE legacy"}]', 'old', 'old')`;
        }
        const [legacy] =
          yield* sql`SELECT * FROM devin_sessions WHERE id = 'ambiguous'`;
        const [before] =
          yield* sql`SELECT * FROM devin_sessions WHERE id = 'one'`;
        const notifications = yield* sql`SELECT * FROM attention_notifications`;
        const migrationsFolder = fileURLToPath(
          new URL("../migrations", import.meta.url),
        );
        // Exercise the cumulative upgrade with populated ACU/generation values
        // before recovery runs, rather than only testing their defaults.
        yield* Effect.promise(async () => {
          const name = "20260914000253_session_acus_analysis_generation";
          await Deno.mkdir(`${directory}/${name}`);
          await Deno.copyFile(
            new URL(`../migrations/${name}/migration.sql`, import.meta.url),
            `${directory}/${name}/migration.sql`,
          );
        });
        yield* migrate(db, { migrationsFolder: directory });
        assert.deepEqual(
          (yield* sql`SELECT * FROM devin_sessions WHERE id = 'one'`)[0],
          { ...before, acus_consumed: null, analysis_generation: 0 },
        );
        yield* sql`UPDATE devin_sessions SET acus_consumed = 3.625, analysis_generation = 4 WHERE id = 'one'`;
        yield* migrate(db, { migrationsFolder });
        const [after] =
          yield* sql`SELECT * FROM devin_sessions WHERE id = 'one'`;
        assert.deepEqual(
          Object.fromEntries(
            Object.keys(before).map((key) => [key, after[key]]),
          ),
          before,
        );
        assert.equal(after.acus_consumed, 3.625);
        assert.equal(after.analysis_generation, 4);
        assert.equal(after.local_ownership, "tracking");
        assert.equal(after.lookup_failure_count, 0);
        assert.equal(after.recovery_candidate_ids, "[]");
        assert.deepEqual(
          yield* sql`SELECT * FROM attention_notifications`,
          notifications,
        );
        assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
        assert.equal((yield* sql`PRAGMA foreign_keys`)[0].foreign_keys, 1);
        const upgraded = yield* sql`SELECT * FROM devin_sessions ORDER BY id`;
        const [quarantined] =
          yield* sql`SELECT * FROM devin_sessions WHERE id = 'ambiguous'`;
        assert.equal(quarantined.acus_consumed, null);
        assert.equal(quarantined.analysis_generation, 0);
        assert.equal(quarantined.status, "submitting");
        assert.equal(quarantined.recovery_blocked, 1);
        assert.ok(quarantined.reconciliation_escalated_at);
        assert.deepEqual(
          Object.fromEntries(
            Object.keys(legacy).map((key) => [key, quarantined[key]]),
          ),
          {
            ...legacy,
            status: "submitting",
            recovery_blocked: 1,
          },
        );
        assert.equal(quarantined.first_lookup_failure_at, null);
        const audit = yield* sql`SELECT * FROM session_admin_events`;
        assert.equal(audit.length, 1);
        assert.equal(audit[0].action, "migration");
        assert.equal(audit[0].outcome, "legacy_ambiguous_retry");
        assert.ok(audit[0].recorded_at);
        yield* migrate(db, { migrationsFolder });
        assert.deepEqual(
          yield* sql`SELECT * FROM devin_sessions ORDER BY id`,
          upgraded,
        );
        assert.deepEqual(yield* sql`SELECT * FROM session_admin_events`, audit);
        yield* sql`INSERT INTO github_webhook_deliveries (id, delivery_id, event_name, repo, payload, inserted_at) VALUES ('unique-check', 'unique-check', 'issues', 'owner/repo', '{}', 'old')`;
        assert.equal(
          (yield* sql`INSERT INTO devin_sessions (id, github_delivery_id, status, devin_session_id, inserted_at, updated_at) VALUES ('two', 'unique-check', 'submitted', 'remote-one', 'old', 'old')`
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* DevinSessionRepository;
        const admin = yield* SessionAdministration;
        const orchestra = yield* DevinSessionOrchestrator;
        const eligible = yield* repository.claimPending;
        assert.deepEqual(eligible.map((work) => work.session.id), [
          "retryable",
        ]);
        yield* repository.markSkipped(eligible[0].session);
        yield* orchestra.tick;
        yield* orchestra.tick;
        const row = yield* admin.inspect("ambiguous");
        assert.equal(row.status, "submitting");
        assert.equal(row.recoveryBlocked, true);
        assert.equal(row.attempts, 1);
        assert.equal(row.remoteId, null);
      }).pipe(
        Effect.provide(recoveryLayer(`${directory}/baseline.sqlite`, 3)),
        Effect.provideService(FetchHttpClient.Fetch, missingFetch),
        Effect.provide(Logger.layer([])),
        Effect.scoped,
      ),
    );
  } finally {
    client.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("session_reconciliation snapshot follows and retains the complete ACU/generation snapshot", async () => {
  const readSnapshot = async (name: string) =>
    JSON.parse(
      await Deno.readTextFile(
        new URL(`../migrations/${name}/snapshot.json`, import.meta.url),
      ),
    );
  const previous = await readSnapshot(
    "20260914000253_session_acus_analysis_generation",
  );
  const recovery = await readSnapshot("20260914000730_session_reconciliation");
  assert.deepEqual(recovery.prevIds, [previous.id]);
  for (const entry of previous.ddl) {
    assert.ok(
      recovery.ddl.some((candidate: unknown) =>
        isDeepStrictEqual(candidate, entry)
      ),
      `Recovery snapshot must retain ${entry.entityType} ${entry.name}`,
    );
  }
});
