import assert from "node:assert/strict";
import {
  after,
  before,
  test,
} from "node:test";
import { createHash, randomUUID } from "node:crypto";
import {
  freezePublishedUnit,
  parseInput,
  publishedUnitSchema,
  type Actor,
  type PublishedUnit,
} from "@scopeledger/contracts";
import {
  createIsolatedProofDatabase,
  PostgresAuthoringStore,
  type ProtocolDatabase,
  sql,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  handleQuestionResponsePost,
  type ReconciliationDependencies,
} from "../../../apps/web/app/api/provider/reconciliation/service.js";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;
const databaseUrl = process.env.IP01_DATABASE_URL;
assert.ok(
  databaseUrl,
  "IP01_DATABASE_URL is required; provider reconciliation uses real PostgreSQL.",
);

let isolated: Awaited<ReturnType<typeof createIsolatedProofDatabase>>;
let database: ProtocolDatabase;
let reconciliationDependencies: () => ReconciliationDependencies;
const priorConnection = process.env.SCOPELEDGER_DATABASE_URL;
const priorSchema = process.env.SCOPELEDGER_DATABASE_SCHEMA;

before(async () => {
  const runtimePath =
    "../../../apps/web/app/api/provider/reconciliation/runtime.js";
  const runtime = await import(runtimePath) as {
    reconciliationDependencies: () => ReconciliationDependencies;
  };
  reconciliationDependencies = runtime.reconciliationDependencies;
  isolated = await createIsolatedProofDatabase(databaseUrl);
  database = isolated.database;
  process.env.SCOPELEDGER_DATABASE_URL = databaseUrl;
  process.env.SCOPELEDGER_DATABASE_SCHEMA = isolated.schema;
  (globalThis as typeof globalThis & {
    __scopeledgerProtocolDatabase?: ProtocolDatabase;
  }).__scopeledgerProtocolDatabase = database;
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${workspaceId},'synthetic-merchant','sandbox')`
    .execute(database.kysely);
});

after(async () => {
  delete (globalThis as typeof globalThis & {
    __scopeledgerProtocolDatabase?: ProtocolDatabase;
  }).__scopeledgerProtocolDatabase;
  if (priorConnection === undefined) {
    delete process.env.SCOPELEDGER_DATABASE_URL;
  } else {
    process.env.SCOPELEDGER_DATABASE_URL = priorConnection;
  }
  if (priorSchema === undefined) {
    delete process.env.SCOPELEDGER_DATABASE_SCHEMA;
  } else {
    process.env.SCOPELEDGER_DATABASE_SCHEMA = priorSchema;
  }
  await isolated.dispose();
});

function commandId() {
  return { commandId: randomUUID() };
}

function snapshot(
  projectId: string,
  unitId: string,
  version = 1,
  overrides: Record<string, unknown> = {},
): PublishedUnit {
  return parseInput(publishedUnitSchema, {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    workspaceId,
    projectId,
    clientId: `${projectId}-client`,
    unitId,
    version,
    contextRevision: 1,
    title: `Synthetic unit ${projectId}`,
    treatment: "payable",
    scope: ["One exact synthetic implementation unit."],
    exclusions: ["Anything outside the exact synthetic unit."],
    dependencies: [],
    baselineReferences: [{ id: `${projectId}-baseline`, version: 1 }],
    sourceReferences: [{
      id: `${projectId}-source`,
      version: 1,
      locator: "Synthetic agreement section 1",
      availability: "available",
    }],
    rationale: "Provider-reviewed synthetic rationale.",
    approver: {
      actorId: `${projectId}-approver`,
      nominationEpoch: 1,
      condition: "Named synthetic approver with exact-version authority.",
    },
    timing: {
      description: "Five working days after prerequisites.",
      deliveryDependencies: [],
    },
    prerequisites: [],
    reconciliation: [],
    payment: {
      policy: "full-prepayment",
      financial: {
        currency: "USD",
        merchantId: "synthetic-merchant",
        environment: "sandbox",
        lines: [{
          id: "implementation",
          description: "Synthetic implementation unit",
          quantity: "1",
          unitPrice: "300.00",
          amount: "300.00",
        }],
        subtotal: "300.00",
        tax: {
          treatment: "none",
          amount: "0.00",
          declaration: "No synthetic tax added.",
        },
        gross: "300.00",
      },
    },
    financialEffect: { kind: "new" },
    ...overrides,
  });
}

async function projectFixture(label: string) {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const projectId = `project-${suffix}`;
  const packetId = `request-${suffix}`;
  const unitId = `unit-${suffix}`;
  const approverId = `${projectId}-approver`;
  const provider: Actor = {
    workspaceId,
    projectId,
    actorId: providerActorId,
    grantEpoch: providerGrantEpoch,
  };
  const approver: Actor = {
    workspaceId,
    projectId,
    actorId: approverId,
    grantEpoch: 1,
  };
  await sql`insert into projects(
      workspace_id,id,client_id,approver_id,provider_display_name,
      provider_created_by,provider_created_at,provider_initial_client_id,
      provider_initial_approver_id,provider_creation_digest
    ) values (
      ${workspaceId},${projectId},${`${projectId}-client`},${approverId},
      ${`Project ${label}`},${providerActorId},clock_timestamp(),
      ${`${projectId}-client`},${approverId},${"a".repeat(64)}
    )`.execute(database.kysely);
  for (const [actorId, actions] of [
    [providerActorId, ["publish", "review", "inspect"]],
    [approverId, ["decide", "correct", "inspect"]],
  ] as const) {
    for (const action of actions) {
      await sql`insert into grants(
          workspace_id,project_id,actor_id,action,epoch,active
        ) values (
          ${workspaceId},${projectId},${actorId},${action},1,true
        )`.execute(database.kysely);
    }
  }
  const store = new OrderedConsentStore(database);
  await store.registerContext(provider, {
    ...commandId(),
    baseline: { id: `${projectId}-baseline`, version: 1 },
    sources: [{
      id: `${projectId}-source`,
      version: 1,
      availability: "available",
    }],
  });
  await store.createPacket(provider, { ...commandId(), packetId });
  await store.createUnit(provider, { ...commandId(), unitId, packetId });
  const published = snapshot(projectId, unitId);
  await store.publish(provider, {
    ...commandId(),
    snapshot: published,
    expectedPreviousVersion: null,
  });
  const authoring = new PostgresAuthoringStore(database);
  await authoring.recordSourceIntake({
    workspaceId,
    projectId,
    sourceId: `${projectId}-source`,
    version: 1,
    availability: "available",
    reviewedBy: providerActorId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "synthetic-agreement.pdf",
    declaredByteLength: 20,
    contentDigest: createHash("sha256")
      .update(`synthetic-source:${projectId}`)
      .digest("hex"),
    provenance: {
      origin: "agreement",
      suppliedBy: providerActorId,
      originReference: "Synthetic agreement section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "The authenticated provider attested this synthetic source.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model processing is used for these commercial terms.",
      },
    },
  });
  await store.confirmProviderBaseline(provider, {
    ...commandId(),
    requestId: packetId,
    sourceId: `${projectId}-source`,
    sourceVersion: 1,
  });
  return {
    projectId,
    packetId,
    unitId,
    approverId,
    provider,
    approver,
    store,
    authoring,
    published,
  };
}

function commercialPreparation(
  fixture: Awaited<ReturnType<typeof projectFixture>>,
  draftRevision: number,
) {
  return {
    commandId: randomUUID(),
    preparationId: randomUUID(),
    requestId: fixture.packetId,
    unitId: fixture.unitId,
    draftRevision,
    treatment: "payable" as const,
    independenceExplanation:
      "The corrected work remains one independently decidable unit.",
    dependencies: [],
    clientVisibleRationale:
      "The provider revised the exact terms after the material correction.",
    delivery: {
      description: "Delivery occurs within five working days.",
      dependencies: [],
    },
    prerequisites: [],
    consentRequirement: "required" as const,
    paymentExplanation: "Fresh consent is required before payment.",
    tax: {
      treatment: "none" as const,
      amount: "0.00",
      declaration: "No synthetic tax is added.",
    },
    price: {
      currency: "USD" as const,
      paymentPolicy: "full-prepayment" as const,
      lines: [{
        id: "corrected-implementation",
        description: "Corrected synthetic implementation unit.",
        quantity: "1",
        unitPrice: "275.00",
        amount: "275.00",
      }],
      subtotal: "275.00",
      gross: "275.00",
    },
    sourceCoverage: [{
      sourceId: `${fixture.projectId}-source`,
      version: 1,
      locator: "Synthetic agreement section 1",
      materiality: "material" as const,
      coverageStatus: "covered" as const,
      analysisStatus: "not-used" as const,
      analysisReference: null,
      explanation: "The provider reviewed this exact admitted source.",
    }],
  };
}

async function admitQuestion(
  fixture: Awaited<ReturnType<typeof projectFixture>>,
) {
  const questionId = randomUUID();
  await new PostgresAuthoringStore(database).askQuestion({
    workspaceId,
    projectId: fixture.projectId,
    questionId,
    requestId: fixture.packetId,
    unitId: fixture.unitId,
    unitVersion: fixture.published.version,
    askedBy: fixture.approverId,
    exactText: "Which exact source governs this charge?",
    modelProcessing: "denied",
  });
  return questionId;
}

async function admitCorrection(
  fixture: Awaited<ReturnType<typeof projectFixture>>,
) {
  const concernId = `concern-${randomUUID()}`;
  await fixture.store.admitCorrection(fixture.approver, {
    ...commandId(),
    concernId,
    packetId: fixture.packetId,
    originUnitId: fixture.unitId,
    scope: { kind: "known", unitIds: [fixture.unitId] },
    claim: {
      statement: "The populated page was included in the signed agreement.",
      claimedSourceType: "Synthetic signed agreement",
      source: {
        availability: "available",
        reference: "Synthetic agreement section 1",
        date: null,
      },
      sharingAuthorized: true,
      modelProcessingPermitted: false,
    },
  });
  return concernId;
}

function post(path: string, body: object): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    },
    body: JSON.stringify(body),
  });
}

test("authorized questions list safely and exact response replay is idempotent", async () => {
  const fixture = await projectFixture("question");
  const questionId = await admitQuestion(fixture);
  const dependencies = reconciliationDependencies();
  const inbox = await dependencies.listInbox();
  const listed = inbox.questions.find((item) => item.questionId === questionId);
  assert.ok(listed);
  assert.equal(listed.communicationEffect, "communication-only");
  assert.doesNotMatch(JSON.stringify(listed), /digest|email|session/iu);

  const input = {
    questionId,
    expectedVersion: 1,
    commandId: randomUUID(),
    status: "answered" as const,
    response: "The synthetic agreement section is the governing source.",
  };
  const first = await dependencies.recordQuestionResponse(input);
  const replay = await dependencies.recordQuestionResponse(input);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, first.revision);
  await assert.rejects(
    dependencies.recordQuestionResponse({
      ...input,
      response: "Different content with the same command identity.",
    }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "IDEMPOTENCY_CONFLICT",
  );
  const holds = await sql<{ count: number }>`select count(*)::integer as count
    from holds
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}`.execute(database.kysely);
  assert.equal(holds.rows[0]?.count, 0);
});

test("revoked and stale question access fails without exposing another project", async () => {
  const revoked = await projectFixture("revoked");
  const revokedQuestion = await admitQuestion(revoked);
  await sql`update grants set active = false
    where workspace_id = ${workspaceId}
      and project_id = ${revoked.projectId}
      and actor_id = ${providerActorId}`
    .execute(database.kysely);
  const dependencies = {
    ...reconciliationDependencies(),
    verifyProvider: async () => ({ ok: true as const }),
  };
  const response = await handleQuestionResponsePost(
    post("/response", {
      idempotencyKey: randomUUID(),
      expectedVersion: 1,
      status: "answered",
      response: "This must remain inaccessible after grant revocation.",
    }),
    revokedQuestion,
    dependencies,
  );
  assert.equal(response.status, 404);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "RECONCILIATION_ITEM_NOT_AVAILABLE",
  );
  assert.equal(
    (await dependencies.listInbox()).questions.some(
      (item) => item.questionId === revokedQuestion,
    ),
    false,
  );

  const stale = await projectFixture("stale");
  const staleQuestion = await admitQuestion(stale);
  const second = snapshot(stale.projectId, stale.unitId, 2);
  await stale.store.publish(stale.provider, {
    ...commandId(),
    snapshot: second,
    expectedPreviousVersion: 1,
  });
  await assert.rejects(
    dependencies.recordQuestionResponse({
      questionId: staleQuestion,
      expectedVersion: 1,
      commandId: randomUUID(),
      status: "answered",
      response: "A stale question basis must not be recorded as current.",
    }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "STALE_UNIT_VERSION",
  );
});

test("needs-information records a response but leaves the correction hold active", async () => {
  const fixture = await projectFixture("needs-info");
  const concernId = await admitCorrection(fixture);
  const result = await reconciliationDependencies().assessCorrection({
    concernId,
    expectedVersion: 1,
    commandId: randomUUID(),
    applicability: "needs-information",
    sourceReview: "The referenced correspondence is not available.",
    response: "Please provide the referenced correspondence for review.",
  });
  assert.equal(result.applicability, "needs-information");
  assert.equal(result.reissueDraftRevision, null);
  const response = (await sql<{ disposition: string }>`
    select disposition from correction_responses
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and concern_id = ${concernId}
      and revision = ${result.responseRevision}
  `.execute(database.kysely)).rows[0];
  assert.equal(response?.disposition, "request-information");
  const hold = (await sql<{ active: boolean }>`select exists (
      select 1 from holds
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and concern_id = ${concernId}
        and reason = 'correction'
        and resolved_at is null
    ) as active`.execute(database.kysely)).rows[0];
  assert.equal(hold?.active, true);

});

test("material assessment derives an immutable in-progress reissue draft from the exact current unit", async () => {
  const fixture = await projectFixture("material");
  const priorDecision = await fixture.store.decide(fixture.approver, {
    ...commandId(),
    unitId: fixture.unitId,
    version: 1,
    digest: freezePublishedUnit(fixture.published).digest,
    decision: "approve",
    attestation: {
      reviewedExactVersion: true,
      authority: true,
      statement: "Synthetic exact-version authority attestation.",
    },
  });
  assert.ok(priorDecision.obligationId);
  const concernId = await admitCorrection(fixture);
  const before = (await sql<{
    versions: number;
    decisions: number;
    obligations: number;
    payments: number;
  }>`select
      (select count(*)::integer from unit_versions
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as versions,
      (select count(*)::integer from decisions
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as decisions,
      (select count(*)::integer from obligations
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as obligations,
      (select count(*)::integer from payment_facts
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as payments
  `.execute(database.kysely)).rows[0];
  assert.ok(before);

  const command = randomUUID();
  const dependencies = reconciliationDependencies();
  const first = await dependencies.assessCorrection({
    concernId,
    expectedVersion: 1,
    commandId: command,
    applicability: "material-change",
    sourceReview: "The synthetic agreement changes the current scope.",
    response: "The current unit requires corrected terms and fresh consent.",
  });
  const replay = await dependencies.assessCorrection({
    concernId,
    expectedVersion: 1,
    commandId: command,
    applicability: "material-change",
    sourceReview: "The synthetic agreement changes the current scope.",
    response: "The current unit requires corrected terms and fresh consent.",
  });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.reissueDraftRevision, first.reissueDraftRevision);
  assert.ok(first.reissueDraftRevision);

  const draft = await new PostgresAuthoringStore(database).readDraft({
    workspaceId,
    projectId: fixture.projectId,
    requestId: fixture.packetId,
    unitId: fixture.unitId,
    revision: first.reissueDraftRevision,
  });
  assert.ok(draft);
  assert.equal(draft.state, "in-progress");
  assert.equal(draft.title, fixture.published.title);
  assert.deepEqual(draft.scope, fixture.published.scope);
  assert.deepEqual(draft.exclusions, fixture.published.exclusions);
  assert.deepEqual(draft.sourceReferences, [{
    sourceId: `${fixture.projectId}-source`,
    version: 1,
  }]);
  assert.match(draft.summary, /exact published unit version 1/iu);
  assert.match(draft.summary, /material correction assessment/iu);

  const assessment = (await sql<{
    unit_version: number;
    unit_digest: string;
    applicability: string;
    response_revision: number;
  }>`select unit_version,unit_digest,applicability,response_revision
    from provider_reconciliation_assessments
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and concern_id = ${concernId}
  `.execute(database.kysely)).rows[0];
  assert.equal(assessment?.unit_version, 1);
  assert.equal(
    assessment?.unit_digest,
    freezePublishedUnit(fixture.published).digest,
  );
  assert.equal(assessment?.applicability, "material-change");

  const after = (await sql<typeof before>`select
      (select count(*)::integer from unit_versions
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as versions,
      (select count(*)::integer from decisions
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as decisions,
      (select count(*)::integer from obligations
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as obligations,
      (select count(*)::integer from payment_facts
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as payments
  `.execute(database.kysely)).rows[0];
  assert.deepEqual(after, before);
  const hold = (await sql<{ active: boolean }>`select exists (
      select 1 from holds
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and concern_id = ${concernId}
        and reason = 'correction'
        and resolved_at is null
    ) as active`.execute(database.kysely)).rows[0];
  assert.equal(hold?.active, true);

  const correctedDraft = await fixture.authoring.saveDraft({
    workspaceId,
    projectId: fixture.projectId,
    requestId: fixture.packetId,
    unitId: fixture.unitId,
    revision: first.reissueDraftRevision + 1,
    expectedPreviousRevision: first.reissueDraftRevision,
    state: "ready-for-client-review",
    title: fixture.published.title,
    summary: "Provider-edited correction terms ready for commercial preparation.",
    scope: ["One corrected synthetic implementation unit."],
    exclusions: fixture.published.exclusions,
    sourceReferences: [{
      sourceId: `${fixture.projectId}-source`,
      version: 1,
    }],
    authoredBy: providerActorId,
  });
  const preparation = commercialPreparation(
    fixture,
    correctedDraft.draft.revision,
  );
  await fixture.store.prepareCommercial(fixture.provider, preparation);
  const reissue = await fixture.store.publishPrepared(fixture.provider, {
    commandId: randomUUID(),
    preparationId: preparation.preparationId,
  });
  assert.equal(reissue.version, 2);
  const reissued = (await sql<{ snapshot: PublishedUnit }>`select snapshot
    from unit_versions
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and unit_id = ${fixture.unitId}
      and version = 2
  `.execute(database.kysely)).rows[0]?.snapshot;
  assert.deepEqual(reissued?.reconciliation, [{
    concernId,
    responseRevision: first.responseRevision,
  }]);
  assert.deepEqual(reissued?.financialEffect, {
    kind: "unpaid-replacement",
    replacesObligationId: priorDecision.obligationId,
  });
  assert.equal((await sql`select 1 from decisions
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and unit_id = ${fixture.unitId}
      and version = 2`.execute(database.kysely)).rows.length, 0);
  const retained = (await sql<{
    accepted_version: number | null;
    collectible: boolean;
  }>`select u.accepted_version,o.collectible
    from units u
    join obligations o
      on o.workspace_id = u.workspace_id
      and o.project_id = u.project_id
      and o.unit_id = u.id
      and o.version = 1
    where u.workspace_id = ${workspaceId}
      and u.project_id = ${fixture.projectId}
      and u.id = ${fixture.unitId}
  `.execute(database.kysely)).rows[0];
  assert.deepEqual(retained, {
    accepted_version: 1,
    collectible: true,
  });
});

test("no-material response awaits explicit client resolution and preserves other holds, decisions and payment facts", async () => {
  const fixture = await projectFixture("no-material");
  const decision = await fixture.store.decide(fixture.approver, {
    ...commandId(),
    unitId: fixture.unitId,
    version: 1,
    digest: freezePublishedUnit(fixture.published).digest,
    decision: "approve",
    attestation: {
      reviewedExactVersion: true,
      authority: true,
      statement: "Synthetic exact-version authority attestation.",
    },
  });
  assert.ok(decision.obligationId);
  const attemptId = randomUUID();
  const operationId = randomUUID();
  const providerKey = randomUUID();
  await database.transaction(async (transaction) => {
    await sql`insert into attempts(
        workspace_id,project_id,id,obligation_id,initiated_by,payer_epoch,
        nomination_epoch,state,order_id,resolved_at
      ) values (
        ${workspaceId},${fixture.projectId},${attemptId}::uuid,
        ${decision.obligationId},'synthetic-payer',1,1,'completed',
        'ORDER-HISTORY',clock_timestamp()
      )`.execute(transaction);
    await sql`insert into operations(
        workspace_id,project_id,id,attempt_id,kind,request,request_hash,
        provider_key,state,admitted_at,admission,result
      ) values (
        ${workspaceId},${fixture.projectId},${operationId}::uuid,
        ${attemptId}::uuid,'capture','{}'::jsonb,${"b".repeat(64)},
        ${providerKey}::uuid,'result',clock_timestamp(),'{}'::jsonb,
        '{"outcome":"completed"}'::jsonb
      )`.execute(transaction);
    await sql`insert into payment_facts(
        workspace_id,project_id,operation_id,capture_id,order_id,merchant_id,
        environment,currency,gross,evidence
      ) values (
        ${workspaceId},${fixture.projectId},${operationId}::uuid,
        'CAPTURE-HISTORY','ORDER-HISTORY','synthetic-merchant','sandbox',
        'USD','300.00','{"kind":"synthetic-history"}'::jsonb
      )`.execute(transaction);
  });
  const concernId = await admitCorrection(fixture);
  await fixture.store.placeIndependentHold(fixture.provider, {
    ...commandId(),
    unitId: fixture.unitId,
    reason: "source",
    basis: "An independent source review remains open.",
  });
  const decisionBefore = (await sql<{ digest: string; recorded_at: Date }>`
    select digest,recorded_at from decisions
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and unit_id = ${fixture.unitId}
      and version = 1
  `.execute(database.kysely)).rows[0];
  const paymentBefore = (await sql<{
    capture_id: string;
    gross: string;
    evidence: unknown;
  }>`select capture_id,gross,evidence from payment_facts
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and operation_id = ${operationId}::uuid
  `.execute(database.kysely)).rows[0];

  const assessmentCommand = randomUUID();
  const dependencies = reconciliationDependencies();
  const assessment = await dependencies.assessCorrection({
    concernId,
    expectedVersion: 1,
    commandId: assessmentCommand,
    applicability: "no-material-change",
    sourceReview: "The supplied statement matches the current exact scope.",
    response: "No material change is required to the published terms.",
  });
  const beforeAcknowledgement = (await sql<{ active: boolean }>`select exists (
      select 1 from holds
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and concern_id = ${concernId}
        and reason = 'correction'
        and resolved_at is null
    ) as active`.execute(database.kysely)).rows[0];
  assert.equal(beforeAcknowledgement?.active, true);
    const providerResponse = (await sql<{ disposition: string }>`
      select disposition from correction_responses
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and concern_id = ${concernId}
        and revision = ${assessment.responseRevision}
    `.execute(database.kysely)).rows[0];
    assert.equal(providerResponse?.disposition, "maintain");
    assert.equal((await sql`select 1 from provider_authoring_draft_versions
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and unit_id = ${fixture.unitId}`
      .execute(database.kysely)).rows.length, 0);

  await fixture.store.resolveAcceptedConcern(fixture.approver, {
    ...commandId(),
    unitId: fixture.unitId,
    version: 1,
    digest: freezePublishedUnit(fixture.published).digest,
    resolution: {
      acknowledged: true,
      concerns: [{
        concernId,
        responseRevision: assessment.responseRevision,
      }],
    },
    attestation: {
      reviewedExactVersion: true,
      authority: true,
      statement: "Client explicitly acknowledges the provider response.",
    },
  });
  const holds = (await sql<{
    reason: string;
    concern_id: string | null;
    resolved_at: Date | null;
  }>`select reason,concern_id,resolved_at from holds
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and unit_id = ${fixture.unitId}
    order by reason collate "C"
  `.execute(database.kysely)).rows;
  assert.equal(
    holds.some((hold) =>
      hold.reason === "correction"
      && hold.concern_id === concernId
      && hold.resolved_at !== null),
    true,
  );
  assert.equal(
    holds.some((hold) =>
      hold.reason === "source" && hold.resolved_at === null),
    true,
  );
  const replay = await dependencies.assessCorrection({
    concernId,
    expectedVersion: 1,
    commandId: assessmentCommand,
    applicability: "no-material-change",
    sourceReview: "The supplied statement matches the current exact scope.",
    response: "No material change is required to the published terms.",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.responseRevision, assessment.responseRevision);
  const decisionAfter = (await sql<typeof decisionBefore>`select digest,recorded_at
    from decisions
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and unit_id = ${fixture.unitId}
      and version = 1
  `.execute(database.kysely)).rows[0];
  const paymentAfter = (await sql<typeof paymentBefore>`select capture_id,gross,evidence
    from payment_facts
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and operation_id = ${operationId}::uuid
  `.execute(database.kysely)).rows[0];
  assert.deepEqual(decisionAfter, decisionBefore);
  assert.deepEqual(paymentAfter, paymentBefore);
  const history = (await sql<{ event: string }>`select event from protocol_history
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
    order by sequence`.execute(database.kysely)).rows.map((row) => row.event);
  assert.ok(history.includes("decision"));
  assert.ok(history.includes("correction-responded"));
  assert.ok(history.includes("accepted-concern-resolved"));
});
