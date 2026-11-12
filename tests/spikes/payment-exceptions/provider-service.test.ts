import assert from "node:assert/strict";
import test from "node:test";
import {
  handlePaymentExceptionsGet,
  handlePaymentExceptionsRefresh,
} from "../../../apps/web/app/api/provider/payment-exceptions/service.js";
import type {
  PaymentExceptionDependencies,
  ProviderPaymentException,
} from "../../../apps/web/app/api/provider/payment-exceptions/service.js";

const exception: ProviderPaymentException = Object.freeze({
  observationId: "41",
  projectName: "Cedar Roastery",
  requestTitle: "Case-study request",
  unitTitle: "Populate one case-study page",
  kind: "refund",
  state: "partial-refund",
  providerStatus: "COMPLETED",
  providerResourceId: "REFUND123",
  captureId: "CAPTURE123",
  currency: "USD",
  captureGross: "300.00",
  affectedGross: "75.00",
  observedAt: "2026-11-12T10:00:00.000Z",
  activeFinancialHold: true,
  readiness: "withheld-financial-exception",
  workStart: {
    version: 2,
    recordedAt: "2026-11-12T09:00:00.000Z",
  },
});

function dependencies(
  overrides: Partial<PaymentExceptionDependencies> = {},
): PaymentExceptionDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    hasInspectGrant: async () => true,
    listExceptions: async () => [exception],
    refresh: async () => ({
      processed: 1,
      eventTypes: [{
        eventType: "PAYMENT.REFUND.COMPLETED",
        count: 1,
      }],
      outcomes: [{
        outcome: "payment-exception-recorded",
        count: 1,
      }],
    }),
    ...overrides,
  };
}

function refreshRequest(body: object): Request {
  return new Request(
    "http://127.0.0.1:3000/api/provider/payment-exceptions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3000",
      },
      body: JSON.stringify(body),
    },
  );
}

test("provider exception reads require assurance and current inspect authority", async () => {
  const assuranceDenied = await handlePaymentExceptionsGet(dependencies({
    verifyProvider: async () => ({
      ok: false,
      status: 403,
      code: "PROVIDER_ASSURANCE_REQUIRED",
    }),
  }));
  assert.equal(assuranceDenied.status, 403);
  const grantDenied = await handlePaymentExceptionsGet(dependencies({
    hasInspectGrant: async () => false,
  }));
  assert.equal(grantDenied.status, 403);
  const allowed = await handlePaymentExceptionsGet(dependencies());
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as {
    capabilities: Record<string, boolean>;
  };
  assert.deepEqual(body.capabilities, {
    authoritativeRefresh: true,
    refundInitiation: false,
    manualOutcomeOverride: false,
  });
});

test("explicit refresh reports observations and guarantees no financial write", async () => {
  const response = await handlePaymentExceptionsRefresh(
    refreshRequest({ action: "refresh" }),
    dependencies(),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    effects: Record<string, boolean>;
    exceptions: readonly ProviderPaymentException[];
  };
  assert.deepEqual(body.effects, {
    refundInitiated: false,
    paymentAttemptCreated: false,
    agreementChanged: false,
    manualOutcomeOverride: false,
  });
  assert.deepEqual(body.exceptions, [exception]);
});

test("manual outcome and refund commands are rejected", async () => {
  for (const body of [
    { action: "refund" },
    { action: "mark-success" },
    { action: "refresh", outcome: "completed" },
  ]) {
    const response = await handlePaymentExceptionsRefresh(
      refreshRequest(body),
      dependencies(),
    );
    assert.equal(response.status, 400);
  }
});
