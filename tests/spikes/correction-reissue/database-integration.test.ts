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
  handleDraftsPost,
  type AuthoringDependencies,
} from "../../../apps/web/app/api/provider/authoring/service.js";
import {
  handleCommercialPublishPost,
  type CommercialDependencies,
} from "../../../apps/web/app/api/provider/authoring/commercial-service.js";
import {
  ReviewLoadError,
  ReviewLocatorCodec,
  type ReviewLocators,
  type ReviewProjection,
  type ReviewSession,
} from "../../../apps/web/app/api/review/service.js";
import {
  handleReviewMutationPost,
  type ReviewMutationBasis,
  type ReviewMutationDependencies,
  type ReviewMutationSession,
} from "../../../apps/web/app/api/review/mutation-service.js";
import type {
  ReconciliationDependencies,
} from "../../../apps/web/app/api/provider/reconciliation/service.js";
import {
  providerSourceScopePrefix,
} from "../../../apps/web/app/api/provider/sources/service.js";

const databaseUrl = process.env.IP01_DATABASE_URL;
assert.ok(
  databaseUrl,
  "IP01_DATABASE_URL is required; correction reissue uses real PostgreSQL.",
);

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const approverId = "cedar-approver";
const secret = "37".repeat(32);
const expectedSubject = "synthetic-client-subject";
const priorConnection = process.env.SCOPELEDGER_DATABASE_URL;
const priorSchema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
const priorSecret = process.env.ACCESS_SESSION_SECRET;

let isolated: Awaited<ReturnType<typeof createIsolatedProofDatabase>>;
let database: ProtocolDatabase;
let reconciliationDependencies: () => ReconciliationDependencies;
let authoringDependencies: () => AuthoringDependencies;
let commercialDependencies: () => CommercialDependencies;
let loadDatabaseReview: (input: Readonly<{
  database: ProtocolDatabase;
  codec: ReviewLocatorCodec;
  expectedSubject: string;
  locators: ReviewLocators;
  session: ReviewSession;
}>) => Promise<ReviewProjection>;
let loadDatabaseReviewMutationBasis: (input: Readonly<{
  database: ProtocolDatabase;
  codec: ReviewLocatorCodec;
  expectedSubject: string;
  locators: ReviewLocators;
  session: ReviewMutationSession;
}>) => Promise<ReviewMutationBasis>;

before(async () => {
  isolated = await createIsolatedProofDatabase(databaseUrl);
  database = isolated.database;
  process.env.SCOPELEDGER_DATABASE_URL = databaseUrl;
  process.env.SCOPELEDGER_DATABASE_SCHEMA = isolated.schema;
  process.env.ACCESS_SESSION_SECRET = secret;
  (globalThis as typeof globalThis & {
    __scopeledgerProtocolDatabase?: ProtocolDatabase;
  }).__scopeledgerProtocolDatabase = database;
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${workspaceId},'synthetic-merchant','sandbox')`
    .execute(database.kysely);
  const apiRoot = "../../../apps/web/app/api";
  const runtimePaths = {
    reconciliation: `${apiRoot}/provider/reconciliation/runtime.js`,
    authoring: `${apiRoot}/provider/authoring/runtime.js`,
    commercial: `${apiRoot}/provider/authoring/commercial-runtime.js`,
    reviewDatabase: `${apiRoot}/review/database.js`,
  };
  const [
    reconciliationRuntime,
    authoringRuntime,
    commercialRuntime,
    reviewDatabase,
  ] =
    await Promise.all([
      import(runtimePaths.reconciliation),
      import(runtimePaths.authoring),
      import(runtimePaths.commercial),
      import(runtimePaths.reviewDatabase),
    ]);
  reconciliationDependencies =
    reconciliationRuntime.reconciliationDependencies;
  authoringDependencies = authoringRuntime.authoringDependencies;
  commercialDependencies = commercialRuntime.commercialDependencies;
  loadDatabaseReview = reviewDatabase.loadDatabaseReview;
  loadDatabaseReviewMutationBasis =
    reviewDatabase.loadDatabaseReviewMutationBasis;
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
  if (priorSecret === undefined) {
    delete process.env.ACCESS_SESSION_SECRET;
  } else {
    process.env.ACCESS_SESSION_SECRET = priorSecret;
  }
  await isolated.dispose();
});

function commandId() {
  return { commandId: randomUUID() };
}

function request(path: string, body: object): Request {
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

function snapshot(
  projectId: string,
  unitId: string,
  sourceId: string,
): PublishedUnit {
  return parseInput(publishedUnitSchema, {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    workspaceId,
    projectId,
    clientId: `${projectId}-client`,
    unitId,
    version: 1,
    contextRevision: 1,
    title: "Synthetic implementation unit",
    treatment: "payable",
    scope: ["One exact synthetic implementation unit."],
    exclusions: ["Anything outside the exact synthetic unit."],
    dependencies: [],
    baselineReferences: [{ id: `${projectId}-baseline`, version: 1 }],
    sourceReferences: [{
      id: sourceId,
      version: 1,
      locator: "Synthetic agreement section 1",
      availability: "available",
    }],
    rationale: "Provider-reviewed synthetic rationale.",
    approver: {
      actorId: approverId,
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
  });
}

async function fixture(label: string) {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const projectId = `project-${suffix}`;
  const requestId = `request-${suffix}`;
  const unitId = `unit-${suffix}`;
  const sourceId = `${providerSourceScopePrefix({
    workspaceId,
    projectId,
    requestId,
  })}${createHash("sha256").update(`source:${projectId}`).digest("hex").slice(0, 48)}`;
  const provider: Actor = {
    workspaceId,
    projectId,
    actorId: providerActorId,
    grantEpoch: 1,
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
      id: sourceId,
      version: 1,
      availability: "available",
    }],
  });
  await store.createPacket(provider, { ...commandId(), packetId: requestId });
  await store.createUnit(provider, { ...commandId(), unitId, packetId: requestId });
  const published = snapshot(projectId, unitId, sourceId);
  await store.publish(provider, {
    ...commandId(),
    snapshot: published,
    expectedPreviousVersion: null,
  });
  const authoring = new PostgresAuthoringStore(database);
  await authoring.recordSourceIntake({
    workspaceId,
    projectId,
    sourceId,
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
    requestId,
    sourceId,
    sourceVersion: 1,
  });
  const decision = await store.decide(approver, {
    ...commandId(),
    unitId,
    version: 1,
    digest: freezePublishedUnit(published).digest,
    decision: "approve",
    attestation: {
      reviewedExactVersion: true,
      authority: true,
      statement: "Synthetic exact-version authority attestation.",
    },
  });
  assert.ok(decision.obligationId);
  const concernId = `concern-${randomUUID()}`;
  await store.admitCorrection(approver, {
    ...commandId(),
    concernId,
    packetId: requestId,
    originUnitId: unitId,
    scope: { kind: "known", unitIds: [unitId] },
    claim: {
      statement: "The populated implementation was included in the agreement.",
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
  return {
    projectId,
    requestId,
    unitId,
    provider,
    approver,
    store,
    published,
    obligationId: decision.obligationId,
    concernId,
    sourceId,
  };
}

async function assessAndEdit(
  current: Awaited<ReturnType<typeof fixture>>,
) {
  const assessment = await reconciliationDependencies().assessCorrection({
    concernId: current.concernId,
    expectedVersion: 1,
    commandId: randomUUID(),
    applicability: "material-change",
    sourceReview: "The signed agreement changes the current exact scope.",
    response: "Corrected terms and fresh client consent are required.",
  });
  assert.ok(assessment.reissueDraftRevision);
  const authoring = authoringDependencies();
  const discovered = await authoring.listDrafts({
    projectId: current.projectId,
    requestId: current.requestId,
  });
  const sourceDraft = discovered.find((draft) =>
    draft.revision === assessment.reissueDraftRevision);
  assert.ok(sourceDraft);
  assert.equal(sourceDraft.state, "in-progress");
  assert.equal(sourceDraft.correctionContexts.length, 1);
  assert.equal(
    sourceDraft.correctionContexts[0]?.statement,
    "The populated implementation was included in the agreement.",
  );
  assert.equal(
    sourceDraft.correctionContexts[0]?.sourceVersion,
    1,
  );
  const editResponse = await handleDraftsPost(
    request("/draft", {
      title: sourceDraft.title,
      summary: "Corrected immutable revision ready for client review.",
      scope: ["One corrected synthetic implementation unit."],
      exclusions: sourceDraft.exclusions,
      sourceLocators: sourceDraft.sourceReferences.map(
        (source) => source.locator,
      ),
      reviewReady: true,
    }),
    current.projectId,
    current.requestId,
    current.unitId,
    {
      ...authoring,
      requireSameOrigin: () => undefined,
      verifyProvider: async () => ({ ok: true }),
      authorize: async () => true,
    },
  );
  assert.equal(editResponse.status, 201);
  const edited = (await editResponse.json()) as {
    draft: Awaited<ReturnType<AuthoringDependencies["createDraft"]>>;
  };
  assert.equal(edited.draft.revision, assessment.reissueDraftRevision + 1);
  assert.equal(edited.draft.state, "ready-for-client-review");
  assert.equal(edited.draft.correctionContexts.length, 1);
  return {
    assessment,
    draft: edited.draft,
  };
}

function preparationInput(
  current: Awaited<ReturnType<typeof fixture>>,
  edited: Awaited<ReturnType<typeof assessAndEdit>>["draft"],
) {
  return {
    projectId: current.projectId,
    requestId: current.requestId,
    unitId: current.unitId,
    draftRevision: edited.revision,
    idempotencyKey: randomUUID(),
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
      description: "Corrected synthetic implementation unit.",
      amount: "275.00",
    },
    sourceCoverage: [{
      sourceLocator: edited.sourceReferences[0]!.locator,
      locator: "Synthetic agreement section 1",
      materiality: "material" as const,
      coverageStatus: "covered" as const,
      analysisStatus: "not-used" as const,
      analysisReference: null,
      explanation: "The provider reviewed this exact admitted source.",
    }],
  };
}

function locators(
  codec: ReviewLocatorCodec,
  current: Awaited<ReturnType<typeof fixture>>,
): ReviewLocators {
  return {
    projectLocator: codec.project(workspaceId, current.projectId),
    requestLocator: codec.request(
      workspaceId,
      current.projectId,
      current.requestId,
    ),
    unitLocator: codec.unit(
      workspaceId,
      current.projectId,
      current.requestId,
      current.unitId,
    ),
  };
}

test("material correction flows through discovery, immutable republication, stale v1 rejection, exact diff, and fresh decline", async () => {
  const current = await fixture("complete-reissue");
  const edited = await assessAndEdit(current);
  const commercial = commercialDependencies();
  const prepared = await commercial.prepareCommercial(
    preparationInput(current, edited.draft),
  );
  assert.equal(prepared.publicationAllowed, true);
  const codec = new ReviewLocatorCodec(secret);
  const reviewLocators = locators(codec, current);
  const oldMutationLocators = {
    ...reviewLocators,
    unitLocator: codec.mutationUnit(
      workspaceId,
      current.projectId,
      current.requestId,
      current.unitId,
      1,
      freezePublishedUnit(current.published).digest,
    ),
  };
  const publication = await commercial.publishCommercial({
    projectId: current.projectId,
    requestId: current.requestId,
    unitId: current.unitId,
    draftRevision: edited.draft.revision,
    idempotencyKey: randomUUID(),
    preparationLocator: prepared.preparationLocator,
  });
  assert.equal(publication.version, 2);

  await assert.rejects(
    loadDatabaseReviewMutationBasis({
      database,
      codec,
      expectedSubject,
      locators: oldMutationLocators,
      session: {
        subject: expectedSubject,
        role: "client-approver",
        challengeId: randomUUID(),
      },
    }),
    (error: unknown) =>
      error instanceof ReviewLoadError && error.code === "STALE_RECORD",
  );

  const review = await loadDatabaseReview({
    database,
    codec,
    expectedSubject,
    locators: reviewLocators,
    session: {
      subject: expectedSubject,
      role: "client-approver",
    },
  });
  assert.equal(review.unit.version, 2);
  assert.equal(review.facts.decision.status, "not-recorded");
  assert.equal(review.actions.decision.available, true);
  assert.equal(review.actions.decision.responseAcknowledgementCount, 1);
  assert.equal(review.reissue?.previousVersion, 1);
  assert.equal(review.reissue?.correctionContexts.length, 1);
  assert.ok(review.reissue?.differences.some((difference) =>
    difference.field === "Included scope"
    && difference.before.includes("One exact synthetic implementation unit.")
    && difference.current.includes(
      "One corrected synthetic implementation unit.",
    )));
  assert.equal(
    review.history.previousVersions[0]?.decision.status,
    "approved",
  );
  assert.equal(
    review.history.previousVersions[0]?.obligation?.paymentStatus,
    "not-initiated",
  );

  await current.store.placeIndependentHold(current.provider, {
    ...commandId(),
    unitId: current.unitId,
    reason: "source",
    basis: "An independent source review remains open.",
  });
  const currentAction = review.actions.endpoint.split("/");
  const actionLocators = {
    projectLocator: currentAction.at(-3)!,
    requestLocator: currentAction.at(-2)!,
    unitLocator: currentAction.at(-1)!,
  };
  const session = {
    subject: expectedSubject,
    role: "client-approver" as const,
    challengeId: randomUUID(),
  };
  const mutationDependencies: ReviewMutationDependencies = {
    requireSameOrigin: () => undefined,
    readSession: async () => session,
    loadMutationBasis: (target, suppliedSession) =>
      loadDatabaseReviewMutationBasis({
        database,
        codec,
        expectedSubject,
        locators: target,
        session: suppliedSession,
      }),
    decide: (basis, command) => current.store.decide({
      workspaceId: basis.workspaceId,
      projectId: basis.projectId,
      actorId: basis.actorId,
      grantEpoch: basis.decideGrantEpoch,
    }, command),
    askQuestion: async () => ({ duplicate: false }),
    admitCorrection: async () => ({
      concernId: "not-used",
      affectedUnitIds: [],
    }),
    createId: () => randomUUID(),
  };
  const decisionResponse = await handleReviewMutationPost(
    request("/review", {
      kind: "decision",
      decision: "decline",
      reviewedExactVersion: true,
      authority: true,
      acknowledgedResponses: true,
    }),
    actionLocators,
    mutationDependencies,
  );
  assert.equal(decisionResponse.status, 200);
  assert.equal(
    ((await decisionResponse.json()) as { decision: string }).decision,
    "decline",
  );
  const holds = (await sql<{
    reason: string;
    concern_id: string | null;
    resolved_at: Date | null;
  }>`select reason,concern_id,resolved_at from holds
    where workspace_id = ${workspaceId}
      and project_id = ${current.projectId}
      and unit_id = ${current.unitId}
    order by reason collate "C"`
    .execute(database.kysely)).rows;
  assert.equal(
    holds.some((hold) =>
      hold.reason === "correction"
      && hold.concern_id === current.concernId
      && hold.resolved_at !== null),
    true,
  );
  assert.equal(
    holds.some((hold) =>
      hold.reason === "source" && hold.resolved_at === null),
    true,
  );
  const lineage = (await sql<{
    version: number;
    decision: string;
    obligation_id: string | null;
    collectible: boolean | null;
  }>`select d.version,d.decision,o.id as obligation_id,o.collectible
    from decisions d
    left join obligations o
      on o.workspace_id = d.workspace_id
      and o.project_id = d.project_id
      and o.unit_id = d.unit_id
      and o.version = d.version
    where d.workspace_id = ${workspaceId}
      and d.project_id = ${current.projectId}
      and d.unit_id = ${current.unitId}
    order by d.version`
    .execute(database.kysely)).rows;
  assert.deepEqual(lineage, [{
    version: 1,
    decision: "approve",
    obligation_id: current.obligationId,
    collectible: true,
  }, {
    version: 2,
    decision: "decline",
    obligation_id: null,
    collectible: null,
  }]);
});

test("fresh approval resolves only the published correction and creates the replacement obligation without collecting", async () => {
  const current = await fixture("fresh-approval");
  const edited = await assessAndEdit(current);
  const commercial = commercialDependencies();
  const prepared = await commercial.prepareCommercial(
    preparationInput(current, edited.draft),
  );
  await commercial.publishCommercial({
    projectId: current.projectId,
    requestId: current.requestId,
    unitId: current.unitId,
    draftRevision: edited.draft.revision,
    idempotencyKey: randomUUID(),
    preparationLocator: prepared.preparationLocator,
  });
  const codec = new ReviewLocatorCodec(secret);
  const review = await loadDatabaseReview({
    database,
    codec,
    expectedSubject,
    locators: locators(codec, current),
    session: {
      subject: expectedSubject,
      role: "client-approver",
    },
  });
  const action = review.actions.endpoint.split("/");
  const actionLocators = {
    projectLocator: action.at(-3)!,
    requestLocator: action.at(-2)!,
    unitLocator: action.at(-1)!,
  };
  const session = {
    subject: expectedSubject,
    role: "client-approver" as const,
    challengeId: randomUUID(),
  };
  const response = await handleReviewMutationPost(
    request("/review", {
      kind: "decision",
      decision: "approve",
      reviewedExactVersion: true,
      authority: true,
      acknowledgedResponses: true,
    }),
    actionLocators,
    {
      requireSameOrigin: () => undefined,
      readSession: async () => session,
      loadMutationBasis: (target, suppliedSession) =>
        loadDatabaseReviewMutationBasis({
          database,
          codec,
          expectedSubject,
          locators: target,
          session: suppliedSession,
        }),
      decide: (basis, command) => current.store.decide({
        workspaceId: basis.workspaceId,
        projectId: basis.projectId,
        actorId: basis.actorId,
        grantEpoch: basis.decideGrantEpoch,
      }, command),
      askQuestion: async () => ({ duplicate: false }),
      admitCorrection: async () => ({
        concernId: "not-used",
        affectedUnitIds: [],
      }),
      createId: () => randomUUID(),
    },
  );
  assert.equal(response.status, 200);
  const responseBody = await response.json() as {
    decision: string;
    obligationCreated: boolean;
    paymentChanged: boolean;
  };
  assert.deepEqual(responseBody, {
    ok: true,
    kind: "decision",
    decision: "approve",
    agreementStatus: "approved",
    obligationCreated: true,
    paymentStatus: "not-initiated",
    paymentChanged: false,
  });
  const obligations = (await sql<{
    version: number;
    collectible: boolean;
    replaces_id: string | null;
  }>`select version,collectible,replaces_id from obligations
    where workspace_id = ${workspaceId}
      and project_id = ${current.projectId}
      and unit_id = ${current.unitId}
    order by version`
    .execute(database.kysely)).rows;
  assert.deepEqual(obligations, [{
    version: 1,
    collectible: false,
    replaces_id: null,
  }, {
    version: 2,
    collectible: true,
    replaces_id: current.obligationId,
  }]);
  assert.equal((await sql`select 1 from attempts
    where workspace_id = ${workspaceId}
      and project_id = ${current.projectId}`
    .execute(database.kysely)).rows.length, 0);
  assert.equal((await sql`select 1 from payment_facts
    where workspace_id = ${workspaceId}
      and project_id = ${current.projectId}`
    .execute(database.kysely)).rows.length, 0);
  const correctionHold = (await sql<{ active: boolean }>`select exists (
      select 1 from holds
      where workspace_id = ${workspaceId}
        and project_id = ${current.projectId}
        and concern_id = ${current.concernId}
        and reason = 'correction'
        and resolved_at is null
    ) as active`
    .execute(database.kysely)).rows[0];
  assert.equal(correctionHold?.active, false);
});

test("prior verified payment blocks changed financial republication and preserves every money fact", async () => {
  const current = await fixture("paid-boundary");
  const attemptId = randomUUID();
  const operationId = randomUUID();
  await database.transaction(async (transaction) => {
    await sql`insert into attempts(
        workspace_id,project_id,id,obligation_id,initiated_by,payer_epoch,
        nomination_epoch,state,order_id,resolved_at
      ) values (
        ${workspaceId},${current.projectId},${attemptId}::uuid,
        ${current.obligationId},'synthetic-payer',1,1,'completed',
        'ORDER-PAID-REISSUE',clock_timestamp()
      )`.execute(transaction);
    await sql`insert into operations(
        workspace_id,project_id,id,attempt_id,kind,request,request_hash,
        provider_key,state,admitted_at,admission,result
      ) values (
        ${workspaceId},${current.projectId},${operationId}::uuid,
        ${attemptId}::uuid,'capture','{}'::jsonb,${"b".repeat(64)},
        ${randomUUID()}::uuid,'result',clock_timestamp(),'{}'::jsonb,
        '{"outcome":"completed"}'::jsonb
      )`.execute(transaction);
    await sql`insert into payment_facts(
        workspace_id,project_id,operation_id,capture_id,order_id,merchant_id,
        environment,currency,gross,evidence
      ) values (
        ${workspaceId},${current.projectId},${operationId}::uuid,
        'CAPTURE-PAID-REISSUE','ORDER-PAID-REISSUE',
        'synthetic-merchant','sandbox','USD','300.00',
        '{"kind":"synthetic-paid-lineage"}'::jsonb
      )`.execute(transaction);
  });
  const before = (await sql<{
    versions: number;
    decisions: number;
    obligations: number;
    attempts: number;
    facts: number;
  }>`select
      (select count(*)::integer from unit_versions
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as versions,
      (select count(*)::integer from decisions
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as decisions,
      (select count(*)::integer from obligations
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as obligations,
      (select count(*)::integer from attempts
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as attempts,
      (select count(*)::integer from payment_facts
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as facts`
    .execute(database.kysely)).rows[0];
  assert.ok(before);

  const edited = await assessAndEdit(current);
  const runtime = commercialDependencies();
  const prepared = await runtime.prepareCommercial(
    preparationInput(current, edited.draft),
  );
  const response = await handleCommercialPublishPost(
    request("/commercial/publish", {
      idempotencyKey: randomUUID(),
      draftRevision: edited.draft.revision,
      preparationLocator: prepared.preparationLocator,
      confirmed: true,
    }),
    current.projectId,
    current.requestId,
    current.unitId,
    {
      ...runtime,
      requireSameOrigin: () => undefined,
      verifyProvider: async () => ({ ok: true }),
      authorize: async () => true,
    },
  );
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { code: string }).code,
    "COMMERCIAL_EXTERNAL_FINANCIAL_RESOLUTION_REQUIRED",
  );
  const after = (await sql<typeof before>`select
      (select count(*)::integer from unit_versions
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as versions,
      (select count(*)::integer from decisions
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as decisions,
      (select count(*)::integer from obligations
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as obligations,
      (select count(*)::integer from attempts
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as attempts,
      (select count(*)::integer from payment_facts
        where workspace_id = ${workspaceId}
          and project_id = ${current.projectId}) as facts`
    .execute(database.kysely)).rows[0];
  assert.deepEqual(after, before);
  const payment = (await sql<{
    capture_id: string;
    order_id: string;
    gross: string;
    evidence: unknown;
  }>`select capture_id,order_id,gross,evidence from payment_facts
    where workspace_id = ${workspaceId}
      and project_id = ${current.projectId}
      and operation_id = ${operationId}::uuid`
    .execute(database.kysely)).rows[0];
  assert.deepEqual(payment, {
    capture_id: "CAPTURE-PAID-REISSUE",
    order_id: "ORDER-PAID-REISSUE",
    gross: "300.00",
    evidence: { kind: "synthetic-paid-lineage" },
  });
  const correctionHold = (await sql<{ active: boolean }>`select exists (
      select 1 from holds
      where workspace_id = ${workspaceId}
        and project_id = ${current.projectId}
        and unit_id = ${current.unitId}
        and concern_id = ${current.concernId}
        and reason = 'correction'
        and resolved_at is null
    ) as active`
    .execute(database.kysely)).rows[0];
  assert.equal(correctionHold?.active, true);
});
