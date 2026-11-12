import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CorrectionForm,
  QuestionForm,
} from "../../../apps/web/app/provider/reconciliation/reconciliation-forms.js";

const styles = new Proxy({}, {
  get: (_target, property) => String(property),
}) as Readonly<Record<string, string>>;

test("question UI labels communication status without commercial side effects", () => {
  const html = renderToStaticMarkup(
    <QuestionForm
      question={{
        questionId: "11111111-1111-4111-8111-111111111111",
        projectName: "Cedar Roastery",
        requestTitle: "Case-study request",
        unitTitle: "Populate one case-study page",
        version: 2,
        text: "Which source governs this charge?",
        asked: {
          label: "Client approver",
          at: "2026-11-12T10:00:00.000Z",
        },
        status: "open",
        latestResponse: null,
        communicationEffect: "communication-only",
      }}
      busy={false}
      submit={async () => undefined}
      styles={styles}
    />,
  );
  assert.match(html, /Response status/u);
  assert.match(html, /Needs client information/u);
  assert.match(html, /Provider response/u);
  assert.doesNotMatch(html, /approve|payment|clear hold/iu);
});

test("correction UI requires one explicit applicability assessment", () => {
  const html = renderToStaticMarkup(
    <CorrectionForm
      correction={{
        concernId: "client-concern-one",
        projectName: "Cedar Roastery",
        requestTitle: "Case-study request",
        unitTitle: "Populate one case-study page",
        version: 2,
        statement: "The page was included in the signed scope.",
        claimedSourceType: "Signed scope",
        sourceAvailability: "available",
        admitted: {
          label: "Client approver",
          at: "2026-11-12T10:00:00.000Z",
        },
        correctionHoldActive: true,
        otherHoldPresent: true,
        latestResponse: null,
        latestAssessment: null,
      }}
      busy={false}
      submit={async () => undefined}
      styles={styles}
    />,
  );
  for (const label of [
    "Applicability assessment",
    "Needs information",
    "No material change",
    "Material change",
    "Source review",
    "Provider response",
    "Record assessment",
  ]) {
    assert.match(html, new RegExp(label, "u"));
  }
  assert.doesNotMatch(
    html,
    /client@|sessionId|unitDigest|contentDigest|private source bytes/iu,
  );
});
