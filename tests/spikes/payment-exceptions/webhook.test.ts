import assert from "node:assert/strict";
import test from "node:test";
import type { PayPalWebhookReceipt } from "@scopeledger/paypal-adapter";
import {
  handlePayPalWebhookPost,
  type PayPalWebhookRouteDependencies,
} from "../../../apps/web/app/api/paypal/webhook/service.js";

function request(event: object): Request {
  return new Request("http://127.0.0.1:3000/api/paypal/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "paypal-transmission-id": "transmission-id",
      "paypal-transmission-time": "2026-11-12T10:00:00Z",
      "paypal-transmission-sig": "signature",
      "paypal-cert-url":
        "https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-123",
      "paypal-auth-algo": "SHA256withRSA",
    },
    body: JSON.stringify(event),
  });
}

function dependencies() {
  const receipts = new Map<string, PayPalWebhookReceipt>();
  let verified = 0;
  const value: PayPalWebhookRouteDependencies = {
    async verifyWebhook() {
      verified += 1;
      return true;
    },
    async insertVerified(receipt) {
      const duplicate = receipts.has(receipt.eventId);
      receipts.set(receipt.eventId, receipt);
      return { duplicate };
    },
  };
  return { value, receipts, verified: () => verified };
}

test("refund and reversal webhooks are verified and stored only as triggers", async () => {
  const current = dependencies();
  for (const event of [
    {
      id: "EVENT_REFUND",
      event_type: "PAYMENT.REFUND.COMPLETED",
      create_time: "2026-11-12T10:00:00Z",
      resource_type: "refund",
      resource: {
        id: "REFUND123",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "999999.00" },
      },
    },
    {
      id: "EVENT_REVERSAL",
      event_type: "PAYMENT.CAPTURE.REVERSED",
      create_time: "2026-11-12T10:01:00Z",
      resource_type: "capture",
      resource: {
        id: "CAPTURE123",
        status: "REVERSED",
        amount: { currency_code: "USD", value: "999999.00" },
      },
    },
  ]) {
    assert.equal(
      (await handlePayPalWebhookPost(
        request(event),
        current.value,
      )).status,
      204,
    );
  }
  assert.equal(current.verified(), 2);
  assert.deepEqual(
    [...current.receipts.values()].map((receipt) => ({
      eventType: receipt.eventType,
      resourceId: receipt.resourceId,
      resourceStatus: receipt.resourceStatus,
    })),
    [
      {
        eventType: "PAYMENT.REFUND.COMPLETED",
        resourceId: "REFUND123",
        resourceStatus: "COMPLETED",
      },
      {
        eventType: "PAYMENT.CAPTURE.REVERSED",
        resourceId: "CAPTURE123",
        resourceStatus: "REVERSED",
      },
    ],
  );
  assert.equal(
    JSON.stringify([...current.receipts.values()]).includes("999999.00"),
    false,
  );
});

test("duplicate verified delivery is acknowledged without a second financial action", async () => {
  const current = dependencies();
  const event = {
    id: "EVENT_REFUND",
    event_type: "PAYMENT.REFUND.COMPLETED",
    create_time: "2026-11-12T10:00:00Z",
    resource_type: "refund",
    resource: { id: "REFUND123", status: "COMPLETED" },
  };
  assert.equal(
    (await handlePayPalWebhookPost(request(event), current.value)).status,
    204,
  );
  assert.equal(
    (await handlePayPalWebhookPost(request(event), current.value)).status,
    200,
  );
  assert.equal(current.receipts.size, 1);
});
