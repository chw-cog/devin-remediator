# Devin structured remediation outcomes

## Why use the v3 schema fields?

This repository uses Devin's v3 organization sessions API. Its
[Create Session documentation](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions)
supports both requested fields:

- `structured_output_schema` accepts a self-contained JSON Schema Draft 7
  object, up to 64 KB, with no external `$ref`.
- `structured_output_required: true` requires the agent to call
  `provide_structured_output` with `is_final=true` before its turn ends. The
  documented default is true; the issues processor sets it explicitly.

The
[Get Session documentation](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session)
describes `structured_output` as nullable, validated output populated on
get/list responses, not the creation response.

The older
[v1 structured-output guide](https://docs.devin.ai/api-reference/v1/structured-output)
describes prompt-requested output that changes while Devin works. Its
prompt-only instructions are not a substitute for the v3 schema fields.

## Why this schema?

`src/remediation-output.ts` defines one Effect schema for local validation and
generates the Draft 7 request schema from it:

- Required `outcome`: `fixed`, `needs_human`, `not_reproducible`, `failed`, or
  `already_resolved`.
- Required `summary`: a nonempty string containing non-whitespace text, with
  reproduction, verification, and blocker or next-action evidence.
- Optional `confidence`: a finite number between 0 and 1.
- Optional `verification`: an object with required `status` (`passed`, `failed`,
  `partial`, or `not_run`) and `evidence` (an array of nonblank strings).
- Optional `blocker` and `next_action`: nonblank strings or null.
- No additional properties.

The issues processor supplies the schema on every session creation, including
when it reuses an existing playbook. The prompt defines the outcomes so that
`fixed` means a verified safe fix, not merely an agent turn that ended. It
explicitly requests verification evidence, blocker, and next action. Those
fields remain optional in the schema so that sessions started with the earlier
schema still produce valid results. Null means no blocker or next action;
omission means the field was not reported.

Issue sessions carry `github:<org>/<repo>` alongside their delivery and issue
tags, using the persisted repository name.

## Why keep status separate from outcome?

Session execution and issue remediation answer different questions. A session
that finishes normally can report `needs_human`, `not_reproducible`, or
`failed`. This change preserves the repository's existing lifecycle mapping.

`devin_sessions.output` stores the entire validated object, including its
summary, verification evidence, blocker, next action, and confidence when
supplied. Drizzle's SQLite JSON mode serializes it as JSON text and returns a
typed object on reads. The old scalar `outcome` column is removed.

Application policy, rather than a Devin API guarantee, determines persistence:

- For `succeeded` or `failed`, save the complete locally valid structured
  output.
- If that output is absent or invalid, save a fallback object with outcome
  `needs_human` for `succeeded` or `failed` for `failed`, and a summary
  explaining that no valid result was available. Do not invent verification
  evidence.
- For every other local status, including `skipped`, keep `output` null.
- Submission rejection and exhausted attempts save a `failed` output object with
  a summary describing the local failure.

The migration backfills historical `succeeded` rows with `needs_human` and
historical `failed` rows with `failed`. Old rows have no stored structured
output; neither successful execution nor a PR number proves that a fix was
verified. The follow-up JSON migration wraps each existing outcome with the
summary `"Legacy session: structured output was not recorded."` and preserves
all other session data.

SQLite enforces terminal output presence, nonterminal nullability, valid JSON
objects, the embedded outcome enum, and a nonempty string summary. The Effect
schema validates the complete result at the API boundary.

## Why evidence and an already-resolved outcome?

These are application design choices, not documented Devin features or
guarantees.

**Verification evidence is more useful than confidence.** A partial result can
now retain concrete evidence and the action needed to finish:

```json
{
  "outcome": "needs_human",
  "summary": "The regression test passes, but browser verification is blocked.",
  "verification": {
    "status": "partial",
    "evidence": ["deno test src/example.test.ts: passed"]
  },
  "blocker": "No credentials for the affected environment.",
  "next_action": "Provide a test account for browser verification."
}
```

The verification enum (`passed`, `failed`, `partial`, and `not_run`)
distinguishes failed checks from checks Devin never ran. Keep this separate from
the remediation outcome. Bounded confidence remains a self-assessment, not a
calibrated probability or grounds for automatic merging.

**Already resolved distinguishes existing fixes from new work.** Use
`already_resolved` only when an existing fix is verified to resolve the issue.
The prompt requests the fix URL and verification evidence. An unmerged PR
needing review still uses `needs_human`, not `already_resolved`.

## What remains uncertain?

The documented requirement applies before a **turn** ends, not necessarily
before the whole session completes. The fetched v3 schema does not expose a
finality marker or output-specific timestamp alongside `structured_output`.

The reviewed docs do not establish output availability after crashes, quota
exhaustion, or interruptions. Nor do they specify invalid-output retry behavior.
A valid payload can be an earlier snapshot, particularly after an abrupt
failure. The stored output is therefore an agent-reported result, not
independent proof of remediation. Preserve the lifecycle status when assessing
it.

Validation uses HTTP fixtures, the real Devin client and orchestration code, and
SQLite migrations. No live Devin session was created for this change.
