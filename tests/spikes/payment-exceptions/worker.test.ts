import assert from "node:assert/strict";
import test from "node:test";
import type {
  PaymentExceptionObservation,
} from "@scopeledger/domain";
import {
  PayPalAdapterError,
  PayPalSandboxClient,
} from "@scopeledger/paypal-adapter";
import type {
  PayPalCaptureDetails,
  PayPalOrderDetails,
  PayPalRefundDetails,
} from "@scopeledger/paypal-adapter";
import {
  PayPalWebhookReceiptProcessor,
} from "@scopeledger/payment-worker";
import type {
  PayPalWebhookDomainStore,
  PayPalWebhookProviderClient,
  StoredPayPalWebhookReceipt,
} from "@scopeledger/payment-worker";

const scope = Object.freeze({
  workspaceId: "demo-workspace",
  projectId: "project-one",
  environment: "sandbox" as const,
  merchantId: "sandbox-merchant",
});
const admission = Object.freeze({
  operationId: "11111111-1111-4111-8111-111111111111",
  obligationId: "obligation-one",
  unitId: "unit-one",
  orderId: "ORDER123",
  captureId: "CAPTURE123",
  merchantId: scope.merchantId,
  environment: scope.environment,
  currency: "USD" as const,
  gross: "300.00",
});

function receipt(
  eventId: string,
  eventType: string,
  resourceType: string,
  resourceId: string,
  createdAt: string,
): StoredPayPalWebhookReceipt {
  return Object.freeze({
    workspaceId: scope.workspaceId,
    environment: scope.environment,
    merchantId: scope.merchantId,
    eventId,
    eventType,
    resourceType,
    resourceId,
    resourceStatus: "TRIGGER_ONLY",
    providerCreatedAt: new Date(createdAt),
    receivedAt: new Date(createdAt),
    verificationReference: `verified_${eventId}`,
  });
}

function capture(status: string): PayPalCaptureDetails {
  return Object.freeze({
    captureId: admission.captureId,
    orderId: admission.orderId,
    status,
    merchantId: admission.merchantId,
    currency: "USD",
    gross: admission.gross,
    evidence: {
      kind: "authenticated-adapter" as const,
      verificationReference: "paypal_capture_CAPTURE123",
    },
  });
}

function order(): PayPalOrderDetails {
  return Object.freeze({
    orderId: admission.orderId,
    status: "COMPLETED",
    merchantId: admission.merchantId,
    environment: "sandbox",
    currency: "USD",
    gross: admission.gross,
    captures: [{
      captureId: admission.captureId,
      status: "COMPLETED",
      currency: "USD" as const,
      gross: admission.gross,
    }],
  });
}

function refund(): PayPalRefundDetails {
  return Object.freeze({
    refundId: "REFUND123",
    captureId: admission.captureId,
    status: "COMPLETED",
    currency: "USD",
    gross: "75.00",
    evidence: {
      kind: "authenticated-adapter" as const,
      verificationReference: "paypal_refund_REFUND123",
    },
  });
}

function provider(options: {
  captureStatus?: string;
  mismatch?: boolean;
} = {}): PayPalWebhookProviderClient {
  const adapter = new PayPalSandboxClient({
    environment: "sandbox",
    clientId: "client",
    clientSecret: "secret",
    merchantId: admission.merchantId,
    returnUrl: "http://127.0.0.1:3000/payments/paypal/return",
    cancelUrl: "http://127.0.0.1:3000/payments/paypal/cancel",
    timeoutMilliseconds: 15_000,
  }, {
    fetch: async () => assert.fail("Worker fake supplies exact resources"),
  });
  return {
    async retrieveCaptureDetails() {
      return capture(options.captureStatus ?? "COMPLETED");
    },
    captureObservationFromDetails() {
      throw new Error("Capture completion normalization must not run");
    },
    async retrieveOrderDetails() {
      return order();
    },
    async retrieveRefundDetails() {
      return refund();
    },
    refundExceptionFromDetails(current, details, captureDetails, orderDetails) {
      return adapter.refundExceptionFromDetails(
        current,
        details,
        captureDetails,
        orderDetails,
      );
    },
    captureRefundExceptionFromDetails(
      current,
      captureDetails,
      orderDetails,
    ) {
      if (options.mismatch) {
        throw new PayPalAdapterError(
          "FINANCIAL_MISMATCH",
          "Injected authoritative mismatch",
        );
      }
      return adapter.captureRefundExceptionFromDetails(
        current,
        captureDetails,
        orderDetails,
      );
    },
    captureReversalExceptionFromDetails(
      current,
      captureDetails,
      orderDetails,
    ) {
      return adapter.captureReversalExceptionFromDetails(
        current,
        captureDetails,
        orderDetails,
      );
    },
  };
}

function domain() {
  const observations = new Map<string, PaymentExceptionObservation>();
  const store: PayPalWebhookDomainStore = {
    async captureReconciliationAdmission() {
      throw new Error("Capture completion admission must not run");
    },
    async recordObservation() {
      throw new Error("Capture completion observation must not run");
    },
    async paymentExceptionAdmission() {
      return admission;
    },
    async recordPaymentExceptionObservation(_scope, observation) {
      const identity = JSON.stringify(observation);
      const duplicate = observations.has(identity);
      observations.set(identity, observation);
      return {
        duplicate,
        holdActive: observation.state !== "failed",
        readinessWithheld: observation.state !== "failed",
      };
    },
  };
  return { store, observations };
}

test("duplicate and reordered refund triggers converge on one current partial-refund fact", async () => {
  const receipts = [
    receipt(
      "event-pending",
      "PAYMENT.REFUND.PENDING",
      "refund",
      "REFUND123",
      "2026-11-12T10:00:00.000Z",
    ),
    receipt(
      "event-completed",
      "PAYMENT.REFUND.COMPLETED",
      "refund",
      "REFUND123",
      "2026-11-12T10:01:00.000Z",
    ),
  ];
  let reverse = false;
  const current = domain();
  const processor = new PayPalWebhookReceiptProcessor(
    {
      async listReceipts() {
        reverse = !reverse;
        return reverse ? [...receipts].reverse() : receipts;
      },
    },
    current.store,
    provider(),
  );
  const first = await processor.process(scope);
  const repeated = await processor.process(scope);
  assert.deepEqual(
    first.results.map(({ exceptionState }) => exceptionState),
    ["partial-refund", "partial-refund"],
  );
  assert.deepEqual(
    repeated.results.map(({ duplicate }) => duplicate),
    [true, true],
  );
  assert.equal(current.observations.size, 1);
});

test("reversal unknown and exact mismatch become blocking exception observations", async () => {
  const unknownDomain = domain();
  const unknown = new PayPalWebhookReceiptProcessor(
    {
      async listReceipts() {
        return [receipt(
          "event-reversal",
          "PAYMENT.CAPTURE.REVERSED",
          "capture",
          admission.captureId,
          "2026-11-12T10:00:00.000Z",
        )];
      },
    },
    unknownDomain.store,
    provider({ captureStatus: "COMPLETED" }),
  );
  assert.equal(
    (await unknown.process(scope)).results[0]?.exceptionState,
    "unknown",
  );

  const mismatchDomain = domain();
  const mismatch = new PayPalWebhookReceiptProcessor(
    {
      async listReceipts() {
        return [receipt(
          "event-refunded",
          "PAYMENT.CAPTURE.REFUNDED",
          "capture",
          admission.captureId,
          "2026-11-12T10:01:00.000Z",
        )];
      },
    },
    mismatchDomain.store,
    provider({ mismatch: true }),
  );
  const result = (await mismatch.process(scope)).results[0];
  assert.equal(result?.outcome, "payment-exception-recorded");
  assert.equal(result?.exceptionState, "mismatch");
  assert.equal(result?.holdActive, true);
});
