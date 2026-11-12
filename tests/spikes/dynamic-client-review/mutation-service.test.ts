import assert from "node:assert/strict";
import test from "node:test";
import {
  handleReviewMutationPost,
  type ReviewCorrectionCommand,
  type ReviewDecisionCommand,
  type ReviewMutationBasis,
  type ReviewMutationDependencies,
  type ReviewQuestionCommand,
} from "../../../apps/web/app/api/review/mutation-service.js";
import {
  privateReviewHeaders,
  ReviewLoadError,
  ReviewLocatorCodec,
  type ReviewLocators,
} from "../../../apps/web/app/api/review/service.js";
import { locatorSecret } from "./fixtures.js";

const codec = new ReviewLocatorCodec(locatorSecret);
const digest = "a".repeat(64);
const locators: ReviewLocators = {
  projectLocator: codec.project("workspace-one", "project-one"),
  requestLocator: codec.request(
    "workspace-one",
    "project-one",
    "request-one",
  ),
  unitLocator: codec.mutationUnit(
    "workspace-one",
    "project-one",
    "request-one",
    "unit-one",
    2,
    digest,
  ),
};
const basis: ReviewMutationBasis = {
  workspaceId: "workspace-one",
  projectId: "project-one",
  requestId: "request-one",
  unitId: "unit-one",
  version: 2,
  digest,
  actorId: "approver-one",
  nominationEpoch: 3,
  decideGrantEpoch: 5,
  correctGrantEpoch: 7,
  terminalDecision: null,
  resolutionConcerns: [{
    concernId: "concern-one",
    responseRevision: 4,
  }],
};

function request(body: object): Request {
  return new Request(
    `http://127.0.0.1:3000${[
      "/api/review",
      locators.projectLocator,
      locators.requestLocator,
      locators.unitLocator,
    ].join("/")}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
      },
      body: JSON.stringify(body),
    },
  );
}

function dependencies(
  overrides: Partial<ReviewMutationDependencies> = {},
): ReviewMutationDependencies {
  return {
    requireSameOrigin: () => undefined,
    readSession: async () => ({
      role: "client-approver",
      subject: "b".repeat(64),
      challengeId: "00000000-0000-4000-8000-000000000001",
    }),
    loadMutationBasis: async () => basis,
    decide: async (_current, command) => ({
      decision: command.decision,
      obligationId: command.decision === "approve"
        ? "private-obligation"
        : null,
    }),
    askQuestion: async () => ({ duplicate: false }),
    admitCorrection: async (current, command) => ({
      concernId: command.concernId,
      affectedUnitIds: [current.unitId],
    }),
    createId: (kind) => ({
      "decision-command": "00000000-0000-5000-8000-000000000002",
      question: "00000000-0000-5000-8000-000000000003",
      "correction-command": "00000000-0000-5000-8000-000000000004",
      concern: "00000000-0000-5000-8000-000000000005",
    })[kind],
    ...overrides,
  };
}

function decision(
  overrides: Record<string, unknown> = {},
): object {
  return {
    kind: "decision",
    decision: "approve",
    reviewedExactVersion: true,
    authority: true,
    acknowledgedResponses: true,
    ...overrides,
  };
}

function message(
  kind: "question" | "correction",
  overrides: Record<string, unknown> = {},
): object {
  return {
    kind,
    text: kind === "question"
      ? "Which published source governs this charge?"
      : "This page was included in the signed agreement.",
    allowModel: false,
    ...overrides,
  };
}

test("same-origin rejection happens before session or database access", async () => {
  let sessionRead = false;
  let basisRead = false;
  const response = await handleReviewMutationPost(
    request(decision()),
    locators,
    dependencies({
      requireSameOrigin: () => {
        throw new Error("SAME_ORIGIN_REQUIRED");
      },
      readSession: async () => {
        sessionRead = true;
        return null;
      },
      loadMutationBasis: async () => {
        basisRead = true;
        return basis;
      },
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "REVIEW_MUTATION_ORIGIN_REQUIRED",
  });
  assert.equal(sessionRead, false);
  assert.equal(basisRead, false);
});

test("strict bodies reject browser-owned scope, version, actor, time, concern, and payment facts", async () => {
  for (const body of [
    decision({
      workspaceId: "browser-workspace",
      projectId: "browser-project",
      requestId: "browser-request",
      unitId: "browser-unit",
      version: 99,
      digest: "f".repeat(64),
      actorId: "browser-actor",
      recordedAt: "2026-11-11T00:00:00.000Z",
      concernId: "browser-concern",
      amount: "0.01",
      readiness: "ready",
    }),
    message("question", { unitId: "browser-unit" }),
    message("correction", { concernId: "browser-concern" }),
  ]) {
    let basisRead = false;
    const response = await handleReviewMutationPost(
      request(body),
      locators,
      dependencies({
        loadMutationBasis: async () => {
          basisRead = true;
          return basis;
        },
      }),
    );
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      ok: false,
      code: "INVALID_REVIEW_MUTATION",
    });
    assert.equal(basisRead, false);
  }
});

test("verified current approver authority and opaque locator matching fail closed", async () => {
  for (const [session, status, code] of [
    [null, 401, "CLIENT_ACCESS_REQUIRED"],
    [{
      role: "payer" as const,
      subject: "b".repeat(64),
      challengeId: "00000000-0000-4000-8000-000000000001",
    }, 403, "CLIENT_APPROVER_REQUIRED"],
  ] as const) {
    const response = await handleReviewMutationPost(
      request(decision()),
      locators,
      dependencies({ readSession: async () => session }),
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, code });
  }

  for (const [errorCode, status, code] of [
    ["ACCESS_DENIED", 403, "REVIEW_MUTATION_NOT_AUTHORIZED"],
    ["NOT_FOUND", 404, "REVIEW_MUTATION_NOT_AVAILABLE"],
    ["STALE_RECORD", 409, "REVIEW_STATE_CHANGED"],
  ] as const) {
    const response = await handleReviewMutationPost(
      request(decision()),
      locators,
      dependencies({
        loadMutationBasis: async () => {
          throw new ReviewLoadError(errorCode);
        },
      }),
    );
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { ok: false, code });
  }
});

test("decisions bind exact server version, digest, responses, and acknowledgements without payment side effects", async () => {
  const commands: ReviewDecisionCommand[] = [];
  const response = await handleReviewMutationPost(
    request(decision()),
    locators,
    dependencies({
      decide: async (current, command) => {
        assert.equal(current, basis);
        commands.push(command);
        return {
          decision: command.decision,
          obligationId: "private-obligation",
        };
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(commands, [{
    commandId: "00000000-0000-5000-8000-000000000002",
    unitId: basis.unitId,
    version: basis.version,
    digest: basis.digest,
    decision: "approve",
    attestation: {
      reviewedExactVersion: true,
      authority: true,
      statement:
        "Verified local client approver reviewed the exact current published terms and explicitly recorded this outcome.",
    },
    resolution: {
      acknowledged: true,
      concerns: basis.resolutionConcerns,
    },
  }]);
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "decision",
    decision: "approve",
    agreementStatus: "approved",
    obligationCreated: true,
    paymentStatus: "not-initiated",
    paymentChanged: false,
  });

  const missingResponseAck = await handleReviewMutationPost(
    request(decision({ acknowledgedResponses: false })),
    locators,
    dependencies(),
  );
  assert.equal(missingResponseAck.status, 422);
  assert.deepEqual(await missingResponseAck.json(), {
    ok: false,
    code: "RESPONSE_ACKNOWLEDGEMENT_REQUIRED",
  });

  const noApprovalAuthority = await handleReviewMutationPost(
    request(decision({ authority: false })),
    locators,
    dependencies(),
  );
  assert.equal(noApprovalAuthority.status, 422);
  assert.deepEqual(await noApprovalAuthority.json(), {
    ok: false,
    code: "APPROVAL_AUTHORITY_REQUIRED",
  });
});

test("already-terminal decisions and domain conflicts never replay a new outcome", async () => {
  let decided = false;
  const terminal = await handleReviewMutationPost(
    request(decision({ decision: "decline" })),
    locators,
    dependencies({
      loadMutationBasis: async () => ({
        ...basis,
        terminalDecision: "approve",
      }),
      decide: async () => {
        decided = true;
        throw new Error("must not run");
      },
    }),
  );
  assert.equal(terminal.status, 409);
  assert.deepEqual(await terminal.json(), {
    ok: false,
    code: "REVIEW_DECISION_ALREADY_RECORDED",
  });
  assert.equal(decided, false);

  const conflict = await handleReviewMutationPost(
    request(decision()),
    locators,
    dependencies({
      decide: async () => {
        throw Object.assign(new Error("conflict"), {
          code: "DECISION_CONFLICT",
        });
      },
    }),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), {
    ok: false,
    code: "REVIEW_DECISION_ALREADY_RECORDED",
  });
});

test("questions preserve exact text and model permission while creating no hold", async () => {
  const exactText = "  ¿Which source governs “Café”? 😀\nPlease confirm.\t  ";
  const commands: ReviewQuestionCommand[] = [];
  const response = await handleReviewMutationPost(
    request(message("question", {
      text: exactText,
      allowModel: true,
    })),
    locators,
    dependencies({
      askQuestion: async (current, command) => {
        assert.equal(current, basis);
        commands.push(command);
        return { duplicate: false };
      },
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(commands, [{
    questionId: "00000000-0000-5000-8000-000000000003",
    requestId: basis.requestId,
    unitId: basis.unitId,
    unitVersion: basis.version,
    askedBy: basis.actorId,
    exactText,
    modelProcessing: "permitted",
  }]);
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "question",
    duplicate: false,
    communicationEffect: "communication-only",
    reviewHoldCreated: false,
    agreementChanged: false,
    paymentChanged: false,
    readinessChanged: false,
    workStartChanged: false,
  });

  const replay = await handleReviewMutationPost(
    request(message("question")),
    locators,
    dependencies({
      askQuestion: async () => ({ duplicate: true }),
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal(
    (await replay.json() as { duplicate: boolean }).duplicate,
    true,
  );
});

test("corrections create only a known-scope unit review hold command", async () => {
  const commands: ReviewCorrectionCommand[] = [];
  const response = await handleReviewMutationPost(
    request(message("correction", { allowModel: true })),
    locators,
    dependencies({
      admitCorrection: async (current, command) => {
        commands.push(command);
        return {
          concernId: command.concernId,
          affectedUnitIds: [current.unitId],
        };
      },
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(commands, [{
    commandId: "00000000-0000-5000-8000-000000000004",
    concernId: "client-00000000-0000-5000-8000-000000000005",
    packetId: basis.requestId,
    originUnitId: basis.unitId,
    scope: {
      kind: "known",
      unitIds: [basis.unitId],
    },
    claim: {
      statement: "This page was included in the signed agreement.",
      claimedSourceType: "Client-reported agreement context",
      source: {
        availability: "unavailable",
        explanation:
          "The client raised the correction without an available source reference.",
      },
      sharingAuthorized: true,
      modelProcessingPermitted: true,
    },
  }]);
  assert.deepEqual(await response.json(), {
    ok: true,
    kind: "correction",
    reviewStatus: "on-hold",
    reviewHoldCreated: true,
    agreementChanged: false,
    paymentChanged: false,
    readinessChanged: true,
    workStartChanged: false,
  });

  const missingGrant = await handleReviewMutationPost(
    request(message("correction")),
    locators,
    dependencies({
      loadMutationBasis: async () => ({
        ...basis,
        correctGrantEpoch: null,
      }),
    }),
  );
  assert.equal(missingGrant.status, 403);
  assert.deepEqual(await missingGrant.json(), {
    ok: false,
    code: "REVIEW_MUTATION_NOT_AUTHORIZED",
  });
});

test("mutation responses always use the private no-store review headers", async () => {
  const response = await handleReviewMutationPost(
    request(message("question")),
    locators,
    dependencies(),
  );
  for (const [name, value] of Object.entries(privateReviewHeaders)) {
    assert.equal(response.headers.get(name), value);
  }
});
