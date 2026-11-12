import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  createIsolatedProofDatabase,
  PostgresAuthoringStore,
  readCommercialPreparation,
  sql,
} from "@scopeledger/db";
import type {
  CommercialPreparationCommand,
} from "@scopeledger/domain";
import { OrderedConsentStore } from "@scopeledger/domain";
import { ProtocolError } from "@scopeledger/contracts";
import type { Actor } from "@scopeledger/contracts";

function requiredDatabaseUrl(): string {
  const url = process.env.IP01_DATABASE_URL;
  assert.ok(
    url,
    "IP01_DATABASE_URL is required: publication tests use isolated real PostgreSQL",
  );
  return url;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seed(
  t: TestContext,
  options: {
    studioSharing?: "permitted" | "denied" | "unresolved";
    modelProcessing?: "permitted" | "denied" | "unresolved";
    modelReview?: "cleared" | "not-reviewed" | "unresolved";
    confirmBaseline?: boolean;
  } = {},
) {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = `publication-workspace-${suffix}`;
  const projectId = `publication-project-${suffix}`;
  const requestId = `request-${suffix}`;
  const unitId = `unit-${suffix}`;
  const sourceId = `source-${suffix}`;
  const providerId = `provider-${suffix}`;
  const approverId = `approver-${suffix}`;
  const actor: Actor = {
    workspaceId,
    projectId,
    actorId: providerId,
    grantEpoch: 1,
  };
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${workspaceId},${`merchant-${suffix}`} ,'sandbox')`
    .execute(isolated.database.kysely);
  const authoring = new PostgresAuthoringStore(isolated.database);
  await authoring.createProject({
    workspaceId,
    projectId,
    displayName: "Publication foundation",
    clientId: `client-${suffix}`,
    initialApproverId: approverId,
    createdBy: providerId,
  });
  await sql`insert into grants(
      workspace_id,project_id,actor_id,action
    ) values (${workspaceId},${projectId},${providerId},'publish')`
    .execute(isolated.database.kysely);
  await authoring.createRequest({
    workspaceId,
    projectId,
    requestId,
    title: "Exact commercial review",
    createdBy: providerId,
  });
  const modelProcessing = options.modelProcessing ?? "denied";
  const modelReview = options.modelReview ?? "not-reviewed";
  await authoring.recordSourceIntake({
    workspaceId,
    projectId,
    sourceId,
    version: 1,
    availability: "available",
    reviewedBy: providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "synthetic-scope.pdf",
    declaredByteLength: 20,
    contentDigest: sha256("synthetic-publication-source"),
    provenance: {
      origin: "agreement",
      suppliedBy: providerId,
      originReference: "Synthetic agreement section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Authenticated provider attested this synthetic source.",
      },
    },
    permissions: {
      studioSharing: options.studioSharing ?? "permitted",
      modelProcessing,
      modelInputReview: modelReview === "cleared"
        ? {
          status: "cleared",
          reviewerId: providerId,
          reviewedAt: new Date("2026-11-12T08:00:00.000Z"),
          basis: "Authenticated provider reviewed exact model input.",
        }
        : {
          status: modelReview,
          basis: "No model authority is used for commercial terms.",
        },
    },
  });
  const consent = new OrderedConsentStore(isolated.database);
  if (options.confirmBaseline !== false) {
    await consent.confirmProviderBaseline(actor, {
      commandId: randomUUID(),
      requestId,
      sourceId,
      sourceVersion: 1,
    });
  }
  await authoring.saveDraft({
    workspaceId,
    projectId,
    requestId,
    unitId,
    revision: 1,
    expectedPreviousRevision: null,
    state: "ready-for-client-review",
    title: "Synthetic implementation unit",
    summary: "Exact immutable draft prepared for commercial review.",
    scope: ["Implement the exact synthetic unit."],
    exclusions: ["No work outside the listed source basis."],
    sourceReferences: [{ sourceId, version: 1 }],
    authoredBy: providerId,
  });
  return {
    ...isolated,
    actor,
    authoring,
    store: consent,
    workspaceId,
    projectId,
    requestId,
    unitId,
    sourceId,
    providerId,
  };
}

function preparation(
  fixture: Awaited<ReturnType<typeof seed>>,
  treatment: "included" | "waived" | "payable" | "unresolved",
  overrides: Partial<CommercialPreparationCommand> = {},
): CommercialPreparationCommand {
  const payable = treatment === "payable";
  return {
    commandId: randomUUID(),
    preparationId: randomUUID(),
    requestId: fixture.requestId,
    unitId: fixture.unitId,
    draftRevision: 1,
    treatment,
    independenceExplanation:
      "The provider independently reviewed whether this is a separate unit.",
    dependencies: [],
    clientVisibleRationale:
      "This rationale is visible to the client and was chosen by the provider.",
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
    consentRequirement: payable || treatment === "waived"
      ? "required"
      : "not-applicable",
    paymentExplanation: payable
      ? "Full prepayment is required before work starts."
      : "No payment is required for this treatment.",
    tax: {
      treatment: payable
        ? "none"
        : treatment === "unresolved"
          ? "unresolved"
          : "not-applicable",
      amount: "0.00",
      declaration: payable
        ? "Provider declares that no tax is added to this synthetic price."
        : "Tax is not applicable because no amount is collectible.",
    },
    price: payable
      ? {
        currency: "USD",
        paymentPolicy: "full-prepayment",
        lines: [{
          id: "implementation",
          description: "One exact synthetic implementation unit.",
          quantity: "1",
          unitPrice: "300.00",
          amount: "300.00",
        }],
        subtotal: "300.00",
        gross: "300.00",
      }
      : null,
    sourceCoverage: [{
      sourceId: fixture.sourceId,
      version: 1,
      locator: "Synthetic agreement section 1",
      materiality: "material",
      coverageStatus: "covered",
      analysisStatus: "not-used",
      analysisReference: null,
      explanation: "The authenticated provider reviewed this exact source.",
    }],
    ...overrides,
  };
}

function rejectsCode(work: Promise<unknown>, code: ProtocolError["code"]) {
  return assert.rejects(
    work,
    (error: unknown) => error instanceof ProtocolError && error.code === code,
  );
}

test("provider-created publication blocks without an explicit baseline then succeeds after confirmation", async (t) => {
  const fixture = await seed(t, { confirmBaseline: false });
  const input = preparation(fixture, "payable");
  await rejectsCode(
    fixture.store.prepareCommercial(fixture.actor, input),
    "INVALID_INPUT",
  );
  const confirmed = await fixture.store.confirmProviderBaseline(
    fixture.actor,
    {
      commandId: randomUUID(),
      requestId: fixture.requestId,
      sourceId: fixture.sourceId,
      sourceVersion: 1,
    },
  );
  assert.equal(confirmed.sourceId, fixture.sourceId);
  assert.equal(confirmed.sourceVersion, 1);
  const prepared = await fixture.store.prepareCommercial(
    fixture.actor,
    input,
  );
  assert.equal(prepared.publicationReadiness, "ready");
  const published = await fixture.store.publishPrepared(fixture.actor, {
    commandId: randomUUID(),
    preparationId: input.preparationId,
  });
  assert.equal(published.version, 1);
  const effects = (await sql<{
    decisions: number;
    obligations: number;
    attempts: number;
    facts: number;
  }>`select
      (select count(*)::integer from decisions) as decisions,
      (select count(*)::integer from obligations) as obligations,
      (select count(*)::integer from attempts) as attempts,
      (select count(*)::integer from payment_facts) as facts`
    .execute(fixture.database.kysely)).rows[0]!;
  assert.deepEqual(effects, {
    decisions: 0,
    obligations: 0,
    attempts: 0,
    facts: 0,
  });
});

test("baseline confirmation rejects stale and cross-project sources", async (t) => {
  const stale = await seed(t, { confirmBaseline: false });
  await stale.authoring.recordSourceIntake({
    workspaceId: stale.workspaceId,
    projectId: stale.projectId,
    sourceId: stale.sourceId,
    version: 2,
    availability: "available",
    reviewedBy: stale.providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "synthetic-scope-v2.pdf",
    declaredByteLength: 21,
    contentDigest: sha256("synthetic-publication-source-v2"),
    provenance: {
      origin: "amendment",
      suppliedBy: stale.providerId,
      originReference: "Synthetic amendment section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Authenticated provider attested the revised source.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model processing is used.",
      },
    },
  });
  await rejectsCode(stale.store.confirmProviderBaseline(stale.actor, {
    commandId: randomUUID(),
    requestId: stale.requestId,
    sourceId: stale.sourceId,
    sourceVersion: 1,
  }), "STALE_CONTEXT");

  const otherProjectId = `${stale.projectId}-other`;
  const otherRequestId = `${stale.requestId}-other`;
  const otherSourceId = `${stale.sourceId}-other`;
  await stale.authoring.createProject({
    workspaceId: stale.workspaceId,
    projectId: otherProjectId,
    displayName: "Other project",
    clientId: "other-client",
    initialApproverId: "other-approver",
    createdBy: stale.providerId,
  });
  await stale.authoring.createRequest({
    workspaceId: stale.workspaceId,
    projectId: otherProjectId,
    requestId: otherRequestId,
    title: "Other request",
    createdBy: stale.providerId,
  });
  await stale.authoring.recordSourceIntake({
    workspaceId: stale.workspaceId,
    projectId: otherProjectId,
    sourceId: otherSourceId,
    version: 1,
    availability: "available",
    reviewedBy: stale.providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "other-project.pdf",
    declaredByteLength: 18,
    contentDigest: sha256("other-project-source"),
    provenance: {
      origin: "agreement",
      suppliedBy: stale.providerId,
      originReference: "Other project agreement",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Provider attested this other project source.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model processing is used.",
      },
    },
  });
  await rejectsCode(stale.store.confirmProviderBaseline(stale.actor, {
    commandId: randomUUID(),
    requestId: stale.requestId,
    sourceId: otherSourceId,
    sourceVersion: 1,
  }), "NOT_FOUND");
});

test("baseline confirmation replay converges and changed replay conflicts", async (t) => {
  const fixture = await seed(t, { confirmBaseline: false });
  const command = {
    commandId: randomUUID(),
    requestId: fixture.requestId,
    sourceId: fixture.sourceId,
    sourceVersion: 1,
  };
  const first = await fixture.store.confirmProviderBaseline(
    fixture.actor,
    command,
  );
  assert.deepEqual(
    await fixture.store.confirmProviderBaseline(fixture.actor, command),
    first,
  );
  await rejectsCode(fixture.store.confirmProviderBaseline(fixture.actor, {
    ...command,
    sourceVersion: 2,
  }), "IDEMPOTENCY_CONFLICT");
  const duplicate = await fixture.store.confirmProviderBaseline(
    fixture.actor,
    { ...command, commandId: randomUUID() },
  );
  assert.equal(duplicate.baselineId, first.baselineId);
  assert.equal(duplicate.baselineVersion, first.baselineVersion);
});

test("each treatment has bounded publication and collection semantics", async (t) => {
  for (const treatment of [
    "included",
    "unresolved",
    "waived",
    "payable",
  ] as const) {
    const fixture = await seed(t);
    const input = preparation(fixture, treatment);
    const prepared = await fixture.store.prepareCommercial(
      fixture.actor,
      input,
    );
    assert.equal(
      prepared.publicationReadiness,
      treatment === "included"
        ? "not-applicable"
        : treatment === "unresolved"
          ? "blocked"
          : "ready",
    );
    const stored = await readCommercialPreparation(fixture.database.kysely, {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      preparationId: input.preparationId,
    });
    assert.ok(stored);
    assert.equal(stored.merchantId.startsWith("merchant-"), true);
    assert.equal(stored.environment, "sandbox");
    if (treatment === "included" || treatment === "unresolved") {
      await rejectsCode(fixture.store.publishPrepared(fixture.actor, {
        commandId: randomUUID(),
        preparationId: input.preparationId,
      }), "REVIEW_HOLD");
    } else {
      const published = await fixture.store.publishPrepared(fixture.actor, {
        commandId: randomUUID(),
        preparationId: input.preparationId,
      });
      const snapshot = (await sql<{ snapshot: {
        treatment: string;
        payment: { policy: string };
      } }>`select snapshot from unit_versions
        where workspace_id = ${fixture.workspaceId}
          and project_id = ${fixture.projectId}
          and unit_id = ${fixture.unitId}
          and version = ${published.version}`.execute(fixture.database.kysely))
        .rows[0]!.snapshot;
      assert.equal(
        snapshot.treatment,
        treatment === "waived" ? "additional-waived" : "payable",
      );
      assert.equal(
        snapshot.payment.policy,
        treatment === "waived" ? "not-required" : "full-prepayment",
      );
    }
    const effects = (await sql<{
      decisions: number;
      obligations: number;
      attempts: number;
      operations: number;
      facts: number;
    }>`select
        (select count(*)::integer from decisions) as decisions,
        (select count(*)::integer from obligations) as obligations,
        (select count(*)::integer from attempts) as attempts,
        (select count(*)::integer from operations) as operations,
        (select count(*)::integer from payment_facts) as facts`
      .execute(fixture.database.kysely)).rows[0]!;
    assert.deepEqual(effects, {
      decisions: 0,
      obligations: 0,
      attempts: 0,
      operations: 0,
      facts: 0,
    });
  }
});

test("payable preparations enforce exact USD, tax, and treatment bounds", async (t) => {
  const fixture = await seed(t);
  const mismatch = preparation(fixture, "payable", {
    price: {
      currency: "USD",
      paymentPolicy: "full-prepayment",
      lines: [{
        id: "bad-line",
        description: "Mismatched arithmetic.",
        quantity: "2",
        unitPrice: "100.00",
        amount: "199.99",
      }],
      subtotal: "199.99",
      gross: "199.99",
    },
  });
  await rejectsCode(
    fixture.store.prepareCommercial(fixture.actor, mismatch),
    "INVALID_INPUT",
  );

  const excessive = preparation(fixture, "payable", {
    commandId: randomUUID(),
    preparationId: randomUUID(),
    price: {
      currency: "USD",
      paymentPolicy: "full-prepayment",
      lines: [{
        id: "too-large",
        description: "Amount exceeds the protocol money bound.",
        quantity: "1",
        unitPrice: "10000000000.00",
        amount: "10000000000.00",
      }],
      subtotal: "10000000000.00",
      gross: "10000000000.00",
    },
  });
  await rejectsCode(
    fixture.store.prepareCommercial(fixture.actor, excessive),
    "INVALID_INPUT",
  );

  const badTax = preparation(fixture, "payable", {
    commandId: randomUUID(),
    preparationId: randomUUID(),
    tax: {
      treatment: "exclusive",
      amount: "30.00",
      declaration: "Provider declares exact synthetic exclusive tax.",
    },
  });
  await rejectsCode(
    fixture.store.prepareCommercial(fixture.actor, badTax),
    "INVALID_INPUT",
  );

  const waivedWithPrice = preparation(fixture, "waived", {
    commandId: randomUUID(),
    preparationId: randomUUID(),
    price: preparation(fixture, "payable").price,
  });
  await rejectsCode(
    fixture.store.prepareCommercial(fixture.actor, waivedWithPrice),
    "INVALID_INPUT",
  );
});

test("material coverage and source permissions block publication", async (t) => {
  const unresolvedCoverage = await seed(t);
  const coverageInput = preparation(unresolvedCoverage, "waived", {
    sourceCoverage: [{
      sourceId: unresolvedCoverage.sourceId,
      version: 1,
      locator: "Synthetic agreement section 1",
      materiality: "material",
      coverageStatus: "unresolved",
      analysisStatus: "unresolved",
      analysisReference: null,
      explanation: "Material coverage is unresolved.",
    }],
  });
  assert.equal((await unresolvedCoverage.store.prepareCommercial(
    unresolvedCoverage.actor,
    coverageInput,
  )).publicationReadiness, "blocked");
  await rejectsCode(unresolvedCoverage.store.publishPrepared(
    unresolvedCoverage.actor,
    {
      commandId: randomUUID(),
      preparationId: coverageInput.preparationId,
    },
  ), "REVIEW_HOLD");

  const unresolvedPermission = await seed(t, {
    studioSharing: "unresolved",
    confirmBaseline: false,
  });
  const baselineSourceId = `${unresolvedPermission.sourceId}-baseline`;
  await unresolvedPermission.authoring.recordSourceIntake({
    workspaceId: unresolvedPermission.workspaceId,
    projectId: unresolvedPermission.projectId,
    sourceId: baselineSourceId,
    version: 1,
    availability: "available",
    reviewedBy: unresolvedPermission.providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "confirmed-baseline.pdf",
    declaredByteLength: 18,
    contentDigest: sha256("confirmed-baseline-source"),
    provenance: {
      origin: "agreement",
      suppliedBy: unresolvedPermission.providerId,
      originReference: "Confirmed baseline section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Provider attested this separate baseline source.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model processing is used.",
      },
    },
  });
  await unresolvedPermission.store.confirmProviderBaseline(
    unresolvedPermission.actor,
    {
      commandId: randomUUID(),
      requestId: unresolvedPermission.requestId,
      sourceId: baselineSourceId,
      sourceVersion: 1,
    },
  );
  const permissionInput = preparation(unresolvedPermission, "payable");
  assert.equal((await unresolvedPermission.store.prepareCommercial(
    unresolvedPermission.actor,
    permissionInput,
  )).publicationReadiness, "blocked");
  await rejectsCode(unresolvedPermission.store.publishPrepared(
    unresolvedPermission.actor,
    {
      commandId: randomUUID(),
      preparationId: permissionInput.preparationId,
    },
  ), "REVIEW_HOLD");
});

test("new draft or source versions make an unpublished preparation stale", async (t) => {
  const draftFixture = await seed(t);
  const draftInput = preparation(draftFixture, "waived");
  await draftFixture.store.prepareCommercial(draftFixture.actor, draftInput);
  await draftFixture.authoring.saveDraft({
    workspaceId: draftFixture.workspaceId,
    projectId: draftFixture.projectId,
    requestId: draftFixture.requestId,
    unitId: draftFixture.unitId,
    revision: 2,
    expectedPreviousRevision: 1,
    state: "ready-for-client-review",
    title: "Revised synthetic implementation unit",
    summary: "A new immutable draft requires a new commercial preparation.",
    scope: ["Implement the revised exact synthetic unit."],
    exclusions: [],
    sourceReferences: [{ sourceId: draftFixture.sourceId, version: 1 }],
    authoredBy: draftFixture.providerId,
  });
  await rejectsCode(draftFixture.store.publishPrepared(draftFixture.actor, {
    commandId: randomUUID(),
    preparationId: draftInput.preparationId,
  }), "STALE_CONTEXT");

  const sourceFixture = await seed(t);
  const sourceInput = preparation(sourceFixture, "payable");
  await sourceFixture.store.prepareCommercial(sourceFixture.actor, sourceInput);
  await sourceFixture.authoring.recordSourceIntake({
    workspaceId: sourceFixture.workspaceId,
    projectId: sourceFixture.projectId,
    sourceId: sourceFixture.sourceId,
    version: 2,
    availability: "available",
    reviewedBy: sourceFixture.providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "synthetic-scope-v2.pdf",
    declaredByteLength: 21,
    contentDigest: sha256("synthetic-publication-source-v2"),
    provenance: {
      origin: "amendment",
      suppliedBy: sourceFixture.providerId,
      originReference: "Synthetic amendment section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Authenticated provider attested the revised source.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model processing is used.",
      },
    },
  });
  await rejectsCode(sourceFixture.store.publishPrepared(sourceFixture.actor, {
    commandId: randomUUID(),
    preparationId: sourceInput.preparationId,
  }), "STALE_CONTEXT");
});

test("changed draft and source state requires a new preparation and publication version", async (t) => {
  const fixture = await seed(t);
  const firstInput = preparation(fixture, "payable");
  await fixture.store.prepareCommercial(fixture.actor, firstInput);
  const firstPublication = await fixture.store.publishPrepared(fixture.actor, {
    commandId: randomUUID(),
    preparationId: firstInput.preparationId,
  });
  assert.equal(firstPublication.version, 1);

  await fixture.authoring.recordSourceIntake({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    sourceId: fixture.sourceId,
    version: 2,
    availability: "available",
    reviewedBy: fixture.providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "synthetic-scope-v2.pdf",
    declaredByteLength: 21,
    contentDigest: sha256("synthetic-publication-source-v2"),
    provenance: {
      origin: "amendment",
      suppliedBy: fixture.providerId,
      originReference: "Synthetic amendment section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Authenticated provider attested the revised source.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model processing is used.",
      },
    },
  });
  await fixture.authoring.saveDraft({
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    requestId: fixture.requestId,
    unitId: fixture.unitId,
    revision: 2,
    expectedPreviousRevision: 1,
    state: "ready-for-client-review",
    title: "Revised synthetic implementation unit",
    summary: "The revised source is bound to a new immutable draft.",
    scope: ["Implement the revised exact synthetic unit."],
    exclusions: ["The prior source version is historical only."],
    sourceReferences: [{ sourceId: fixture.sourceId, version: 2 }],
    authoredBy: fixture.providerId,
  });
  const secondInput = preparation(fixture, "payable", {
    commandId: randomUUID(),
    preparationId: randomUUID(),
    draftRevision: 2,
    sourceCoverage: [{
      sourceId: fixture.sourceId,
      version: 2,
      locator: "Synthetic amendment section 1",
      materiality: "material",
      coverageStatus: "covered",
      analysisStatus: "not-used",
      analysisReference: null,
      explanation: "The provider reviewed the exact revised source.",
    }],
  });
  const secondPreparation = await fixture.store.prepareCommercial(
    fixture.actor,
    secondInput,
  );
  assert.equal(secondPreparation.revision, 2);
  const secondPublication = await fixture.store.publishPrepared(fixture.actor, {
    commandId: randomUUID(),
    preparationId: secondInput.preparationId,
  });
  assert.equal(secondPublication.version, 2);
  assert.notEqual(secondPublication.digest, firstPublication.digest);
  const history = (await sql<{
    version: number;
    digest: string;
  }>`select version,digest from unit_versions
    where workspace_id = ${fixture.workspaceId}
      and project_id = ${fixture.projectId}
      and unit_id = ${fixture.unitId}
    order by version`.execute(fixture.database.kysely)).rows;
  assert.deepEqual(history, [
    { version: 1, digest: firstPublication.digest },
    { version: 2, digest: secondPublication.digest },
  ]);
});

test("exact replay converges while changed preparation or publication replay conflicts", async (t) => {
  const fixture = await seed(t);
  const input = preparation(fixture, "payable");
  const firstPreparation = await fixture.store.prepareCommercial(
    fixture.actor,
    input,
  );
  assert.deepEqual(
    await fixture.store.prepareCommercial(fixture.actor, input),
    firstPreparation,
  );
  await rejectsCode(fixture.store.prepareCommercial(fixture.actor, {
    ...input,
    clientVisibleRationale: "Changed content reusing the same command.",
  }), "IDEMPOTENCY_CONFLICT");
  await rejectsCode(fixture.store.prepareCommercial(fixture.actor, {
    ...input,
    commandId: randomUUID(),
    clientVisibleRationale: "Changed content reusing the same preparation.",
  }), "IDEMPOTENCY_CONFLICT");

  const publication = {
    commandId: randomUUID(),
    preparationId: input.preparationId,
  };
  const firstPublication = await fixture.store.publishPrepared(
    fixture.actor,
    publication,
  );
  assert.deepEqual(
    await fixture.store.publishPrepared(fixture.actor, publication),
    firstPublication,
  );
  await rejectsCode(fixture.store.publishPrepared(fixture.actor, {
    ...publication,
    preparationId: randomUUID(),
  }), "IDEMPOTENCY_CONFLICT");
  await rejectsCode(fixture.store.publishPrepared(fixture.actor, {
    commandId: randomUUID(),
    preparationId: input.preparationId,
  }), "IDEMPOTENCY_CONFLICT");

  const provenance = (await sql<{
    versions: number;
    provenance: number;
  }>`select
      (select count(*)::integer from unit_versions) as versions,
      (select count(*)::integer from provider_publication_provenance)
        as provenance`.execute(fixture.database.kysely)).rows[0]!;
  assert.deepEqual(provenance, { versions: 1, provenance: 1 });
  await assert.rejects(sql`update provider_commercial_preparations
    set client_visible_rationale = 'rewritten'
    where workspace_id = ${fixture.workspaceId}
      and project_id = ${fixture.projectId}
      and preparation_id = ${input.preparationId}::uuid`
    .execute(fixture.database.kysely), { code: "23514" });
  await assert.rejects(sql`delete from provider_publication_provenance
    where workspace_id = ${fixture.workspaceId}
      and project_id = ${fixture.projectId}
      and preparation_id = ${input.preparationId}::uuid`
    .execute(fixture.database.kysely), { code: "23514" });
});

test("server-owned publication fields are not accepted from command input", async (t) => {
  const fixture = await seed(t);
  const input = preparation(fixture, "waived");
  await rejectsCode(fixture.store.prepareCommercial(fixture.actor, {
    ...input,
    merchantId: "browser-merchant",
    environment: "live",
    version: 99,
    digest: "a".repeat(64),
  }), "INVALID_INPUT");
  await fixture.store.prepareCommercial(fixture.actor, input);
  await rejectsCode(fixture.store.publishPrepared(fixture.actor, {
    commandId: randomUUID(),
    preparationId: input.preparationId,
    version: 99,
    digest: "b".repeat(64),
    publishedBy: "browser-actor",
    publishedAt: new Date().toISOString(),
    merchantId: "browser-merchant",
    paymentOperationId: randomUUID(),
  }), "INVALID_INPUT");
});
