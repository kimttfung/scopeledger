import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  handleCommercialPublishPost,
  type CommercialDependencies,
} from "../../../apps/web/app/api/provider/authoring/commercial-service.js";
import {
  handleCorrectionAssessmentPost,
  type ReconciliationDependencies,
} from "../../../apps/web/app/api/provider/reconciliation/service.js";

function request(path: string, body: object): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    },
    body: JSON.stringify(body),
  });
}

test("material assessment returns an authoring selection without publishing or clearing the hold", async () => {
  const authoringUrl =
    "/provider/authoring?projectId=project-one&requestId=request-one&unitId=unit-one";
  const dependencies: ReconciliationDependencies = {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    hasInboxGrant: async () => true,
    listInbox: async () => ({ questions: [], corrections: [] }),
    loadQuestionTarget: async () => null,
    loadCorrectionTarget: async () => ({
      projectId: "project-one",
      version: 2,
    }),
    authorize: async () => true,
    recordQuestionResponse: async () => {
      throw new Error("not used");
    },
    assessCorrection: async () => ({
      duplicate: false,
      assessmentRevision: 1,
      responseRevision: 1,
      applicability: "material-change",
      reissueDraftRevision: 3,
      authoringUrl,
      assessedAt: "2026-11-12T10:00:00.000Z",
    }),
  };
  const response = await handleCorrectionAssessmentPost(
    request("/corrections/concern-one/assess", {
      idempotencyKey: randomUUID(),
      expectedVersion: 2,
      applicability: "material-change",
      response: "Corrected terms and fresh consent are required.",
      sourceReview: "The admitted correction changes the current scope.",
    }),
    "concern-one",
    dependencies,
  );
  assert.equal(response.status, 201);
  const body = await response.json() as {
    assessment: {
      reissue: {
        authoringUrl: string;
        state: string;
        publicationRequired: boolean;
        priorConsentReused: boolean;
      };
    };
    correctionHoldCleared: boolean;
    agreementChanged: boolean;
    paymentChanged: boolean;
  };
  assert.deepEqual(body.assessment.reissue, {
    draftRevision: 3,
    state: "in-progress",
    publicationRequired: true,
    priorConsentReused: false,
    authoringUrl,
  });
  assert.equal(body.correctionHoldCleared, false);
  assert.equal(body.agreementChanged, false);
  assert.equal(body.paymentChanged, false);
});

test("paid prior terms expose the external financial-resolution boundary without inventing money", async () => {
  const dependencies: CommercialDependencies = {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    authorize: async () => true,
    prepareCommercial: async () => {
      throw new Error("not used");
    },
    publishCommercial: async () => {
      throw Object.assign(new Error("prior payment history"), {
        code: "PAYMENT_OUTCOME_UNKNOWN",
      });
    },
  };
  const response = await handleCommercialPublishPost(
    request("/publish", {
      idempotencyKey: randomUUID(),
      draftRevision: 2,
      preparationLocator: `slcp1_${"a".repeat(43)}`,
      confirmed: true,
    }),
    "project-one",
    "request-one",
    "unit-one",
    dependencies,
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "COMMERCIAL_EXTERNAL_FINANCIAL_RESOLUTION_REQUIRED",
    message:
      "The prior accepted obligation has payment history. The correction hold remains active; resolve the financial basis externally before publishing changed terms. ScopeLedger did not create a balance, refund, cancellation, or recollection.",
  });
});
