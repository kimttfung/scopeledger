import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import type { PaymentObservation } from "@scopeledger/contracts";
import {
  approver, captureIntent, contributor, correctionInput, decisionInput, fixture, newCommand, payerActor,
  provider, rejectsCode, scope, snapshot, syntheticObservation,
} from "./support/fixture.js";

/** Locally injected adapter-contract fixture ONLY; no provider retrieval/authentication occurs. */
function injectedAdapterContractObservation(operationId: string, outcome: "order-created" | "completed", reference: string): PaymentObservation {
  return {
    ...syntheticObservation(operationId, outcome),
    evidence: { kind: "authenticated-adapter", verificationReference: `synthetic-local-contract-${reference}` },
  };
}

test("default library mode rejects synthetic observations; local fault success requires an explicit sandbox proof configuration", async (t) => {
  const f = await fixture(t);
  const productionDefault = new OrderedConsentStore(f.database);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const intent = await f.store.initiatePayment(payer, newCommand());
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(lease, payer);
  await rejectsCode(productionDefault.recordObservation(scope, syntheticObservation(intent.operationId, "order-created")), "ACCESS_DENIED");
  await rejectsCode(f.store.recordObservation(scope, { ...syntheticObservation(intent.operationId, "order-created"), environment: "live" }), "ACCESS_DENIED");
  assert.equal((await sql`select 1 from observations`.execute(f.database.kysely)).rows.length, 0);
  assert.equal((await f.store.recordObservation(scope, syntheticObservation(intent.operationId, "order-created"))).matchesBasis, true);
});

test("expired and replaced leases never become fresh dispatch permission; admission replay is reconcile-only", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const intent = await f.store.initiatePayment(payer, newCommand());
  const stale = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 1 });
  const deadline = Date.now() + 2_000;
  while (true) {
    const expired = (await sql<{ expired: boolean }>`select clock_timestamp() >= lease_expires_at as expired
      from operations where id = ${intent.operationId}::uuid`.execute(f.database.kysely)).rows[0]?.expired;
    if (expired) break;
    assert.ok(Date.now() < deadline, "Lease expiry must be observed in PostgreSQL");
    await delay(1);
  }
  await rejectsCode(f.store.admitDispatch(stale, payer), "STALE_LEASE");
  assert.equal((await sql`select 1 from operations where admitted_at is not null`.execute(f.database.kysely)).rows.length, 0);
  const current = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  assert.equal(current.generation, stale.generation + 1);
  await rejectsCode(f.store.admitDispatch(stale, payer), "STALE_LEASE");
  const first = await f.store.admitDispatch(current, payer);
  assert.equal(first.dispatchAllowed, true);
  assert.equal((await f.store.admitDispatch(current, payer)).dispatchAllowed, false);
  await rejectsCode(f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 1 }), "RECONCILIATION_REQUIRED");
  await f.store.markOutcomeUnknown({ ...scope, operationId: intent.operationId }, "process-recovery");
  assert.equal((await f.store.admitDispatch(current, payer)).reconciliationRequired, true);
  await rejectsCode(f.store.retireCreateOnlyAttempt(payer), "RETIREMENT_DISABLED");
  assert.equal((await f.store.initiatePayment(payer, newCommand())).operationId, intent.operationId);
});

test("delayed external transport holds no DB transaction/unit locks; later correction/revocation cannot suppress original admitted facts", async (t) => {
  const f = await fixture(t);
  const { payer, obligationId } = await f.approveAndNominate(await f.addUnit());
  const intent = await captureIntent(f.store, payer);
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  const dispatcher = await f.connection();
  const correcting = await f.connection();
  let releaseTransport!: () => void;
  const transportGate = new Promise<void>((resolve) => { releaseTransport = resolve; });
  let enteredTransport!: () => void;
  const entered = new Promise<void>((resolve) => { enteredTransport = resolve; });
  let calls = 0;
  const running = dispatcher.store.dispatch(lease, payer, async (admission) => {
    calls += 1;
    assert.equal(admission.operationId, intent.operationId);
    enteredTransport();
    await transportGate;
    return syntheticObservation(intent.operationId, "completed");
  });
  try {
    await entered;
    const backend = (await f.database.pool.query<{ state: string; xact_start: Date | null }>(
      "select state,xact_start from pg_stat_activity where pid = $1", [dispatcher.pid],
    )).rows[0];
    assert.equal(backend?.state, "idle");
    assert.equal(backend?.xact_start, null);
    await correcting.store.admitCorrection(contributor, correctionInput());
    await correcting.store.nominatePayer(provider, {
      ...newCommand(), obligationId, payerId: payerActor.actorId, active: false, continuityConfirmed: true,
      basis: "Prospective revocation while already-admitted synthetic I/O remains delayed",
    });
    assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 0);
    releaseTransport();
    assert.equal((await running).dispatchAllowed, true);
  } finally {
    releaseTransport();
    await running;
  }
  assert.equal(calls, 1);
  assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "review-hold");
});

test("a transport fault remains unknown on the stable operation; replay never automatically dispatches another external write", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const intent = await captureIntent(f.store, payer);
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  let calls = 0;
  await rejectsCode(f.store.dispatch(lease, payer, async () => {
    calls += 1;
    throw new Error("EXPLICIT LOCAL SYNTHETIC lost response after possible provider write");
  }), "PAYMENT_OUTCOME_UNKNOWN");
  const repeated = await f.store.dispatch(lease, payer, async () => {
    calls += 1;
    return syntheticObservation(intent.operationId, "completed");
  });
  assert.equal(repeated.dispatchAllowed, false);
  assert.equal(calls, 1);
  const resumed = await f.store.initiatePayment(payer, newCommand());
  assert.equal(resumed.attemptId, intent.attemptId);
  assert.equal((await sql`select 1 from attempts where resolved_at is null`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "awaiting-payment");
  await rejectsCode(f.store.retireCreateOnlyAttempt(payer), "RETIREMENT_DISABLED");
});

test("synthetic financial mismatches are durably quarantined; exact later observation records original money without releasing the exception hold", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const intent = await captureIntent(f.store, payer);
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(lease, payer);
  const mismatch = { ...syntheticObservation(intent.operationId, "completed"), gross: "299.99" };
  assert.deepEqual(await f.store.recordObservation(scope, mismatch), { matchesBasis: false, completed: false });
  assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 0);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds[0]?.reason, "financial");
  const correct = syntheticObservation(intent.operationId, "completed");
  assert.equal((await f.store.recordObservation(scope, correct)).completed, true);
  assert.equal((await f.store.recordObservation(scope, correct)).completed, true);
  assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await sql`select 1 from observations where not matches_basis`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "review-hold");
  assert.deepEqual(await f.store.recordObservation(scope, { ...correct, captureId: "different-synthetic-capture" }), { matchesBasis: false, completed: false });
  assert.equal((await sql`select 1 from observations where not matches_basis`.execute(f.database.kysely)).rows.length, 2);
});

test("settled create retrievals with distinct local verification-reference fixtures append evidence without inventing a financial conflict", async (t) => {
  const f = await fixture(t);
  const adapterBoundary = new OrderedConsentStore(f.database);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const intent = await f.store.initiatePayment(payer, newCommand());
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(lease, payer);
  const original = injectedAdapterContractObservation(intent.operationId, "order-created", "create-check-1");
  const repeated = injectedAdapterContractObservation(intent.operationId, "order-created", "create-check-2");
  assert.deepEqual(await adapterBoundary.recordObservation(scope, original), { matchesBasis: true, completed: false });
  const settled = (await sql<{ result: unknown }>`select result from operations where id = ${intent.operationId}::uuid`.execute(f.database.kysely)).rows[0];
  assert.deepEqual(await adapterBoundary.recordObservation(scope, repeated), { matchesBasis: true, completed: false });
  assert.deepEqual(await adapterBoundary.recordObservation(scope, repeated), { matchesBasis: true, completed: false });
  const evidence = (await sql<{ reference: string; matches_basis: boolean }>`select payload#>>'{evidence,verificationReference}' as reference,matches_basis
    from observations where operation_id = ${intent.operationId}::uuid order by reference`.execute(f.database.kysely)).rows;
  assert.deepEqual(evidence, [
    { reference: "synthetic-local-contract-create-check-1", matches_basis: true },
    { reference: "synthetic-local-contract-create-check-2", matches_basis: true },
  ]);
  assert.deepEqual((await sql<{ result: unknown }>`select result from operations where id = ${intent.operationId}::uuid`.execute(f.database.kysely)).rows[0], settled);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds.length, 0);
  const capture = await f.store.requestCapture(payer, { ...newCommand(), attemptId: intent.attemptId, orderId: original.orderId });
  assert.equal(capture.attemptId, intent.attemptId);
});

test("settled capture retrievals compare stable financial meaning, retain independent local evidence, and still quarantine genuine changes", async (t) => {
  const f = await fixture(t);
  const adapterBoundary = new OrderedConsentStore(f.database);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const intent = await captureIntent(f.store, payer);
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(lease, payer);
  const original = injectedAdapterContractObservation(intent.operationId, "completed", "capture-check-1");
  const repeated = injectedAdapterContractObservation(intent.operationId, "completed", "capture-check-2");
  assert.deepEqual(await adapterBoundary.recordObservation(scope, original), { matchesBasis: true, completed: true });
  const settlement = (await sql<{ result: unknown; evidence: unknown; verified_at: Date }>`select o.result,f.evidence,f.verified_at
    from operations o join payment_facts f on f.operation_id = o.id where o.id = ${intent.operationId}::uuid`.execute(f.database.kysely)).rows[0];
  assert.deepEqual(await adapterBoundary.recordObservation(scope, repeated), { matchesBasis: true, completed: true });
  assert.deepEqual(await adapterBoundary.recordObservation(scope, repeated), { matchesBasis: true, completed: true });
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "ready");
  assert.equal((await sql`select 1 from observations where operation_id = ${intent.operationId}::uuid and matches_basis`.execute(f.database.kysely)).rows.length, 2);
  for (const [index, changed] of [
    { gross: "299.99" }, { merchantId: "different-synthetic-merchant" },
    { orderId: "different-synthetic-order" }, { captureId: "different-synthetic-capture" },
    { outcome: "pending" as const },
  ].entries()) {
    const mismatch = { ...original, ...changed, evidence: { kind: "authenticated-adapter" as const, verificationReference: `synthetic-local-contract-mismatch-${index}` } };
    assert.deepEqual(await adapterBoundary.recordObservation(scope, mismatch), { matchesBasis: false, completed: false });
  }
  assert.equal((await sql`select 1 from observations where operation_id = ${intent.operationId}::uuid and not matches_basis`.execute(f.database.kysely)).rows.length, 5);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "review-hold");
  assert.deepEqual((await sql<{ result: unknown; evidence: unknown; verified_at: Date }>`select o.result,f.evidence,f.verified_at
    from operations o join payment_facts f on f.operation_id = o.id where o.id = ${intent.operationId}::uuid`.execute(f.database.kysely)).rows[0], settlement);
  assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 1);
});

test("create and capture are separately admitted with exact Order linkage and no result can fabricate unadmitted money", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const intent = await f.store.initiatePayment(payer, newCommand());
  await rejectsCode(f.store.recordObservation(scope, syntheticObservation(intent.operationId, "order-created")), "RECONCILIATION_REQUIRED");
  await rejectsCode(f.store.requestCapture(payer, { ...newCommand(), attemptId: intent.attemptId, orderId: "synthetic-order" }), "RECONCILIATION_REQUIRED");
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(lease, payer);
  await f.store.recordObservation(scope, syntheticObservation(intent.operationId, "order-created"));
  await rejectsCode(f.store.requestCapture(payer, { ...newCommand(), attemptId: intent.attemptId, orderId: "wrong-order" }), "RECONCILIATION_REQUIRED");
  const capture = await f.store.requestCapture(payer, { ...newCommand(), attemptId: intent.attemptId, orderId: "synthetic-order" });
  assert.notEqual(capture.operationId, intent.operationId);
  assert.equal(capture.attemptId, intent.attemptId);
  const captureLease = await f.store.claimOperation(scope, { operationId: capture.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(captureLease, payer);
  assert.equal((await f.store.recordObservation(scope, syntheticObservation(capture.operationId, "pending"))).completed, false);
  assert.equal((await sql<{ state: string }>`select state from attempts`.execute(f.database.kysely)).rows[0]?.state, "pending");
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "awaiting-payment");
  await f.store.recordObservation(scope, syntheticObservation(capture.operationId, "completed"));
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "ready");
  await rejectsCode(f.store.initiatePayment(payer, newCommand()), "COLLECTION_CONFLICT");
});

test("webhook reconciliation locates only the admitted capture for the verified Order", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const capture = await captureIntent(f.store, payer);
  await rejectsCode(
    f.store.captureReconciliationAdmission(scope, "synthetic-order"),
    "RECONCILIATION_REQUIRED",
  );
  const lease = await f.store.claimOperation(scope, {
    operationId: capture.operationId,
    leaseMilliseconds: 60_000,
  });
  await f.store.admitDispatch(lease, payer);
  const admission = await f.store.captureReconciliationAdmission(
    scope,
    "synthetic-order",
  );
  assert.equal(admission.operationId, capture.operationId);
  assert.equal(admission.kind, "capture");
  assert.equal(admission.dispatchAllowed, false);
  assert.equal(admission.reconciliationRequired, true);
  await f.store.recordObservation(
    scope,
    syntheticObservation(admission.operationId, "completed"),
  );
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "ready");
  assert.equal(
    (await f.store.captureReconciliationAdmission(scope, "synthetic-order")).operationId,
    capture.operationId,
  );
  await rejectsCode(
    f.store.captureReconciliationAdmission(scope, "unknown-order"),
    "RECONCILIATION_REQUIRED",
  );
});

test("stale exact financial facts withhold readiness without rewriting capture history or creating a fresh attempt", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const capture = await captureIntent(f.store, payer);
  const lease = await f.store.claimOperation(scope, { operationId: capture.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(lease, payer);
  // Test-only database clock fault: still explicitly synthetic, never fabricated provider freshness.
  await sql.raw(`CREATE FUNCTION proof_stale_fact() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.verified_at = clock_timestamp() - interval '25 hours'; RETURN NEW; END $$;
    CREATE TRIGGER proof_stale_fact BEFORE INSERT ON payment_facts FOR EACH ROW EXECUTE FUNCTION proof_stale_fact();`).execute(f.database.kysely);
  await f.store.recordObservation(scope, syntheticObservation(capture.operationId, "completed"));
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "financial-recheck");
  assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 1);
  await rejectsCode(f.store.initiatePayment(payer, newCommand()), "COLLECTION_CONFLICT");
  assert.equal((await sql`select 1 from attempts`.execute(f.database.kysely)).rows.length, 1);
});

test("approver replacement requires explicit payer continuity; renewed current grants resume the SAME attempt", async (t) => {
  const f = await fixture(t);
  const { payer, obligationId } = await f.approveAndNominate(await f.addUnit());
  const originalCommand = newCommand();
  const intent = await f.store.initiatePayment(payer, originalCommand);
  await f.store.replaceApprover(provider, {
    ...newCommand(), approverId: "replacement-approver", expectedEpoch: 1, basis: "Explicit new approver condition; historic acceptance remains",
  });
  await rejectsCode(f.store.initiatePayment(payer, originalCommand), "ACCESS_DENIED");
  await rejectsCode(f.store.initiatePayment({ ...payer, nominationEpoch: 2 }, newCommand()), "ACCESS_DENIED");
  const nomination = await f.store.nominatePayer(provider, {
    ...newCommand(), obligationId, payerId: payerActor.actorId, active: true, continuityConfirmed: true,
    basis: "Replacement approver's authorized nominator explicitly confirms payer continuity",
  });
  const current = { ...payer, ...nomination };
  assert.equal((await f.store.initiatePayment(current, newCommand())).attemptId, intent.attemptId);
  await f.store.setGrant(provider, { ...newCommand(), targetActorId: payerActor.actorId, action: "pay", active: false, basis: "Sensitive authorization expired/revoked before admission" });
  await rejectsCode(f.store.initiatePayment(current, newCommand()), "ACCESS_DENIED");
  const renewed = await f.store.setGrant(provider, { ...newCommand(), targetActorId: payerActor.actorId, action: "pay", active: true, basis: "Explicit currently verified recovery grant" });
  const recovered = { ...current, grantEpoch: renewed.grantEpoch };
  assert.equal((await f.store.initiatePayment(recovered, newCommand())).operationId, intent.operationId);
});

test("payment/start prerequisite scopes remain separate; observations and retractions use the frozen authorized recorder", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit("unit-a", "packet-a", {
    prerequisites: [{ id: "copy", version: 1, recorderId: provider.actorId, description: "Synthetic approved copy supplied", blocks: "start" }],
  });
  const { payer } = await f.approveAndNominate(unit);
  const intent = await captureIntent(f.store, payer);
  const lease = await f.store.claimOperation(scope, { operationId: intent.operationId, leaseMilliseconds: 60_000 });
  await f.store.admitDispatch(lease, payer);
  await f.store.recordObservation(scope, syntheticObservation(intent.operationId, "completed"));
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "awaiting-prerequisite");
  const condition = { ...newCommand(), unitId: "unit-a", version: 1, prerequisiteId: "copy", prerequisiteVersion: 1, satisfied: true, basis: "Explicit attributed synthetic observation" };
  await rejectsCode(f.store.observePrerequisite(approver, condition), "ACCESS_DENIED");
  await f.store.observePrerequisite(provider, condition);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "ready");
  await f.store.observePrerequisite(provider, { ...condition, ...newCommand(), satisfied: false, basis: "Explicit attributed retraction" });
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "awaiting-prerequisite");
  const gated = await f.addUnit("payment-gated", "packet-b", { prerequisites: [
    { id: "financial-basis", version: 1, recorderId: provider.actorId, description: "Explicitly agreed payment prerequisite", blocks: "payment" },
  ] });
  const other = await f.approveAndNominate(gated);
  await rejectsCode(f.store.initiatePayment(other.payer, newCommand()), "REVIEW_HOLD");
});

test("independent-hold property over every source/stop/financial/restore subset: correction resolution changes only correction", async (t) => {
  const f = await fixture(t);
  const reasons = ["source", "stop", "financial", "restore"] as const;
  for (let mask = 0; mask < 16; mask += 1) {
    const unitId = `subset-unit-${mask}`;
    const concernId = `subset-concern-${mask}`;
    await f.addUnit(unitId);
    await f.store.admitCorrection(contributor, correctionInput(unitId, concernId));
    await f.store.respondToCorrection(provider, {
      ...newCommand(), concernId, responseRevision: 1, disposition: "maintain",
      sourceReview: "Explicit manual applicability review", explanation: "Attributable response",
    });
    const version = snapshot({ unitId, version: 2, reconciliation: [{ concernId, responseRevision: 1 }] });
    await f.store.publish(provider, { ...newCommand(), snapshot: version, expectedPreviousVersion: 1 });
    const expected = reasons.filter((_, index) => (mask & (1 << index)) !== 0);
    for (const reason of expected) await f.store.placeIndependentHold(provider, { ...newCommand(), unitId, reason, basis: `Independent ${reason} property fixture` });
    await f.store.decide(approver, {
      ...decisionInput(version, "decline"), resolution: { acknowledged: true, concerns: [{ concernId, responseRevision: 1 }] },
    });
    assert.deepEqual((await f.store.inspectUnit(provider, unitId)).holds.map((hold) => hold.reason).sort(), [...expected].sort(), `mask ${mask}`);
  }
});
