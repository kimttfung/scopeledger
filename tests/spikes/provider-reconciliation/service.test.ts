import assert from "node:assert/strict";
import test from "node:test";
import {
  handleCorrectionAssessmentPost,
  handleQuestionResponsePost,
  handleReconciliationGet,
  type ReconciliationDependencies,
} from "../../../apps/web/app/api/provider/reconciliation/service.js";

const questionId = "11111111-1111-4111-8111-111111111111";
const concernId = "client-concern-one";
const commandId = "22222222-2222-4222-8222-222222222222";

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

function dependencies(
  overrides: Partial<ReconciliationDependencies> = {},
): ReconciliationDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    hasInboxGrant: async () => true,
    listInbox: async () => ({ questions: [], corrections: [] }),
    loadQuestionTarget: async () => ({
      projectId: "project-one",
      version: 2,
    }),
    loadCorrectionTarget: async () => ({
      projectId: "project-one",
      version: 2,
    }),
    authorize: async () => true,
    recordQuestionResponse: async (input) => ({
      duplicate: false,
      revision: 1,
      status: input.status,
      recordedAt: "2026-11-12T10:00:00.000Z",
    }),
    assessCorrection: async (input) => ({
      duplicate: false,
      assessmentRevision: 1,
      responseRevision: 1,
      applicability: input.applicability,
      reissueDraftRevision:
        input.applicability === "material-change" ? 3 : null,
      authoringUrl: input.applicability === "material-change"
        ? "/provider/authoring?projectId=project-one&requestId=request-one&unitId=unit-one"
        : null,
      assessedAt: "2026-11-12T10:01:00.000Z",
    }),
    ...overrides,
  };
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function questionBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: commandId,
    expectedVersion: 2,
    status: "answered",
    response: "The signed amendment is the governing source.",
    ...overrides,
  };
}

function correctionBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: commandId,
    expectedVersion: 2,
    applicability: "needs-information",
    sourceReview: "The referenced correspondence is not available yet.",
    response: "Please provide the referenced message so it can be reviewed.",
    ...overrides,
  };
}

test("inbox requires verified provider assurance and returns no inaccessible totals", async () => {
  const denied = await handleReconciliationGet(dependencies({
    verifyProvider: async () => ({
      ok: false,
      status: 403,
      code: "PROVIDER_ASSURANCE_REQUIRED",
    }),
  }));
  assert.equal(denied.status, 403);

  const grantDenied = await handleReconciliationGet(dependencies({
    hasInboxGrant: async () => false,
  }));
  assert.equal(grantDenied.status, 403);
  assert.equal((await body(grantDenied)).code, "PROVIDER_GRANT_REQUIRED");

  const allowed = await handleReconciliationGet(dependencies());
  assert.equal(allowed.status, 200);
  const serialized = JSON.stringify(await body(allowed));
  assert.doesNotMatch(
    serialized,
    /total|inaccessible|email|sessionId|contentDigest|unitDigest/iu,
  );
});

test("question response remains communication-only and never creates a hold", async () => {
  let recorded: unknown;
  const response = await handleQuestionResponsePost(
    request("/question", questionBody()),
    questionId,
    dependencies({
      recordQuestionResponse: async (input) => {
        recorded = input;
        return {
          duplicate: false,
          revision: 1,
          status: input.status,
          recordedAt: "2026-11-12T10:00:00.000Z",
        };
      },
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(recorded, {
    questionId,
    expectedVersion: 2,
    commandId,
    status: "answered",
    response: "The signed amendment is the governing source.",
  });
  assert.deepEqual(await body(response), {
    ok: true,
    duplicate: false,
    response: {
      revision: 1,
      status: "answered",
      attribution: {
        label: "Provider",
        at: "2026-11-12T10:00:00.000Z",
      },
    },
    communicationEffect: "communication-only",
    reviewHoldCreated: false,
    agreementChanged: false,
    paymentChanged: false,
  });
});

test("needs-information records an explicit assessment without clearing the hold", async () => {
  const response = await handleCorrectionAssessmentPost(
    request("/correction", correctionBody()),
    concernId,
    dependencies(),
  );
  assert.equal(response.status, 201);
  const result = await body(response) as {
    assessment: { applicability: string; reissue: unknown };
    correctionHoldCleared: boolean;
    clientAcknowledgementRequired: boolean;
  };
  assert.equal(result.assessment.applicability, "needs-information");
  assert.equal(result.assessment.reissue, null);
  assert.equal(result.correctionHoldCleared, false);
  assert.equal(result.clientAcknowledgementRequired, false);
});

test("material change creates only an in-progress reissue draft", async () => {
  const response = await handleCorrectionAssessmentPost(
    request("/correction", correctionBody({
      applicability: "material-change",
      sourceReview: "The client source materially changes the described scope.",
      response: "The current published terms need a corrected reissue.",
    })),
    concernId,
    dependencies(),
  );
  assert.equal(response.status, 201);
  const result = await body(response) as {
    assessment: {
      reissue: {
        draftRevision: number;
        state: string;
        publicationRequired: boolean;
        priorConsentReused: boolean;
        authoringUrl: string;
      };
    };
    correctionHoldCleared: boolean;
    agreementChanged: boolean;
    paymentChanged: boolean;
  };
  assert.deepEqual(result.assessment.reissue, {
    draftRevision: 3,
    state: "in-progress",
    publicationRequired: true,
    priorConsentReused: false,
    authoringUrl:
      "/provider/authoring?projectId=project-one&requestId=request-one&unitId=unit-one",
  });
  assert.equal(result.correctionHoldCleared, false);
  assert.equal(result.agreementChanged, false);
  assert.equal(result.paymentChanged, false);
});

test("no-material response still requires explicit client acknowledgement", async () => {
  const response = await handleCorrectionAssessmentPost(
    request("/correction", correctionBody({
      applicability: "no-material-change",
      sourceReview: "The supplied context matches the current published scope.",
      response: "No material change is required to the current terms.",
    })),
    concernId,
    dependencies(),
  );
  assert.equal(response.status, 201);
  const result = await body(response) as {
    correctionHoldCleared: boolean;
    clientAcknowledgementRequired: boolean;
  };
  assert.equal(result.correctionHoldCleared, false);
  assert.equal(result.clientAcknowledgementRequired, true);
});

test("cross-project, revoked, stale and replay-conflict mutations fail closed", async () => {
  const revoked = await handleCorrectionAssessmentPost(
    request("/correction", correctionBody()),
    concernId,
    dependencies({ authorize: async () => false }),
  );
  assert.equal(revoked.status, 404);
  assert.equal(
    (await body(revoked)).code,
    "RECONCILIATION_ITEM_NOT_AVAILABLE",
  );

  for (const [error, expected] of [
    [Object.assign(new Error(), { code: "STALE_UNIT_VERSION" }), 409],
    [Object.assign(new Error(), { code: "IDEMPOTENCY_CONFLICT" }), 409],
  ] as const) {
    const failed = await handleCorrectionAssessmentPost(
      request("/correction", correctionBody()),
      concernId,
      dependencies({
        assessCorrection: async () => {
          throw error;
        },
      }),
    );
    assert.equal(failed.status, expected);
  }
});

test("browser-owned authority and financial fields are rejected before mutation", async () => {
  let called = false;
  const response = await handleCorrectionAssessmentPost(
    request("/correction", correctionBody({
      projectId: "other-project",
      actorId: "browser-provider",
      digest: "a".repeat(64),
      clearHold: true,
      publish: true,
      payment: "refund",
    })),
    concernId,
    dependencies({
      assessCorrection: async () => {
        called = true;
        throw new Error("must not run");
      },
    }),
  );
  assert.equal(response.status, 422);
  assert.equal(called, false);
});
