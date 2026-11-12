import assert from "node:assert/strict";
import test from "node:test";
import {
  PayPalAdapterError,
  PayPalSandboxWebhookManagementClient,
  parsePayPalSandboxManagementConfig,
} from "@scopeledger/paypal-adapter";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function queuedFetch(responses) {
  const queue = [...responses];
  const calls = [];
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

const config = Object.freeze({
  environment: "sandbox",
  clientId: "sandbox-client-id",
  clientSecret: "sandbox-client-secret",
  timeoutMilliseconds: 15_000,
});

const url =
  "https://scopeledger-h1.trycloudflare.com/api/paypal/webhook";
const events = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
];

test("management configuration is sandbox-only", () => {
  assert.equal(
    parsePayPalSandboxManagementConfig(config).environment,
    "sandbox",
  );
  assert.throws(
    () => parsePayPalSandboxManagementConfig({
      ...config,
      environment: "live",
    }),
    PayPalAdapterError,
  );
});

test("OAuth and list use only fixed PayPal Sandbox management endpoints", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "oauth-access-token", expires_in: 3_600 }),
    jsonResponse({
      webhooks: [{
        id: "WH_EXISTING",
        url,
        event_types: events.map((name) => ({ name })),
      }],
    }),
  ]);
  const client = new PayPalSandboxWebhookManagementClient(config, {
    fetch: network.fetch,
  });
  const result = await client.listWebhooks();

  assert.deepEqual(result, [{
    id: "WH_EXISTING",
    url,
    eventTypes: events,
  }]);
  assert.equal(
    network.calls[0]?.url,
    "https://api-m.sandbox.paypal.com/v1/oauth2/token",
  );
  assert.equal(
    network.calls[1]?.url,
    "https://api-m.sandbox.paypal.com/v1/notifications/webhooks",
  );
  assert.equal(
    new Headers(network.calls[1]?.init?.headers).get("authorization"),
    "Bearer oauth-access-token",
  );
  assert.equal(JSON.stringify(result).includes("oauth-access-token"), false);
  assert.equal(JSON.stringify(result).includes("sandbox-client-secret"), false);
});

test("create sends only the reviewed URL and explicit event names", async () => {
  const network = queuedFetch([
    jsonResponse({ access_token: "oauth-access-token", expires_in: 3_600 }),
    jsonResponse({
      id: "WH_CREATED",
      url,
      event_types: events.map((name) => ({ name })),
    }, 201),
  ]);
  const client = new PayPalSandboxWebhookManagementClient(config, {
    fetch: network.fetch,
  });
  const result = await client.createWebhook({ url, eventTypes: events });

  assert.deepEqual(result, {
    id: "WH_CREATED",
    url,
    eventTypes: events,
  });
  assert.equal(
    network.calls[1]?.url,
    "https://api-m.sandbox.paypal.com/v1/notifications/webhooks",
  );
  assert.deepEqual(
    JSON.parse(String(network.calls[1]?.init?.body)),
    {
      url,
      event_types: events.map((name) => ({ name })),
    },
  );
});

test("management client rejects wildcard, insecure and credential-bearing registrations", async () => {
  const client = new PayPalSandboxWebhookManagementClient(config, {
    fetch: async () => assert.fail("Invalid input must not use the transport"),
  });
  for (const input of [
    { url: "http://example.com/api/paypal/webhook", eventTypes: events },
    {
      url: "https://user:password@example.com/api/paypal/webhook",
      eventTypes: events,
    },
    { url, eventTypes: ["*"] },
    { url, eventTypes: [events[0], events[0]] },
  ]) {
    await assert.rejects(() => client.createWebhook(input), PayPalAdapterError);
  }
});
