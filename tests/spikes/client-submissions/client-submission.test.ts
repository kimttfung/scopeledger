import assert from "node:assert/strict";
import test from "node:test";
import {
  handleClientSubmissionPost,
} from "../../../apps/web/app/api/demo/client-submission/service.js";
import type {
  CorrectionCommand,
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

function dependencies(
  overrides: Partial<SubmissionDependencies> = {},
): SubmissionDependencies {
  return {
    requireSameOrigin: () => undefined,
    readSession: async () => ({ role: "client-approver" }),
    loadCurrentBasis: async () => currentBasis,
    admitCorrection: async (command) => ({
      concernId: command.concernId,
      impactRevision: 1,
      affectedUnitIds: [command.originUnitId],
    }),
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
        return { role: "client-approver" };
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
    [{ role: "payer" as const }, 403, "CLIENT_APPROVER_REQUIRED"],
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

test("questions fail closed because the domain has no durable question command", async () => {
  let basisLoaded = false;
  let admitted = false;
  const response = await handleClientSubmissionPost(
    request({
      kind: "question",
      message: "Which source governs this charge?",
      allowModel: false,
    }),
    dependencies({
      loadCurrentBasis: async () => {
        basisLoaded = true;
        return currentBasis;
      },
      admitCorrection: async (command) => {
        admitted = true;
        return {
          concernId: command.concernId,
          impactRevision: 1,
          affectedUnitIds: [command.originUnitId],
        };
      },
    }),
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "QUESTION_SUBMISSION_UNSUPPORTED",
  });
  assert.equal(basisLoaded, false);
  assert.equal(admitted, false);
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
