import assert from "node:assert/strict";
import test from "node:test";
import {
  ensurePayPalSandboxWebhook,
  parseReviewedEventTypes,
  REVIEWED_PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES,
  safeToolingFailure,
  validateLocalWebhookReceiverUrl,
  validatePublicWebhookUrl,
  WebhookToolingError,
} from "../../../scripts/paypal-webhook-tooling.mjs";

const url =
  "https://scopeledger-h1.trycloudflare.com/api/paypal/webhook";
const events = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.COMPLETED",
];

function registration(
  id = "WH_MATCH",
  registrationUrl = url,
  eventTypes = events,
) {
  return Object.freeze({ id, url: registrationUrl, eventTypes });
}

test("exact replay reuses one matching registration without creating", async () => {
  let created = 0;
  const result = await ensurePayPalSandboxWebhook({
    client: {
      async listWebhooks() {
        return [registration()];
      },
      async createWebhook() {
        created += 1;
        throw new Error("Create must not run");
      },
    },
    url,
    eventTypes: events,
  });
  assert.equal(result.action, "reused");
  assert.equal(result.registration.id, "WH_MATCH");
  assert.equal(created, 0);
});

test("register creates once and verifies the exact result by listing again", async () => {
  let lists = 0;
  let creates = 0;
  const result = await ensurePayPalSandboxWebhook({
    client: {
      async listWebhooks() {
        lists += 1;
        return lists === 1 ? [] : [registration("WH_CREATED")];
      },
      async createWebhook(input) {
        creates += 1;
        assert.deepEqual(input, { url, eventTypes: events });
        return registration("WH_CREATED");
      },
    },
    url,
    eventTypes: events,
  });
  assert.equal(result.action, "created");
  assert.equal(result.registration.id, "WH_CREATED");
  assert.equal(lists, 2);
  assert.equal(creates, 1);
});

test("verify mode is read-only and fails when the exact registration is absent", async () => {
  await assert.rejects(
    () => ensurePayPalSandboxWebhook({
      client: {
        async listWebhooks() {
          return [];
        },
        async createWebhook() {
          assert.fail("Verify mode must not create");
        },
      },
      url,
      eventTypes: events,
      mode: "verify",
    }),
    (error) => error instanceof WebhookToolingError
      && error.code === "WEBHOOK_REGISTRATION_NOT_FOUND",
  );
});

test("duplicate exact URLs and mismatched exact event selections fail closed", async () => {
  await assert.rejects(
    () => ensurePayPalSandboxWebhook({
      client: {
        async listWebhooks() {
          return [
            registration("WH_ONE"),
            registration("WH_TWO"),
          ];
        },
      },
      url,
      eventTypes: events,
    }),
    (error) => error instanceof WebhookToolingError
      && error.code === "AMBIGUOUS_WEBHOOK_REGISTRATION",
  );

  await assert.rejects(
    () => ensurePayPalSandboxWebhook({
      client: {
        async listWebhooks() {
          return [registration(
            "WH_DIFFERENT_EVENTS",
            url,
            ["CHECKOUT.ORDER.APPROVED"],
          )];
        },
      },
      url,
      eventTypes: events,
    }),
    (error) => error instanceof WebhookToolingError
      && error.code === "CONFLICTING_WEBHOOK_REGISTRATION",
  );
});

test("post-create list mismatch fails without deleting or updating anything", async () => {
  let lists = 0;
  await assert.rejects(
    () => ensurePayPalSandboxWebhook({
      client: {
        async listWebhooks() {
          lists += 1;
          return lists === 1
            ? []
            : [registration(
              "WH_CREATED",
              url,
              ["CHECKOUT.ORDER.APPROVED"],
            )];
        },
        async createWebhook() {
          return registration("WH_CREATED");
        },
      },
      url,
      eventTypes: events,
    }),
    (error) => error instanceof WebhookToolingError
      && error.code === "CONFLICTING_WEBHOOK_REGISTRATION",
  );
});

test("receiver and public URL validation enforce exact routes and trusted origins", () => {
  assert.equal(
    validateLocalWebhookReceiverUrl(
      "http://127.0.0.1:3210/api/paypal/webhook",
    ),
    "http://127.0.0.1:3210/api/paypal/webhook",
  );
  assert.equal(validatePublicWebhookUrl(url), url);

  for (const invalid of [
    "http://scopeledger-h1.trycloudflare.com/api/paypal/webhook",
    "https://example.com/api/paypal/webhook",
    "https://user:password@scopeledger-h1.trycloudflare.com/api/paypal/webhook",
    "https://scopeledger-h1.trycloudflare.com/api/paypal/webhook?secret=x",
    "https://scopeledger-h1.trycloudflare.com/api/paypal/webhook#fragment",
    "https://scopeledger-h1.trycloudflare.com/other",
  ]) {
    assert.throws(() => validatePublicWebhookUrl(invalid), WebhookToolingError);
  }
  for (const invalid of [
    "https://127.0.0.1:3000/api/paypal/webhook",
    "http://example.com/api/paypal/webhook",
    "http://127.0.0.1:3000/other",
    "http://user:password@127.0.0.1:3000/api/paypal/webhook",
  ]) {
    assert.throws(
      () => validateLocalWebhookReceiverUrl(invalid),
      WebhookToolingError,
    );
  }
});

test("event selection is limited to the reviewed allowlist", () => {
  assert.deepEqual(
    parseReviewedEventTypes(),
    REVIEWED_PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES,
  );
  assert.deepEqual(
    parseReviewedEventTypes(events.join(",")),
    events,
  );
  for (const invalid of [
    "PAYMENT.CAPTURE.COMPLETED,UNREVIEWED.EVENT",
    "PAYMENT.CAPTURE.COMPLETED,PAYMENT.CAPTURE.COMPLETED",
    "",
  ]) {
    assert.throws(() => parseReviewedEventTypes(invalid), WebhookToolingError);
  }
});

test("unexpected errors are redacted rather than echoing credentials or tokens", () => {
  for (const error of [
    new Error("client-secret oauth-access-token"),
    Object.assign(
      new Error("provider message contained oauth-access-token"),
      { code: "PROVIDER_REJECTED" },
    ),
  ]) {
    const serialized = JSON.stringify(safeToolingFailure(error));
    assert.equal(serialized.includes("client-secret"), false);
    assert.equal(serialized.includes("oauth-access-token"), false);
  }
});
