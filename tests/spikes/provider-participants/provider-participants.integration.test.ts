import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  createIsolatedProofDatabase,
  PostgresAuthoringStore,
  sql,
  type ProtocolDatabase,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  ReviewLoadError,
  ReviewLocatorCodec,
  type ReviewLocators,
  type ReviewProjection,
  type ReviewSession,
} from "../../../apps/web/app/api/review/service.js";

const secret = "a".repeat(64);
const workspaceId = "demo-workspace";
const providerId = "northstar-provider";
const approverId = "cedar-approver";
const clientId = "cedar-client";

type Activation = Readonly<{
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

type Authority = Readonly<{
  previewActivation: (
    input: Readonly<{ projectId: string }>,
  ) => Promise<Activation>;
  activate: (
    input: Readonly<{
      projectId: string;
      confirmationLocator: string;
    }>,
  ) => Promise<Readonly<{
    activation: Activation;
    duplicate: boolean;
  }>>;
}>;

async function runtimeModules() {
  const [participant, review] = await Promise.all([
    import(pathToFileURL(resolve(
      "apps/web/app/api/provider/authoring/participant-runtime.ts",
    )).href),
    import(pathToFileURL(resolve(
      "apps/web/app/api/review/database.ts",
    )).href),
  ]);
  return {
    createAuthority: participant.createLocalClientApproverAuthority as (
      input: Readonly<{ database: ProtocolDatabase; secret: string }>,
    ) => Authority,
    loadReview: review.loadDatabaseReview as (
      input: Readonly<{
        database: ProtocolDatabase;
        codec: ReviewLocatorCodec;
        expectedSubject: string;
        locators: ReviewLocators;
        session: ReviewSession;
      }>,
    ) => Promise<ReviewProjection>,
    loadMutationBasis: review.loadDatabaseReviewMutationBasis as (
      input: Readonly<{
        database: ProtocolDatabase;
        codec: ReviewLocatorCodec;
        expectedSubject: string;
        locators: ReviewLocators;
        session: ReviewSession & Readonly<{ challengeId: string }>;
      }>,
    ) => Promise<Readonly<{
      actorId: string;
      decideGrantEpoch: number;
      correctGrantEpoch: number | null;
    }>>,
  };
}

function requiredDatabaseUrl(): string {
  const value = process.env.IP01_DATABASE_URL
    ?? process.env.SCOPELEDGER_DATABASE_URL;
  assert.ok(
    value,
    "IP01_DATABASE_URL is required: participant integration uses isolated PostgreSQL",
  );
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function publishedProject(t: TestContext) {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  const suffix = randomUUID().slice(0, 8);
  const projectId = `participant-project-${suffix}`;
  const requestId = `participant-request-${suffix}`;
  const unitId = `participant-unit-${suffix}`;
  const sourceId = `participant-source-${suffix}`;
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${workspaceId},'participant-merchant','sandbox')`
    .execute(isolated.database.kysely);
  const authoring = new PostgresAuthoringStore(isolated.database);
  await authoring.createProject({
    workspaceId,
    projectId,
    displayName: "Harbor custom terms",
    clientId,
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
    title: "Harbor custom review",
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
    originalName: "harbor-custom-terms.pdf",
    declaredByteLength: 20,
    contentDigest: sha256("harbor-custom-terms"),
    provenance: {
      origin: "agreement",
      suppliedBy: providerId,
      originReference: "Harbor agreement section 1",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Authenticated provider attested this synthetic source.",
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
  const provider = {
    workspaceId,
    projectId,
    actorId: providerId,
    grantEpoch: 1,
  };
  const consent = new OrderedConsentStore(isolated.database);
  await consent.confirmProviderBaseline(provider, {
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
    title: "Harbor custom implementation",
    summary: "Exact immutable draft prepared for local client review.",
    scope: ["Implement the exact Harbor custom unit."],
    exclusions: ["No work outside the admitted source."],
    sourceReferences: [{ sourceId, version: 1 }],
    authoredBy: providerId,
  });
  const preparationId = randomUUID();
  await consent.prepareCommercial(provider, {
    commandId: randomUUID(),
    preparationId,
    requestId,
    unitId,
    draftRevision: 1,
    treatment: "waived",
    independenceExplanation:
      "The provider independently reviewed this as one decidable unit.",
    dependencies: [],
    clientVisibleRationale:
      "The provider deliberately waives any additional amount for this unit.",
    delivery: {
      description: "Delivery occurs within five working days.",
      dependencies: [],
    },
    prerequisites: [],
    consentRequirement: "required",
    paymentExplanation: "No payment is required for this deliberate waiver.",
    tax: {
      treatment: "not-applicable",
      amount: "0.00",
      declaration: "Tax is not applicable because no amount is collectible.",
    },
    price: null,
    sourceCoverage: [{
      sourceId,
      version: 1,
      locator: "Harbor agreement section 1",
      materiality: "material",
      coverageStatus: "covered",
      analysisStatus: "not-used",
      analysisReference: null,
      explanation: "The authenticated provider reviewed this exact source.",
    }],
  });
  await consent.publishPrepared(provider, {
    commandId: randomUUID(),
    preparationId,
  });
  return {
    ...isolated,
    authoring,
    projectId,
    requestId,
    unitId,
  };
}

test("explicit activation grants only current project review authority and unlocks the opaque review", async (t) => {
  const fixture = await publishedProject(t);
  const {
    createAuthority,
    loadReview,
    loadMutationBasis,
  } = await runtimeModules();
  const codec = new ReviewLocatorCodec(secret);
  const locators = {
    projectLocator: codec.project(workspaceId, fixture.projectId),
    requestLocator: codec.request(
      workspaceId,
      fixture.projectId,
      fixture.requestId,
    ),
    unitLocator: codec.unit(
      workspaceId,
      fixture.projectId,
      fixture.requestId,
      fixture.unitId,
    ),
  };
  const session = {
    role: "client-approver" as const,
    subject: "verified-local-client",
  };
  await assert.rejects(
    loadReview({
      database: fixture.database,
      codec,
      expectedSubject: session.subject,
      locators,
      session,
    }),
    (error: unknown) =>
      error instanceof ReviewLoadError
      && error.code === "NOT_FOUND",
  );

  const before = {
    project: (await sql<{
      approver_id: string;
      nomination_epoch: number;
    }>`select approver_id,nomination_epoch from projects
      where workspace_id = ${workspaceId}
        and id = ${fixture.projectId}`
      .execute(fixture.database.kysely)).rows,
    decisions: (await sql`select * from decisions
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}`
      .execute(fixture.database.kysely)).rows,
    versions: (await sql<{
      unit_id: string;
      version: number;
      published_by: string;
      digest: string;
    }>`select unit_id,version,published_by,digest from unit_versions
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
      order by unit_id collate "C",version`
      .execute(fixture.database.kysely)).rows,
    history: (await sql<{
      sequence: string;
      actor_id: string;
      event: string;
      resource_id: string;
      detail: unknown;
    }>`select sequence::text,actor_id,event,resource_id,detail
      from protocol_history
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
      order by sequence`
      .execute(fixture.database.kysely)).rows,
  };

  const authority = createAuthority({
    database: fixture.database,
    secret,
  });
  const preview = await authority.previewActivation({
    projectId: fixture.projectId,
  });
  assert.equal(preview.status, "ready");
  assert.equal(preview.authority.pay, false);
  assert.equal(preview.localChannelVerification, "separate");
  const first = await authority.activate({
    projectId: fixture.projectId,
    confirmationLocator: preview.confirmationLocator,
  });
  const replay = await authority.activate({
    projectId: fixture.projectId,
    confirmationLocator: preview.confirmationLocator,
  });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.activation, first.activation);

  const otherProjectId = `${fixture.projectId}-other`;
  await fixture.authoring.createProject({
    workspaceId,
    projectId: otherProjectId,
    displayName: "Other provider project",
    clientId,
    initialApproverId: approverId,
    createdBy: providerId,
  });
  const otherPreview = await authority.previewActivation({
    projectId: otherProjectId,
  });
  assert.notEqual(
    otherPreview.confirmationLocator,
    preview.confirmationLocator,
  );
  await assert.rejects(
    authority.activate({
      projectId: otherProjectId,
      confirmationLocator: preview.confirmationLocator,
    }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "STALE_CONTEXT",
  );
  assert.equal((await sql<{ count: number }>`select count(*)::integer as count
    from grants
    where workspace_id = ${workspaceId}
      and project_id = ${otherProjectId}
      and actor_id = ${approverId}`
    .execute(fixture.database.kysely)).rows[0]?.count, 0);
  await sql`update projects
    set approver_id = 'replacement-approver',
        nomination_epoch = nomination_epoch + 1
    where workspace_id = ${workspaceId}
      and id = ${otherProjectId}`
    .execute(fixture.database.kysely);
  await assert.rejects(
    authority.previewActivation({ projectId: otherProjectId }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "STALE_CONTEXT",
  );

  const grants = (await sql<{
    action: string;
    epoch: number;
    active: boolean;
  }>`select action,epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and actor_id = ${approverId}
    order by action collate "C"`
    .execute(fixture.database.kysely)).rows;
  assert.deepEqual(grants, [
    { action: "correct", epoch: 1, active: true },
    { action: "decide", epoch: 1, active: true },
    { action: "inspect", epoch: 1, active: true },
  ]);
  const financialAuthority = (await sql<{
    payer_grants: number;
    payer_nominations: number;
  }>`select
      (select count(*)::integer from grants
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}
          and action = 'pay') as payer_grants,
      (select count(*)::integer from payer_nominations
        where workspace_id = ${workspaceId}
          and project_id = ${fixture.projectId}) as payer_nominations`
    .execute(fixture.database.kysely)).rows[0];
  assert.deepEqual(financialAuthority, {
    payer_grants: 0,
    payer_nominations: 0,
  });

  const after = {
    project: (await sql<{
      approver_id: string;
      nomination_epoch: number;
    }>`select approver_id,nomination_epoch from projects
      where workspace_id = ${workspaceId}
        and id = ${fixture.projectId}`
      .execute(fixture.database.kysely)).rows,
    decisions: (await sql`select * from decisions
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}`
      .execute(fixture.database.kysely)).rows,
    versions: (await sql<{
      unit_id: string;
      version: number;
      published_by: string;
      digest: string;
    }>`select unit_id,version,published_by,digest from unit_versions
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
      order by unit_id collate "C",version`
      .execute(fixture.database.kysely)).rows,
    history: (await sql<{
      sequence: string;
      actor_id: string;
      event: string;
      resource_id: string;
      detail: unknown;
    }>`select sequence::text,actor_id,event,resource_id,detail
      from protocol_history
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and event <> 'local-client-approver-activated'
      order by sequence`
      .execute(fixture.database.kysely)).rows,
  };
  assert.deepEqual(after, before);
  const activationEvents = (await sql<{ count: number }>`select
      count(*)::integer as count from protocol_history
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and event = 'local-client-approver-activated'`
    .execute(fixture.database.kysely)).rows[0]?.count;
  assert.equal(activationEvents, 1);
  const activationReceipts = (await sql<{ count: number }>`select
      count(*)::integer as count from command_receipts
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and actor_id = ${providerId}
        and action = 'publish'
        and result->'grantEpochs' is not null`
    .execute(fixture.database.kysely)).rows[0]?.count;
  assert.equal(activationReceipts, 1);

  const review = await loadReview({
    database: fixture.database,
    codec,
    expectedSubject: session.subject,
    locators,
    session,
  });
  assert.equal(review.project.label, "Harbor custom terms");
  assert.equal(review.unit.version, 1);
  const endpointParts = review.actions.endpoint.split("/");
  const mutation = await loadMutationBasis({
    database: fixture.database,
    codec,
    expectedSubject: session.subject,
    locators: {
      projectLocator: endpointParts.at(-3)!,
      requestLocator: endpointParts.at(-2)!,
      unitLocator: endpointParts.at(-1)!,
    },
    session: {
      ...session,
      challengeId: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(mutation.actorId, approverId);
  assert.equal(mutation.decideGrantEpoch, 1);
  assert.equal(mutation.correctGrantEpoch, 1);

  await sql`update grants
    set active = false,epoch = epoch + 1
    where workspace_id = ${workspaceId}
      and project_id = ${fixture.projectId}
      and actor_id = ${approverId}
      and action = 'correct'`
    .execute(fixture.database.kysely);
  const currentMutation = await loadMutationBasis({
    database: fixture.database,
    codec,
    expectedSubject: session.subject,
    locators: {
      projectLocator: endpointParts.at(-3)!,
      requestLocator: endpointParts.at(-2)!,
      unitLocator: endpointParts.at(-1)!,
    },
    session: {
      ...session,
      challengeId: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.equal(currentMutation.correctGrantEpoch, null);
  await assert.rejects(
    authority.activate({
      projectId: fixture.projectId,
      confirmationLocator: preview.confirmationLocator,
    }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "STALE_CONTEXT",
  );
  const revoked = (await sql<{ active: boolean; epoch: number }>`select
      active,epoch from grants
      where workspace_id = ${workspaceId}
        and project_id = ${fixture.projectId}
        and actor_id = ${approverId}
        and action = 'correct'`
    .execute(fixture.database.kysely)).rows[0];
  assert.deepEqual(revoked, { active: false, epoch: 2 });
});
