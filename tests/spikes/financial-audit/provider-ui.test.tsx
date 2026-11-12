import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FinancialAuditView } from "../../../apps/web/app/provider/financial-audit/financial-audit-view.js";

const styles = new Proxy({}, {
  get: (_target, property) => String(property),
}) as Readonly<Record<string, string>>;

test("provider financial audit UI exposes one bounded read-only trigger", () => {
  const html = renderToStaticMarkup(
    <FinancialAuditView
      status={{
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
      }}
      run={{
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
      }}
      busy={false}
      message={null}
      error={null}
      onAudit={() => undefined}
      styles={styles}
    />,
  );
  assert.match(html, /Audit next 50/u);
  assert.match(html, /Financial recheck required/u);
  assert.match(html, /Credential failures/u);
  assert.match(html, /No provider identifier, token, hidden-project amount/u);
  assert.doesNotMatch(html, />Refund</u);
  assert.doesNotMatch(html, /Dispatch payment|Mark success|Override outcome/iu);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});
