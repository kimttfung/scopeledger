import assert from "node:assert/strict";
import test from "node:test";
import {
  handleWorkStartGet,
  handleWorkStartPost,
  type WorkStartDependencies,
} from "../../../apps/web/app/api/provider/operations/work-start/service.js";

const snapshot = {
  unitId: "unit-u1",
  acceptedVersion: 2,
  readiness: "ready",
  activeHoldCount: 0,
  workStart: null,
} as const;

function request(body: object): Request {
  return new Request(
    "http://127.0.0.1:3000/api/provider/operations/work-start",
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
  overrides: Partial<WorkStartDependencies> = {},
): WorkStartDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    readSnapshot: async () => snapshot,
    recordWorkStart: async () => ({
      unitId: "unit-u1",
      version: 2,
      startedAt: "2026-11-12T06:00:00.000Z",
    }),
    createCommandId: () => "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

test("protected status does not read operational state without provider authentication", async () => {
  let stateRead = false;
  const response = await handleWorkStartGet(dependencies({
    verifyProvider: async () => ({
      ok: false,
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    }),
    readSnapshot: async () => {
      stateRead = true;
      return snapshot;
    },
  }));

  assert.equal(response.status, 401);
  assert.equal(stateRead, false);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "AUTHENTICATION_REQUIRED",
    message: "Sign in before accessing provider operations.",
  });
});

test("protected status returns distinct readiness and work-start facts", async () => {
  const response = await handleWorkStartGet(dependencies());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await body(response), {
    ok: true,
    snapshot,
  });
});

test("cross-origin recording is rejected before authentication or domain access", async () => {
  let providerRead = false;
  let recorded = false;
  const response = await handleWorkStartPost(request({}), dependencies({
    requireSameOrigin: () => {
      throw new Error("SAME_ORIGIN_REQUIRED");
    },
    verifyProvider: async () => {
      providerRead = true;
      return { ok: true };
    },
    recordWorkStart: async () => {
      recorded = true;
      throw new Error("must not run");
    },
  }));

  assert.equal(response.status, 403);
  assert.equal(providerRead, false);
  assert.equal(recorded, false);
});

test("verified email without MFA cannot reach the domain command", async () => {
  let recorded = false;
  const response = await handleWorkStartPost(request({}), dependencies({
    verifyProvider: async () => ({
      ok: false,
      status: 403,
      code: "PROVIDER_ASSURANCE_REQUIRED",
    }),
    recordWorkStart: async () => {
      recorded = true;
      throw new Error("must not run");
    },
  }));

  assert.equal(response.status, 403);
  assert.equal(recorded, false);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "PROVIDER_ASSURANCE_REQUIRED",
    message: "Verified email and MFA assurance are required.",
  });
});

test("the browser cannot supply readiness, version, actor, or timestamp authority", async () => {
  let recorded = false;
  const response = await handleWorkStartPost(request({
    readiness: "ready",
    version: 99,
    actorId: "browser-provider",
    startedAt: "2020-01-01T00:00:00.000Z",
  }), dependencies({
    recordWorkStart: async () => {
      recorded = true;
      throw new Error("must not run");
    },
  }));

  assert.equal(response.status, 422);
  assert.equal(recorded, false);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "INVALID_WORK_START_REQUEST",
    message: "The browser cannot supply work-start authority or state.",
  });
});

test("recording passes only a server-generated command identity to the route closure", async () => {
  const admitted: Array<Readonly<{ commandId: string }>> = [];
  let stateRead = false;
  const response = await handleWorkStartPost(request({}), dependencies({
    readSnapshot: async () => {
      stateRead = true;
      return snapshot;
    },
    recordWorkStart: async (command) => {
      admitted.push(command);
      return {
        unitId: "unit-u1",
        version: 2,
        startedAt: "2026-11-12T06:00:00.000Z",
      };
    },
  }));

  assert.equal(response.status, 200);
  assert.equal(stateRead, false);
  assert.deepEqual(admitted, [{
    commandId: "11111111-1111-4111-8111-111111111111",
  }]);
  assert.deepEqual(await body(response), {
    ok: true,
    recorded: true,
    workStart: {
      unitId: "unit-u1",
      version: 2,
      startedAt: "2026-11-12T06:00:00.000Z",
    },
  });
});

test("server-side readiness changes fail closed without leaking protocol detail", async () => {
  const error = Object.assign(new Error("private reconciliation detail"), {
    code: "RECONCILIATION_REQUIRED",
  });
  const response = await handleWorkStartPost(request({}), dependencies({
    recordWorkStart: async () => {
      throw error;
    },
  }));

  assert.equal(response.status, 409);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "WORK_START_NOT_READY",
    message: "Work start cannot be recorded until the server reports ready with no active hold.",
  });
});

test("identity assurance does not replace the synthetic provider product grant", async () => {
  const error = Object.assign(new Error("private grant detail"), {
    code: "ACCESS_DENIED",
  });
  const response = await handleWorkStartPost(request({}), dependencies({
    recordWorkStart: async () => {
      throw error;
    },
  }));

  assert.equal(response.status, 403);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "PROVIDER_GRANT_REQUIRED",
    message: "The protected demo provider grant is not active.",
  });
});
