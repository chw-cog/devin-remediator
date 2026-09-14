import { Option, Schema } from "effect";

const decodeIssue = Schema.decodeUnknownOption(Schema.Struct({
  eventName: Schema.Literal("issues"),
  repo: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  ),
  issueNumber: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  payload: Schema.fromJsonString(Schema.Struct({
    action: Schema.Literal("labeled"),
    label: Schema.Struct({ name: Schema.Literal("devin") }),
  })),
}));

export function issueIdentity(
  delivery: {
    eventName: string;
    repo: string;
    issueNumber?: number | null;
    payload: string;
  },
) {
  const decoded = decodeIssue(delivery);
  return Option.isNone(decoded) ? null : {
    repo: decoded.value.repo.toLowerCase(),
    issueNumber: decoded.value.issueNumber,
  };
}
