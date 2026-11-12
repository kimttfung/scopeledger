import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES,
  PayPalAdapterError,
  PayPalSandboxClient,
  parsePayPalConfig,
  persistVerifiedPayPalWebhookReceipt,
} from "@scopeledger/paypal-adapter";
import type {
  FetchLike,
  PayPalDispatchAdmission,
} from "@scopeledger/paypal-adapter";

const operationId = "11111111-1111-4111-8111-111111111111";
const captureOperationId = "22222222-2222-4222-8222-222222222222";
const requestHash = "a".repeat(64);
const orderId = "ORDER123";
const captureId = "CAPTURE123";

function config(overrides: Record<string, unknown> = {}) {
  return {
    environment: "sandbox",
    clientId: "sandbox-client-id",
    clientSecret: "sandbox-client-secret",
    merchantId: "sandbox-merchant",
    returnUrl: "http://127.0.0.1:3000/payments/paypal/return",
    cancelUrl: "http://127.0.0.1:3000/payments/paypal/cancel",
    timeoutMilliseconds: 15_000,
    ...overrides,
  };
}

function admission(
  kind: "create" | "capture",
  overrides: Record<string, unknown> = {},
): PayPalDispatchAdmission {
  return {
    dispatchAllowed: true,
    reconciliationRequired: false,
    operationId: kind === "create" ? operationId : captureOperationId,
    providerKey: kind === "create" ? operationId : captureOperationId,
    kind,
    requestHash,
    request: {
      schemaVersion: "scopeledger.payment-operation.v1",
      obligationId: "obligation-a",
      unitId: "unit-a",
      version: 1,
      kind,
      merchantId: "sandbox-merchant",
      environment: "sandbox",
      currency: "USD",
      gross: "300.00",
      orderId: kind === "create" ? null : orderId,
    },
    ...overrides,
  };
}

function order(options: {
  amount?: string;
  merchantId?: string;
  approvalUrl?: string;
  captureStatus?: string;
} = {}) {
  return {
    id: orderId,
    status: options.captureStatus ? "COMPLETED" : "CREATED",
    purchase_units: [{
      reference_id: "obligation-a",
      amount: { currency_code: "USD", value: options.amount ?? "300.00" },
      payee: { merchant_id: options.merchantId ?? "sandbox-merchant" },
      ...(options.captureStatus ? {
        payments: {
          captures: [{
            id: captureId,
            status: options.captureStatus,
            amount: { currency_code: "USD", value: options.amount ?? "300.00" },
          }],
        },
      } : {}),
    }],
    links: [{
      href: options.approvalUrl ?? `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`,
      rel: "payer-action",
      method: "GET",
    }],
  };
}

function captureDetails(options: {
  amount?: string;
  merchantId?: string;
  status?: string;
  relatedOrderId?: string;
} = {}) {
  return {
    id: captureId,
    status: options.status ?? "COMPLETED",
    amount: {
      currency_code: "USD",
      value: options.amount ?? "300.00",
    },
    payee: {
      merchant_id: options.merchantId ?? "sandbox-merchant",
    },
    supplementary_data: {
      related_ids: {
        order_id: options.relatedOrderId ?? orderId,
      },
    },
  };
}

function refundDetails(options: {
  amount?: string;
  status?: string;
  captureLink?: string;
} = {}) {
  return {
    id: "REFUND123",
    status: options.status ?? "COMPLETED",
    amount: {
      currency_code: "USD",
      value: options.amount ?? "1.00",
    },
    links: [{
      rel: "up",
      method: "GET",
      href: options.captureLink
        ?? `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
    }],
  };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function queuedFetch(
  responses: readonly Response[],
): { fetch: FetchLike; calls: { url: string; init: RequestInit | undefined }[] } {
  const queue = [...responses];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      const response = queue.shift();
      assert.ok(response, `Unexpected request ${String(input)}`);
      return response;
    },
  };
}

test("configuration is sandbox-only and permits local loopback returns", () => {
  assert.equal(parsePayPalConfig(config()).environment, "sandbox");
  for (const invalid of [
    config({ environment: "live" }),
    config({ clientSecret: "" }),
    config({ returnUrl: "http://example.com/return" }),
    config({ returnUrl: "https://user:pass@example.com/return" }),
    config({ merchantId: "invalid merchant" }),
  ]) {
    assert.throws(() => parsePayPalConfig(invalid), PayPalAdapterError);
  }
});

test("authentication check verifies OAuth without exposing the access token", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "must-not-be-returned", expires_in: 3_600 }),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  assert.deepEqual(await client.checkAuthentication(), {
    environment: "sandbox",
    merchantId: "sandbox-merchant",
  });
  assert.equal(JSON.stringify(await client.checkAuthentication()).includes("must-not-be-returned"), false);
  assert.equal(network.calls.length, 1);
});

test("create uses fixed sandbox endpoints, exact amount, stable request ID and validated approval origin", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse(order(), 201, { "paypal-debug-id": "debug-create" }),
    jsonResponse(order()),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  const result = await client.createOrder(admission("create"));

  assert.equal(result.kind, "create");
  assert.equal(result.approvalUrl, `https://www.sandbox.paypal.com/checkoutnow?token=${orderId}`);
  assert.deepEqual(result.observation, {
    operationId,
    evidence: {
      kind: "synthetic-fault",
      scenario: "Injected local PayPal adapter contract fixture; no provider authentication or provider call occurred",
    },
    merchantId: "sandbox-merchant",
    environment: "sandbox",
    currency: "USD",
    gross: "300.00",
    orderId,
    outcome: "order-created",
  });
  assert.equal(network.calls[0]?.url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
  assert.equal(network.calls[1]?.url, "https://api-m.sandbox.paypal.com/v2/checkout/orders");
  assert.equal(network.calls[2]?.url, `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`);
  assert.equal(new Headers(network.calls[1]?.init?.headers).get("PayPal-Request-Id"), operationId);
  const body = JSON.parse(String(network.calls[1]?.init?.body)) as {
    purchase_units: { amount: { value: string } }[];
  };
  assert.equal(body.purchase_units[0]?.amount.value, "300.00");
});

test("an untrusted approval origin is rejected", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse(order({ approvalUrl: "https://evil.example/approve" }), 201),
    jsonResponse(order({ approvalUrl: "https://evil.example/approve" })),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  await assert.rejects(
    () => client.createOrder(admission("create")),
    (error: unknown) => error instanceof PayPalAdapterError
      && error.code === "APPROVAL_LINK_INVALID",
  );
});

test("capture re-reads provider state and emits one exact completed observation", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse(order({ captureStatus: "COMPLETED" }), 201),
    jsonResponse(order({ captureStatus: "COMPLETED" })),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  const result = await client.captureOrder(admission("capture"));

  assert.equal(result.kind, "capture");
  assert.equal(result.observation.outcome, "completed");
  assert.equal(result.observation.captureId, captureId);
  assert.equal(network.calls[1]?.url, `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`);
  assert.equal(network.calls[2]?.url, `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}`);
  assert.equal(new Headers(network.calls[1]?.init?.headers).get("PayPal-Request-Id"), captureOperationId);
});

test("changed provider amount or merchant fails closed", async () => {
  for (const changed of [
    order({ amount: "299.00" }),
    order({ merchantId: "different-merchant" }),
  ]) {
    const network = queuedFetch([
      jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
      jsonResponse(changed, 201),
      jsonResponse(changed),
    ]);
    const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
    await assert.rejects(() => client.createOrder(admission("create")), PayPalAdapterError);
  }
});

test("capture retrieval re-fetches authoritative resource state and binds it to the admitted operation", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse(captureDetails()),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  const details = await client.retrieveCaptureDetails(captureId);
  const reconciled = client.captureObservationFromDetails(
    admission("capture"),
    details,
  );
  assert.equal(details.orderId, orderId);
  assert.equal(reconciled.outcome, "completed");
  assert.equal(reconciled.captureId, captureId);
  assert.equal(
    network.calls[1]?.url,
    `https://api-m.sandbox.paypal.com/v2/payments/captures/${captureId}`,
  );
});

test("capture retrieval rejects wrong merchant, amount or Order linkage", async () => {
  for (const changed of [
    captureDetails({ merchantId: "different-merchant" }),
    captureDetails({ amount: "299.00" }),
    captureDetails({ relatedOrderId: "OTHERORDER" }),
  ]) {
    const network = queuedFetch([
      jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
      jsonResponse(changed),
    ]);
    const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
    if (changed.payee.merchant_id !== "sandbox-merchant") {
      await assert.rejects(
        () => client.retrieveCaptureDetails(captureId),
        PayPalAdapterError,
      );
      continue;
    }
    const details = await client.retrieveCaptureDetails(captureId);
    assert.throws(
      () => client.captureObservationFromDetails(admission("capture"), details),
      PayPalAdapterError,
    );
  }
});

test("refund retrieval identifies its parent capture without issuing a refund", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse(refundDetails()),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  const refund = await client.retrieveRefundDetails("REFUND123");
  assert.equal(refund.refundId, "REFUND123");
  assert.equal(refund.captureId, captureId);
  assert.equal(refund.status, "COMPLETED");
  assert.equal(refund.gross, "1.00");
  assert.equal(
    network.calls[1]?.url,
    "https://api-m.sandbox.paypal.com/v2/payments/refunds/REFUND123",
  );
});

test("refund retrieval rejects an untrusted parent-capture link", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse(refundDetails({
      captureLink: `https://evil.example/v2/payments/captures/${captureId}`,
    })),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  await assert.rejects(
    () => client.retrieveRefundDetails("REFUND123"),
    PayPalAdapterError,
  );
});
test("OAuth tokens are reused and refreshed once after an authentication-expiry response", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "token-one", expires_in: 3_600 }),
    jsonResponse({ name: "AUTHENTICATION_FAILURE" }, 401),
    jsonResponse({ access_token: "token-two", expires_in: 3_600 }),
    jsonResponse(order(), 201),
    jsonResponse(order()),
  ]);
  const client = new PayPalSandboxClient(config(), { fetch: network.fetch });
  const result = await client.createOrder(admission("create"));
  assert.equal(result.observation.outcome, "order-created");
  assert.equal(network.calls.filter((call) => call.url.endsWith("/v1/oauth2/token")).length, 2);
});

test("webhook postback verification requires a configured ID and rejects failure", async () => {
  const webhook = {
    transmissionId: "transmission-id",
    transmissionTime: "2026-11-11T12:00:00Z",
    transmissionSignature: "signature",
    certificateUrl: "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-123",
    authenticationAlgorithm: "SHA256withRSA",
    event: { id: "WH-123", event_type: "PAYMENT.CAPTURE.COMPLETED" },
  };
  const withoutWebhook = new PayPalSandboxClient(config(), {
    fetch: async () => assert.fail("Network must not run without a webhook ID"),
  });
  await assert.rejects(
    () => withoutWebhook.verifyWebhook(webhook),
    (error: unknown) => error instanceof PayPalAdapterError
      && error.code === "WEBHOOK_NOT_CONFIGURED",
  );

  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse({ verification_status: "FAILURE" }),
  ]);
  const client = new PayPalSandboxClient(config({ webhookId: "webhook-id" }), { fetch: network.fetch });
  await assert.rejects(
    () => client.verifyWebhook(webhook),
    (error: unknown) => error instanceof PayPalAdapterError
      && error.code === "WEBHOOK_VERIFICATION_FAILED",
  );
});

test("verified webhook receipts are normalized, durable and duplicate-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeledger-paypal-webhook-"));
  const event = {
    id: "WH-123",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    create_time: "2026-11-11T12:00:00Z",
    resource_type: "capture",
    summary: "This provider summary must not be persisted.",
    resource: {
      id: "CAPTURE123",
      status: "COMPLETED",
      payer: { email_address: "must-not-be-persisted@example.com" },
    },
  };
  try {
    const first = await persistVerifiedPayPalWebhookReceipt({
      rootDirectory: root,
      event,
      receivedAt: "2026-11-11T12:00:01Z",
    });
    const duplicate = await persistVerifiedPayPalWebhookReceipt({
      rootDirectory: root,
      event,
      receivedAt: "2026-11-11T12:00:02Z",
    });
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    const stored = await readFile(join(root, "WH-123.json"), "utf8");
    assert.deepEqual(JSON.parse(stored), {
      schemaVersion: "scopeledger.paypal-webhook-receipt.v1",
      eventId: "WH-123",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      providerCreatedAt: "2026-11-11T12:00:00Z",
      resourceType: "capture",
      resourceId: "CAPTURE123",
      resourceStatus: "COMPLETED",
      verification: "paypal-postback-success",
      receivedAt: "2026-11-11T12:00:01Z",
    });
    assert.equal(stored.includes("must-not-be-persisted"), false);
    assert.ok(PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES.includes("PAYMENT.CAPTURE.COMPLETED"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported webhook events cannot enter the durable inbox", async () => {
  await assert.rejects(
    () => persistVerifiedPayPalWebhookReceipt({
      rootDirectory: ".paypal-sandbox/test-invalid",
      event: {
        id: "WH-INVALID",
        event_type: "UNSUPPORTED.EVENT",
        create_time: "2026-11-11T12:00:00Z",
        resource_type: "unknown",
        resource: {},
      },
    }),
    (error: unknown) => error instanceof PayPalAdapterError
      && error.code === "WEBHOOK_EVENT_INVALID",
  );
});
