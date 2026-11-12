import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentObservation } from "@scopeledger/contracts";
import type { DispatchAdmission } from "@scopeledger/domain";
import type {
  PayPalCaptureDetails,
  PayPalOrderDetails,
  PayPalRefundDetails,
} from "@scopeledger/paypal-adapter";
import {
  PayPalFinancialAuditor,
  processPayPalWebhookTriggersForKnownTargets,
  summarizePayPalFinancialAudit,
  summarizePayPalWebhookHealth,
} from "@scopeledger/payment-worker";
import type {
  CaptureReconciliationStore,
  PayPalCaptureReconciliationClient,
  PayPalFinancialAuditTarget,
  PayPalFinancialAuditTargetSource,
  PayPalWebhookDomainStore,
  PayPalWebhookProviderClient,
  StoredPayPalWebhookReceipt,
} from "@scopeledger/payment-worker";

const now = new Date("2026-11-12T16:00:00.000Z");
const workspaceId = "workspace-secret";
const merchantId = "merchant-secret";

function target(
  projectId: string,
  operationId: string,
  options: Partial<PayPalFinancialAuditTarget> = {},
): PayPalFinancialAuditTarget {
  return Object.freeze({
    workspaceId,
    projectId,
    operationId,
    orderId: `order-${operationId}`,
    captureId: `capture-${operationId}`,
    factVerifiedAt: new Date("2026-11-12T15:00:00.000Z"),
    activeAttempt: false,
    ...options,
  });
}

function admission(received: PayPalFinancialAuditTarget): DispatchAdmission {
  return Object.freeze({
    dispatchAllowed: false,
    reconciliationRequired: true,
    operationId: received.operationId,
    providerKey: received.operationId,
    kind: "capture",
    request: {
      orderId: received.orderId,
      merchantId,
      environment: "sandbox",
      currency: "USD",
      gross: "1.00",
    },
    requestHash: "a".repeat(64),
  });
}

function captureDetails(
  received: PayPalFinancialAuditTarget,
  status = "COMPLETED",
): PayPalCaptureDetails {
  return Object.freeze({
    captureId: received.captureId!,
    orderId: received.orderId,
    status,
    merchantId,
    currency: "USD",
    gross: "1.00",
    evidence: {
      kind: "authenticated-adapter" as const,
      verificationReference: `verified-${received.operationId}`,
    },
  });
}

function observation(
  received: PayPalFinancialAuditTarget,
  details: PayPalCaptureDetails,
): PaymentObservation {
  return Object.freeze({
    operationId: received.operationId,
    evidence: details.evidence,
    merchantId,
    environment: "sandbox",
    currency: "USD",
    gross: "1.00",
    orderId: received.orderId,
    captureId: details.captureId,
    outcome: details.status === "COMPLETED"
      ? "completed"
      : details.status === "PENDING" ? "pending" : "unknown",
  });
}

function auditFixture(
  listed: readonly PayPalFinancialAuditTarget[],
  options: Readonly<{
    providerError?: unknown;
    status?: string;
  }> = {},
) {
  const byOrder = new Map(listed.map((entry) => [entry.orderId, entry]));
  const byCapture = new Map(
    listed
      .filter((entry) => entry.captureId)
      .map((entry) => [entry.captureId!, entry]),
  );
  const calls = {
    captureReads: [] as string[],
    orderReads: [] as string[],
    observations: [] as PaymentObservation[],
    dispatches: 0,
  };
  const source: PayPalFinancialAuditTargetSource = {
    async listTargets() {
      return listed;
    },
  };
  const store: CaptureReconciliationStore = {
    async captureReconciliationAdmission(_scope, orderId) {
      return admission(byOrder.get(orderId)!);
    },
    async recordObservation(_scope, received) {
      calls.observations.push(received);
      return {
        matchesBasis: received.outcome === "completed",
        completed: received.outcome === "completed",
      };
    },
  };
  const client: PayPalCaptureReconciliationClient & {
    execute(): Promise<never>;
  } = {
    async execute() {
      calls.dispatches += 1;
      throw new Error("Audit must never dispatch capture");
    },
    async retrieveCaptureDetails(captureId) {
      calls.captureReads.push(captureId);
      if (options.providerError) throw options.providerError;
      const received = byCapture.get(captureId)!;
      return captureDetails(received, options.status);
    },
    captureObservationFromDetails(_admission, details) {
      return observation(byCapture.get(details.captureId)!, details);
    },
    async retrieveOrderDetails(orderId): Promise<PayPalOrderDetails> {
      calls.orderReads.push(orderId);
      const received = byOrder.get(orderId)!;
      return Object.freeze({
        orderId,
        status: "COMPLETED",
        merchantId,
        environment: "sandbox",
        currency: "USD",
        gross: "1.00",
        captures: [{
          captureId: `discovered-${received.operationId}`,
          status: "COMPLETED",
          currency: "USD" as const,
          gross: "1.00",
        }],
      });
    },
    captureObservationFromOrderDetails(_admission, details) {
      const received = byOrder.get(details.orderId)!;
      return Object.freeze({
        operationId: received.operationId,
        evidence: {
          kind: "authenticated-adapter" as const,
          verificationReference: `discovered-${received.operationId}`,
        },
        merchantId,
        environment: "sandbox",
        currency: "USD",
        gross: "1.00",
        orderId: received.orderId,
        captureId: details.captures[0]!.captureId,
        outcome: "completed",
      });
    },
  };
  return {
    calls,
    auditor: new PayPalFinancialAuditor(source, store, client),
  };
}

test("audit pages are deterministic, bounded and never redispatch capture", async () => {
  const listed = [
    target("project-b", "operation-2"),
    target("project-a", "operation-1"),
  ];
  const fixture = auditFixture(listed);
  const first = await fixture.auditor.auditPage({
    workspaceId,
    environment: "sandbox",
    merchantId,
    limit: 1,
    now,
  });
  assert.deepEqual(first.results.map(({ cursor }) => cursor), [{
    projectId: "project-a",
    operationId: "operation-1",
  }]);
  const second = await fixture.auditor.auditPage({
    workspaceId,
    environment: "sandbox",
    merchantId,
    after: first.nextCursor!,
    limit: 1,
    now,
  });
  assert.deepEqual(second.results.map(({ cursor }) => cursor), [{
    projectId: "project-b",
    operationId: "operation-2",
  }]);
  assert.equal(fixture.calls.dispatches, 0);
  assert.deepEqual(fixture.calls.captureReads, [
    "capture-operation-1",
    "capture-operation-2",
  ]);
});

test("stale exact refresh preserves reducer limits and remains unresolved", async () => {
  const stale = target("project-a", "operation-stale", {
    factVerifiedAt: new Date("2026-11-11T14:00:00.000Z"),
  });
  const fixture = auditFixture([stale]);
  const results = await fixture.auditor.auditTargets([stale], {
    workspaceId,
    limit: 1,
    now,
  });
  assert.equal(results[0]?.outcome, "exact-refresh");
  assert.equal(results[0]?.readinessRestored, false);
  assert.equal(fixture.calls.observations.length, 1);
  assert.deepEqual(summarizePayPalFinancialAudit(results), {
    audited: 1,
    activeAttempts: 0,
    knownFacts: 1,
    staleFacts: 1,
    exactRefreshes: 1,
    captureDiscoveries: 0,
    readinessRestored: 0,
    readinessWithheld: 1,
    pending: 0,
    unknown: 0,
    credentialFailures: 0,
    providerFailures: 0,
    authoritativeMismatches: 0,
    domainFailures: 0,
    unresolved: 1,
  });
});

test("Order retrieval discovers a completed capture on the same admitted attempt", async () => {
  const unknownCapture = target("project-a", "operation-discovery", {
    captureId: null,
    factVerifiedAt: null,
    activeAttempt: true,
  });
  const fixture = auditFixture([unknownCapture]);
  const results = await fixture.auditor.auditTargets([unknownCapture], {
    workspaceId,
    limit: 1,
    now,
  });
  assert.equal(results[0]?.outcome, "capture-discovered");
  assert.equal(results[0]?.readinessRestored, true);
  assert.deepEqual(fixture.calls.orderReads, [unknownCapture.orderId]);
  assert.equal(fixture.calls.dispatches, 0);
});

test("unknown, credential and provider outcomes are safe unresolved counts", async () => {
  const known = target("project-a", "operation-health");
  const unknownFixture = auditFixture([known], { status: "DENIED" });
  const unknown = await unknownFixture.auditor.auditTargets([known], {
    workspaceId,
    limit: 1,
    now,
  });
  assert.equal(unknown[0]?.outcome, "unknown");

  for (const [code, expected] of [
    ["AUTHENTICATION_FAILED", "credential-failure"],
    ["PROVIDER_REJECTED", "provider-failure"],
  ] as const) {
    const failed = auditFixture([known], {
      providerError: Object.assign(new Error("provider secret"), { code }),
    });
    const results = await failed.auditor.auditTargets([known], {
      workspaceId,
      limit: 1,
      now,
    });
    assert.equal(results[0]?.outcome, expected);
    const serialized = JSON.stringify(summarizePayPalFinancialAudit(results));
    assert.equal(serialized.includes("provider secret"), false);
    assert.equal(serialized.includes(known.captureId!), false);
    assert.equal(serialized.includes(merchantId), false);
  }
});

function receipt(
  eventId: string,
  eventType: string,
  options: Partial<StoredPayPalWebhookReceipt> = {},
): StoredPayPalWebhookReceipt {
  return Object.freeze({
    workspaceId,
    environment: "sandbox",
    merchantId,
    eventId,
    eventType,
    resourceType: "capture",
    resourceId: "capture-trigger",
    resourceStatus: "TRIGGER_ONLY",
    providerCreatedAt: new Date("2026-11-12T15:00:00.000Z"),
    receivedAt: new Date("2026-11-12T15:00:02.000Z"),
    verificationReference: "verified-trigger-secret",
    ...options,
  });
}

test("verified refund triggers resolve against known scopes and health redacts identities", async () => {
  const targets = [
    target("project-a", "operation-a", {
      captureId: "capture-trigger",
    }),
    target("project-b", "operation-b", {
      captureId: "capture-trigger-b",
    }),
  ];
  const exceptionAdmission = {
    operationId: "operation-b",
    obligationId: "obligation-secret",
    unitId: "unit-secret",
    orderId: "order-operation-b",
    captureId: "capture-trigger-b",
    merchantId,
    environment: "sandbox" as const,
    currency: "USD" as const,
    gross: "1.00",
  };
  const domain: PayPalWebhookDomainStore = {
    async captureReconciliationAdmission() {
      throw new Error("Capture admission not used");
    },
    async recordObservation() {
      throw new Error("Capture observation not used");
    },
    async paymentExceptionAdmission(scope) {
      if (scope.projectId === "project-a") {
        throw Object.assign(new Error("not this project"), {
          code: "RECONCILIATION_REQUIRED",
        });
      }
      return exceptionAdmission;
    },
    async recordPaymentExceptionObservation() {
      return {
        duplicate: false,
        holdActive: true,
        readinessWithheld: true,
      };
    },
  };
  const provider: PayPalWebhookProviderClient = {
    async retrieveCaptureDetails(captureId) {
      return captureDetails({
        ...targets[1]!,
        captureId,
      });
    },
    captureObservationFromDetails() {
      throw new Error("Capture normalization not used");
    },
    async retrieveOrderDetails(): Promise<PayPalOrderDetails> {
      return Object.freeze({
        orderId: exceptionAdmission.orderId,
        status: "COMPLETED",
        merchantId,
        environment: "sandbox",
        currency: "USD",
        gross: "1.00",
        captures: [],
      });
    },
    async retrieveRefundDetails(): Promise<PayPalRefundDetails> {
      return Object.freeze({
        refundId: "refund-provider-secret",
        captureId: exceptionAdmission.captureId,
        status: "COMPLETED",
        currency: "USD",
        gross: "1.00",
        evidence: {
          kind: "authenticated-adapter" as const,
          verificationReference: "refund-proof-secret",
        },
      });
    },
    refundExceptionFromDetails(admission, refund) {
      return Object.freeze({
        provider: "paypal",
        kind: "refund",
        state: "full-refund",
        operationId: admission.operationId,
        resourceId: refund.refundId,
        orderId: admission.orderId,
        captureId: admission.captureId,
        merchantId: admission.merchantId,
        environment: "sandbox" as const,
        currency: admission.currency,
        captureGross: admission.gross,
        affectedGross: admission.gross,
        providerStatus: refund.status,
        evidence: refund.evidence,
      });
    },
    captureRefundExceptionFromDetails() {
      throw new Error("Capture refund normalization not used");
    },
    captureReversalExceptionFromDetails() {
      throw new Error("Reversal normalization not used");
    },
  };
  const receipts = [receipt("event-provider-secret", "PAYMENT.REFUND.COMPLETED", {
    resourceType: "refund",
    resourceId: "refund-provider-secret",
  })];
  const batch = await processPayPalWebhookTriggersForKnownTargets({
    receipts,
    targets,
    domain,
    provider,
  });
  assert.equal(batch.results[0]?.outcome, "payment-exception-recorded");
  const health = summarizePayPalWebhookHealth(batch, receipts, now);
  assert.equal(health.processed, 1);
  assert.equal(health.unresolved, 0);
  const serialized = JSON.stringify(health);
  for (const secret of [
    "event-provider-secret",
    "refund-provider-secret",
    "refund-proof-secret",
    merchantId,
    "1.00",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("credential failure in a known capture trigger is counted without raw error", async () => {
  const known = target("project-a", "operation-trigger", {
    captureId: "capture-trigger",
  });
  const provider: PayPalWebhookProviderClient = {
    async retrieveCaptureDetails() {
      throw Object.assign(new Error("credential raw secret"), {
        code: "AUTHENTICATION_FAILED",
      });
    },
    captureObservationFromDetails() {
      throw new Error("not reached");
    },
    async retrieveOrderDetails() {
      throw new Error("not reached");
    },
    async retrieveRefundDetails() {
      throw new Error("not reached");
    },
    refundExceptionFromDetails() {
      throw new Error("not reached");
    },
    captureRefundExceptionFromDetails() {
      throw new Error("not reached");
    },
    captureReversalExceptionFromDetails() {
      throw new Error("not reached");
    },
  };
  const batch = await processPayPalWebhookTriggersForKnownTargets({
    receipts: [receipt("credential-event-secret", "PAYMENT.CAPTURE.COMPLETED")],
    targets: [known],
    domain: {
      async captureReconciliationAdmission() {
        throw new Error("not reached");
      },
      async recordObservation() {
        throw new Error("not reached");
      },
      async paymentExceptionAdmission() {
        throw new Error("not reached");
      },
      async recordPaymentExceptionObservation() {
        throw new Error("not reached");
      },
    },
    provider,
  });
  const health = summarizePayPalWebhookHealth(batch, [
    receipt("credential-event-secret", "PAYMENT.CAPTURE.COMPLETED"),
  ], now);
  assert.equal(health.credentialFailures, 1);
  assert.equal(health.unresolved, 1);
  assert.equal(JSON.stringify(health).includes("credential raw secret"), false);
});
