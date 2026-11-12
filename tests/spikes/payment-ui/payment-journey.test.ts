import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type {
  Lease,
  Payer,
} from "@scopeledger/contracts";
import type {
  PaymentAttemptSnapshot,
  PaymentJourneyDependencies,
} from "../../../apps/web/app/api/demo/payment/service.js";
import {
  captureCheckout,
  handlePaymentCapturePost,
  handlePaymentPreparePost,
  handlePaymentStatusPost,
  prepareCheckout,
  readPaymentStatus,
} from "../../../apps/web/app/api/demo/payment/service.js";

const operationId = "11111111-1111-4111-8111-111111111111";
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

function orderAvailable(): PaymentAttemptSnapshot {
  return {
    attemptId,
    state: "order-available",
    orderId: "SERVER_ORDER",
    operations: [{
      operationId,
      kind: "create",
      state: "result",
      approvalUrl,
    }],
  };
}

function dependencies(
  overrides: Partial<PaymentJourneyDependencies> = {},
): PaymentJourneyDependencies {
  let snapshot: PaymentAttemptSnapshot | null = null;
  const payer = {
    workspaceId: "demo-workspace",
    projectId: "cedar-roastery",
    actorId: "cedar-payer",
    grantEpoch: 1,
    obligationId: "server-obligation",
    payerEpoch: 4,
    nominationEpoch: 2,
  } satisfies Payer;
  const lease = {
    workspaceId: payer.workspaceId,
    projectId: payer.projectId,
    operationId,
    token: "44444444-4444-4444-8444-444444444444",
    generation: 1,
  } satisfies Lease;
  return {
    requireSameOrigin(received) {
      if (received.headers.get("origin") !== "http://localhost") {
        throw new Error("SAME_ORIGIN_REQUIRED");
      }
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
      return {
        payerEpoch: payer.payerEpoch,
        nominationEpoch: payer.nominationEpoch,
      };
    },
    async loadAttempt() {
      return snapshot;
    },
    async initiatePayment(received, commandId) {
      assert.equal(received.obligationId, "server-obligation");
      assert.equal(commandId, "server-command");
      snapshot = {
        attemptId,
        state: "intent",
        orderId: null,
        operations: [{
          operationId,
          kind: "create",
          state: "intent",
          approvalUrl: null,
        }],
      };
      return {
        attemptId,
        operationId,
        providerKey: operationId,
        state: "intent",
      };
    },
    async requestCapture(
      received,
      commandId,
      receivedAttemptId,
      receivedOrderId,
    ) {
      assert.equal(received.obligationId, "server-obligation");
      assert.equal(commandId, "server-command");
      assert.equal(receivedAttemptId, attemptId);
      assert.equal(receivedOrderId, "SERVER_ORDER");
      snapshot = {
        ...orderAvailable(),
        state: "capture-intent",
        operations: [
          ...orderAvailable().operations,
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
    async claimOperation(receivedOperationId) {
      return {
        ...lease,
        operationId: receivedOperationId,
      };
    },
    async dispatchOperation(receivedLease) {
      if (receivedLease.operationId === captureOperationId) {
        snapshot = {
          ...orderAvailable(),
          state: "completed",
          operations: [
            ...orderAvailable().operations,
            {
              operationId: captureOperationId,
              kind: "capture",
              state: "result",
              approvalUrl: null,
            },
          ],
        };
        return { approvalUrl: null };
      }
      snapshot = orderAvailable();
      return { approvalUrl };
    },
    async inspectReadiness() {
      return snapshot?.state === "completed" ? "ready" : "awaiting-payment";
    },
    createCommandId() {
      return "server-command";
    },
    ...overrides,
  };
}

test("payment endpoints require a payer session and reject the wrong role", async () => {
  let touched = false;
  const noSession = dependencies({
    async readSession() {
      return null;
    },
    async loadCurrentPaymentBasis() {
      touched = true;
      return null;
    },
  });
  const missing = await handlePaymentPreparePost(
    request("/api/demo/payment/prepare"),
    noSession,
  );
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), {
    ok: false,
    code: "PAYER_ACCESS_REQUIRED",
  });
  assert.equal(touched, false);

  const wrongRole = dependencies({
    async readSession() {
      return { role: "client-approver" };
    },
  });
  const forbidden = await handlePaymentStatusPost(
    request("/api/demo/payment/status"),
    wrongRole,
  );
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), {
    ok: false,
    code: "PAYER_ROLE_REQUIRED",
  });

  const crossOrigin = await handlePaymentStatusPost(
    new Request("http://localhost/api/demo/payment/status", {
      method: "POST",
      headers: {
        host: "localhost",
        origin: "https://attacker.example",
      },
    }),
    dependencies(),
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), {
    ok: false,
    code: "PAYMENT_ORIGIN_REQUIRED",
  });
});

test("same-origin handlers accept no browser payment identity or financial input", async () => {
  let touched = false;
  const response = await handlePaymentPreparePost(
    request(
      "/api/demo/payment/prepare",
      JSON.stringify({
        obligationId: "browser-obligation",
        amount: "0.01",
        merchantId: "browser-merchant",
        version: 999,
        orderId: "browser-order",
        operationId: "browser-operation",
        providerKey: "browser-provider-key",
        approvalUrl: "https://attacker.example",
      }),
    ),
    dependencies({
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

test("an empty streamed browser POST is accepted as having no payment input", async () => {
  const response = await handlePaymentPreparePost(
    new Request("http://localhost/api/demo/payment/prepare", {
      method: "POST",
      headers: {
        host: "localhost",
        origin: "http://localhost",
      },
      body: "",
    }),
    dependencies(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    state: "awaiting-buyer-approval",
    readiness: "awaiting-payment",
    approvalUrl,
  });
});

test("preparation uses server-owned nomination continuity and create sequencing", async () => {
  const sequence: string[] = [];
  let snapshot: PaymentAttemptSnapshot | null = null;
  const deps = dependencies({
    async loadCurrentPaymentBasis() {
      return {
        obligationId: "server-obligation",
        nominationEpoch: 2,
        nomination: {
          actorId: "former-payer",
          payerEpoch: 8,
          nominationEpoch: 1,
          active: true,
        },
      };
    },
    async nominatePayer(receivedObligationId) {
      sequence.push(`nominate:${receivedObligationId}`);
      return { payerEpoch: 9, nominationEpoch: 2 };
    },
    async loadAttempt() {
      return snapshot;
    },
    async initiatePayment(received) {
      sequence.push(
        `intent:${received.obligationId}:${received.payerEpoch}:${received.nominationEpoch}`,
      );
      snapshot = {
        attemptId,
        state: "intent",
        orderId: null,
        operations: [{
          operationId,
          kind: "create",
          state: "intent",
          approvalUrl: null,
        }],
      };
      return {
        attemptId,
        operationId,
        providerKey: operationId,
        state: "intent",
      };
    },
    async claimOperation(receivedOperationId) {
      sequence.push(`claim:${receivedOperationId}`);
      return {
        workspaceId: "demo-workspace",
        projectId: "cedar-roastery",
        operationId: receivedOperationId,
        token: "44444444-4444-4444-8444-444444444444",
        generation: 1,
      };
    },
    async dispatchOperation() {
      sequence.push("worker");
      snapshot = orderAvailable();
      return { approvalUrl };
    },
  });
  const result = await prepareCheckout(deps);
  assert.deepEqual(sequence, [
    "nominate:server-obligation",
    "intent:server-obligation:9:2",
    `claim:${operationId}`,
    "worker",
  ]);
  assert.deepEqual(result, {
    state: "awaiting-buyer-approval",
    readiness: "awaiting-payment",
    approvalUrl,
  });
});

test("matching obligation-scoped continuity is reused without renominating", async () => {
  let nominations = 0;
  const result = await prepareCheckout(dependencies({
    async nominatePayer() {
      nominations += 1;
      return { payerEpoch: 5, nominationEpoch: 2 };
    },
    async loadAttempt() {
      return orderAvailable();
    },
  }));
  assert.equal(nominations, 0);
  assert.equal(result.state, "awaiting-buyer-approval");
});

test("approval status alone does not request or dispatch capture", async () => {
  let captures = 0;
  let dispatches = 0;
  const status = await readPaymentStatus(dependencies({
    async loadAttempt() {
      return orderAvailable();
    },
    async requestCapture() {
      captures += 1;
      throw new Error("must not run");
    },
    async dispatchOperation() {
      dispatches += 1;
      throw new Error("must not run");
    },
  }));
  assert.deepEqual(status, {
    state: "awaiting-buyer-approval",
    readiness: "awaiting-payment",
    approvalUrl,
  });
  assert.equal(captures, 0);
  assert.equal(dispatches, 0);
});

test("capture uses only the original server-known attempt and Order", async () => {
  const sequence: string[] = [];
  let snapshot = orderAvailable();
  const result = await captureCheckout(dependencies({
    async loadAttempt() {
      return snapshot;
    },
    async requestCapture(_payer, _commandId, receivedAttempt, receivedOrder) {
      sequence.push(`capture-intent:${receivedAttempt}:${receivedOrder}`);
      snapshot = {
        ...snapshot,
        state: "capture-intent",
        operations: [
          ...snapshot.operations,
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
    async claimOperation(receivedOperationId) {
      sequence.push(`claim:${receivedOperationId}`);
      return {
        workspaceId: "demo-workspace",
        projectId: "cedar-roastery",
        operationId: receivedOperationId,
        token: "44444444-4444-4444-8444-444444444444",
        generation: 1,
      };
    },
    async dispatchOperation() {
      sequence.push("worker");
      snapshot = {
        ...snapshot,
        state: "completed",
        operations: snapshot.operations.map((candidate) =>
          candidate.kind === "capture"
            ? { ...candidate, state: "result" }
            : candidate),
      };
      return { approvalUrl: null };
    },
    async inspectReadiness() {
      return snapshot.state === "completed" ? "ready" : "awaiting-payment";
    },
  }));
  assert.deepEqual(sequence, [
    `capture-intent:${attemptId}:SERVER_ORDER`,
    `claim:${captureOperationId}`,
    "worker",
  ]);
  assert.deepEqual(result, {
    state: "completed",
    readiness: "ready",
  });
});

test("ambiguous admitted outcomes are surfaced without automatic retry", async () => {
  let dispatches = 0;
  const deps = dependencies({
    async loadAttempt() {
      return {
        ...orderAvailable(),
        state: "capture-admitted",
        operations: [
          ...orderAvailable().operations,
          {
            operationId: captureOperationId,
            kind: "capture",
            state: "admitted",
            approvalUrl: null,
          },
        ],
      };
    },
    async dispatchOperation() {
      dispatches += 1;
      throw new Error("must not retry");
    },
  });
  const response = await handlePaymentCapturePost(
    request("/api/demo/payment/capture"),
    deps,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    state: "reconciliation-required",
    readiness: "awaiting-payment",
  });
  assert.equal(dispatches, 0);
});

test("provider uncertainty is safe and the response exposes no payment IDs", async () => {
  let dispatches = 0;
  const response = await handlePaymentPreparePost(
    request("/api/demo/payment/prepare"),
    dependencies({
      async dispatchOperation() {
        dispatches += 1;
        throw Object.assign(new Error("synthetic ambiguity"), {
          code: "PAYMENT_OUTCOME_UNKNOWN",
        });
      },
    }),
  );
  assert.equal(dispatches, 1);
  assert.equal(response.status, 409);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body, {
    ok: false,
    code: "PAYMENT_RECONCILIATION_REQUIRED",
    state: "reconciliation-required",
  });
  for (const forbidden of [
    "attemptId",
    "operationId",
    "orderId",
    "providerKey",
    "merchantId",
    "amount",
    "gross",
  ]) {
    assert.equal(forbidden in body, false);
  }
});

test("unvalidated approval URLs are never returned", async () => {
  let snapshot: PaymentAttemptSnapshot | null = null;
  const result = await prepareCheckout(dependencies({
    async loadAttempt() {
      return snapshot;
    },
    async initiatePayment() {
      snapshot = {
        attemptId,
        state: "intent",
        orderId: null,
        operations: [{
          operationId,
          kind: "create",
          state: "intent",
          approvalUrl: null,
        }],
      };
      return {
        attemptId,
        operationId,
        providerKey: operationId,
        state: "intent",
      };
    },
    async dispatchOperation() {
      snapshot = {
        ...orderAvailable(),
        operations: [{
          operationId,
          kind: "create",
          state: "result",
          approvalUrl: "https://attacker.example/checkout",
        }],
      };
      return { approvalUrl: "https://attacker.example/checkout" };
    },
  }));
  assert.deepEqual(result, {
    state: "reconciliation-required",
    readiness: "awaiting-payment",
  });
});

test("GET navigation pages cannot invoke capture", async () => {
  const route = await readFile(
    "apps/web/app/api/demo/payment/capture/route.ts",
    "utf8",
  );
  assert.match(route, /export async function POST/);
  assert.doesNotMatch(route, /export async function GET/);

  const returnPage = await readFile(
    "apps/web/app/payments/paypal/return/page.tsx",
    "utf8",
  );
  assert.doesNotMatch(returnPage, /requestCapture|dispatchOperation/);
});
