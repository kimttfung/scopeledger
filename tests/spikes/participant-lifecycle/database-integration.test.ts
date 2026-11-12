import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  freezePublishedUnit,
  parseInput,
  ProtocolError,
  publishedUnitSchema,
  type Actor,
  type Payer,
  type PaymentObservation,
  type PublishedUnit,
} from "@scopeledger/contracts";
import {
  createIsolatedProofDatabase,
  PostgresAuthoringStore,
  sql,
  type ProtocolDatabase,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  loadPayerPaymentTarget,
  type PaymentLocators,
} from "../../../apps/web/app/api/pay/database.js";
import {
  ParticipantLifecycleStore,
} from "../../../apps/web/app/api/provider/participants/lifecycle-store.js";
import {
  ReviewLocatorCodec,
  type ReviewLocators,
  type ReviewProjection,
  type ReviewSession,
} from "../../../apps/web/app/api/review/service.js";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const fixedApproverId = "cedar-approver";
const fixedPayerId = "cedar-payer";
const secret = "31".repeat(32);

function databaseUrl(): string {
  const value = process.env.IP01_DATABASE_URL
    ?? process.env.SCOPELEDGER_DATABASE_URL;
  assert.ok(value, "A PostgreSQL proof database URL is required");
  return value;
}

function command() {
  return { commandId: randomUUID() };
}

function rejectsProtocol(
  work: Promise<unknown>,
  code: ProtocolError["code"],
) {
  return assert.rejects(
    work,
    (error: unknown) =>
      error instanceof ProtocolError && error.code === code,
  );
}

function participantError(work: Promise<unknown>, code: string) {
  return assert.rejects(
    work,
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === code,
  );
}

async function loadReview(input: Readonly<{
  database: ProtocolDatabase;
  codec: ReviewLocatorCodec;
  expectedSubject: string;
  locators: ReviewLocators;
  session: ReviewSession;
}>): Promise<ReviewProjection> {
  const module = await import(pathToFileURL(resolve(
    "apps/web/app/api/review/database.ts",
  )).href);
  return module.loadDatabaseReview(input);
}

function snapshot(input: Readonly<{
  projectId: string;
  unitId: string;
  version?: number;
  approverEpoch?: number;
  treatment?: "payable" | "additional-waived";
  gross?: string;
}>): PublishedUnit {
  const treatment = input.treatment ?? "payable";
  const gross = input.gross ?? "125.00";
  return parseInput(publishedUnitSchema, {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    workspaceId,
    projectId: input.projectId,
    clientId: "cedar-client",
    unitId: input.unitId,
    version: input.version ?? 1,
    contextRevision: 1,
    title: `${input.unitId} exact terms`,
    treatment,
    scope: [`Perform the exact ${input.unitId} scope.`],
    exclusions: ["No work outside the admitted source."],
    dependencies: [],
    baselineReferences: [{
      id: `${input.projectId}-baseline`,
      version: 1,
    }],
    sourceReferences: [{
      id: `${input.projectId}-source`,
      version: 1,
      locator: "Synthetic agreement section 1",
      availability: "available",
    }],
    rationale: "Provider-reviewed synthetic participant lifecycle fixture.",
    approver: {
      actorId: fixedApproverId,
      nominationEpoch: input.approverEpoch ?? 1,
      condition: "Named project approver with exact-version authority.",
    },
    timing: {
      description: "Delivery follows the recorded agreement.",
      deliveryDependencies: [],
    },
    prerequisites: [],
    reconciliation: [],
    payment: treatment === "payable"
      ? {
        policy: "full-prepayment",
        financial: {
          currency: "USD",
          merchantId: "participant-merchant",
          environment: "sandbox",
          lines: [{
            id: "exact-unit",
            description: "Exact approved participant lifecycle unit.",
            quantity: "1",
            unitPrice: gross,
            amount: gross,
          }],
          subtotal: gross,
          tax: {
            treatment: "none",
            amount: "0.00",
            declaration: "Provider declares no tax is added.",
          },
          gross,
        },
      }
      : {
        policy: "not-required",
        explanation: "The provider deliberately waived this amount.",
      },
    financialEffect: treatment === "payable"
      ? { kind: "new" }
      : { kind: "no-obligation" },
  });
}

function decisionInput(unit: PublishedUnit) {
  return {
    ...command(),
    unitId: unit.unitId,
    version: unit.version,
    digest: freezePublishedUnit(unit).digest,
    decision: "approve" as const,
    attestation: {
      reviewedExactVersion: true as const,
      authority: true,
      statement: "Explicit synthetic exact-version approval authority.",
    },
  };
}

async function fixture(t: TestContext) {
  const isolated = await createIsolatedProofDatabase(databaseUrl());
  t.after(isolated.dispose);
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${workspaceId},'participant-merchant','sandbox')`
    .execute(isolated.database.kysely);
  return {
    ...isolated,
    consent: new OrderedConsentStore(isolated.database, {
      observationMode: "local-synthetic-proof",
    }),
    authoring: new PostgresAuthoringStore(isolated.database),
    lifecycle: new ParticipantLifecycleStore(isolated.database, secret),
  };
}

async function createProject(
  database: ProtocolDatabase,
  authoring: PostgresAuthoringStore,
  consent: OrderedConsentStore,
  projectId: string,
  label: string,
) {
  const requestId = `${projectId}-request`;
  await authoring.createProject({
    workspaceId,
    projectId,
    displayName: label,
    clientId: "cedar-client",
    initialApproverId: fixedApproverId,
    createdBy: providerActorId,
  });
  for (const action of ["inspect", "publish"] as const) {
    await sql`insert into grants(
        workspace_id,project_id,actor_id,action
      ) values (${workspaceId},${projectId},${providerActorId},${action})`
      .execute(database.kysely);
  }
  await authoring.createRequest({
    workspaceId,
    projectId,
    requestId,
    title: `${label} request`,
    createdBy: providerActorId,
  });
  const provider: Actor = {
    workspaceId,
    projectId,
    actorId: providerActorId,
    grantEpoch: 1,
  };
  await consent.registerContext(provider, {
    ...command(),
    baseline: { id: `${projectId}-baseline`, version: 1 },
    sources: [{
      id: `${projectId}-source`,
      version: 1,
      availability: "available",
    }],
  });
  for (const action of ["inspect", "decide", "correct"] as const) {
    await sql`insert into grants(
        workspace_id,project_id,actor_id,action
      ) values (${workspaceId},${projectId},${fixedApproverId},${action})`
      .execute(database.kysely);
  }
  return { provider, requestId };
}

async function publishUnit(
  consent: OrderedConsentStore,
  provider: Actor,
  requestId: string,
  unit: PublishedUnit,
) {
  await consent.createUnit(provider, {
    ...command(),
    packetId: requestId,
    unitId: unit.unitId,
  });
  await consent.publish(provider, {
    ...command(),
    snapshot: unit,
    expectedPreviousVersion: null,
  });
}

function syntheticObservation(
  operationId: string,
  outcome: PaymentObservation["outcome"],
): PaymentObservation {
  return {
    operationId,
    outcome,
    orderId: "participant-order",
    merchantId: "participant-merchant",
    environment: "sandbox",
    currency: "USD",
    gross: "125.00",
    evidence: {
      kind: "synthetic-fault",
      scenario: "Local participant lifecycle recovery proof.",
    },
    ...(outcome === "completed"
      ? { captureId: `participant-capture-${operationId}` }
      : {}),
  };
}

test("approver revoke and old-actor restore use fresh epochs without rewriting history", async (t) => {
  const f = await fixture(t);
  const projectId = `approver-lifecycle-${randomUUID().slice(0, 8)}`;
  const otherProjectId = `${projectId}-other`;
  const { provider, requestId } = await createProject(
    f.database,
    f.authoring,
    f.consent,
    projectId,
    "Harbor approver lifecycle",
  );
  await createProject(
    f.database,
    f.authoring,
    f.consent,
    otherProjectId,
    "Other protected project",
  );
  const accepted = snapshot({
    projectId,
    unitId: "accepted-waived-unit",
    treatment: "additional-waived",
  });
  const pending = snapshot({
    projectId,
    unitId: "pending-payable-unit",
  });
  await publishUnit(f.consent, provider, requestId, accepted);
  await publishUnit(f.consent, provider, requestId, pending);
  const approver: Actor = {
    workspaceId,
    projectId,
    actorId: fixedApproverId,
    grantEpoch: 1,
  };
  await f.consent.decide(approver, decisionInput(accepted));
  const historicDecision = (await sql`select * from decisions
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and unit_id = ${accepted.unitId}`
    .execute(f.database.kysely)).rows;
  const historicVersions = (await sql<{
    unit_id: string;
    version: number;
    digest: string;
    canonical_bytes: Buffer;
    published_by: string;
  }>`select unit_id,version,digest,canonical_bytes,published_by
    from unit_versions
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
    order by unit_id collate "C",version`
    .execute(f.database.kysely)).rows;
  const reviewCodec = new ReviewLocatorCodec(secret);
  const locators = {
    projectLocator: reviewCodec.project(workspaceId, projectId),
    requestLocator: reviewCodec.request(
      workspaceId,
      projectId,
      requestId,
    ),
    unitLocator: reviewCodec.unit(
      workspaceId,
      projectId,
      requestId,
      pending.unitId,
    ),
  };
  const session = {
    role: "client-approver" as const,
    subject: "still-valid-local-session",
  };
  assert.equal((await loadReview({
    database: f.database,
    codec: reviewCodec,
    expectedSubject: session.subject,
    locators,
    session,
  })).unit.version, 1);

  const listed = await f.lifecycle.list();
  const selected = listed.find((participant) =>
    participant.kind === "project-approver"
    && participant.projectLabel === "Harbor approver lifecycle");
  assert.ok(selected);
  assert.doesNotMatch(
    JSON.stringify(listed),
    /approver-lifecycle-|cedar-approver|nominationEpoch|grantEpoch|actorId/,
  );
  const revokePreview = await f.lifecycle.preview(
    selected.selector,
    "revoke-approver",
  );
  const revoked = await f.lifecycle.confirm(
    revokePreview.confirmationLocator,
  );
  const revokeReplay = await f.lifecycle.confirm(
    revokePreview.confirmationLocator,
  );
  assert.equal(revoked.duplicate, false);
  assert.equal(revokeReplay.duplicate, true);
  assert.equal(revoked.participant.status, "revoked");
  await assert.rejects(
    loadReview({
      database: f.database,
      codec: reviewCodec,
      expectedSubject: session.subject,
      locators,
      session,
    }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "NOT_FOUND",
  );
  await rejectsProtocol(
    f.consent.decide(approver, decisionInput(pending)),
    "ACCESS_DENIED",
  );
  const otherGrantsBefore = (await sql<{
    action: string;
    epoch: number;
    active: boolean;
  }>`select action,epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${otherProjectId}
      and actor_id = ${fixedApproverId}
    order by action collate "C"`
    .execute(f.database.kysely)).rows;

  const replacementId = "temporary-demo-approver";
  await sql`update projects
    set approver_id = ${replacementId},nomination_epoch = 2
    where workspace_id = ${workspaceId}
      and id = ${projectId}`
    .execute(f.database.kysely);
  for (const action of ["inspect", "decide", "correct"] as const) {
    await sql`insert into grants(
        workspace_id,project_id,actor_id,action,active
      ) values (
        ${workspaceId},${projectId},${replacementId},${action},true
      )`
      .execute(f.database.kysely);
  }
  const replacement = (await f.lifecycle.list()).find((participant) =>
    participant.selector === selected.selector);
  assert.equal(replacement?.status, "replacement-active");
  const restorePreview = await f.lifecycle.preview(
    selected.selector,
    "restore-approver",
  );
  assert.equal(restorePreview.requiresReissue, true);
  const restored = await f.lifecycle.confirm(
    restorePreview.confirmationLocator,
  );
  const restoreReplay = await f.lifecycle.confirm(
    restorePreview.confirmationLocator,
  );
  assert.equal(restored.duplicate, false);
  assert.equal(restoreReplay.duplicate, true);
  assert.equal(restored.participant.status, "active");
  assert.deepEqual((await sql<{
    approver_id: string;
    nomination_epoch: number;
  }>`select approver_id,nomination_epoch from projects
    where workspace_id = ${workspaceId}
      and id = ${projectId}`
    .execute(f.database.kysely)).rows[0], {
    approver_id: fixedApproverId,
    nomination_epoch: 3,
  });
  assert.deepEqual((await sql<{
    action: string;
    epoch: number;
    active: boolean;
  }>`select action,epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and actor_id = ${fixedApproverId}
      and action = any(${["inspect", "decide", "correct"]}::text[])
    order by action collate "C"`
    .execute(f.database.kysely)).rows, [
    { action: "correct", epoch: 3, active: true },
    { action: "decide", epoch: 3, active: true },
    { action: "inspect", epoch: 3, active: true },
  ]);
  await assert.rejects(
    loadReview({
      database: f.database,
      codec: reviewCodec,
      expectedSubject: session.subject,
      locators,
      session,
    }),
    (error: unknown) =>
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "STALE_RECORD",
  );
  await rejectsProtocol(
    f.consent.decide(
      { ...approver, grantEpoch: 3 },
      decisionInput(pending),
    ),
    "ACCESS_DENIED",
  );
  await participantError(
    f.lifecycle.confirm(revokePreview.confirmationLocator),
    "STALE_CONTEXT",
  );
  assert.deepEqual((await sql`select * from decisions
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and unit_id = ${accepted.unitId}`
    .execute(f.database.kysely)).rows, historicDecision);
  assert.deepEqual((await sql<{
    unit_id: string;
    version: number;
    digest: string;
    canonical_bytes: Buffer;
    published_by: string;
  }>`select unit_id,version,digest,canonical_bytes,published_by
    from unit_versions
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
    order by unit_id collate "C",version`
    .execute(f.database.kysely)).rows, historicVersions);
  assert.deepEqual((await sql<{
    action: string;
    epoch: number;
    active: boolean;
  }>`select action,epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${otherProjectId}
      and actor_id = ${fixedApproverId}
    order by action collate "C"`
    .execute(f.database.kysely)).rows, otherGrantsBefore);
});

test("payer revoke blocks new admissions while admitted capture recovery and fresh-epoch replacement remain safe", async (t) => {
  const f = await fixture(t);
  const recoveryProjectId =
    `payer-recovery-${randomUUID().slice(0, 8)}`;
  const restoreProjectId =
    `payer-restore-${randomUUID().slice(0, 8)}`;
  const recoveryProject = await createProject(
    f.database,
    f.authoring,
    f.consent,
    recoveryProjectId,
    "Harbor admitted capture",
  );
  const restoreProject = await createProject(
    f.database,
    f.authoring,
    f.consent,
    restoreProjectId,
    "Harbor payer replacement",
  );
  const recoveryUnit = snapshot({
    projectId: recoveryProjectId,
    unitId: "recovery-unit",
  });
  const restoreUnit = snapshot({
    projectId: restoreProjectId,
    unitId: "restore-unit",
  });
  await publishUnit(
    f.consent,
    recoveryProject.provider,
    recoveryProject.requestId,
    recoveryUnit,
  );
  await publishUnit(
    f.consent,
    restoreProject.provider,
    restoreProject.requestId,
    restoreUnit,
  );
  const recoveryDecision = await f.consent.decide({
    workspaceId,
    projectId: recoveryProjectId,
    actorId: fixedApproverId,
    grantEpoch: 1,
  }, decisionInput(recoveryUnit));
  const restoreDecision = await f.consent.decide({
    workspaceId,
    projectId: restoreProjectId,
    actorId: fixedApproverId,
    grantEpoch: 1,
  }, decisionInput(restoreUnit));
  assert.ok(recoveryDecision.obligationId);
  assert.ok(restoreDecision.obligationId);
  const recoveryActivation = await f.consent.activatePayerAuthority(
    recoveryProject.provider,
    {
      ...command(),
      obligationId: recoveryDecision.obligationId,
      unitId: recoveryUnit.unitId,
      version: 1,
      digest: freezePublishedUnit(recoveryUnit).digest,
      payerId: fixedPayerId,
    },
  );
  const restoreActivation = await f.consent.activatePayerAuthority(
    restoreProject.provider,
    {
      ...command(),
      obligationId: restoreDecision.obligationId,
      unitId: restoreUnit.unitId,
      version: 1,
      digest: freezePublishedUnit(restoreUnit).digest,
      payerId: fixedPayerId,
    },
  );
  const recoveryPayer: Payer = {
    workspaceId,
    projectId: recoveryProjectId,
    actorId: fixedPayerId,
    grantEpoch: recoveryActivation.grantEpoch,
    obligationId: recoveryDecision.obligationId,
    payerEpoch: recoveryActivation.payerEpoch,
    nominationEpoch: recoveryActivation.nominationEpoch,
  };
  const create = await f.consent.initiatePayment(
    recoveryPayer,
    command(),
  );
  const createLease = await f.consent.claimOperation(
    { workspaceId, projectId: recoveryProjectId },
    { operationId: create.operationId, leaseMilliseconds: 60_000 },
  );
  await f.consent.admitDispatch(createLease, recoveryPayer);
  await f.consent.recordObservation(
    { workspaceId, projectId: recoveryProjectId },
    syntheticObservation(create.operationId, "order-created"),
  );
  const capture = await f.consent.requestCapture(recoveryPayer, {
    ...command(),
    attemptId: create.attemptId,
    orderId: "participant-order",
  });
  const captureLease = await f.consent.claimOperation(
    { workspaceId, projectId: recoveryProjectId },
    { operationId: capture.operationId, leaseMilliseconds: 60_000 },
  );
  await f.consent.admitDispatch(captureLease, recoveryPayer);
  const decisionsBefore = (await sql`select * from decisions
    order by project_id collate "C",unit_id collate "C"`
    .execute(f.database.kysely)).rows;
  const admittedBefore = (await sql<{
    admitted_at: Date;
    admission: unknown;
  }>`select admitted_at,admission from operations
    where workspace_id = ${workspaceId}
      and project_id = ${recoveryProjectId}
      and id = ${capture.operationId}::uuid`
    .execute(f.database.kysely)).rows[0];

  const recoveryParticipant = (await f.lifecycle.list()).find((participant) =>
    participant.kind === "obligation-payer"
    && participant.projectLabel === "Harbor admitted capture");
  assert.ok(recoveryParticipant);
  assert.equal(recoveryParticipant.recovery, "admitted-capture");
  const revokePreview = await f.lifecycle.preview(
    recoveryParticipant.selector,
    "revoke-payer",
  );
  assert.equal(revokePreview.admittedCaptureRecoveryPreserved, true);
  const revoked = await f.lifecycle.confirm(
    revokePreview.confirmationLocator,
  );
  const replay = await f.lifecycle.confirm(
    revokePreview.confirmationLocator,
  );
  assert.equal(revoked.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(revoked.participant.status, "revoked");
  await rejectsProtocol(
    f.consent.initiatePayment(recoveryPayer, command()),
    "ACCESS_DENIED",
  );
  await rejectsProtocol(
    f.consent.admitDispatch(captureLease, recoveryPayer),
    "ACCESS_DENIED",
  );

  const reviewCodec = new ReviewLocatorCodec(secret);
  const paymentLocators: PaymentLocators = {
    projectLocator: reviewCodec.project(
      workspaceId,
      recoveryProjectId,
    ),
    requestLocator: reviewCodec.request(
      workspaceId,
      recoveryProjectId,
      recoveryProject.requestId,
    ),
    unitLocator: reviewCodec.unit(
      workspaceId,
      recoveryProjectId,
      recoveryProject.requestId,
      recoveryUnit.unitId,
    ),
    payerLocator: reviewCodec.payer(
      workspaceId,
      recoveryProjectId,
      recoveryProject.requestId,
      recoveryUnit.unitId,
      1,
      freezePublishedUnit(recoveryUnit).digest,
      recoveryDecision.obligationId,
      fixedPayerId,
    ),
  };
  const recoveryTarget = await loadPayerPaymentTarget({
    database: f.database,
    codec: reviewCodec,
    locators: paymentLocators,
    subject: "still-valid-payer-session",
    expectedSubject: "still-valid-payer-session",
  });
  assert.equal(recoveryTarget.payer, null);
  assert.equal(recoveryTarget.admittedCaptureRecovery, true);
  const recoveryAdmission =
    await f.consent.captureReconciliationAdmission(
      { workspaceId, projectId: recoveryProjectId },
      "participant-order",
    );
  assert.equal(recoveryAdmission.operationId, capture.operationId);
  await f.consent.recordObservation(
    { workspaceId, projectId: recoveryProjectId },
    syntheticObservation(capture.operationId, "completed"),
  );
  assert.equal((await f.lifecycle.confirm(
    revokePreview.confirmationLocator,
  )).duplicate, true);
  assert.equal((await sql<{ count: number }>`select count(*)::integer as count
    from payment_facts
    where workspace_id = ${workspaceId}
      and project_id = ${recoveryProjectId}`
    .execute(f.database.kysely)).rows[0]?.count, 1);
  assert.deepEqual((await sql<{
    admitted_at: Date;
    admission: unknown;
  }>`select admitted_at,admission from operations
    where workspace_id = ${workspaceId}
      and project_id = ${recoveryProjectId}
      and id = ${capture.operationId}::uuid`
    .execute(f.database.kysely)).rows[0], admittedBefore);

  const restoreParticipant = (await f.lifecycle.list()).find((participant) =>
    participant.kind === "obligation-payer"
    && participant.projectLabel === "Harbor payer replacement");
  assert.ok(restoreParticipant);
  const restoreRevoke = await f.lifecycle.preview(
    restoreParticipant.selector,
    "revoke-payer",
  );
  await f.lifecycle.confirm(restoreRevoke.confirmationLocator);
  const replacementPayer = "temporary-demo-payer";
  await sql`update payer_nominations
    set actor_id = ${replacementPayer},epoch = epoch + 1,
        continuity_epoch = 1,active = true,
        nominated_by = ${providerActorId},
        basis = 'Explicit synthetic replacement payer.'
    where workspace_id = ${workspaceId}
      and project_id = ${restoreProjectId}
      and obligation_id = ${restoreDecision.obligationId}`
    .execute(f.database.kysely);
  await sql`insert into grants(
      workspace_id,project_id,actor_id,action,active
    ) values (
      ${workspaceId},${restoreProjectId},${replacementPayer},'pay',true
    )`
    .execute(f.database.kysely);
  const replacement = (await f.lifecycle.list()).find((participant) =>
    participant.selector === restoreParticipant.selector);
  assert.equal(replacement?.status, "replacement-active");
  const restorePreview = await f.lifecycle.preview(
    restoreParticipant.selector,
    "restore-payer",
  );
  const restored = await f.lifecycle.confirm(
    restorePreview.confirmationLocator,
  );
  const restoredReplay = await f.lifecycle.confirm(
    restorePreview.confirmationLocator,
  );
  assert.equal(restored.duplicate, false);
  assert.equal(restoredReplay.duplicate, true);
  assert.equal(restored.participant.status, "active");
  assert.deepEqual((await sql<{
    actor_id: string;
    epoch: number;
    continuity_epoch: number;
    active: boolean;
  }>`select actor_id,epoch,continuity_epoch,active
    from payer_nominations
    where workspace_id = ${workspaceId}
      and project_id = ${restoreProjectId}
      and obligation_id = ${restoreDecision.obligationId}`
    .execute(f.database.kysely)).rows[0], {
    actor_id: fixedPayerId,
    epoch: 4,
    continuity_epoch: 1,
    active: true,
  });
  const restoredGrant = (await sql<{
    epoch: number;
    active: boolean;
  }>`select epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${restoreProjectId}
      and actor_id = ${fixedPayerId}
      and action = 'pay'`
    .execute(f.database.kysely)).rows[0];
  assert.deepEqual(restoredGrant, { epoch: 3, active: true });
  const stalePayer: Payer = {
    workspaceId,
    projectId: restoreProjectId,
    actorId: fixedPayerId,
    grantEpoch: restoreActivation.grantEpoch,
    obligationId: restoreDecision.obligationId,
    payerEpoch: restoreActivation.payerEpoch,
    nominationEpoch: restoreActivation.nominationEpoch,
  };
  await rejectsProtocol(
    f.consent.initiatePayment(stalePayer, command()),
    "ACCESS_DENIED",
  );
  const currentPayer: Payer = {
    ...stalePayer,
    grantEpoch: restoredGrant!.epoch,
    payerEpoch: 4,
  };
  const freshIntent = await f.consent.initiatePayment(
    currentPayer,
    command(),
  );
  assert.ok(freshIntent.operationId);
  assert.deepEqual((await sql`select * from decisions
    order by project_id collate "C",unit_id collate "C"`
    .execute(f.database.kysely)).rows, decisionsBefore);
  assert.deepEqual((await sql<{
    epoch: number;
    active: boolean;
  }>`select epoch,active from grants
    where workspace_id = ${workspaceId}
      and project_id = ${recoveryProjectId}
      and actor_id = ${fixedPayerId}
      and action = 'pay'`
    .execute(f.database.kysely)).rows[0], {
    epoch: 2,
    active: false,
  });
});
