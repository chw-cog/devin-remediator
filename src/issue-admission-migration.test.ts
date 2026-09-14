import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { LibsqlClient } from "@effect/sql-libsql";
import * as Drizzle from "drizzle-orm/effect-libsql";
import { migrate } from "drizzle-orm/effect-libsql/migrator";
import { ConfigProvider, Effect } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { type AppDatabase, DatabaseClient } from "./database.ts";
import { DevinSessionRepository } from "./devin-session-repository.ts";
import { issueIdentity } from "./issue-admission.ts";

const current = "20260914043819_issue_admission";
const matching = '{"action":"labeled","label":{"name":"devin"}}';
const timestamp = "2026-01-01T00:00:00.000Z";

function migrationTest(
  name: string,
  test: (
    db: AppDatabase,
    upgrade: Effect.Effect<void, unknown>,
    client: ReturnType<typeof createClient>,
  ) => Effect.Effect<void, unknown>,
) {
  Deno.test(name, async () => {
    const folder = await Deno.makeTempDir();
    const client = createClient({ url: `file:${folder}/legacy.sqlite` });
    try {
      for await (
        const entry of Deno.readDir(new URL("../migrations", import.meta.url))
      ) {
        if (!entry.isDirectory || entry.name >= current) continue;
        await Deno.mkdir(`${folder}/${entry.name}`);
        await Deno.copyFile(
          new URL(`../migrations/${entry.name}/migration.sql`, import.meta.url),
          `${folder}/${entry.name}/migration.sql`,
        );
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* LibsqlClient.make({ liveClient: client });
          const db = yield* Drizzle.makeWithDefaults().pipe(
            Effect.provideService(LibsqlClient.LibsqlClient, sql),
          );
          yield* sql`PRAGMA foreign_keys = ON`;
          yield* migrate(db, { migrationsFolder: folder });
          yield* test(
            db,
            migrate(db, {
              migrationsFolder: fileURLToPath(
                new URL("../migrations", import.meta.url),
              ),
            }),
            client,
          );
        }).pipe(Effect.provide(Reactivity.layer), Effect.scoped),
      );
    } finally {
      client.close();
      await Deno.remove(folder, { recursive: true });
    }
  });
}

const seed = Effect.fnUntraced(
  function* (db: AppDatabase, id: string, options: {
    repo?: string;
    issue?: number | null;
    payload?: string;
    event?: string;
    status?: string;
    remote?: string | null;
    attempts?: number;
    insertedAt?: string;
  } = {}) {
    yield* db.$client.unsafe(
      "INSERT INTO github_webhook_deliveries (id, delivery_id, repo, issue_number, event_name, payload, inserted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        id,
        options.repo ?? "Owner/Repo",
        options.issue === undefined ? 42 : options.issue,
        options.event ?? "issues",
        options.payload ?? matching,
        timestamp,
      ],
    );
    yield* db.$client.unsafe(
      "INSERT INTO devin_sessions (id, github_delivery_id, status, devin_session_id, attempts, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        id,
        options.status ?? "pending",
        options.remote ?? null,
        options.attempts ?? 0,
        options.insertedAt ?? timestamp,
        timestamp,
      ],
    );
  },
);

migrationTest(
  "admission migration quarantines uncertain output shapes without losing evidence",
  (db, upgrade) =>
    Effect.gen(function* () {
      const uncertain = [
        '[{"outcome":"failed"}]',
        '[{"outcome":"failed","summary":null}]',
        '["legacy evidence"]',
        "[null]",
        '[{"outcome":"fix_proposed","summary":"Submission permanently rejected before session creation."}]',
      ];
      for (const [index, outputs] of uncertain.entries()) {
        yield* seed(db, `uncertain-${index}`, {
          issue: index + 1,
          attempts: 1,
        });
        yield* db.$client.unsafe(
          "UPDATE devin_sessions SET outputs = ? WHERE id = ?",
          [outputs, `uncertain-${index}`],
        );
      }
      yield* seed(db, "known-rejection", { issue: 10, attempts: 1 });
      yield* db
        .$client`UPDATE devin_sessions SET outputs = '[{"outcome":"failed","summary":"Submission permanently rejected before session creation."}]' WHERE id = 'known-rejection'`;
      yield* upgrade;
      const rows = yield* db
        .$client`SELECT id, status, recovery_blocked, outputs FROM devin_sessions ORDER BY id`;
      assert.equal(rows[0].status, "pending");
      for (const [index, row] of rows.slice(1).entries()) {
        assert.equal(row.status, "submitting");
        assert.equal(row.recovery_blocked, 1);
        assert.equal(row.outputs, uncertain[index]);
      }
      assert.equal(
        (yield* db.$client`SELECT * FROM issue_admissions`).length,
        6,
      );
    }),
);

migrationTest(
  "admission migration retains duplicate remote history, ranks canonical work once, fences queued duplicates and preserves lookup-only recovery",
  (db, upgrade) =>
    Effect.gen(function* () {
      yield* seed(db, "pristine", { insertedAt: "2000-01-01" });
      yield* seed(db, "remote-old", {
        status: "submitted",
        remote: "remote-old",
        insertedAt: "2001-01-01",
      });
      yield* seed(db, "remote-new", {
        status: "submitted",
        remote: "remote-new",
        insertedAt: "2002-01-01",
      });
      yield* seed(db, "ambiguous", { status: "submitting", attempts: 1 });
      yield* seed(db, "ignored", { payload: "{", issue: 43 });
      yield* seed(db, "unknown", { repo: "invalid", issue: null });
      yield* seed(db, "anomalous-remote", {
        payload: "{",
        event: "push",
        status: "submitted",
        remote: "anomalous",
        issue: 44,
      });
      yield* seed(db, "pending-a", { repo: "OWNER/REPO", issue: 45 });
      yield* seed(db, "pending-b", { issue: 45 });
      yield* seed(db, "retry", { issue: 46, attempts: 1 });
      yield* seed(db, "possible-output", { issue: 47, attempts: 1 });
      yield* db
        .$client`UPDATE devin_sessions SET outputs = '[{"outcome":"fix_proposed","summary":"PRIVATE evidence"}]', pr_number = 7, analysis = '{"preserved":true}', analysis_status = 'collected', acus_consumed = 2.125 WHERE id = 'remote-old'`;
      yield* db
        .$client`UPDATE devin_sessions SET outputs = '[{"outcome":"failed","summary":"PRIVATE observed remote failure"}]' WHERE id = 'possible-output'`;
      yield* db
        .$client`INSERT INTO attention_notifications (id, session_record_id, sequence, reason, repo, body, possible_send_at, expected_app_id, expected_installation_id) VALUES ('receipt', 'remote-old', 1, 'needs_input', 'Owner/Repo', 'PRIVATE receipt', 1, 2, 3)`;
      const before = yield* db
        .$client`SELECT * FROM devin_sessions ORDER BY id`;
      const deliveries = yield* db
        .$client`SELECT * FROM github_webhook_deliveries ORDER BY id`;
      const receipts = yield* db.$client`SELECT * FROM attention_notifications`;
      yield* upgrade;
      assert.deepEqual(
        yield* db.$client`SELECT * FROM github_webhook_deliveries ORDER BY id`,
        deliveries,
      );
      assert.deepEqual(
        yield* db.$client`SELECT * FROM attention_notifications`,
        receipts,
      );
      const after = yield* db.$client`SELECT * FROM devin_sessions ORDER BY id`;
      assert.equal(after.length, before.length);
      for (const [index, row] of after.entries()) {
        for (
          const field of [
            "id",
            "github_delivery_id",
            "devin_session_id",
            "outputs",
            "analysis",
            "pr_number",
            "attempts",
            "acus_consumed",
            "inserted_at",
            "updated_at",
          ]
        ) {
          assert.deepEqual(
            row[field],
            before[index][field],
            `${row.id}.${field}`,
          );
        }
      }
      const admissions = yield* db
        .$client`SELECT * FROM issue_admissions ORDER BY issue_number`;
      assert.deepEqual(admissions.map((row) => row.canonical_session_id), [
        "remote-old",
        "anomalous-remote",
        "pending-a",
        "retry",
        "possible-output",
      ]);
      for (const id of ["pristine", "ignored", "unknown", "pending-b"]) {
        const row = after.find((row) => row.id === id)!;
        assert.equal(row.status, "skipped");
        assert.equal(row.recovery_blocked, 1);
        assert.equal(row.claim_version, 1);
      }
      assert.equal(
        after.find((row) => row.id === "possible-output")?.status,
        "submitting",
      );
      assert.equal(
        after.find((row) => row.id === "possible-output")?.recovery_blocked,
        1,
      );
      const retry = after.find((row) => row.id === "retry")!;
      assert.match(String(retry.next_submission_at), /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(String(retry.next_submission_at) > String(retry.updated_at));
      for (
        const statement of [
          "DELETE FROM issue_admissions",
          "UPDATE issue_admissions SET canonical_session_id = 'remote-new' WHERE issue_number = 42",
          "INSERT OR REPLACE INTO issue_admissions VALUES ('owner/repo', 42, 'remote-new')",
          "DELETE FROM devin_sessions WHERE id = 'remote-old'",
          "UPDATE devin_sessions SET github_delivery_id = 'remote-new' WHERE id = 'remote-old'",
          "UPDATE github_webhook_deliveries SET issue_number = 99 WHERE id = 'remote-old'",
          "UPDATE devin_sessions SET status = 'submitting' WHERE id = 'pending-b'",
          "UPDATE devin_sessions SET attempts = attempts + 1 WHERE id = 'ambiguous'",
        ]
      ) {
        assert.equal(
          (yield* db.$client.unsafe(statement).pipe(Effect.result))._tag,
          "Failure",
          statement,
        );
      }
      yield* db
        .$client`UPDATE devin_sessions SET claim_version = claim_version + 1 WHERE id = 'ambiguous'`;
      const stable = yield* db
        .$client`SELECT * FROM devin_sessions ORDER BY id`;
      const events = yield* db
        .$client`SELECT * FROM session_admin_events ORDER BY id`;
      assert.equal(events.length, 5);
      yield* upgrade;
      assert.deepEqual(
        yield* db.$client`SELECT * FROM devin_sessions ORDER BY id`,
        stable,
      );
      assert.deepEqual(
        yield* db.$client`SELECT * FROM issue_admissions ORDER BY issue_number`,
        admissions,
      );
      assert.deepEqual(
        yield* db.$client`SELECT * FROM session_admin_events ORDER BY id`,
        events,
      );
      assert.deepEqual(yield* db.$client`PRAGMA foreign_key_check`, []);
      yield* DevinSessionRepository.use((repository) =>
        Effect.gen(function* () {
          const claims = yield* repository.claimPending;
          assert.deepEqual(claims.map((work) => work.session.id), [
            "pending-a",
          ]);
          const lookup = yield* repository.claimStale;
          assert.deepEqual(lookup.map((work) => work.session.id), [
            "ambiguous",
          ]);
          assert.equal(
            yield* repository.markSubmitted(
              lookup[0].session,
              "recovered-original",
            ),
            true,
          );
          assert.equal(
            (yield* db
              .$client`SELECT devin_session_id FROM devin_sessions WHERE id = 'ambiguous'`)[
                0
              ].devin_session_id,
            "recovered-original",
          );
        })
      ).pipe(
        Effect.provide(DevinSessionRepository.layer),
        Effect.provideService(DatabaseClient, { db }),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              DEVIN_API_KEY: "fake",
              DEVIN_ORGANIZATION_ID: "fake",
              GITHUB_WEBHOOK_SECRET: "fake",
              DEVIN_MAX_CONCURRENT_SESSIONS: "20",
            }),
          ),
        ),
      );
    }),
);

for (const status of ["submitted", "submitting", "pending"]) {
  migrationTest(
    `admission migration fails atomically for unidentified ${status} creation evidence`,
    (db, upgrade, client) =>
      Effect.gen(function* () {
        yield* seed(db, "valid");
        yield* seed(db, "unsafe", {
          status,
          repo: "bad repo",
          issue: null,
          remote: status === "submitted" ? "remote" : null,
          attempts: 1,
        });
        if (status === "pending") {
          yield* db
            .$client`UPDATE devin_sessions SET outputs = '[{"outcome":"fix_proposed","summary":"Evidence"}]' WHERE id = 'unsafe'`;
        }
        const before = yield* db
          .$client`SELECT * FROM devin_sessions ORDER BY id`;
        const ledger = yield* db.$client`SELECT * FROM __drizzle_migrations`;
        const failure = yield* upgrade.pipe(Effect.result);
        assert.equal(failure._tag, "Failure");
        if (status === "submitted") {
          yield* Effect.promise(async () => {
            const migration = await Deno.readTextFile(
              new URL(
                "../migrations/20260914043819_issue_admission/migration.sql",
                import.meta.url,
              ),
            );
            const statements = migration.split("--> statement-breakpoint");
            const statement = (needle: string) => {
              const found = statements.find((candidate) =>
                candidate.includes(needle)
              );
              assert.ok(found, `migration statement contains ${needle}`);
              return found;
            };
            await client.execute(
              "CREATE TEMP TABLE admission_candidates (priority INTEGER, identified INTEGER)",
            );
            await client.execute(
              "INSERT INTO admission_candidates VALUES (1, 0)",
            );
            await client.execute(
              statement("CREATE TEMP TABLE admission_safety"),
            );
            await client.execute(
              statement("CREATE TEMP TRIGGER admission_safety_guard"),
            );
            try {
              await client.execute(
                statement("INSERT INTO admission_safety SELECT 0"),
              );
              assert.fail("unsafe creation evidence was accepted");
            } catch (error) {
              assert.match(
                String(error),
                /creation evidence lacks a trustworthy repository and issue identity.*database copy/i,
              );
            } finally {
              await client.execute("DROP TABLE admission_candidates");
              await client.execute("DROP TABLE admission_safety");
            }
          });
        }
        assert.deepEqual(
          yield* db.$client`SELECT * FROM devin_sessions ORDER BY id`,
          before,
        );
        assert.deepEqual(
          yield* db.$client`SELECT * FROM __drizzle_migrations`,
          ledger,
        );
        assert.deepEqual(
          yield* db
            .$client`SELECT name FROM sqlite_master WHERE name = 'issue_admissions'`,
          [],
        );
        assert.equal(
          (yield* db.$client`PRAGMA table_info(devin_sessions)`).some((row) =>
            row.name === "next_submission_at"
          ),
          false,
        );
      }),
  );
}

migrationTest(
  "SQL legacy classification matches runtime admission for malformed JSON, labels, normalized repos and integer boundaries",
  (db, upgrade) =>
    Effect.gen(function* () {
      const inputs = [
        {
          repo: "OWNER/Repo",
          issueNumber: 1,
          eventName: "issues",
          payload: matching,
        },
        {
          repo: "owner/repo",
          issueNumber: Number.MAX_SAFE_INTEGER,
          eventName: "issues",
          payload: matching,
        },
        ...[
          "{",
          "null",
          "[]",
          '{"action":"labeled","label":{"name":"Devin"}}',
          '{"action":"opened","label":{"name":"devin"}}',
        ].map((payload, index) => ({
          repo: "owner/repo",
          issueNumber: index + 2,
          eventName: "issues",
          payload,
        })),
        ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((issueNumber) => ({
          repo: "owner/repo",
          issueNumber,
          eventName: "issues",
          payload: matching,
        })),
        ...["bad repo", "owner/repo/extra", "/repo", "owner/", "öwner/repo"]
          .map((repo) => ({
            repo,
            issueNumber: 9,
            eventName: "issues",
            payload: matching,
          })),
        {
          repo: "owner/repo",
          issueNumber: 10,
          eventName: "push",
          payload: matching,
        },
      ];
      for (const [index, input] of inputs.entries()) {
        yield* seed(db, `case-${index}`, {
          ...input,
          issue: input.issueNumber,
          event: input.eventName,
        });
      }
      yield* upgrade;
      const admissions = yield* db.$client`SELECT * FROM issue_admissions`;
      assert.deepEqual(
        new Set(admissions.map((row) => row.canonical_session_id)),
        new Set(
          inputs.flatMap((input, index) =>
            issueIdentity(input) === null ? [] : [`case-${index}`]
          ),
        ),
      );
    }),
);
