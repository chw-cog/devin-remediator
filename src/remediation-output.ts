import { JsonSchema, Predicate, Schema } from "effect";

export const RemediationOutcome = Schema.Literals([
  "fix_proposed",
  "needs_human",
  "not_reproducible",
  "failed",
  "already_resolved",
]);

export type RemediationOutcome = typeof RemediationOutcome.Type;

const NonBlankString = Schema.NonEmptyString.check(Schema.isPattern(/\S/));

export const RemediationOutput = Schema.Struct({
  outcome: RemediationOutcome.annotate({
    description:
      "fix_proposed: a new safe fix is implemented, verified, and submitted as a PR; merging is not required. needs_human: human input or a decision is required to complete implementation or verification, or security escalation is needed; routine PR review and merge are not blockers. not_reproducible: investigation could not reproduce the reported bug; failed: remediation was attempted but could not be completed; already_resolved: an existing fix is verified to resolve the issue, without new remediation. An unmerged PR alone is not already_resolved.",
  }),
  summary: NonBlankString.annotate({
    description:
      "Concise result, reproduction and verification evidence, and any blocker or smallest next action. Do not claim checks passed if they were not run.",
  }),
  verification: Schema.optionalKey(Schema.Struct({
    status: Schema.Literals(["passed", "failed", "partial", "not_run"])
      .annotate({
        description:
          "passed: all relevant checks ran and passed; failed: a relevant check failed; partial: only some required checks ran; not_run: no verification checks ran.",
      }),
    evidence: Schema.Array(NonBlankString).annotate({
      description:
        "Concrete commands and observed results, reproduction evidence, or evidence URLs. Use an empty array if no evidence was collected; never invent evidence.",
    }),
  })),
  blocker: Schema.optionalKey(Schema.NullOr(NonBlankString)).annotate({
    description:
      "What prevents implementation or verification; null if nothing. Routine PR review and merge are not blockers.",
  }),
  next_action: Schema.optionalKey(Schema.NullOr(NonBlankString)).annotate({
    description:
      "The smallest concrete next step and who needs to take it; for fix_proposed, identify the maintainer review and merge step. Use null if no action remains.",
  }),
  confidence: Schema.optionalKey(
    Schema.Finite.check(
      Schema.isBetween({ minimum: 0, maximum: 1 }),
    ).annotate({
      description:
        "Optional self-assessed confidence in the outcome, from 0 to 1; not a calibrated probability.",
    }),
  ),
});

export type RemediationOutput = typeof RemediationOutput.Type;

export const normalizedRemediationOutput = (output: RemediationOutput) =>
  JSON.stringify(
    output,
    (_key, value: unknown) =>
      Predicate.isObject(value) && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left.localeCompare(right)
          ),
        )
        : value,
  );

export const remediationOutputSchema = Schema.decodeUnknownSync(
  Schema.JsonObject,
)(
  JsonSchema.toDocumentDraft07(
    Schema.toJsonSchemaDocument(RemediationOutput, {
      onExcessProperty: "error",
    }),
  ).schema,
);

export const decodeRemediationOutput = Schema.decodeUnknownOption(
  RemediationOutput,
  { onExcessProperty: "error" },
);
