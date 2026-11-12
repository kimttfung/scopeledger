import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentObservation } from "@scopeledger/contracts";
import type { DispatchAdmission } from "@scopeledger/domain";
import type {
  PayPalCaptureDetails,
  PayPalRefundDetails,
} from "@scopeledger/paypal-adapter";
import {
  PayPalWebhookReceiptProcessor,
  summarizePayPalWebhookProcessing,
} from "../../../packages/payment-worker/src/index.js";
import type {
  PayPalWebhookDomainStore,
  PayPalWebhookProviderClient,
  PayPalWebhookReceiptSource,
  StoredPayPalWebhookReceipt,
} from "../../../packages/payment-worker/src/index.js";

const scope = Object.freeze({
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
  environment: "sandbox" as const,
  merchantId: "merchant",
});

const captureAdmission: DispatchAdmission = Object.freeze({
  dispatchAllowed: false,
  reconciliationRequired: true,
  operationId: "11111111-1111-4111-8111-111111111111",
  providerKey: "11111111-1111-4111-8111-111111111111",
  kind: "capture",
  request: {
    orderId: "ORDER_SECRET",
    merchantId: scope.merchantId,
    environment: scope.environment,
    currency: "USD",
    gross: "1.00",
  },
  requestHash: "a".repeat(64),
});

function receipt(
  eventId: string,
  eventType: string,
  options: Partial<StoredPayPalWebhookReceipt> = {},
): StoredPayPalWebhookReceipt {
  return Object.freeze({
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    merchantId: scope.merchantId,
    eventId,
    eventType,
    resourceType: "capture",
    resourceId: "CAPTURE_SECRET",
    resourceStatus: "WEBHOOK_STATUS_IS_ONLY_A_TRIGGER",
    providerCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    receivedAt: new Date("2026-01-01T00:00:01.000Z"),
    verificationReference: "verified",
    ...options,
  });
}

function source(
  list: () => readonly StoredPayPalWebhookReceipt[],
): PayPalWebhookReceiptSource {
  return {
    async listReceipts() {
      return list();
    },
  };
}

function captureDetails(
  status = "COMPLETED",
): PayPalCaptureDetails {
  return Object.freeze({
    captureId: "CAPTURE_SECRET",
    orderId: "ORDER_SECRET",
    status,
    merchantId: scope.merchantId,
    currency: "USD",
    gross: "1.00",
    evidence: {
      kind: "synthetic-fault" as const,
      scenario: "Local webhook worker fake; no provider call occurred",
    },
  });
}

function refundDetails(): PayPalRefundDetails {
  return Object.freeze({
    refundId: "REFUND_SECRET",
    captureId: "CAPTURE_SECRET",
    status: "COMPLETED",
    currency: "USD",
    gross: "1.00",
    evidence: {
      kind: "synthetic-fault" as const,
      scenario: "Local webhook worker fake; no provider call occurred",
    },
  });
}

function observation(
  admission: DispatchAdmission,
  details: PayPalCaptureDetails,
): PaymentObservation {
  return Object.freeze({
    operationId: admission.operationId,
    evidence: details.evidence,
    merchantId: details.merchantId,
    environment: scope.environment,
    currency: details.currency,
    gross: details.gross,
    orderId: details.orderId,
    captureId: details.captureId,
    outcome: details.status === "COMPLETED"
      ? "completed"
      : details.status === "PENDING" ? "pending" : "unknown",
  });
}

function unusedDomain(): PayPalWebhookDomainStore {
  return {
    async captureReconciliationAdmission() {
      throw new Error("Domain capture reconciliation must not run");
    },
    async recordObservation() {
      throw new Error("Domain observation must not run");
    },
  };
}

function unusedProvider(): PayPalWebhookProviderClient {
  return {
    async retrieveCaptureDetails() {
      throw new Error("Capture retrieval must not run");
    },
    captureObservationFromDetails() {
      throw new Error("Capture normalization must not run");
    },
    async retrieveRefundDetails() {
      throw new Error("Refund retrieval must not run");
    },
  };
}

test("lists receipts in deterministic provider-created, received, event order", async () => {
  const receipts = [
    receipt("event-c", "CHECKOUT.ORDER.APPROVED", {
      providerCreatedAt: new Date("2026-01-02T00:00:00.000Z"),
    }),
    receipt("event-b", "CHECKOUT.ORDER.APPROVED", {
      receivedAt: new Date("2026-01-01T00:00:02.000Z"),
    }),
    receipt("event-a", "CHECKOUT.ORDER.APPROVED"),
  ];
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => receipts),
    unusedDomain(),
    unusedProvider(),
  );
  assert.deepEqual(
    (await processor.list(scope)).map(({ eventId }) => eventId),
    ["event-a", "event-b", "event-c"],
  );
});

test("capture webhook status only triggers authoritative re-fetch before reduction", async () => {
  const sequence: string[] = [];
  const domain: PayPalWebhookDomainStore = {
    async captureReconciliationAdmission(_scope, orderId) {
      sequence.push(`admission:${orderId}`);
      return captureAdmission;
    },
    async recordObservation(_scope, received) {
      sequence.push(`record:${received.outcome}`);
      return { matchesBasis: true, completed: false };
    },
  };
  const provider: PayPalWebhookProviderClient = {
    async retrieveCaptureDetails(captureId) {
      sequence.push(`retrieve:${captureId}`);
      return captureDetails("PENDING");
    },
    captureObservationFromDetails(admission, details) {
      sequence.push(`normalize:${details.status}`);
      return observation(admission, details);
    },
    async retrieveRefundDetails() {
      throw new Error("Refund retrieval must not run");
    },
  };
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => [
      receipt("event-completed", "PAYMENT.CAPTURE.COMPLETED", {
        resourceStatus: "COMPLETED",
      }),
    ]),
    domain,
    provider,
  );
  const batch = await processor.process(scope);
  assert.deepEqual(sequence, [
    "retrieve:CAPTURE_SECRET",
    "admission:ORDER_SECRET",
    "normalize:PENDING",
    "record:pending",
  ]);
  assert.deepEqual(batch.results[0], {
    eventId: "event-completed",
    eventType: "PAYMENT.CAPTURE.COMPLETED",
    outcome: "capture-observation-recorded",
    matchesBasis: true,
    completed: false,
  });
});

test("approved order is observed without capture or domain action", async () => {
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => [
      receipt("event-approved", "CHECKOUT.ORDER.APPROVED", {
        resourceType: "checkout-order",
        resourceId: "ORDER_SECRET",
        resourceStatus: "APPROVED",
      }),
    ]),
    unusedDomain(),
    unusedProvider(),
  );
  assert.equal(
    (await processor.process(scope)).results[0]?.outcome,
    "observed-no-automatic-action",
  );
});

test("refund and capture reversal are re-fetched then retained for manual domain integration", async () => {
  const retrieved: string[] = [];
  const provider: PayPalWebhookProviderClient = {
    async retrieveCaptureDetails(captureId) {
      retrieved.push(`capture:${captureId}`);
      return captureDetails();
    },
    captureObservationFromDetails() {
      throw new Error("Refund/reversal must not normalize a capture observation");
    },
    async retrieveRefundDetails(refundId) {
      retrieved.push(`refund:${refundId}`);
      return refundDetails();
    },
  };
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => [
      receipt("event-refund", "PAYMENT.REFUND.COMPLETED", {
        resourceType: "refund",
        resourceId: "REFUND_SECRET",
      }),
      receipt("event-reversal", "PAYMENT.CAPTURE.REVERSED"),
    ]),
    unusedDomain(),
    provider,
  );
  const batch = await processor.process(scope);
  assert.deepEqual(retrieved, [
    "refund:REFUND_SECRET",
    "capture:CAPTURE_SECRET",
  ]);
  assert.deepEqual(
    batch.results.map(({ outcome }) => outcome),
    [
      "retained-manual-domain-integration-required",
      "retained-manual-domain-integration-required",
    ],
  );
});

test("a provider failure does not stop later receipts", async () => {
  const provider: PayPalWebhookProviderClient = {
    async retrieveCaptureDetails() {
      throw new Error("Synthetic provider failure");
    },
    captureObservationFromDetails() {
      throw new Error("Normalization must not run after retrieval failure");
    },
    async retrieveRefundDetails() {
      throw new Error("Refund retrieval must not run");
    },
  };
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => [
      receipt("event-failure", "PAYMENT.CAPTURE.DENIED"),
      receipt("event-later", "CHECKOUT.ORDER.APPROVED", {
        providerCreatedAt: new Date("2026-01-01T00:00:02.000Z"),
        resourceType: "checkout-order",
        resourceId: "ORDER_SECRET",
      }),
    ]),
    unusedDomain(),
    provider,
  );
  assert.deepEqual(
    (await processor.process(scope)).results.map(({ outcome }) => outcome),
    ["provider-failure", "observed-no-automatic-action"],
  );
});

test("invalid, resource-missing and unmatched outcomes are stable per receipt", async () => {
  const domain: PayPalWebhookDomainStore = {
    async captureReconciliationAdmission() {
      throw Object.assign(new Error("No admitted capture"), {
        code: "RECONCILIATION_REQUIRED",
      });
    },
    async recordObservation() {
      throw new Error("Observation must not run for unmatched capture");
    },
  };
  const provider: PayPalWebhookProviderClient = {
    async retrieveCaptureDetails() {
      return captureDetails();
    },
    captureObservationFromDetails() {
      throw new Error("Normalization must not run for unmatched capture");
    },
    async retrieveRefundDetails() {
      throw new Error("Refund retrieval must not run");
    },
  };
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => [
      receipt("event-missing", "PAYMENT.CAPTURE.PENDING", {
        resourceId: null,
      }),
      receipt("event-unmatched", "PAYMENT.CAPTURE.COMPLETED", {
        providerCreatedAt: new Date("2026-01-01T00:00:02.000Z"),
      }),
      receipt("event-invalid", "PAYMENT.CAPTURE.COMPLETED", {
        providerCreatedAt: new Date("invalid"),
      }),
    ]),
    domain,
    provider,
  );
  assert.deepEqual(
    (await processor.process(scope)).results.map(({ outcome }) => outcome),
    [
      "resource-missing",
      "unmatched-capture-operation",
      "invalid-receipt",
    ],
  );
});

test("duplicate and reordered repeated processing converges through the normal reducer", async () => {
  const receipts = [
    receipt("event-pending", "PAYMENT.CAPTURE.PENDING"),
    receipt("event-completed", "PAYMENT.CAPTURE.COMPLETED", {
      providerCreatedAt: new Date("2026-01-01T00:00:02.000Z"),
    }),
  ];
  let reverse = false;
  const reduced = new Map<string, PaymentObservation>();
  const domain: PayPalWebhookDomainStore = {
    async captureReconciliationAdmission() {
      return captureAdmission;
    },
    async recordObservation(_scope, received) {
      reduced.set(received.operationId, received);
      return { matchesBasis: true, completed: received.outcome === "completed" };
    },
  };
  const provider: PayPalWebhookProviderClient = {
    async retrieveCaptureDetails() {
      return captureDetails("COMPLETED");
    },
    captureObservationFromDetails: observation,
    async retrieveRefundDetails() {
      throw new Error("Refund retrieval must not run");
    },
  };
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => {
      reverse = !reverse;
      return reverse ? [...receipts].reverse() : receipts;
    }),
    domain,
    provider,
  );
  const first = await processor.process(scope);
  const repeated = await processor.process(scope);
  assert.deepEqual(first, repeated);
  assert.equal(reduced.size, 1);
  assert.equal(reduced.get(captureAdmission.operationId)?.outcome, "completed");
});

test("summary output contains only counts, event types and outcomes", async () => {
  const processor = new PayPalWebhookReceiptProcessor(
    source(() => [
      receipt("EVENT_PROVIDER_SECRET", "CHECKOUT.ORDER.APPROVED", {
        resourceType: "checkout-order",
        resourceId: "RESOURCE_PROVIDER_SECRET",
      }),
    ]),
    unusedDomain(),
    unusedProvider(),
  );
  const summary = summarizePayPalWebhookProcessing(
    await processor.process(scope),
  );
  assert.deepEqual(Object.keys(summary), [
    "processed",
    "eventTypes",
    "outcomes",
  ]);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("EVENT_PROVIDER_SECRET"), false);
  assert.equal(serialized.includes("RESOURCE_PROVIDER_SECRET"), false);
  assert.equal(serialized.includes(scope.merchantId), false);
  assert.deepEqual(summary, {
    processed: 1,
    eventTypes: [{ eventType: "CHECKOUT.ORDER.APPROVED", count: 1 }],
    outcomes: [{ outcome: "observed-no-automatic-action", count: 1 }],
  });
});
