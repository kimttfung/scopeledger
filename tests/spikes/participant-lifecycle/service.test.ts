import assert from "node:assert/strict";
import test from "node:test";
import {
  handleParticipantConfirmPost,
  handleParticipantPreviewPost,
  handleParticipantsGet,
  type ParticipantLifecycleDependencies,
  type ParticipantPreview,
  type ProviderParticipant,
} from "../../../apps/web/app/api/provider/participants/service.js";

const selector = `slpt1_${"A".repeat(43)}`;
const confirmationLocator =
  `slpcf1_${"A".repeat(43)}_${"B".repeat(43)}`;
const participant: ProviderParticipant = {
  selector,
  kind: "project-approver",
  projectLabel: "Harbor custom terms",
  requestLabel: null,
  unitTitle: null,
  amount: null,
  participantLabel: "Fixed local demo approver",
  status: "active",
  recovery: "none",
  availableOperations: ["revoke-approver"],
};
const preview: ParticipantPreview = {
  confirmationLocator,
  operation: "revoke-approver",
  projectLabel: participant.projectLabel,
  requestLabel: null,
  unitTitle: null,
  amount: null,
  participantLabel: participant.participantLabel,
  effect: ["Blocks future project inspection, decisions, and corrections."],
  preserved: ["Historical attribution remains unchanged."],
  requiresReissue: false,
  admittedCaptureRecoveryPreserved: false,
};

function dependencies(
  overrides: Partial<ParticipantLifecycleDependencies> = {},
): ParticipantLifecycleDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    list: async () => [participant],
    preview: async () => preview,
    confirm: async () => ({
      participant: {
        ...participant,
        status: "revoked",
        availableOperations: ["restore-approver"],
      },
      duplicate: false,
    }),
    ...overrides,
  };
}

function post(path: string, value: object): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    },
    body: JSON.stringify(value),
  });
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("verified email and MFA gate list, preview and confirmation", async () => {
  for (const access of [
    {
      ok: false as const,
      status: 401 as const,
      code: "AUTHENTICATION_REQUIRED" as const,
    },
    {
      ok: false as const,
      status: 403 as const,
      code: "PROVIDER_ASSURANCE_REQUIRED" as const,
    },
  ]) {
    let called = false;
    const denied = dependencies({
      verifyProvider: async () => access,
      list: async () => {
        called = true;
        return [];
      },
      preview: async () => {
        called = true;
        return preview;
      },
      confirm: async () => {
        called = true;
        throw new Error("must not confirm");
      },
    });
    const responses = [
      await handleParticipantsGet(denied),
      await handleParticipantPreviewPost(
        post("/api/provider/participants/preview", {
          selector,
          operation: "revoke-approver",
        }),
        denied,
      ),
      await handleParticipantConfirmPost(
        post("/api/provider/participants/confirm", {
          confirmationLocator,
          confirmed: true,
        }),
        denied,
      ),
    ];
    assert.deepEqual(responses.map((response) => response.status), [
      access.status,
      access.status,
      access.status,
    ]);
    assert.equal(called, false);
  }
});

test("same-origin rejection precedes authentication and lifecycle work", async () => {
  let verified = false;
  let called = false;
  const denied = dependencies({
    requireSameOrigin: () => {
      throw new Error("SAME_ORIGIN_REQUIRED");
    },
    verifyProvider: async () => {
      verified = true;
      return { ok: true };
    },
    preview: async () => {
      called = true;
      return preview;
    },
    confirm: async () => {
      called = true;
      throw new Error("must not confirm");
    },
  });
  const previewResponse = await handleParticipantPreviewPost(
    post("/api/provider/participants/preview", {
      selector,
      operation: "revoke-approver",
    }),
    denied,
  );
  const confirmResponse = await handleParticipantConfirmPost(
    post("/api/provider/participants/confirm", {
      confirmationLocator,
      confirmed: true,
    }),
    denied,
  );
  assert.equal(previewResponse.status, 403);
  assert.equal(confirmResponse.status, 403);
  assert.equal(verified, false);
  assert.equal(called, false);
});

test("browser inputs are limited to opaque selectors, operation and confirmation", async () => {
  let previewInput: unknown = null;
  let confirmationInput: unknown = null;
  const accepted = dependencies({
    preview: async (receivedSelector, operation) => {
      previewInput = { receivedSelector, operation };
      return preview;
    },
    confirm: async (received) => {
      confirmationInput = received;
      return { participant, duplicate: true };
    },
  });
  const rejected = await handleParticipantPreviewPost(
    post("/api/provider/participants/preview", {
      selector,
      operation: "revoke-approver",
      actorId: "browser-actor",
      grantName: "decide",
      epoch: 99,
      projectId: "other-project",
      obligationId: "other-obligation",
      historicalActor: "former-actor",
      timestamp: "2026-11-12T12:00:00.000Z",
    }),
    accepted,
  );
  assert.equal(rejected.status, 422);
  assert.equal(previewInput, null);

  const previewResponse = await handleParticipantPreviewPost(
    post("/api/provider/participants/preview", {
      selector,
      operation: "revoke-approver",
    }),
    accepted,
  );
  assert.equal(previewResponse.status, 200);
  assert.deepEqual(previewInput, {
    receivedSelector: selector,
    operation: "revoke-approver",
  });

  const confirmationResponse = await handleParticipantConfirmPost(
    post("/api/provider/participants/confirm", {
      confirmationLocator,
      confirmed: true,
    }),
    accepted,
  );
  assert.equal(confirmationResponse.status, 201);
  assert.equal(confirmationInput, confirmationLocator);
  assert.doesNotMatch(
    JSON.stringify(await body(confirmationResponse)),
    /actorId|grantEpoch|nominationEpoch|projectId|obligationId|recordedAt/,
  );
});

test("stale, grant and idempotency failures remain explicit and safe", async () => {
  for (const [code, status, publicCode] of [
    ["ACCESS_DENIED", 403, "PROVIDER_GRANT_REQUIRED"],
    ["NOT_FOUND", 404, "PARTICIPANT_NOT_AVAILABLE"],
    ["STALE_CONTEXT", 409, "PARTICIPANT_STATE_CHANGED"],
    ["IDEMPOTENCY_CONFLICT", 409, "PARTICIPANT_REPLAY_CONFLICT"],
  ] as const) {
    const response = await handleParticipantConfirmPost(
      post("/api/provider/participants/confirm", {
        confirmationLocator,
        confirmed: true,
      }),
      dependencies({
        confirm: async () => {
          throw Object.assign(new Error(code), { code });
        },
      }),
    );
    assert.equal(response.status, status);
    assert.equal((await body(response)).code, publicCode);
  }
});
