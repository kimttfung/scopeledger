import assert from "node:assert/strict";
import test from "node:test";
import {
  PayPalAdapterError,
  PayPalSandboxClient,
} from "@scopeledger/paypal-adapter";
import type {
  FetchLike,
  PayPalCaptureDetails,
  PayPalOrderDetails,
  PayPalPaymentExceptionAdmission,
  PayPalRefundDetails,
} from "@scopeledger/paypal-adapter";

const admission: PayPalPaymentExceptionAdmission = Object.freeze({
  operationId: "11111111-1111-4111-8111-111111111111",
  orderId: "ORDER123",
  captureId: "CAPTURE123",
  merchantId: "sandbox-merchant",
  environment: "sandbox",
  currency: "USD",
  gross: "300.00",
});

function client(fetch?: FetchLike) {
  return new PayPalSandboxClient({
    environment: "sandbox",
    clientId: "sandbox-client-id",
    clientSecret: "sandbox-client-secret",
    merchantId: admission.merchantId,
    returnUrl: "http://127.0.0.1:3000/payments/paypal/return",
    cancelUrl: "http://127.0.0.1:3000/payments/paypal/cancel",
    timeoutMilliseconds: 15_000,
  }, {
    fetch: fetch
      ?? (async () => assert.fail("Pure exception normalization must not fetch")),
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function queuedFetch(responses: readonly Response[]) {
  const queue = [...responses];
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    urls.push(String(input));
    const response = queue.shift();
    assert.ok(response, `Unexpected request ${String(input)}`);
    return response;
  };
  return { fetch, urls };
}

function capture(
  status = "COMPLETED",
  overrides: Partial<PayPalCaptureDetails> = {},
): PayPalCaptureDetails {
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
    ...overrides,
  });
}

function order(
  overrides: Partial<PayPalOrderDetails> = {},
): PayPalOrderDetails {
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
    ...overrides,
  });
}

function refund(gross: string, status = "COMPLETED"): PayPalRefundDetails {
  return Object.freeze({
    refundId: gross === admission.gross ? "REFUND_FULL" : "REFUND_PARTIAL",
    captureId: admission.captureId,
    status,
    currency: "USD",
    gross,
    evidence: {
      kind: "authenticated-adapter" as const,
      verificationReference: `paypal_refund_${gross.replace(".", "_")}`,
    },
  });
}

test("exact refund resources reduce to partial and full observations", () => {
  const adapter = client();
  const partial = adapter.refundExceptionFromDetails(
    admission,
    refund("75.00"),
    capture(),
    order(),
  );
  const full = adapter.refundExceptionFromDetails(
    admission,
    refund("300.00"),
    capture("REFUNDED"),
    order(),
  );
  assert.deepEqual(
    [partial.state, partial.affectedGross, full.state, full.affectedGross],
    ["partial-refund", "75.00", "full-refund", "300.00"],
  );
  assert.equal(partial.operationId, admission.operationId);
  assert.equal(full.captureId, admission.captureId);
});

test("capture reversal and unresolved authoritative status remain distinct", () => {
  const adapter = client();
  const reversed = adapter.captureReversalExceptionFromDetails(
    admission,
    capture("REVERSED"),
    order(),
  );
  const unknown = adapter.captureReversalExceptionFromDetails(
    admission,
    capture("COMPLETED"),
    order(),
  );
  assert.equal(reversed.state, "reversed");
  assert.equal(reversed.affectedGross, "300.00");
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.affectedGross, null);
});

test("merchant, Order, capture, currency, gross and parent mismatches fail closed", () => {
  const adapter = client();
  for (const work of [
    () => adapter.refundExceptionFromDetails(
      admission,
      { ...refund("75.00"), captureId: "OTHER_CAPTURE" },
      capture(),
      order(),
    ),
    () => adapter.refundExceptionFromDetails(
      admission,
      refund("75.00"),
      capture("COMPLETED", { merchantId: "other-merchant" }),
      order(),
    ),
    () => adapter.refundExceptionFromDetails(
      admission,
      refund("75.00"),
      capture(),
      order({ orderId: "OTHER_ORDER" }),
    ),
    () => adapter.refundExceptionFromDetails(
      admission,
      refund("75.00"),
      capture(),
      order({
        captures: [{
          captureId: "OTHER_CAPTURE",
          status: "COMPLETED",
          currency: "USD",
          gross: "300.00",
        }],
      }),
    ),
    () => adapter.refundExceptionFromDetails(
      admission,
      refund("301.00"),
      capture(),
      order(),
    ),
  ]) {
    assert.throws(work, PayPalAdapterError);
  }
});

test("refund, parent capture and Order are re-fetched from fixed sandbox origins", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse({
      id: "REFUND_PARTIAL",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "75.00" },
      links: [{
        rel: "up",
        method: "GET",
        href:
          "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123",
      }],
    }),
    jsonResponse({
      id: admission.captureId,
      status: "PARTIALLY_REFUNDED",
      amount: { currency_code: "USD", value: admission.gross },
      seller_receivable_breakdown: {
        total_refunded_amount: { currency_code: "USD", value: "75.00" },
      },
      payee: { merchant_id: admission.merchantId },
      supplementary_data: {
        related_ids: { order_id: admission.orderId },
      },
    }),
    jsonResponse({
      id: admission.orderId,
      status: "COMPLETED",
      purchase_units: [{
        amount: { currency_code: "USD", value: admission.gross },
        payee: { merchant_id: admission.merchantId },
        payments: {
          captures: [{
            id: admission.captureId,
            status: "PARTIALLY_REFUNDED",
            amount: { currency_code: "USD", value: admission.gross },
          }],
        },
      }],
    }),
  ]);
  const adapter = client(network.fetch);
  const refundDetails = await adapter.retrieveRefundDetails("REFUND_PARTIAL");
  const captureDetails = await adapter.retrieveCaptureDetails(
    admission.captureId,
  );
  const orderDetails = await adapter.retrieveOrderDetails(admission.orderId);
  assert.equal(
    adapter.refundExceptionFromDetails(
      admission,
      refundDetails,
      captureDetails,
      orderDetails,
    ).state,
    "partial-refund",
  );
  assert.deepEqual(network.urls.slice(1), [
    "https://api-m.sandbox.paypal.com/v2/payments/refunds/REFUND_PARTIAL",
    "https://api-m.sandbox.paypal.com/v2/payments/captures/CAPTURE123",
    "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER123",
  ]);
});

test("refund retrieval rejects an untrusted parent-capture origin", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "access-token", expires_in: 3_600 }),
    jsonResponse({
      id: "REFUND_PARTIAL",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "75.00" },
      links: [{
        rel: "up",
        method: "GET",
        href: "https://evil.example/v2/payments/captures/CAPTURE123",
      }],
    }),
  ]);
  await assert.rejects(
    () => client(network.fetch).retrieveRefundDetails("REFUND_PARTIAL"),
    PayPalAdapterError,
  );
});
