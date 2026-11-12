import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PaymentExceptionRegisterView } from "../../../apps/web/app/provider/payment-exceptions/payment-exception-view.js";

const styles = new Proxy({}, {
  get: (_target, property) => String(property),
}) as Readonly<Record<string, string>>;

test("provider UI is a read-only exception register with one explicit refresh", () => {
  const html = renderToStaticMarkup(
    <PaymentExceptionRegisterView
      exceptions={[{
        observationId: "41",
        projectName: "Cedar Roastery",
        requestTitle: "Case-study request",
        unitTitle: "Populate one case-study page",
        kind: "refund",
        state: "partial-refund",
        providerStatus: "COMPLETED",
        providerResourceId: "REFUND123",
        captureId: "CAPTURE123",
        currency: "USD",
        captureGross: "300.00",
        affectedGross: "75.00",
        observedAt: "2026-11-12T10:00:00.000Z",
        activeFinancialHold: true,
        readiness: "withheld-financial-exception",
        workStart: {
          version: 2,
          recordedAt: "2026-11-12T09:00:00.000Z",
        },
      }]}
      busy={false}
      message={null}
      error={null}
      onRefresh={() => undefined}
      styles={styles}
    />,
  );
  assert.match(html, /Refresh from PayPal/u);
  assert.match(html, /Readiness withheld/u);
  assert.match(html, /partial refund/u);
  assert.match(html, /\$75\.00/u);
  assert.match(html, /Actual work start remains recorded for version 2/u);
  assert.match(html, /original capture and agreement history are not rewritten/u);
  assert.doesNotMatch(html, />Refund</u);
  assert.doesNotMatch(html, /Mark (success|failed)|Override outcome/iu);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});
