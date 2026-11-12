import assert from "node:assert/strict";
import test from "node:test";
import {
  handleDecisionPost,
} from "../../../apps/web/app/api/demo/decision/service.js";
import type {
  DecisionCommand,
  DecisionDependencies,
} from "../../../apps/web/app/api/demo/decision/service.js";

const currentUnit = {
  unitId: "unit-u1",
  version: 2,
  digest: "a".repeat(64),
} as const;

function request(body: object): Request {
  return new Request("http://127.0.0.1:3000/api/demo/decision", {
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
  overrides: Partial<DecisionDependencies> = {},
): DecisionDependencies {
  return {
    requireSameOrigin: () => undefined,
    readSession: async () => ({ role: "client-approver" }),
    loadCurrentUnit: async () => currentUnit,
    decide: async (command) => ({
      unitId: command.unitId,
      version: command.version,
      decision: command.decision,
      obligationId: command.decision === "approve"
        ? "private-obligation-id"
        : null,
    }),
    createCommandId: () => "00000000-0000-4000-8000-000000000001",
    ...overrides,
  };
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

test("a missing local access session cannot reach PostgreSQL or decide", async () => {
  let loaded = false;
  let decided = false;
  const response = await handleDecisionPost(request({
    decision: "approve",
    reviewedResponse: true,
    authority: true,
  }), dependencies({
    readSession: async () => null,
    loadCurrentUnit: async () => {
      loaded = true;
      return currentUnit;
    },
    decide: async (command) => {
      decided = true;
      return {
        unitId: command.unitId,
        version: command.version,
        decision: command.decision,
        obligationId: null,
      };
    },
  }));

  assert.equal(response.status, 401);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "CLIENT_ACCESS_REQUIRED",
  });
  assert.equal(loaded, false);
  assert.equal(decided, false);
});

test("a cross-origin request is rejected before session or database access", async () => {
  let sessionRead = false;
  const response = await handleDecisionPost(request({
    decision: "approve",
    reviewedResponse: true,
    authority: true,
  }), dependencies({
    requireSameOrigin: () => {
      throw new Error("SAME_ORIGIN_REQUIRED");
    },
    readSession: async () => {
      sessionRead = true;
      return { role: "client-approver" };
    },
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "DECISION_ORIGIN_REQUIRED",
  });
  assert.equal(sessionRead, false);
});

test("a payer session cannot act as the fixed client approver", async () => {
  let decided = false;
  const response = await handleDecisionPost(request({
    decision: "decline",
    reviewedResponse: true,
    authority: false,
  }), dependencies({
    readSession: async () => ({ role: "payer" }),
    decide: async (command) => {
      decided = true;
      return {
        unitId: command.unitId,
        version: command.version,
        decision: command.decision,
        obligationId: null,
      };
    },
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "CLIENT_APPROVER_REQUIRED",
  });
  assert.equal(decided, false);
});

test("strict browser input cannot supply version, digest, or other authority", async () => {
  let loaded = false;
  const response = await handleDecisionPost(request({
    decision: "approve",
    reviewedResponse: true,
    authority: true,
    version: 99,
    digest: "b".repeat(64),
    actorId: "browser-actor",
  }), dependencies({
    loadCurrentUnit: async () => {
      loaded = true;
      return currentUnit;
    },
  }));

  assert.equal(response.status, 422);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "INVALID_DECISION_INPUT",
  });
  assert.equal(loaded, false);
});

test("the reviewed-response boolean must be explicitly true", async () => {
  let decided = false;
  const response = await handleDecisionPost(request({
    decision: "decline",
    reviewedResponse: false,
    authority: true,
  }), dependencies({
    decide: async (command) => {
      decided = true;
      return {
        unitId: command.unitId,
        version: command.version,
        decision: command.decision,
        obligationId: null,
      };
    },
  }));

  assert.equal(response.status, 422);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "INVALID_DECISION_INPUT",
  });
  assert.equal(decided, false);
});

test("the command uses only the server-owned current version and digest", async () => {
  const admitted: DecisionCommand[] = [];
  const response = await handleDecisionPost(request({
    decision: "approve",
    reviewedResponse: true,
    authority: true,
  }), dependencies({
    decide: async (command) => {
      admitted.push(command);
      return {
        unitId: command.unitId,
        version: command.version,
        decision: command.decision,
        obligationId: "private-obligation-id",
      };
    },
  }));

  assert.equal(response.status, 200);
  const command = admitted[0];
  assert.ok(command);
  assert.equal(command.commandId, "00000000-0000-4000-8000-000000000001");
  assert.equal(command.unitId, currentUnit.unitId);
  assert.equal(command.version, currentUnit.version);
  assert.equal(command.digest, currentUnit.digest);
  assert.deepEqual(command.resolution, {
    acknowledged: true,
    concerns: [{
      concernId: "layout-concern",
      responseRevision: 1,
    }],
  });
});

test("approval requires authority while decline records its explicit value", async () => {
  let approveCalled = false;
  const approval = await handleDecisionPost(request({
    decision: "approve",
    reviewedResponse: true,
    authority: false,
  }), dependencies({
    decide: async (command) => {
      approveCalled = true;
      return {
        unitId: command.unitId,
        version: command.version,
        decision: command.decision,
        obligationId: null,
      };
    },
  }));
  assert.equal(approval.status, 422);
  assert.deepEqual(await body(approval), {
    ok: false,
    code: "APPROVAL_AUTHORITY_REQUIRED",
  });
  assert.equal(approveCalled, false);

  let declineAuthority: boolean | null = null;
  const decline = await handleDecisionPost(request({
    decision: "decline",
    reviewedResponse: true,
    authority: false,
  }), dependencies({
    decide: async (command) => {
      declineAuthority = command.attestation.authority;
      return {
        unitId: command.unitId,
        version: command.version,
        decision: command.decision,
        obligationId: null,
      };
    },
  }));
  assert.equal(decline.status, 200);
  assert.equal(declineAuthority, false);
});

test("approval reports domain obligation state without a payment side effect", async () => {
  const response = await handleDecisionPost(request({
    decision: "approve",
    reviewedResponse: true,
    authority: true,
  }), dependencies());

  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), {
    ok: true,
    recorded: true,
    unitId: "unit-u1",
    version: 2,
    decision: "approve",
    agreementStatus: "approved",
    obligationCreated: true,
    paymentStatus: "not-initiated",
  });
});

test("unexpected database details are replaced by a stable safe error", async () => {
  const response = await handleDecisionPost(request({
    decision: "decline",
    reviewedResponse: true,
    authority: true,
  }), dependencies({
    decide: async () => {
      throw new Error("postgres password and internal table details");
    },
  }));

  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "DECISION_RECORDING_FAILED",
  });
});
