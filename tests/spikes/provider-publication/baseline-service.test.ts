import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  handleBaselineConfirmPost,
  handleBaselinePreviewPost,
  type BaselineDependencies,
  type BaselinePreview,
} from "../../../apps/web/app/api/provider/authoring/baseline-service.js";
import {
  handleCommercialPreparePost,
  type CommercialDependencies,
} from "../../../apps/web/app/api/provider/authoring/commercial-service.js";

const projectId = "project-one";
const requestId = "request-one";
const sourceLocator = "sl1_source_one";
const previewLocator = `slbp1_${"A".repeat(43)}`;

function preview(): BaselinePreview {
  return {
    previewLocator,
    sourceLocator,
    displayReference: "SRC-00000001 · v1",
    originalName: "agreement.pdf",
    mediaType: "application/pdf",
    provenanceOrigin: "agreement",
    originReference: "Agreement section 1",
    acceptance: {
      kind: "provider-attested-import",
      basis: "The authenticated provider attested this permitted import.",
    },
    studioSharing: "permitted",
    confirmationAllowed: true,
    alreadyConfirmed: false,
    confirmedAt: null,
  };
}

function dependencies(
  overrides: Partial<BaselineDependencies> = {},
): BaselineDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    authorize: async () => "authorized",
    previewBaseline: async () => preview(),
    confirmBaseline: async () => ({
      displayReference: "SRC-00000001 · v1",
      baselineVersion: 1,
      confirmedAt: "2026-11-12T08:10:00.000Z",
      duplicate: false,
    }),
    ...overrides,
  };
}

function post(payload: object): Request {
  return new Request("http://127.0.0.1:3000/api/provider/authoring", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    },
    body: JSON.stringify(payload),
  });
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("baseline preview reads server-owned attestation truth from one admitted source", async () => {
  let admitted: unknown = null;
  const response = await handleBaselinePreviewPost(
    post({ sourceLocator }),
    projectId,
    requestId,
    dependencies({
      previewBaseline: async (input) => {
        admitted = input;
        return preview();
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(admitted, { projectId, requestId, sourceLocator });
  const serialized = JSON.stringify(await body(response));
  assert.match(serialized, /provider-attested-import/);
  assert.doesNotMatch(serialized, /sourceId|recordDigest|confirmedBy|actorId/);
});

test("baseline confirmation requires exact preview and rejects browser authority fields", async () => {
  const rejected = await handleBaselineConfirmPost(
    post({
      sourceLocator,
      previewLocator,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      confirmed: true,
      confirmedBy: "browser-provider",
      baselineId: "browser-baseline",
      confirmedAt: "2026-11-12T08:10:00.000Z",
      precedence: "browser-selected",
    }),
    projectId,
    requestId,
    dependencies(),
  );
  assert.equal(rejected.status, 422);

  let admitted: unknown = null;
  const accepted = await handleBaselineConfirmPost(
    post({
      sourceLocator,
      previewLocator,
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      confirmed: true,
    }),
    projectId,
    requestId,
    dependencies({
      confirmBaseline: async (input) => {
        admitted = input;
        return {
          displayReference: "SRC-00000001 · v1",
          baselineVersion: 1,
          confirmedAt: "2026-11-12T08:10:00.000Z",
          duplicate: false,
        };
      },
    }),
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(admitted, {
    projectId,
    requestId,
    sourceLocator,
    previewLocator,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
  });
});

test("stale or cross-project source preview fails closed", async () => {
  for (const [code, expected] of [
    ["STALE_CONTEXT", "BASELINE_SOURCE_STALE"],
    ["NOT_FOUND", "BASELINE_SOURCE_NOT_FOUND"],
  ] as const) {
    const response = await handleBaselinePreviewPost(
      post({ sourceLocator }),
      projectId,
      requestId,
      dependencies({
        previewBaseline: async () => {
          throw Object.assign(new Error(code), { code });
        },
      }),
    );
    assert.equal(response.status, code === "NOT_FOUND" ? 404 : 409);
    assert.equal((await body(response)).code, expected);
  }
});

test("baseline exact replay converges while changed replay conflicts", async () => {
  const receipts = new Map<string, string>();
  const replayDependencies = dependencies({
    confirmBaseline: async (input) => {
      const payload = JSON.stringify(input);
      const previous = receipts.get(input.idempotencyKey);
      if (previous && previous !== payload) {
        throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), {
          code: "IDEMPOTENCY_CONFLICT",
        });
      }
      receipts.set(input.idempotencyKey, payload);
      return {
        displayReference: "SRC-00000001 · v1",
        baselineVersion: 1,
        confirmedAt: "2026-11-12T08:10:00.000Z",
        duplicate: previous !== undefined,
      };
    },
  });
  const payload = {
    sourceLocator,
    previewLocator,
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    confirmed: true,
  };
  const first = await handleBaselineConfirmPost(
    post(payload),
    projectId,
    requestId,
    replayDependencies,
  );
  const replay = await handleBaselineConfirmPost(
    post(payload),
    projectId,
    requestId,
    replayDependencies,
  );
  assert.equal(first.status, 201);
  assert.equal(replay.status, 201);

  const changed = await handleBaselineConfirmPost(
    post({
      ...payload,
      previewLocator: `slbp1_${"Z".repeat(43)}`,
    }),
    projectId,
    requestId,
    replayDependencies,
  );
  assert.equal(changed.status, 409);
  assert.equal((await body(changed)).code, "BASELINE_REPLAY_CONFLICT");
});

test("commercial preparation reports the missing confirmed baseline precisely", async () => {
  const commercial: CommercialDependencies = {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    authorize: async () => true,
    prepareCommercial: async () => {
      throw Object.assign(new Error("BASELINE_REQUIRED"), {
        code: "BASELINE_REQUIRED",
      });
    },
    publishCommercial: async () => {
      throw new Error("not used");
    },
  };
  const response = await handleCommercialPreparePost(
    post({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      draftRevision: 1,
      treatment: "payable",
      independenceExplanation: "Independent exact unit.",
      dependencies: [],
      clientVisibleRationale: "Outside the confirmed baseline.",
      delivery: { description: "Five working days.", dependencies: [] },
      prerequisites: [],
      consentRequirement: "required",
      paymentExplanation: "Full prepayment before work.",
      tax: {
        treatment: "none",
        amount: "0.00",
        declaration: "No tax is added.",
      },
      price: { description: "Exact unit.", amount: "300.00" },
      sourceCoverage: [{
        sourceLocator,
        locator: "Agreement section 1",
        materiality: "material",
        coverageStatus: "covered",
        analysisStatus: "human-reviewed",
        analysisReference: null,
        explanation: "Provider reviewed exact source.",
      }],
    }),
    projectId,
    requestId,
    "unit-one",
    commercial,
  );
  assert.equal(response.status, 409);
  assert.equal((await body(response)).code, "COMMERCIAL_BASELINE_REQUIRED");
});

test("baseline UI separates preview from accessible explicit confirmation", async () => {
  const [panel, workspace] = await Promise.all([
    readFile(
      "apps/web/app/provider/authoring/baseline-confirmation.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/authoring/authoring-workspace.tsx",
      "utf8",
    ),
  ]);
  assert.match(panel, /Preview baseline confirmation/);
  assert.match(panel, /aria-labelledby="baseline-preview-title"/);
  assert.match(panel, /htmlFor="baseline-confirmation"/);
  assert.match(panel, /Confirm exact baseline/);
  assert.match(panel, /Uploading alone never confirms a baseline/);
  assert.match(workspace, /BaselineConfirmationPanel/);
});
