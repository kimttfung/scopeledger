import assert from "node:assert/strict";
import test from "node:test";
import {
  handleClientSubmissionPost,
} from "../../../apps/web/app/api/demo/client-submission/service.js";
import type {
  CorrectionCommand,
  QuestionCommand,
  SubmissionDependencies,
} from "../../../apps/web/app/api/demo/client-submission/service.js";

const currentBasis = {
  unitId: "unit-u1",
  packetId: "packet-review",
  version: 2,
  digest: "a".repeat(64),
} as const;

function request(body: object): Request {
  return new Request("http://127.0.0.1:3000/api/demo/client-submission", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    },
    body: JSON.stringify(body),
  });
}

function correction(overrides: Record<string, unknown> = {}): object {
  return {
    kind: "correction",
    message: "The populated page was included in the signed scope.",
    source: "Signed scope, section 4",
    allowModel: false,
    ...overrides,
  };
}

function question(overrides: Record<string, unknown> = {}): object {
  return {
    kind: "question",
    message: "Which source governs this charge?",
    allowModel: false,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<SubmissionDependencies> = {},
): SubmissionDependencies {
  return {
    requireSameOrigin: () => undefined,
    readSession: async () => ({
      role: "client-approver",
      challengeId: "00000000-0000-4000-8000-000000000003",
    }),
    loadCurrentBasis: async () => currentBasis,
    askQuestion: async (command) => ({
      duplicate: false,
      question: {
        questionId: command.questionId,
        packetId: command.packetId,
        unitId: command.unitId,
        unitVersion: command.unitVersion,
        communicationEffect: "communication-only",
      },
    }),
    admitCorrection: async (command) => ({
      concernId: command.concernId,
      impactRevision: 1,
      affectedUnitIds: [command.originUnitId],
    }),
    createQuestionId: () => "00000000-0000-5000-8000-000000000004",
    createCommandId: () => "00000000-0000-4000-8000-000000000001",
    createConcernId: () => "client-00000000-0000-4000-8000-000000000002",
    ...overrides,
  };
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

test("cross-origin requests fail before session or PostgreSQL access", async () => {
  let sessionRead = false;
  let basisLoaded = false;
  const response = await handleClientSubmissionPost(
    request(correction()),
    dependencies({
      requireSameOrigin: () => {
        throw new Error("SAME_ORIGIN_REQUIRED");
      },
      readSession: async () => {
        sessionRead = true;
        return {
          role: "client-approver",
          challengeId: "00000000-0000-4000-8000-000000000003",
        };
      },
      loadCurrentBasis: async () => {
        basisLoaded = true;
        return currentBasis;
      },
    }),
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "SUBMISSION_ORIGIN_REQUIRED",
  });
  assert.equal(sessionRead, false);
  assert.equal(basisLoaded, false);
});

test("only a verified client approver can reach the current review basis", async () => {
  for (const [session, status, code] of [
    [null, 401, "CLIENT_ACCESS_REQUIRED"],
    [{
      role: "payer" as const,
      challengeId: "00000000-0000-4000-8000-000000000003",
    }, 403, "CLIENT_APPROVER_REQUIRED"],
  ] as const) {
    let basisLoaded = false;
    const response = await handleClientSubmissionPost(
      request(correction()),
      dependencies({
        readSession: async () => session,
        loadCurrentBasis: async () => {
          basisLoaded = true;
          return currentBasis;
        },
      }),
    );
    assert.equal(response.status, status);
    assert.deepEqual(await body(response), { ok: false, code });
    assert.equal(basisLoaded, false);
  }
});

test("browser-owned version, digest, concern, actor and payment fields are rejected", async () => {
  let basisLoaded = false;
  const response = await handleClientSubmissionPost(
    request(correction({
      version: 99,
      digest: "b".repeat(64),
      concernId: "browser-concern",
      actorId: "browser-actor",
      decision: "approve",
      amount: "0.01",
    })),
    dependencies({
      loadCurrentBasis: async () => {
        basisLoaded = true;
        return currentBasis;
      },
    }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "INVALID_SUBMISSION_INPUT",
  });
  assert.equal(basisLoaded, false);
});

test("questions accept only exact text plus separate model permission", async () => {
  let basisLoaded = false;
  let asked = false;
  const response = await handleClientSubmissionPost(
    request(question({
      workspaceId: "browser-workspace",
      projectId: "browser-project",
      questionId: "00000000-0000-4000-8000-000000000099",
      requestId: "browser-request",
      unitId: "browser-unit",
      version: 99,
      actorId: "browser-actor",
      askedAt: "2026-11-11T00:00:00.000Z",
      digest: "b".repeat(64),
      communicationEffect: "commercial",
      hold: true,
      decision: "approve",
      payment: "paid",
      readiness: "ready",
      workStart: true,
      source: "browser-source",
    })),
    dependencies({
      loadCurrentBasis: async () => {
        basisLoaded = true;
        return currentBasis;
      },
      askQuestion: async (command) => {
        asked = true;
        return {
          duplicate: false,
          question: {
            questionId: command.questionId,
            packetId: command.packetId,
            unitId: command.unitId,
            unitVersion: command.unitVersion,
            communicationEffect: "communication-only",
          },
        };
      },
    }),
  );

  assert.equal(response.status, 422);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "INVALID_SUBMISSION_INPUT",
  });
  assert.equal(basisLoaded, false);
  assert.equal(asked, false);
});

test("questions bind exact text and model permission to the server-current basis", async () => {
  const exactText = "  ¿Which source governs “Café”? 😀\nPlease confirm.\t  ";
  const asked: QuestionCommand[] = [];
  let idInput: Parameters<SubmissionDependencies["createQuestionId"]>[0] | null = null;
  let correctionAdmitted = false;
  const response = await handleClientSubmissionPost(
    request(question({ message: exactText, allowModel: true })),
    dependencies({
      askQuestion: async (command) => {
        asked.push(command);
        return {
          duplicate: false,
          question: {
            questionId: command.questionId,
            packetId: command.packetId,
            unitId: command.unitId,
            unitVersion: command.unitVersion,
            communicationEffect: "communication-only",
          },
        };
      },
      admitCorrection: async () => {
        correctionAdmitted = true;
        throw new Error("correction path must not run");
      },
      createQuestionId: (session) => {
        idInput = session;
        return "00000000-0000-5000-8000-000000000004";
      },
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(idInput, {
    role: "client-approver",
    challengeId: "00000000-0000-4000-8000-000000000003",
  });
  assert.deepEqual(asked, [{
    questionId: "00000000-0000-5000-8000-000000000004",
    packetId: currentBasis.packetId,
    unitId: currentBasis.unitId,
    unitVersion: currentBasis.version,
    exactText,
    modelProcessing: "permitted",
  }]);
  assert.equal(correctionAdmitted, false);
  assert.deepEqual(await body(response), {
    ok: true,
    submitted: true,
    kind: "question",
    duplicate: false,
    questionId: "00000000-0000-5000-8000-000000000004",
    unitId: currentBasis.unitId,
    version: currentBasis.version,
    digest: currentBasis.digest,
    communicationEffect: "communication-only",
    reviewHoldCreated: false,
    agreementChanged: false,
    paymentChanged: false,
    readinessChanged: false,
    workStartChanged: false,
  });
});

test("question replay is idempotent and changed replay conflicts safely", async () => {
  const replay = await handleClientSubmissionPost(
    request(question()),
    dependencies({
      askQuestion: async (command) => ({
        duplicate: true,
        question: {
          questionId: command.questionId,
          packetId: command.packetId,
          unitId: command.unitId,
          unitVersion: command.unitVersion,
          communicationEffect: "communication-only",
        },
      }),
    }),
  );
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { duplicate: boolean }).duplicate, true);

  const conflict = await handleClientSubmissionPost(
    request(question({ message: "Changed replay text." })),
    dependencies({
      askQuestion: async () => {
        throw Object.assign(new Error("internal persistence detail"), {
          code: "QUESTION_CONFLICT",
        });
      },
    }),
  );
  assert.equal(conflict.status, 409);
  assert.deepEqual(await body(conflict), {
    ok: false,
    code: "SUBMISSION_STATE_CHANGED",
  });
});

test("question validation counts Unicode code points and rejects control characters", async () => {
  const acceptedText = "😀".repeat(10_000);
  let recorded = "";
  const accepted = await handleClientSubmissionPost(
    request(question({ message: acceptedText })),
    dependencies({
      askQuestion: async (command) => {
        recorded = command.exactText;
        return {
          duplicate: false,
          question: {
            questionId: command.questionId,
            packetId: command.packetId,
            unitId: command.unitId,
            unitVersion: command.unitVersion,
            communicationEffect: "communication-only",
          },
        };
      },
    }),
  );
  assert.equal(accepted.status, 201);
  assert.equal(recorded, acceptedText);

  for (const [message, code] of [
    [`${acceptedText}😀`, "SUBMISSION_TEXT_LIMIT"],
    ["Question\u0000text", "INVALID_SUBMISSION_INPUT"],
    ["Question\rtext", "INVALID_SUBMISSION_INPUT"],
    ["Question\u0085text", "INVALID_SUBMISSION_INPUT"],
    ["\ud800", "INVALID_SUBMISSION_INPUT"],
  ] as const) {
    const rejected = await handleClientSubmissionPost(
      request(question({ message })),
      dependencies(),
    );
    assert.equal(rejected.status, 422);
    assert.deepEqual(await body(rejected), { ok: false, code });
  }
});

test("Unicode limits count code points and preserve valid text", async () => {
  const acceptedMessage = "😀".repeat(10_000);
  let admittedStatement = "";
  const accepted = await handleClientSubmissionPost(
    request(correction({ message: acceptedMessage, source: "" })),
    dependencies({
      admitCorrection: async (command) => {
        admittedStatement = command.claim.statement;
        return {
          concernId: command.concernId,
          impactRevision: 1,
          affectedUnitIds: [command.originUnitId],
        };
      },
    }),
  );
  assert.equal(accepted.status, 201);
  assert.equal(admittedStatement, acceptedMessage);

  const rejected = await handleClientSubmissionPost(
    request(correction({ message: `${acceptedMessage}😀` })),
    dependencies(),
  );
  assert.equal(rejected.status, 422);
  assert.deepEqual(await body(rejected), {
    ok: false,
    code: "SUBMISSION_TEXT_LIMIT",
  });

  const oversizedUnavailableSource = await handleClientSubmissionPost(
    request(correction({ source: " ".repeat(10_001) })),
    dependencies(),
  );
  assert.equal(oversizedUnavailableSource.status, 422);
  assert.deepEqual(await body(oversizedUnavailableSource), {
    ok: false,
    code: "SUBMISSION_TEXT_LIMIT",
  });
});

test("corrections use only server-owned basis and concern identity", async () => {
  const admitted: CorrectionCommand[] = [];
  const response = await handleClientSubmissionPost(
    request(correction({ allowModel: true })),
    dependencies({
      admitCorrection: async (command) => {
        admitted.push(command);
        return {
          concernId: command.concernId,
          impactRevision: 1,
          affectedUnitIds: [command.originUnitId],
        };
      },
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(admitted, [{
    commandId: "00000000-0000-4000-8000-000000000001",
    concernId: "client-00000000-0000-4000-8000-000000000002",
    packetId: currentBasis.packetId,
    originUnitId: currentBasis.unitId,
    scope: {
      kind: "known",
      unitIds: [currentBasis.unitId],
    },
    claim: {
      statement: "The populated page was included in the signed scope.",
      claimedSourceType: "Client-reported agreement context",
      source: {
        availability: "available",
        reference: "Signed scope, section 4",
        date: null,
      },
      sharingAuthorized: true,
      modelProcessingPermitted: true,
    },
  }]);
  assert.deepEqual(await body(response), {
    ok: true,
    submitted: true,
    kind: "correction",
    concernId: "client-00000000-0000-4000-8000-000000000002",
    unitId: currentBasis.unitId,
    version: currentBasis.version,
    digest: currentBasis.digest,
    reviewStatus: "on-hold",
    agreementChanged: false,
    paymentChanged: false,
  });
});

test("missing source remains an honest unavailable-source concern", async () => {
  const admitted: CorrectionCommand[] = [];
  const response = await handleClientSubmissionPost(
    request(correction({ source: "   " })),
    dependencies({
      admitCorrection: async (command) => {
        admitted.push(command);
        return {
          concernId: command.concernId,
          impactRevision: 1,
          affectedUnitIds: [command.originUnitId],
        };
      },
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(admitted[0]?.claim.source, {
    availability: "unavailable",
    explanation: "The client raised the concern without an available source reference.",
  });
});

test("unexpected persistence details are replaced by a stable safe error", async () => {
  const response = await handleClientSubmissionPost(
    request(correction()),
    dependencies({
      admitCorrection: async () => {
        throw new Error("postgres password and internal table details");
      },
    }),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "SUBMISSION_RECORDING_FAILED",
  });
});
