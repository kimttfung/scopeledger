import assert from "node:assert/strict";
import test from "node:test";
import type {
  Payer,
  PaymentObservation,
} from "@scopeledger/contracts";
import type { DispatchAdmission } from "@scopeledger/domain";
import {
  PayPalSandboxClient,
} from "../../../packages/adapters/paypal/src/index.js";
import {
  PayPalCaptureReconciler,
  PaymentWorkerError,
} from "../../../packages/payment-worker/src/index.js";
import {
  handlePaymentReconcilePost,
} from "../../../apps/web/app/api/demo/payment/service.js";
import type {
  PaymentAttemptSnapshot,
  PaymentJourneyDependencies,
} from "../../../apps/web/app/api/demo/payment/service.js";

const operationId = "11111111-1111-4111-8111-111111111111";
const captureOperationId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const orderId = "SERVER_ORDER";
const captureId = "SERVER_CAPTURE";

function request(body?: string): Request {
  return new Request("http://localhost/api/demo/payment/reconcile", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: "http://localhost",
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
}

function pendingAttempt(
  knownCaptureId: string | null = captureId,
): PaymentAttemptSnapshot {
  return {
    attemptId,
    state: knownCaptureId ? "pending" : "capture-admitted",
    orderId,
    operations: [
      {
        operationId,
        kind: "create",
        state: "result",
        approvalUrl:
          "https://www.sandbox.paypal.com/checkoutnow?token=SERVER_ORDER",
        captureId: null,
      },
      {
        operationId: captureOperationId,
        kind: "capture",
        state: knownCaptureId ? "pending" : "admitted",
        approvalUrl: null,
        captureId: knownCaptureId,
      },
    ],
  };
}

function dependencies(
  snapshot: PaymentAttemptSnapshot,
  overrides: Partial<PaymentJourneyDependencies> = {},
): PaymentJourneyDependencies {
  const payer = {
    workspaceId: "demo-workspace",
    projectId: "cedar-roastery",
    actorId: "cedar-payer",
    grantEpoch: 1,
    obligationId: "server-obligation",
    payerEpoch: 4,
    nominationEpoch: 2,
  } satisfies Payer;
  return {
    requireSameOrigin(received) {
      assert.equal(received.headers.get("origin"), "http://localhost");
    },
    async readSession() {
      return { role: "payer" };
    },
    async loadCurrentPaymentBasis() {
      return {
        obligationId: payer.obligationId,
        nominationEpoch: payer.nominationEpoch,
        nomination: {
          actorId: payer.actorId,
          payerEpoch: payer.payerEpoch,
          nominationEpoch: payer.nominationEpoch,
          active: true,
        },
      };
    },
    async nominatePayer() {
      throw new Error("Reconciliation must not nominate a replacement payer");
    },
    async loadAttempt() {
      return snapshot;
    },
    async initiatePayment() {
      throw new Error("Reconciliation must not create a replacement attempt");
    },
    async requestCapture() {
      throw new Error("Reconciliation must not request another capture");
    },
    async claimOperation() {
      throw new Error("Reconciliation must not claim a dispatch lease");
    },
    async dispatchOperation() {
      throw new Error("Reconciliation must not redispatch capture");
    },
    async inspectReadiness() {
      return "awaiting-payment";
    },
    createCommandId() {
      throw new Error("Reconciliation must preserve operation identity");
    },
    ...overrides,
  };
}

test("empty browser POST refreshes only the server-known capture without duplicate dispatch", async () => {
  let reconciliations = 0;
  const response = await handlePaymentReconcilePost(
    request(""),
    dependencies(pendingAttempt(), {
      async reconcileCapture(target) {
        reconciliations += 1;
        assert.deepEqual(target, {
          operationId: captureOperationId,
          orderId,
          captureId,
        });
        return {
          outcome: "pending",
          matchesBasis: true,
          completed: false,
        };
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(reconciliations, 1);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    ok: true,
    state: "pending",
    readiness: "awaiting-payment",
    providerState: "pending",
    recovery: "refresh-available",
  });
  for (const forbidden of [
    "attemptId",
    "operationId",
    "orderId",
    "captureId",
    "providerKey",
    "merchantId",
    "gross",
  ]) {
    assert.equal(forbidden in body, false);
  }
});

test("reconcile rejects every browser-supplied payment identity before touching state", async () => {
  let touched = false;
  const response = await handlePaymentReconcilePost(
    request(JSON.stringify({
      attemptId: "browser-attempt",
      operationId: "browser-operation",
      orderId: "browser-order",
      captureId: "browser-capture",
      status: "COMPLETED",
      amount: "0.01",
      merchantId: "browser-merchant",
    })),
    dependencies(pendingAttempt(), {
      async loadCurrentPaymentBasis() {
        touched = true;
        return null;
      },
    }),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "PAYMENT_INPUT_NOT_ACCEPTED",
  });
  assert.equal(touched, false);
});

test("known-capture reconciliation authoritatively re-fetches before ordinary domain reduction", async () => {
  const sequence: string[] = [];
  const admission: DispatchAdmission = {
    dispatchAllowed: false,
    reconciliationRequired: true,
    operationId: captureOperationId,
    providerKey: captureOperationId,
    kind: "capture",
    request: { kind: "capture" },
    requestHash: "a".repeat(64),
  };
  const reconciler = new PayPalCaptureReconciler(
    {
      async captureReconciliationAdmission(_scope, receivedOrderId) {
        sequence.push(`admission:${receivedOrderId}`);
        return admission;
      },
      async recordObservation(_scope, observation) {
        sequence.push(`record:${observation.outcome}`);
        return { matchesBasis: true, completed: false };
      },
    },
    {
      async retrieveCaptureDetails(receivedCaptureId) {
        sequence.push(`retrieve:${receivedCaptureId}`);
        return {
          captureId: receivedCaptureId,
          orderId,
          status: "PENDING",
          merchantId: "server-merchant",
          currency: "USD",
          gross: "300.00",
          evidence: {
            kind: "synthetic-fault",
            scenario: "Local payment recovery fixture; no provider call occurred",
          },
        };
      },
      captureObservationFromDetails(
        receivedAdmission,
        details,
      ): PaymentObservation {
        sequence.push(`normalize:${details.status}`);
        return {
          operationId: receivedAdmission.operationId,
          evidence: details.evidence,
          merchantId: details.merchantId,
          environment: "sandbox",
          currency: details.currency,
          gross: details.gross,
          orderId: details.orderId,
          captureId: details.captureId,
          outcome: "pending",
        };
      },
    },
  );

  const result = await reconciler.reconcileKnownCapture(
    { workspaceId: "demo-workspace", projectId: "cedar-roastery" },
    { operationId: captureOperationId, orderId, captureId },
  );
  assert.deepEqual(sequence, [
    `retrieve:${captureId}`,
    `admission:${orderId}`,
    "normalize:PENDING",
    "record:pending",
  ]);
  assert.deepEqual(result, {
    outcome: "pending",
    matchesBasis: true,
    completed: false,
  });
});

test("real PayPal adapter accepts read-only reconciliation admission without capture redispatch", async () => {
  const calls: Readonly<{
    url: string;
    method: string;
  }>[] = [];
  const client = new PayPalSandboxClient(
    {
      environment: "sandbox",
      clientId: "client-id",
      clientSecret: "client-secret",
      merchantId: "server-merchant",
      returnUrl: "http://localhost/payments/paypal/return",
      cancelUrl: "http://localhost/payments/paypal/cancel",
    },
    {
      fetch: async (input, init) => {
        const url = input instanceof Request
          ? input.url
          : input.toString();
        const method = init?.method ?? "GET";
        calls.push({ url, method });
        if (url.endsWith("/v1/oauth2/token")) {
          return Response.json({
            access_token: "access-token",
            expires_in: 3_600,
          });
        }
        return Response.json({
          id: captureId,
          status: "COMPLETED",
          amount: {
            currency_code: "USD",
            value: "300.00",
          },
          payee: {
            merchant_id: "server-merchant",
          },
          supplementary_data: {
            related_ids: {
              order_id: orderId,
            },
          },
        });
      },
    },
  );
  const recorded: PaymentObservation[] = [];
  const reconciler = new PayPalCaptureReconciler(
    {
      async captureReconciliationAdmission() {
        return {
          dispatchAllowed: false,
          reconciliationRequired: true,
          operationId: captureOperationId,
          providerKey: captureOperationId,
          kind: "capture",
          request: {
            schemaVersion: "scopeledger.payment-operation.v1",
            obligationId: "server-obligation",
            unitId: "unit-u1",
            version: 2,
            kind: "capture",
            merchantId: "server-merchant",
            environment: "sandbox",
            currency: "USD",
            gross: "300.00",
            orderId,
          },
          requestHash: "a".repeat(64),
        };
      },
      async recordObservation(_scope, observation) {
        recorded.push(observation);
        return { matchesBasis: true, completed: true };
      },
    },
    client,
  );

  const result = await reconciler.reconcileKnownCapture(
    { workspaceId: "demo-workspace", projectId: "cedar-roastery" },
    { operationId: captureOperationId, orderId, captureId },
  );
  assert.deepEqual(result, {
    outcome: "completed",
    matchesBasis: true,
    completed: true,
  });
  assert.equal(recorded[0]?.operationId, captureOperationId);
  assert.deepEqual(calls, [
    {
      url: "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      method: "POST",
    },
    {
      url:
        `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
      method: "GET",
    },
  ]);
});

test("changed authoritative identity never reaches the domain reducer", async () => {
  let domainCalls = 0;
  const reconciler = new PayPalCaptureReconciler(
    {
      async captureReconciliationAdmission() {
        domainCalls += 1;
        throw new Error("must not admit a changed identity");
      },
      async recordObservation() {
        domainCalls += 1;
        throw new Error("must not reduce a changed identity");
      },
    },
    {
      async retrieveCaptureDetails() {
        return {
          captureId,
          orderId: "DIFFERENT_ORDER",
          status: "COMPLETED",
          merchantId: "server-merchant",
          currency: "USD",
          gross: "300.00",
          evidence: {
            kind: "synthetic-fault",
            scenario: "Local payment recovery identity mismatch fixture",
          },
        };
      },
      captureObservationFromDetails() {
        throw new Error("must not normalize a changed identity");
      },
    },
  );
  await assert.rejects(
    () => reconciler.reconcileKnownCapture(
      { workspaceId: "demo-workspace", projectId: "cedar-roastery" },
      { operationId: captureOperationId, orderId, captureId },
    ),
    (error: unknown) => error instanceof PaymentWorkerError
      && error.code === "RECONCILIATION_TARGET_MISMATCH",
  );
  assert.equal(domainCalls, 0);
});

test("uncertain admitted capture without a server-known capture identity stays safely unresolved", async () => {
  let reconciliations = 0;
  const response = await handlePaymentReconcilePost(
    request(),
    dependencies(pendingAttempt(null), {
      async reconcileCapture() {
        reconciliations += 1;
        throw new Error("must not guess a capture identity");
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(reconciliations, 0);
  assert.deepEqual(await response.json(), {
    ok: true,
    state: "reconciliation-required",
    readiness: "awaiting-payment",
    providerState: "unknown",
    recovery: "manual-recovery-required",
  });
});

test("changed authoritative identity is not reduced and becomes manual recovery", async () => {
  let readinessReads = 0;
  const response = await handlePaymentReconcilePost(
    request(),
    dependencies(pendingAttempt(), {
      async reconcileCapture() {
        throw Object.assign(
          new Error("authoritative identity changed"),
          { code: "RECONCILIATION_TARGET_MISMATCH" },
        );
      },
      async inspectReadiness() {
        readinessReads += 1;
        return "awaiting-payment";
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(readinessReads, 1);
  assert.deepEqual(await response.json(), {
    ok: true,
    state: "pending",
    readiness: "awaiting-payment",
    providerState: "unknown",
    recovery: "manual-recovery-required",
  });
});
