import assert from "node:assert/strict";
import test from "node:test";
import {
  MFA_ACR_VALUE,
  MFA_CUSTOM_CLAIM,
  providerAssurance,
} from "../../../apps/web/lib/provider-session.js";
import {
  readAuth0Environment,
} from "../../../apps/web/lib/auth0-config.js";

test("provider assurance fails closed without verified email and MFA claims", () => {
  assert.deepEqual(providerAssurance({ sub: "auth0|provider" }), {
    subject: "auth0|provider",
    email: null,
    emailVerified: false,
    mfaVerified: false,
  });
  assert.equal(providerAssurance({
    sub: "auth0|provider",
    email: "provider@example.test",
    email_verified: true,
    amr: ["pwd"],
  }).mfaVerified, false);
});

test("provider assurance accepts standard MFA method or ACR claims", () => {
  assert.equal(providerAssurance({
    sub: "auth0|provider",
    email_verified: true,
    amr: ["pwd", "mfa"],
  }).mfaVerified, true);
  assert.equal(providerAssurance({
    sub: "auth0|provider",
    email_verified: true,
    acr: MFA_ACR_VALUE,
  }).mfaVerified, true);
  assert.equal(providerAssurance({
    sub: "auth0|provider",
    email_verified: true,
    [MFA_CUSTOM_CLAIM]: true,
  }).mfaVerified, true);
});

test("Auth0 environment is optional for the public synthetic profile and strict when present", () => {
  assert.deepEqual(readAuth0Environment({}), {
    configured: false,
    missing: [
      "AUTH0_DOMAIN",
      "AUTH0_CLIENT_ID",
      "AUTH0_CLIENT_SECRET",
      "AUTH0_SECRET",
      "APP_BASE_URL",
    ],
  });
  const configured = readAuth0Environment({
    AUTH0_DOMAIN: "tenant.us.auth0.com",
    AUTH0_CLIENT_ID: "client-id",
    AUTH0_CLIENT_SECRET: "client-secret",
    AUTH0_SECRET: "a".repeat(64),
    APP_BASE_URL: "http://127.0.0.1:3000",
  });
  assert.equal(configured.configured, true);
  assert.throws(() => readAuth0Environment({
    AUTH0_DOMAIN: "https://tenant.us.auth0.com",
    AUTH0_CLIENT_ID: "client-id",
    AUTH0_CLIENT_SECRET: "client-secret",
    AUTH0_SECRET: "short",
    APP_BASE_URL: "http://example.com",
  }));
});
