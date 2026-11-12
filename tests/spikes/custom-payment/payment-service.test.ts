import assert from "node:assert/strict";
import test from "node:test";
import type { Lease } from "@scopeledger/contracts";
import type {
  ApprovedPaymentTarget,
  PaymentLocators,
} from "../../../apps/web/app/api/pay/database.js";
import {
  captureCheckout,
  handlePaymentCapturePost,
  handlePaymentPreparePost,
  loadCustomPayment,
  reconcileCheckout,
  type CustomPaymentDependencies,
  type PaymentAttemptSnapshot,
} from "../../../apps/web/app/api/pay/service.js";

const locators: PaymentLocators = {
  projectLocator: `slr1p_${"A".repeat(43)}`,
  requestLocator: `slr1r_${"B".repeat(43)}`,
  unitLocator: `slr1u_${"C".repeat(43)}`,
  payerLocator: `slr1y_${"D".repeat(43)}`,
};
const target: ApprovedPaymentTarget = {
  workspaceId: "demo-workspace",
  projectId: "server-project",
  requestId: "server-request",
  unitId: "server-unit",
  version: 1,
  digest: "a".repeat(64),
  obligationId: "server-obligation",
  projectNominationEpoch: 1,
  providerInspectGrantEpoch: 4,
  providerPublishGrantEpoch: 7,
  projectLabel: "Harbor Bakery H1 Demo",
  requestLabel: "Harbor opaque review",
  unitTitle: "Harbor custom payable unit",
  currency: "USD",
  gross: "200.00",
  payer: {
    workspaceId: "demo-workspace",
    projectId: "server-project",
    actorId: "cedar-payer",
    grantEpoch: 1,
    obligationId: "server-obligation",
    payerEpoch: 1,
    nominationEpoch: 1,
  },
  activatedAt: "2026-11-12T14:00:00.000Z",
};
const createOperationId = "11111111-1111-4111-8111-111111111111";
const captureOperationId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const approvalUrl =
  "https://www.sandbox.paypal.com/checkoutnow?token=SERVER_ORDER";

function request(path: string, body?: string): Request {
  return new Request(`http://localhost${path}`, {
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

function available(): PaymentAttemptSnapshot {
  return {
    attemptId,
    state: "order-available",
    orderId: "SERVER_ORDER",
    operations: [{
      operationId: createOperationId,
      kind: "create",
      state: "result",
      approvalUrl,
    }],
  };
}

function dependencies(
  overrides: Partial<CustomPaymentDependencies> = {},
): CustomPaymentDependencies {
  let snapshot: PaymentAttemptSnapshot | null = null;
  const lease: Lease = {
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    operationId: createOperationId,
    token: "44444444-4444-4444-8444-444444444444",
    generation: 1,
  };
  return {
    requireSameOrigin(received) {
      if (received.headers.get("origin") !== "http://localhost") {
        throw new Error("SAME_ORIGIN_REQUIRED");
      }
    },
    async readSession() {
      return { subject: "verified-payer", role: "payer" };
    },
    async loadTarget() {
      return target;
    },
    async loadAttempt() {
      return snapshot;
    },
    async initiatePayment(received, commandId) {
      assert.equal(received.obligationId, "server-obligation");
      assert.equal(received.gross, "200.00");
      assert.equal(commandId, "stable-create-command");
      snapshot = {
        attemptId,
        state: "intent",
        orderId: null,
        operations: [{
          operationId: createOperationId,
          kind: "create",
          state: "intent",
          approvalUrl: null,
        }],
      };
      return {
        attemptId,
        operationId: createOperationId,
        providerKey: createOperationId,
        state: "intent",
      };
    },
    async requestCapture(received, commandId, receivedAttempt, orderId) {
      assert.equal(received.obligationId, "server-obligation");
      assert.equal(commandId, "stable-capture-command");
      assert.equal(receivedAttempt, attemptId);
      assert.equal(orderId, "SERVER_ORDER");
      snapshot = {
        ...available(),
        state: "capture-intent",
        operations: [
          ...available().operations,
          {
            operationId: captureOperationId,
            kind: "capture",
            state: "intent",
            approvalUrl: null,
          },
        ],
      };
      return {
        attemptId,
        operationId: captureOperationId,
        providerKey: captureOperationId,
        state: "intent",
      };
    },
    async claimOperation(_target, operationId) {
      return { ...lease, operationId };
    },
    async dispatchOperation(_target, receivedLocators, receivedLease) {
      assert.deepEqual(receivedLocators, locators);
      if (receivedLease.operationId === captureOperationId) {
        snapshot = {
          ...available(),
          state: "completed",
          operations: [
            ...available().operations,
            {
              operationId: captureOperationId,
              kind: "capture",
              state: "result",
              approvalUrl: null,
              captureId: "SERVER_CAPTURE",
            },
          ],
        };
        return { approvalUrl: null };
      }
      snapshot = available();
      return { approvalUrl };
    },
    async inspectReadiness() {
      return snapshot?.state === "completed" ? "ready" : "awaiting-payment";
    },
    createCommandId(kind) {
      return kind === "create"
        ? "stable-create-command"
        : "stable-capture-command";
    },
    ...overrides,
  };
}

test("verified payer role and current server authority gate every payment action", async () => {
  let loaded = false;
  const missing = await handlePaymentPreparePost(
    request("/api/pay/opaque/prepare"),
    locators,
    dependencies({
      async readSession() {
        return null;
      },
      async loadTarget() {
        loaded = true;
        return target;
      },
    }),
  );
  assert.equal(missing.status, 401);
  assert.equal(loaded, false);

  const wrongRole = await handlePaymentCapturePost(
    request("/api/pay/opaque/capture"),
    locators,
    dependencies({
      async readSession() {
        return { subject: "verified-approver", role: "client-approver" };
      },
    }),
  );
  assert.equal(wrongRole.status, 403);
  assert.deepEqual(await wrongRole.json(), {
    ok: false,
    code: "PAYER_ROLE_REQUIRED",
  });

  const revoked = await loadCustomPayment(locators, dependencies({
    async loadTarget() {
      throw Object.assign(new Error("revoked"), { code: "ACCESS_DENIED" });
    },
  }));
  assert.deepEqual(revoked, {
    ok: false,
    status: 403,
    code: "PAYMENT_NOT_AUTHORIZED",
  });
});

test("browser payment IDs and financial fields are rejected before server lookup", async () => {
  let loaded = false;
  const response = await handlePaymentPreparePost(
    request("/api/pay/opaque/prepare", JSON.stringify({
      workspaceId: "browser-workspace",
      projectId: "browser-project",
      unitId: "browser-unit",
      version: 999,
      digest: "b".repeat(64),
      obligationId: "browser-obligation",
      attemptId: "browser-attempt",
      orderId: "browser-order",
      captureId: "browser-capture",
      merchantId: "browser-merchant",
      amount: "0.01",
      currency: "USD",
      status: "COMPLETED",
    })),
    locators,
    dependencies({
      async loadTarget() {
        loaded = true;
        return target;
      },
    }),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "PAYMENT_INPUT_NOT_ACCEPTED",
  });
  assert.equal(loaded, false);
});

test("prepare exposes only an opaque continuation and reuses one attempt", async () => {
  let initiations = 0;
  let snapshot: PaymentAttemptSnapshot | null = null;
  const deps = dependencies({
    async loadAttempt() {
      return snapshot;
    },
    async initiatePayment(received, commandId) {
      initiations += 1;
      assert.equal(received.currency, "USD");
      assert.equal(received.gross, "200.00");
      assert.equal(commandId, "stable-create-command");
      snapshot = {
        attemptId,
        state: "intent",
        orderId: null,
        operations: [{
          operationId: createOperationId,
          kind: "create",
          state: "intent",
          approvalUrl: null,
        }],
      };
      return {
        attemptId,
        operationId: createOperationId,
        providerKey: createOperationId,
        state: "intent",
      };
    },
    async dispatchOperation() {
      snapshot = available();
      return { approvalUrl };
    },
  });
  const first = await handlePaymentPreparePost(
    request("/api/pay/opaque/prepare"),
    locators,
    deps,
  );
  const second = await handlePaymentPreparePost(
    request("/api/pay/opaque/prepare"),
    locators,
    deps,
  );
  assert.equal(initiations, 1);
  for (const response of [first, second]) {
    const body = await response.json() as Record<string, unknown>;
    assert.equal(
      typeof body.checkoutUrl === "string"
      && body.checkoutUrl.endsWith("/approval"),
      true,
    );
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /SERVER_ORDER|server-obligation|merchant/u);
    assert.doesNotMatch(serialized, /200[.]00/u);
  }
});

test("explicit capture uses the original server attempt and derives ready", async () => {
  let snapshot = available();
  const result = await captureCheckout(
    dependencies({
      async loadAttempt() {
        return snapshot;
      },
      async requestCapture(_target, commandId, receivedAttempt, orderId) {
        assert.equal(commandId, "stable-capture-command");
        assert.equal(receivedAttempt, attemptId);
        assert.equal(orderId, "SERVER_ORDER");
        snapshot = {
          ...available(),
          state: "capture-intent",
          operations: [
            ...available().operations,
            {
              operationId: captureOperationId,
              kind: "capture",
              state: "intent",
              approvalUrl: null,
            },
          ],
        };
        return {
          attemptId,
          operationId: captureOperationId,
          providerKey: captureOperationId,
          state: "intent",
        };
      },
      async dispatchOperation() {
        snapshot = {
          ...snapshot,
          state: "completed",
          operations: snapshot.operations.map((candidate) =>
            candidate.kind === "capture"
              ? {
                ...candidate,
                state: "result",
                captureId: "SERVER_CAPTURE",
              }
              : candidate),
        };
        return { approvalUrl: null };
      },
      async inspectReadiness() {
        return snapshot.state === "completed" ? "ready" : "awaiting-payment";
      },
    }),
    locators,
    target,
  );
  assert.deepEqual(result, {
    state: "completed",
    readiness: "ready",
    providerState: "completed",
    recovery: "manual-recovery-required",
  });
});

test("capture discovery reconciles the original Order without duplicate dispatch", async () => {
  let dispatches = 0;
  let discoveries = 0;
  let snapshot: PaymentAttemptSnapshot = {
    ...available(),
    state: "capture-admitted",
    operations: [
      ...available().operations,
      {
        operationId: captureOperationId,
        kind: "capture",
        state: "unknown",
        approvalUrl: null,
        captureId: null,
      },
    ],
  };
  const result = await reconcileCheckout(dependencies({
    async loadAttempt() {
      return snapshot;
    },
    async dispatchOperation() {
      dispatches += 1;
      throw new Error("must not dispatch");
    },
    async reconcileOrderCapture(_target, discovered) {
      discoveries += 1;
      assert.equal(discovered.orderId, "SERVER_ORDER");
      assert.equal(discovered.operationId, captureOperationId);
      snapshot = {
        ...snapshot,
        state: "completed",
        operations: snapshot.operations.map((candidate) =>
          candidate.kind === "capture"
            ? {
              ...candidate,
              state: "result",
              captureId: "DISCOVERED_CAPTURE",
            }
            : candidate),
      };
      return {
        outcome: "completed",
        matchesBasis: true,
        completed: true,
      };
    },
    async inspectReadiness() {
      return snapshot.state === "completed" ? "ready" : "awaiting-payment";
    },
  }), target);
  assert.equal(discoveries, 1);
  assert.equal(dispatches, 0);
  assert.equal(result.state, "completed");
  assert.equal(result.readiness, "ready");
  assert.equal(result.providerState, "completed");
});

test("payer projection displays the exact server-owned USD 200 obligation", async () => {
  const result = await loadCustomPayment(locators, dependencies());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.payment.currency, "USD");
  assert.equal(result.payment.gross, "200.00");
  assert.equal(result.payment.projectLabel, "Harbor Bakery H1 Demo");
  assert.match(result.payment.endpoints.capture, /^\/api\/pay\/slr1p_/u);
});
