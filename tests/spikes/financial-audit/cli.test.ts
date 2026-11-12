import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  financialAuditExitCode,
  parseFinancialAuditCliArguments,
} from "@scopeledger/payment-worker";

test("financial audit CLI requires an explicit bounded limit and supports dry status", () => {
  assert.throws(() => parseFinancialAuditCliArguments([]), /--limit/u);
  assert.throws(
    () => parseFinancialAuditCliArguments(["--limit", "0"]),
    /--limit/u,
  );
  assert.throws(
    () => parseFinancialAuditCliArguments(["--limit", "1001"]),
    /--limit/u,
  );
  assert.deepEqual(
    parseFinancialAuditCliArguments(["--status", "--limit=25"]),
    {
      mode: "status",
      limit: 25,
      auditIntervalMilliseconds: 86_400_000,
    },
  );
});

test("financial audit CLI exits nonzero for unresolved audit or webhook health", () => {
  const audit = {
    audited: 1,
    activeAttempts: 0,
    knownFacts: 1,
    staleFacts: 0,
    exactRefreshes: 1,
    captureDiscoveries: 0,
    readinessRestored: 0,
    readinessWithheld: 0,
    pending: 0,
    unknown: 0,
    credentialFailures: 0,
    providerFailures: 0,
    authoritativeMismatches: 0,
    domainFailures: 0,
    unresolved: 0,
  };
  const webhooks = {
    receipts: 1,
    processed: 1,
    unresolved: 0,
    credentialFailures: 0,
    providerFailures: 0,
    authoritativeFailures: 0,
    lastReceiptAt: "2026-11-12T16:00:00.000Z",
    queueLagSeconds: 0,
  };
  assert.equal(financialAuditExitCode({ audit, webhooks }), 0);
  assert.equal(financialAuditExitCode({
    audit: { ...audit, unresolved: 1 },
    webhooks,
  }), 1);
  assert.equal(financialAuditExitCode({
    audit,
    webhooks: { ...webhooks, unresolved: 1 },
  }), 1);
});

test("financial audit script reports invalid arguments safely", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/audit-paypal-financials.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
      },
    },
  );
  assert.equal(result.status, 2);
  const body = JSON.parse(result.stdout) as {
    code: string;
    message: string;
  };
  assert.equal(body.code, "INVALID_AUDIT_ARGUMENTS");
  assert.equal(body.message.includes("credential"), false);
  assert.equal(body.message.includes("provider ID"), false);
});
