import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { createIsolatedProofDatabase, ProtocolDatabase, sql } from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { freezePublishedUnit, parseInput, ProtocolError, publishedUnitSchema } from "@scopeledger/contracts";
import type { Actor, Payer, PaymentObservation, PublishedUnit } from "@scopeledger/contracts";

export function requiredDatabaseUrl(): string {
  const url = process.env.IP01_DATABASE_URL;
  assert.ok(url, "IP01_DATABASE_URL is required: IP-01 must use isolated real PostgreSQL, never skip or substitute an in-memory database");
  return url;
}

export const scope = { workspaceId: "synthetic-workspace", projectId: "synthetic-project" };
export const provider: Actor = { ...scope, actorId: "synthetic-publisher", grantEpoch: 1 };
export const approver: Actor = { ...scope, actorId: "synthetic-approver", grantEpoch: 1 };
export const payerActor: Actor = { ...scope, actorId: "synthetic-payer", grantEpoch: 1 };
export const contributor: Actor = { ...scope, actorId: "synthetic-contributor", grantEpoch: 1 };
export const newCommand = () => ({ commandId: randomUUID() });

export function snapshot(overrides: Record<string, unknown> = {}): PublishedUnit {
  return parseInput(publishedUnitSchema, {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    ...scope, clientId: "synthetic-client", unitId: "unit-a", version: 1, contextRevision: 1,
    title: "Synthetic additional page",
    treatment: "payable",
    scope: ["One populated case-study page"], exclusions: ["Reusable layout already included"],
    dependencies: [],
    baselineReferences: [{ id: "synthetic-baseline", version: 1 }],
    sourceReferences: [{ id: "synthetic-source", version: 1, locator: "Synthetic paragraph 1", availability: "available" }],
    rationale: "Provider-reviewed synthetic rationale: the populated page is additional; the reusable layout is included.",
    approver: { actorId: approver.actorId, nominationEpoch: 1, condition: "Named project approver with explicit authority attestation" },
    timing: { description: "Five working days after agreed prerequisites", deliveryDependencies: ["Included layout precedes final page delivery"] },
    prerequisites: [], reconciliation: [],
    payment: { policy: "full-prepayment", financial: {
      currency: "USD", merchantId: "synthetic-merchant", environment: "sandbox",
      lines: [{ id: "page", description: "One populated page", quantity: "1", unitPrice: "300.00", amount: "300.00" }],
      subtotal: "300.00", tax: { treatment: "none", amount: "0.00", declaration: "Provider-declared synthetic no tax added" }, gross: "300.00",
    } },
    financialEffect: { kind: "new" },
    ...overrides,
  });
}

export function decisionInput(unit: PublishedUnit, decision: "approve" | "decline" = "approve") {
  return {
    ...newCommand(), unitId: unit.unitId, version: unit.version, digest: freezePublishedUnit(unit).digest,
    decision, attestation: { reviewedExactVersion: true as const, authority: decision === "approve", statement: "Explicit synthetic exact-version review and authority attestation" },
  };
}

export function correctionInput(unitId = "unit-a", concernId = "synthetic-concern", unknown = false, packetId = "packet-a") {
  return {
    ...newCommand(), concernId, originUnitId: unitId, packetId,
    scope: unknown ? { kind: "unknown" as const } : { kind: "known" as const, unitIds: [unitId] },
    claim: {
      statement: "Synthetic missing promise may change this unit",
      claimedSourceType: "Unavailable synthetic correspondence",
      source: { availability: "unavailable" as const, explanation: "The contributor cannot supply the source; no fabricated date or reference" },
      sharingAuthorized: true as const, modelProcessingPermitted: false,
    },
  };
}

export async function fixture(t: TestContext) {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  const { database } = isolated;
  const additional: ProtocolDatabase[] = [];
  t.after(async () => {
    for (const connection of additional) await connection.close();
    await isolated.dispose();
  });
  const store = new OrderedConsentStore(database, { observationMode: "local-synthetic-proof" });
  await sql`insert into workspaces(id,merchant_id,environment) values (${scope.workspaceId},'synthetic-merchant','sandbox')`.execute(database.kysely);
  await sql`insert into projects(workspace_id,id,client_id,approver_id)
    values (${scope.workspaceId},${scope.projectId},'synthetic-client',${approver.actorId})`.execute(database.kysely);
  for (const [actor, actions] of [
    [provider, ["publish", "review", "nominate", "inspect"]],
    [approver, ["decide", "correct", "nominate", "inspect"]],
    [payerActor, ["pay", "inspect"]],
    [contributor, ["correct", "inspect"]],
  ] as const) {
    for (const action of actions) {
      await sql`insert into grants(workspace_id,project_id,actor_id,action)
        values (${scope.workspaceId},${scope.projectId},${actor.actorId},${action})`.execute(database.kysely);
    }
  }
  await store.registerContext(provider, {
    ...newCommand(), baseline: { id: "synthetic-baseline", version: 1 },
    sources: [{ id: "synthetic-source", version: 1, availability: "available" }],
  });
  await store.createPacket(provider, { ...newCommand(), packetId: "packet-a" });
  await store.createPacket(provider, { ...newCommand(), packetId: "packet-b" });
  async function addUnit(unitId = "unit-a", packetId = "packet-a", overrides: Record<string, unknown> = {}) {
    await store.createUnit(provider, { ...newCommand(), unitId, packetId });
    const unit = snapshot({ unitId, ...overrides });
    await store.publish(provider, { ...newCommand(), snapshot: unit, expectedPreviousVersion: null });
    return unit;
  }
  async function approveAndNominate(unit: PublishedUnit): Promise<{ payer: Payer; obligationId: string }> {
    const result = await store.decide(approver, decisionInput(unit));
    assert.ok(result.obligationId);
    const nomination = await store.nominatePayer(approver, {
      ...newCommand(), obligationId: result.obligationId, payerId: payerActor.actorId, active: true,
      continuityConfirmed: true, basis: "Separate explicit synthetic obligation-scoped payer nomination",
    });
    return { obligationId: result.obligationId, payer: { ...payerActor, obligationId: result.obligationId, ...nomination } };
  }
  async function connection() {
    const db = new ProtocolDatabase({ connectionString: requiredDatabaseUrl(), schema: isolated.schema, maxConnections: 1 });
    additional.push(db);
    const pid = Number((await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.kysely)).rows[0]?.pid);
    return { database: db, store: new OrderedConsentStore(db, { observationMode: "local-synthetic-proof" }), pid };
  }
  return { ...isolated, store, addUnit, approveAndNominate, connection };
}

/** Every result here is a LOCAL SYNTHETIC FAULT OBSERVATION, never actual PayPal evidence. */
export function syntheticObservation(operationId: string, outcome: PaymentObservation["outcome"], orderId = "synthetic-order"): PaymentObservation {
  return {
    operationId, outcome, orderId, merchantId: "synthetic-merchant", environment: "sandbox", currency: "USD", gross: "300.00",
    evidence: { kind: "synthetic-fault", scenario: "Local deterministic fault evidence; no provider call or provider verification occurred" },
    ...(outcome === "completed" ? { captureId: `synthetic-capture-${operationId}` } : {}),
  };
}

export async function availableOrder(store: OrderedConsentStore, payer: Payer) {
  const intent = await store.initiatePayment(payer, newCommand());
  const lease = await store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  assert.equal((await store.admitDispatch(lease, payer)).dispatchAllowed, true);
  await store.recordObservation(scope, syntheticObservation(intent.operationId, "order-created"));
  return intent;
}

export async function captureIntent(store: OrderedConsentStore, payer: Payer) {
  const created = await availableOrder(store, payer);
  return store.requestCapture(payer, { ...newCommand(), attemptId: created.attemptId, orderId: "synthetic-order" });
}

export function rejectsCode(work: Promise<unknown>, code: ProtocolError["code"]) {
  return assert.rejects(work, (error: unknown) => error instanceof ProtocolError && error.code === code);
}
