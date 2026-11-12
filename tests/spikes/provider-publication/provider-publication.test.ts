import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  handleCommercialPreparePost,
  handleCommercialPublishPost,
  type CommercialDependencies,
  type CommercialPreparationInput,
  type CommercialPreparationPreview,
} from "../../../apps/web/app/api/provider/authoring/commercial-service.js";

const projectId = "project-one";
const requestId = "request-one";
const unitId = "unit-one";
const sourceLocator = "sl1_source_one";
const preparationLocator = `slcp1_${"A".repeat(43)}`;
const reviewLocators = {
  projectLocator: `slr1p_${"B".repeat(43)}`,
  requestLocator: `slr1r_${"C".repeat(43)}`,
  unitLocator: `slr1u_${"D".repeat(43)}`,
} as const;

function payableBody(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    draftRevision: 2,
    treatment: "payable",
    independenceExplanation:
      "The provider confirmed this is one independently decidable unit.",
    dependencies: [],
    clientVisibleRationale:
      "This exact work is outside the confirmed baseline.",
    delivery: {
      description: "Delivery occurs within five working days.",
      dependencies: ["The client supplies final approved copy."],
    },
    prerequisites: [{
      id: "approved-copy",
      version: 1,
      description: "Client supplies final approved copy.",
      blocks: "start",
    }],
    consentRequirement: "required",
    paymentExplanation: "Full prepayment is required before work starts.",
    tax: {
      treatment: "none",
      amount: "0.00",
      declaration: "The provider declares that no tax is added.",
    },
    price: {
      description: "Exact implementation unit.",
      amount: "300.00",
    },
    sourceCoverage: [{
      sourceLocator,
      locator: "Agreement section 4.2",
      materiality: "material",
      coverageStatus: "covered",
      analysisStatus: "human-reviewed",
      analysisReference: "Provider analysis run 7",
      explanation: "The provider reviewed this exact source and scope.",
    }],
    ...overrides,
  };
}

function preview(
  input: CommercialPreparationInput,
): CommercialPreparationPreview {
  return {
    preparationLocator,
    revision: 1,
    draftRevision: input.draftRevision,
    treatment: input.treatment,
    publicationReadiness: input.treatment === "unresolved"
      || input.sourceCoverage.some((source) =>
        source.materiality === "material"
        && source.coverageStatus === "unresolved")
      ? "blocked"
      : input.treatment === "included"
        ? "not-applicable"
        : "ready",
    publicationAllowed: (
      input.treatment === "payable"
      || input.treatment === "waived"
    ) && input.sourceCoverage.every((source) =>
      source.materiality !== "material"
      || source.coverageStatus === "covered"),
    preparedAt: "2026-11-12T08:00:00.000Z",
    draft: {
      title: "Exact implementation unit",
      summary: "Immutable review-ready draft.",
      scope: ["Implement the exact unit."],
      exclusions: ["No work outside this unit."],
      sources: input.sourceCoverage.map((source) => ({
        displayReference: "SRC-00000001 · v1",
        locator: source.locator,
        materiality: source.materiality,
        coverageStatus: source.coverageStatus,
        analysisStatus: source.analysisStatus,
        analysisReference: source.analysisReference,
        explanation: source.explanation,
      })),
    },
    terms: {
      independenceExplanation: input.independenceExplanation,
      dependencies: input.dependencies.map((dependency) => ({
        explanation: dependency.explanation,
      })),
      clientVisibleRationale: input.clientVisibleRationale,
      delivery: input.delivery,
      prerequisites: input.prerequisites,
      consentRequirement: input.consentRequirement,
      paymentExplanation: input.paymentExplanation,
      tax: input.tax,
      price: input.price
        ? {
          currency: "USD",
          paymentPolicy: "full-prepayment",
          description: input.price.description,
          amount: input.price.amount,
          gross: input.price.amount,
        }
        : null,
    },
  };
}

function dependencies(
  overrides: Partial<CommercialDependencies> = {},
): CommercialDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    authorize: async () => true,
    prepareCommercial: async (input) => preview(input),
    publishCommercial: async () => ({
      treatment: "payable",
      version: 1,
      publishedAt: "2026-11-12T08:01:00.000Z",
      review: {
        ...reviewLocators,
        url: `/review/${reviewLocators.projectLocator}/${reviewLocators.requestLocator}/${reviewLocators.unitLocator}`,
      },
    }),
    ...overrides,
  };
}

function post(path: string, payload: object): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    },
    body: JSON.stringify(payload),
  });
}

async function responseBody(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

test("payable preparation admits exact provider terms but no server-owned authority fields", async () => {
  const admitted: CommercialPreparationInput[] = [];
  const response = await handleCommercialPreparePost(
    post("/commercial/prepare", payableBody()),
    projectId,
    requestId,
    unitId,
    dependencies({
      prepareCommercial: async (input) => {
        admitted.push(input);
        return preview(input);
      },
    }),
  );

  assert.equal(response.status, 201);
  const received = admitted[0];
  assert.ok(received);
  assert.equal(received.projectId, projectId);
  assert.equal(received.price?.amount, "300.00");
  assert.equal(received.tax.treatment, "none");
  assert.equal(received.sourceCoverage[0]?.locator, "Agreement section 4.2");
  const serialized = JSON.stringify(await responseBody(response));
  assert.doesNotMatch(serialized, /workspaceId|merchantId|environment|actorId/);
  assert.doesNotMatch(serialized, /preparationId|preparationDigest|draftDigest/);
});

test("waived preparation carries no price while payable tax and price mismatches fail", async () => {
  const waived = payableBody({
    treatment: "waived",
    consentRequirement: "required",
    tax: {
      treatment: "not-applicable",
      amount: "0.00",
      declaration: "No tax applies because no amount is collectible.",
    },
    price: null,
    paymentExplanation: "No payment is required for this deliberate waiver.",
  });
  const accepted = await handleCommercialPreparePost(
    post("/commercial/prepare", waived),
    projectId,
    requestId,
    unitId,
    dependencies(),
  );
  assert.equal(accepted.status, 201);

  for (const invalid of [
    payableBody({ price: null }),
    payableBody({
      tax: {
        treatment: "not-applicable",
        amount: "0.00",
        declaration: "Invalid payable tax declaration.",
      },
    }),
    {
      ...waived,
      price: {
        description: "A waiver cannot carry price.",
        amount: "10.00",
      },
    },
  ]) {
    const response = await handleCommercialPreparePost(
      post("/commercial/prepare", invalid),
      projectId,
      requestId,
      unitId,
      dependencies(),
    );
    assert.equal(response.status, 422);
  }
});

test("material coverage can prepare a blocked preview but cannot imply publication", async () => {
  const response = await handleCommercialPreparePost(
    post("/commercial/prepare", payableBody({
      sourceCoverage: [{
        sourceLocator,
        locator: "Agreement section 4.2",
        materiality: "material",
        coverageStatus: "unresolved",
        analysisStatus: "unresolved",
        analysisReference: null,
        explanation: "Material coverage remains unresolved.",
      }],
    })),
    projectId,
    requestId,
    unitId,
    dependencies(),
  );
  assert.equal(response.status, 201);
  const body = await responseBody(response) as {
    preparation: CommercialPreparationPreview;
  };
  assert.equal(body.preparation.publicationReadiness, "blocked");
  assert.equal(body.preparation.publicationAllowed, false);

  const blocked = await handleCommercialPublishPost(
    post("/commercial/publish", {
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      draftRevision: 2,
      preparationLocator,
      confirmed: true,
    }),
    projectId,
    requestId,
    unitId,
    dependencies({
      publishCommercial: async () => {
        throw Object.assign(new Error("REVIEW_HOLD"), {
          code: "REVIEW_HOLD",
        });
      },
    }),
  );
  assert.equal(blocked.status, 409);
  assert.equal(
    (await responseBody(blocked)).code,
    "COMMERCIAL_PUBLICATION_BLOCKED",
  );
});

test("stale draft or preparation state fails closed with a refresh instruction", async () => {
  for (const operation of ["prepare", "publish"] as const) {
    const stale = Object.assign(new Error("STALE_CONTEXT"), {
      code: operation === "prepare" ? "STALE_CONTEXT" : "STALE_UNIT_VERSION",
    });
    const response = operation === "prepare"
      ? await handleCommercialPreparePost(
        post("/commercial/prepare", payableBody()),
        projectId,
        requestId,
        unitId,
        dependencies({
          prepareCommercial: async () => {
            throw stale;
          },
        }),
      )
      : await handleCommercialPublishPost(
        post("/commercial/publish", {
          idempotencyKey: "22222222-2222-4222-8222-222222222222",
          draftRevision: 2,
          preparationLocator,
          confirmed: true,
        }),
        projectId,
        requestId,
        unitId,
        dependencies({
          publishCommercial: async () => {
            throw stale;
          },
        }),
      );
    assert.equal(response.status, 409);
    const body = await responseBody(response);
    assert.equal(body.code, "COMMERCIAL_STATE_CHANGED");
    assert.match(String(body.message), /Refresh and prepare again/);
  }
});

test("exact replay converges while changed replay conflicts", async () => {
  const receipts = new Map<string, string>();
  const publicationReceipts = new Map<string, string>();
  const replayDependencies = dependencies({
    prepareCommercial: async (input) => {
      const payload = JSON.stringify(input);
      const previous = receipts.get(input.idempotencyKey);
      if (previous && previous !== payload) {
        throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), {
          code: "IDEMPOTENCY_CONFLICT",
        });
      }
      receipts.set(input.idempotencyKey, payload);
      return preview(input);
    },
    publishCommercial: async (input) => {
      const payload = JSON.stringify(input);
      const previous = publicationReceipts.get(input.idempotencyKey);
      if (previous && previous !== payload) {
        throw Object.assign(new Error("IDEMPOTENCY_CONFLICT"), {
          code: "IDEMPOTENCY_CONFLICT",
        });
      }
      publicationReceipts.set(input.idempotencyKey, payload);
      return {
        treatment: "payable",
        version: 1,
        publishedAt: "2026-11-12T08:01:00.000Z",
        review: {
          ...reviewLocators,
          url: `/review/${reviewLocators.projectLocator}/${reviewLocators.requestLocator}/${reviewLocators.unitLocator}`,
        },
      };
    },
  });
  const first = await handleCommercialPreparePost(
    post("/commercial/prepare", payableBody()),
    projectId,
    requestId,
    unitId,
    replayDependencies,
  );
  const replay = await handleCommercialPreparePost(
    post("/commercial/prepare", payableBody()),
    projectId,
    requestId,
    unitId,
    replayDependencies,
  );
  assert.deepEqual(await responseBody(replay), await responseBody(first));

  const changed = await handleCommercialPreparePost(
    post("/commercial/prepare", payableBody({
      clientVisibleRationale: "Changed content reusing one operation identity.",
    })),
    projectId,
    requestId,
    unitId,
    replayDependencies,
  );
  assert.equal(changed.status, 409);
  assert.equal(
    (await responseBody(changed)).code,
    "COMMERCIAL_REPLAY_CONFLICT",
  );

  const publicationBody = {
    idempotencyKey: "22222222-2222-4222-8222-222222222222",
    draftRevision: 2,
    preparationLocator,
    confirmed: true,
  };
  const firstPublication = await handleCommercialPublishPost(
    post("/commercial/publish", publicationBody),
    projectId,
    requestId,
    unitId,
    replayDependencies,
  );
  const publicationReplay = await handleCommercialPublishPost(
    post("/commercial/publish", publicationBody),
    projectId,
    requestId,
    unitId,
    replayDependencies,
  );
  assert.deepEqual(
    await responseBody(publicationReplay),
    await responseBody(firstPublication),
  );
  const changedPublication = await handleCommercialPublishPost(
    post("/commercial/publish", {
      ...publicationBody,
      preparationLocator: `slcp1_${"Z".repeat(43)}`,
    }),
    projectId,
    requestId,
    unitId,
    replayDependencies,
  );
  assert.equal(changedPublication.status, 409);
  assert.equal(
    (await responseBody(changedPublication)).code,
    "COMMERCIAL_REPLAY_CONFLICT",
  );
});

test("publication returns only safe review locators and creates no payment-shaped response", async () => {
  const response = await handleCommercialPublishPost(
    post("/commercial/publish", {
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      draftRevision: 2,
      preparationLocator,
      confirmed: true,
    }),
    projectId,
    requestId,
    unitId,
    dependencies(),
  );
  assert.equal(response.status, 201);
  const serialized = JSON.stringify(await responseBody(response));
  assert.match(serialized, /slr1p_/);
  assert.match(serialized, /slr1r_/);
  assert.match(serialized, /slr1u_/);
  assert.doesNotMatch(serialized, /project-one|request-one|unit-one/);
  assert.doesNotMatch(serialized, /digest|obligation|attempt|order|paymentId/);
});

test("commercial UI separates accessible preview from explicit confirmation", async () => {
  const [workspace, commercial, page] = await Promise.all([
    readFile(
      "apps/web/app/provider/authoring/authoring-workspace.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/authoring/commercial-workbench.tsx",
      "utf8",
    ),
    readFile("apps/web/app/provider/authoring/page.tsx", "utf8"),
  ]);
  assert.match(workspace, /htmlFor="review-ready"/);
  assert.match(commercial, /aria-labelledby="prepared-preview-title"/);
  assert.match(commercial, /htmlFor="publication-confirmation"/);
  assert.match(commercial, /Prepare commercial preview/);
  assert.match(commercial, /Publish exact prepared terms/);
  assert.match(commercial, /No client offer/);
  assert.match(commercial, /Publication blocked/);
  assert.match(commercial, /No decision or payment was/);
  assert.match(page, /Prepare, preview, then publish/);
});
