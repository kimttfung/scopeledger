import assert from "node:assert/strict";
import test from "node:test";
import {
  handleFinancialAuditGet,
  handleFinancialAuditPost,
} from "../../../apps/web/app/api/provider/financial-audit/service.js";
import type {
  FinancialAuditDependencies,
  ProviderFinancialAuditRun,
  ProviderFinancialAuditStatus,
} from "../../../apps/web/app/api/provider/financial-audit/service.js";

const status: ProviderFinancialAuditStatus = Object.freeze({
  generatedAt: "2026-11-12T16:00:00.000Z",
  auditIntervalSeconds: 86_400,
  credentialFailures: 0,
  knownAttempts: 4,
  knownCaptures: 3,
  activeAttempts: 1,
  staleFacts: 1,
  receiptCount: 6,
  lastReceiptAt: "2026-11-12T15:59:00.000Z",
  queueLagSeconds: 60,
});

const run: ProviderFinancialAuditRun = Object.freeze({
  generatedAt: "2026-11-12T16:00:00.000Z",
  limit: 50,
  truncated: false,
  audit: {
    audited: 4,
    activeAttempts: 1,
    knownFacts: 3,
    staleFacts: 1,
    exactRefreshes: 2,
    captureDiscoveries: 1,
    readinessRestored: 1,
    readinessWithheld: 1,
    pending: 0,
    unknown: 0,
    credentialFailures: 0,
    providerFailures: 0,
    authoritativeMismatches: 0,
    domainFailures: 0,
    unresolved: 1,
  },
  webhooks: {
    receipts: 6,
    processed: 6,
    unresolved: 0,
    credentialFailures: 0,
    providerFailures: 0,
    authoritativeFailures: 0,
    lastReceiptAt: "2026-11-12T15:59:00.000Z",
    queueLagSeconds: 60,
  },
});

function dependencies(
  overrides: Partial<FinancialAuditDependencies> = {},
): FinancialAuditDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    hasInspectGrant: async () => true,
    status: async () => status,
    audit: async () => run,
    ...overrides,
  };
}

function auditRequest(body: object): Request {
  return new Request(
    "http://127.0.0.1:3000/api/provider/financial-audit",
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

test("financial health requires MFA assurance and a current inspect grant", async () => {
  const assurance = await handleFinancialAuditGet(dependencies({
    verifyProvider: async () => ({
      ok: false,
      status: 403,
      code: "PROVIDER_ASSURANCE_REQUIRED",
    }),
  }));
  assert.equal(assurance.status, 403);
  const grant = await handleFinancialAuditGet(dependencies({
    hasInspectGrant: async () => false,
  }));
  assert.equal(grant.status, 403);
  const allowed = await handleFinancialAuditGet(dependencies());
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as {
    capabilities: Record<string, boolean>;
  };
  assert.deepEqual(body.capabilities, {
    authoritativeAudit: true,
    paymentDispatch: false,
    refundInitiation: false,
    manualOutcomeOverride: false,
  });
});

test("explicit bounded audit returns aggregates and no financial action", async () => {
  const response = await handleFinancialAuditPost(
    auditRequest({ action: "audit", limit: 50 }),
    dependencies(),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as {
    run: ProviderFinancialAuditRun;
    effects: Record<string, boolean>;
  };
  assert.deepEqual(body.run, run);
  assert.deepEqual(body.effects, {
    paymentDispatched: false,
    refundInitiated: false,
    paymentAttemptCreated: false,
    financialHistoryRewritten: false,
    manualOutcomeOverride: false,
  });
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("CAPTURE"), false);
  assert.equal(serialized.includes("merchant"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("300.00"), false);
});

test("audit rejects unbounded or mutating commands", async () => {
  for (const body of [
    { action: "audit", limit: 0 },
    { action: "audit", limit: 101 },
    { action: "refund", limit: 50 },
    { action: "audit", limit: 50, outcome: "completed" },
  ]) {
    const response = await handleFinancialAuditPost(
      auditRequest(body),
      dependencies(),
    );
    assert.equal(response.status, 400);
  }
});
