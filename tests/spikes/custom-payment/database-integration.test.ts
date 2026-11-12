import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  createIsolatedProofDatabase,
  PostgresAuthoringStore,
  sql,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { ReviewLocatorCodec } from "../../../apps/web/app/api/review/service.js";
import {
  customPaymentActors,
  loadPayerPaymentTarget,
  loadProviderPaymentTarget,
  type PaymentLocators,
} from "../../../apps/web/app/api/pay/database.js";

const workspaceId = "demo-workspace";
const providerId = "northstar-provider";
const approverId = "cedar-approver";
const payerId = "cedar-payer";
const secret = "22".repeat(32);

function databaseUrl(): string {
  const value = process.env.IP01_DATABASE_URL
    ?? process.env.SCOPELEDGER_DATABASE_URL;
  assert.ok(value, "A PostgreSQL proof database URL is required");
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function approvedPayable(t: TestContext) {
  const isolated = await createIsolatedProofDatabase(databaseUrl());
  t.after(isolated.dispose);
  const suffix = randomUUID().slice(0, 8);
  const projectId = `custom-payment-project-${suffix}`;
  const requestId = `custom-payment-request-${suffix}`;
  const unitId = `custom-payment-unit-${suffix}`;
  const sourceId = `custom-payment-source-${suffix}`;
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${workspaceId},'custom-payment-merchant','sandbox')`
    .execute(isolated.database.kysely);
  const authoring = new PostgresAuthoringStore(isolated.database);
  await authoring.createProject({
    workspaceId,
    projectId,
    displayName: "Harbor Bakery H1 Demo",
    clientId: "harbor-client",
    initialApproverId: approverId,
    createdBy: providerId,
  });
  for (const action of ["inspect", "publish"] as const) {
    await sql`insert into grants(
        workspace_id,project_id,actor_id,action
      ) values (${workspaceId},${projectId},${providerId},${action})`
      .execute(isolated.database.kysely);
  }
  await authoring.createRequest({
    workspaceId,
    projectId,
    requestId,
    title: "Harbor opaque payment review",
    createdBy: providerId,
  });
  await authoring.recordSourceIntake({
    workspaceId,
    projectId,
    sourceId,
    version: 1,
    availability: "available",
    reviewedBy: providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "harbor-payment.pdf",
    declaredByteLength: 20,
    contentDigest: sha256("harbor-payment"),
    provenance: {
      origin: "agreement",
      suppliedBy: providerId,
      originReference: "Harbor agreement section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Provider attested this synthetic payment source.",
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
  const store = new OrderedConsentStore(isolated.database);
  const provider = {
    workspaceId,
    projectId,
    actorId: providerId,
    grantEpoch: 1,
  };
  await store.confirmProviderBaseline(provider, {
    commandId: randomUUID(),
    requestId,
    sourceId,
    sourceVersion: 1,
  });
  await authoring.saveDraft({
    workspaceId,
    projectId,
    requestId,
    unitId,
    revision: 1,
    expectedPreviousRevision: null,
    state: "ready-for-client-review",
    title: "Harbor custom payable unit",
    summary: "Exact immutable Harbor payment unit.",
    scope: ["Implement the exact Harbor custom unit."],
    exclusions: ["No work outside the admitted source."],
    sourceReferences: [{ sourceId, version: 1 }],
    authoredBy: providerId,
  });
  const preparationId = randomUUID();
  await store.prepareCommercial(provider, {
    commandId: randomUUID(),
    preparationId,
    requestId,
    unitId,
    draftRevision: 1,
    treatment: "payable",
    independenceExplanation:
      "The provider confirmed this is one independently decidable unit.",
    dependencies: [],
    clientVisibleRationale:
      "The exact Harbor custom unit is payable only after approval.",
    delivery: {
      description: "Delivery occurs after verified payment.",
      dependencies: [],
    },
    prerequisites: [],
    consentRequirement: "required",
    paymentExplanation: "Full prepayment is required before work starts.",
    tax: {
      treatment: "none",
      amount: "0.00",
      declaration: "The provider declares that no tax is added.",
    },
    price: {
      currency: "USD",
      paymentPolicy: "full-prepayment",
      lines: [{
        id: "harbor-unit",
        description: "Exact Harbor custom payable unit.",
        quantity: "1",
        unitPrice: "200.00",
        amount: "200.00",
      }],
      subtotal: "200.00",
      gross: "200.00",
    },
    sourceCoverage: [{
      sourceId,
      version: 1,
      locator: "Harbor agreement section 1",
      materiality: "material",
      coverageStatus: "covered",
      analysisStatus: "not-used",
      analysisReference: null,
      explanation: "The provider reviewed this exact source.",
    }],
  });
  await store.publishPrepared(provider, {
    commandId: randomUUID(),
    preparationId,
  });
  for (const action of ["inspect", "decide", "correct"] as const) {
    await sql`insert into grants(
        workspace_id,project_id,actor_id,action
      ) values (${workspaceId},${projectId},${approverId},${action})`
      .execute(isolated.database.kysely);
  }
  const version = (await sql<{
    digest: string;
  }>`select digest from unit_versions
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and unit_id = ${unitId}
      and version = 1`
    .execute(isolated.database.kysely)).rows[0]!;
  const decision = await store.decide({
    workspaceId,
    projectId,
    actorId: approverId,
    grantEpoch: 1,
  }, {
    commandId: randomUUID(),
    unitId,
    version: 1,
    digest: version.digest,
    decision: "approve",
    attestation: {
      reviewedExactVersion: true,
      authority: true,
      statement: "Explicit Harbor exact-version approval authority.",
    },
  });
  assert.ok(decision.obligationId);
  const codec = new ReviewLocatorCodec(secret);
  const reviewLocators = {
    projectLocator: codec.project(workspaceId, projectId),
    requestLocator: codec.request(workspaceId, projectId, requestId),
    unitLocator: codec.unit(workspaceId, projectId, requestId, unitId),
  };
  return {
    ...isolated,
    store,
    provider,
    projectId,
    requestId,
    unitId,
    digest: version.digest,
    obligationId: decision.obligationId,
    codec,
    reviewLocators,
  };
}

test("provider activation creates only pay authority and current obligation nomination", async (t) => {
  const fixture = await approvedPayable(t);
  const before = await loadProviderPaymentTarget({
    database: fixture.database,
    codec: fixture.codec,
    locators: fixture.reviewLocators,
  });
  assert.equal(before.currency, "USD");
  assert.equal(before.gross, "200.00");
  assert.equal(before.payer, null);
  const commandId = randomUUID();
  const activated = await fixture.store.activatePayerAuthority(
    fixture.provider,
    {
      commandId,
      obligationId: fixture.obligationId,
      unitId: fixture.unitId,
      version: 1,
      digest: fixture.digest,
      payerId,
    },
  );
  const replay = await fixture.store.activatePayerAuthority(
    fixture.provider,
    {
      commandId,
      obligationId: fixture.obligationId,
      unitId: fixture.unitId,
      version: 1,
      digest: fixture.digest,
      payerId,
    },
  );
  assert.deepEqual(replay, activated);
  const grants = (await sql<{
    action: string;
    epoch: number;
    active: boolean;
  }>`select action,epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and actor_id = ${payerId}
    order by action collate "C"`
    .execute(fixture.database.kysely)).rows;
  assert.deepEqual(grants, [{
    action: "pay",
    epoch: 1,
    active: true,
  }]);
  const nominations = (await sql<{
    actor_id: string;
    epoch: number;
    continuity_epoch: number;
    active: boolean;
  }>`select actor_id,epoch,continuity_epoch,active
    from payer_nominations
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}`
    .execute(fixture.database.kysely)).rows;
  assert.deepEqual(nominations, [{
    actor_id: payerId,
    epoch: 1,
    continuity_epoch: 1,
    active: true,
  }]);
  const attempts = await sql`select 1 from attempts`
    .execute(fixture.database.kysely);
  assert.equal(attempts.rows.length, 0);
});

test("opaque payer locator rejects cross-project and stale approved bases", async (t) => {
  const fixture = await approvedPayable(t);
  await fixture.store.activatePayerAuthority(fixture.provider, {
    commandId: randomUUID(),
    obligationId: fixture.obligationId,
    unitId: fixture.unitId,
    version: 1,
    digest: fixture.digest,
    payerId,
  });
  const valid: PaymentLocators = {
    ...fixture.reviewLocators,
    payerLocator: fixture.codec.payer(
      workspaceId,
      fixture.projectId,
      fixture.requestId,
      fixture.unitId,
      1,
      fixture.digest,
      fixture.obligationId,
      payerId,
    ),
  };
  const loaded = await loadPayerPaymentTarget({
    database: fixture.database,
    codec: fixture.codec,
    locators: valid,
    subject: "verified-payer",
    expectedSubject: "verified-payer",
  });
  assert.equal(loaded.gross, "200.00");
  assert.equal(loaded.payer?.actorId, customPaymentActors.payerActorId);
  assert.equal(
    (await fixture.store.inspectUnit({
      workspaceId,
      projectId: fixture.projectId,
      actorId: providerId,
      grantEpoch: loaded.providerInspectGrantEpoch,
    }, fixture.unitId)).readiness,
    "awaiting-payment",
  );

  for (const invalid of [
    {
      ...valid,
      projectLocator: fixture.codec.project(workspaceId, "other-project"),
    },
    {
      ...valid,
      unitLocator: fixture.codec.unit(
        workspaceId,
        fixture.projectId,
        fixture.requestId,
        "stale-unit",
      ),
    },
    {
      ...valid,
      payerLocator: fixture.codec.payer(
        workspaceId,
        fixture.projectId,
        fixture.requestId,
        fixture.unitId,
        1,
        "b".repeat(64),
        fixture.obligationId,
        payerId,
      ),
    },
  ]) {
    await assert.rejects(
      loadPayerPaymentTarget({
        database: fixture.database,
        codec: fixture.codec,
        locators: invalid,
        subject: "verified-payer",
        expectedSubject: "verified-payer",
      }),
      (error: unknown) =>
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "NOT_FOUND",
    );
  }
});
