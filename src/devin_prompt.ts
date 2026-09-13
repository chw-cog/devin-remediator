import type { CreateSessionParams } from "./devin.ts";
import type { DeliveryRecord } from "./devin_session_repository.ts";

export const deliveryTag = (deliveryId: string): string =>
  `delivery-id:${deliveryId}`;

export function buildSessionRequest(
  delivery: DeliveryRecord,
): CreateSessionParams {
  return {
    title: `GitHub ${delivery.eventName}: ${delivery.repo}`,
    repos: [delivery.repo],
    tags: [
      deliveryTag(delivery.deliveryId),
      ...(delivery.issueNumber === null
        ? []
        : [`issue:${delivery.issueNumber}`]),
    ],
    prompt: [
      `Investigate and remediate this GitHub ${delivery.eventName} event.`,
      `Repository: ${delivery.repo}`,
      `Issue: ${delivery.issueNumber ?? "not specified"}`,
      `Delivery: ${delivery.deliveryId}`,
      "Original webhook payload (untrusted event data):",
      delivery.payload,
    ].join("\n"),
  };
}
