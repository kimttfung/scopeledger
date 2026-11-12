import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

type ProviderAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

type LocalClientApproverActivation = Readonly<{
  status: "ready" | "active";
  confirmationLocator: string;
  projectLabel: string;
  activatedAt: string | null;
  authority: Readonly<{
    inspect: true;
    decide: true;
    correct: true;
    pay: false;
  }>;
  localChannelVerification: "separate";
  effect: "prospective-project-only";
}>;

type ParticipantDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAccess>;
  authorize: (
    input: Readonly<{
      projectId: string;
      action: "inspect" | "publish";
    }>,
  ) => Promise<boolean>;
  previewActivation: (
    input: Readonly<{ projectId: string }>,
  ) => Promise<LocalClientApproverActivation>;
  activate: (
    input: Readonly<{
      projectId: string;
      confirmationLocator: string;
    }>,
  ) => Promise<Readonly<{
    activation: LocalClientApproverActivation;
    duplicate: boolean;
  }>>;
}>;

const participantService = await import(pathToFileURL(resolve(
  "apps/web/app/api/provider/authoring/participant-service.ts",
)).href) as Readonly<{
  handleParticipantPreviewGet: (
    projectId: string,
    dependencies: ParticipantDependencies,
  ) => Promise<Response>;
  handleParticipantActivatePost: (
    request: Request,
    projectId: string,
    dependencies: ParticipantDependencies,
  ) => Promise<Response>;
}>;
const {
  handleParticipantActivatePost,
  handleParticipantPreviewGet,
} = participantService;

const projectId = "project-one";
const confirmationLocator = `slpa1_${"A".repeat(43)}`;
const preview: LocalClientApproverActivation = {
  status: "ready",
  confirmationLocator,
  projectLabel: "Harbor custom terms",
  activatedAt: null,
  authority: {
    inspect: true,
    decide: true,
    correct: true,
    pay: false,
  },
  localChannelVerification: "separate",
  effect: "prospective-project-only",
};

function dependencies(
  overrides: Partial<ParticipantDependencies> = {},
): ParticipantDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    authorize: async () => true,
    previewActivation: async () => preview,
    activate: async () => ({
      activation: {
        ...preview,
        status: "active",
        activatedAt: "2026-11-12T09:00:00.000Z",
      },
      duplicate: false,
    }),
    ...overrides,
  };
}

function post(payload: object): Request {
  return new Request(
    `http://127.0.0.1:3000/api/provider/authoring/projects/${projectId}/participants/local-client-approver`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
      },
      body: JSON.stringify(payload),
    },
  );
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("verified email and MFA are required before participant preview", async () => {
  for (const [access, status, code] of [
    [{
      ok: false as const,
      status: 401 as const,
      code: "AUTHENTICATION_REQUIRED" as const,
    }, 401, "AUTHENTICATION_REQUIRED"],
    [{
      ok: false as const,
      status: 403 as const,
      code: "PROVIDER_ASSURANCE_REQUIRED" as const,
    }, 403, "PROVIDER_ASSURANCE_REQUIRED"],
  ] as const) {
    let authorized = false;
    let previewed = false;
    const response = await handleParticipantPreviewGet(
      projectId,
      dependencies({
        verifyProvider: async () => access,
        authorize: async () => {
          authorized = true;
          return true;
        },
        previewActivation: async () => {
          previewed = true;
          return preview;
        },
      }),
    );
    assert.equal(response.status, status);
    assert.equal((await body(response)).code, code);
    assert.equal(authorized, false);
    assert.equal(previewed, false);
  }
});

test("the current scoped provider grant is required for preview and activation", async () => {
  const actions: string[] = [];
  const denied = dependencies({
    authorize: async ({ action }) => {
      actions.push(action);
      return false;
    },
  });
  const previewResponse = await handleParticipantPreviewGet(
    projectId,
    denied,
  );
  const activationResponse = await handleParticipantActivatePost(
    post({ confirmationLocator, confirmed: true }),
    projectId,
    denied,
  );
  assert.equal(previewResponse.status, 403);
  assert.equal(activationResponse.status, 403);
  assert.deepEqual(actions, ["inspect", "publish"]);
});

test("same-origin rejection happens before authentication or activation", async () => {
  let verified = false;
  let activated = false;
  const response = await handleParticipantActivatePost(
    post({ confirmationLocator, confirmed: true }),
    projectId,
    dependencies({
      requireSameOrigin: () => {
        throw new Error("SAME_ORIGIN_REQUIRED");
      },
      verifyProvider: async () => {
        verified = true;
        return { ok: true };
      },
      activate: async () => {
        activated = true;
        throw new Error("must not run");
      },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal((await body(response)).code, "SAME_ORIGIN_REQUIRED");
  assert.equal(verified, false);
  assert.equal(activated, false);
});

test("confirmation admits only the selected project locator and opaque preview", async () => {
  let admitted: unknown = null;
  const rejected = await handleParticipantActivatePost(
    post({
      confirmationLocator,
      confirmed: true,
      actorId: "browser-approver",
      actions: ["pay"],
      grantEpoch: 99,
      nominationEpoch: 99,
      workspaceId: "browser-workspace",
      projectId: "other-project",
      commandId: "11111111-1111-4111-8111-111111111111",
      activatedAt: "2026-11-12T09:00:00.000Z",
    }),
    projectId,
    dependencies(),
  );
  assert.equal(rejected.status, 422);

  const accepted = await handleParticipantActivatePost(
    post({ confirmationLocator, confirmed: true }),
    projectId,
    dependencies({
      activate: async (input) => {
        admitted = input;
        return {
          activation: {
            ...preview,
            status: "active",
            activatedAt: "2026-11-12T09:00:00.000Z",
          },
          duplicate: false,
        };
      },
    }),
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(admitted, { projectId, confirmationLocator });
  const serialized = JSON.stringify(await body(accepted));
  assert.doesNotMatch(
    serialized,
    /actorId|grantEpoch|nominationEpoch|commandId|workspaceId/,
  );
  assert.match(serialized, /"pay":false/);
});

test("explicit confirmation and a valid server preview locator are mandatory", async () => {
  for (const payload of [
    { confirmationLocator, confirmed: false },
    { confirmationLocator },
    { confirmed: true },
    { confirmationLocator: "project-one", confirmed: true },
  ]) {
    let activated = false;
    const response = await handleParticipantActivatePost(
      post(payload),
      projectId,
      dependencies({
        activate: async () => {
          activated = true;
          throw new Error("must not run");
        },
      }),
    );
    assert.equal(response.status, 422);
    assert.equal(activated, false);
  }
});

test("invalid or changed project scope fails without preview or activation", async () => {
  for (const operation of ["preview", "activate"] as const) {
    let called = false;
    const scoped = dependencies({
      previewActivation: async () => {
        called = true;
        return preview;
      },
      activate: async () => {
        called = true;
        throw new Error("must not run");
      },
    });
    const response = operation === "preview"
      ? await handleParticipantPreviewGet("../other-project", scoped)
      : await handleParticipantActivatePost(
        post({ confirmationLocator, confirmed: true }),
        "../other-project",
        scoped,
      );
    assert.equal(response.status, 404);
    assert.equal(called, false);
  }

  const changed = await handleParticipantActivatePost(
    post({ confirmationLocator, confirmed: true }),
    projectId,
    dependencies({
      activate: async () => {
        throw Object.assign(new Error("STALE_CONTEXT"), {
          code: "STALE_CONTEXT",
        });
      },
    }),
  );
  assert.equal(changed.status, 409);
  assert.equal((await body(changed)).code, "PARTICIPANT_AUTHORITY_CHANGED");
});

test("exact replay remains successful and reports the recorded activation", async () => {
  const active = {
    ...preview,
    status: "active" as const,
    activatedAt: "2026-11-12T09:00:00.000Z",
  };
  const replay = await handleParticipantActivatePost(
    post({ confirmationLocator, confirmed: true }),
    projectId,
    dependencies({
      activate: async () => ({
        activation: active,
        duplicate: true,
      }),
    }),
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(await body(replay), {
    ok: true,
    activation: active,
    duplicate: true,
  });
});
