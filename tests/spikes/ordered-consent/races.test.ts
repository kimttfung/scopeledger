import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as deadline } from "node:timers/promises";
import { ProtocolError } from "@scopeledger/contracts";
import { sql } from "@scopeledger/db";
import type { ProtocolDatabase } from "@scopeledger/db";
import { commitBarrier, settled } from "./support/barrier.js";
import {
  approver, captureIntent, contributor, correctionInput, decisionInput, fixture, newCommand,
  payerActor, provider, rejectsCode, scope, snapshot, syntheticObservation,
} from "./support/fixture.js";

async function orderedRace<A, B>(options: {
  database: ProtocolDatabase; event: string; resourceId: string; firstPid: number; secondPid: number;
  first: () => Promise<A>; second: () => Promise<B>;
}) {
  const gate = await commitBarrier(options.database, options.event, options.resourceId);
  const first = settled(options.first());
  let second: ReturnType<typeof settled<B>> | undefined;
  try {
    await gate.waitForFirst(options.firstPid);
    second = settled(options.second());
    await gate.waitForBlocked(options.firstPid, options.secondPid);
    await gate.release();
    return await Promise.all([first, second]);
  } finally {
    await gate.release();
    await first;
    if (second) await second;
    await gate.dispose();
  }
}

function success<T>(result: { value: T } | { error: unknown }): T {
  if ("error" in result) throw result.error;
  return result.value;
}
function errorCode(result: { value: unknown } | { error: unknown }, code: ProtocolError["code"]) {
  assert.ok("error" in result);
  assert.ok(result.error instanceof ProtocolError);
  assert.equal(result.error.code, code);
}

for (const firstDecision of ["approve", "decline"] as const) {
  test(`real PG decision barrier: ${firstDecision} commits before competing terminal decision`, async (t) => {
    const f = await fixture(t);
    const unit = await f.addUnit();
    const a = await f.connection();
    const b = await f.connection();
    assert.notEqual(a.pid, b.pid);
    const [first, second] = await orderedRace({
      database: f.database, event: "decision", resourceId: "unit-a", firstPid: a.pid, secondPid: b.pid,
      first: () => a.store.decide(approver, decisionInput(unit, firstDecision)),
      second: () => b.store.decide(approver, decisionInput(unit, firstDecision === "approve" ? "decline" : "approve")),
    });
    assert.equal(success(first).decision, firstDecision);
    errorCode(second, "DECISION_CONFLICT");
    const rows = await sql<{ decision: string }>`select decision from decisions`.execute(f.database.kysely);
    assert.deepEqual(rows.rows.map((row) => row.decision), [firstDecision]);
  });
}

for (const firstAction of ["correction", "capture"] as const) {
  test(`real PG correction/capture barrier: ${firstAction} commits first; admitted money chronology remains original`, async (t) => {
    const f = await fixture(t);
    const unit = await f.addUnit();
    const { payer } = await f.approveAndNominate(unit);
    const capture = await captureIntent(f.store, payer);
    const lease = await f.store.claimOperation(scope, { operationId: capture.operationId, leaseMilliseconds: 60_000 });
    const a = await f.connection();
    const b = await f.connection();
    const correction = correctionInput();
    const [first, second] = await orderedRace({
      database: f.database,
      event: firstAction === "correction" ? "correction-admitted" : "dispatch-admitted",
      resourceId: firstAction === "correction" ? correction.concernId : capture.operationId,
      firstPid: a.pid, secondPid: b.pid,
      first: async () => firstAction === "correction"
        ? a.store.admitCorrection(contributor, correction) : a.store.admitDispatch(lease, payer),
      second: async () => firstAction === "correction"
        ? b.store.admitDispatch(lease, payer) : b.store.admitCorrection(contributor, correction),
    });
    success(first);
    if (firstAction === "correction") {
      errorCode(second, "REVIEW_HOLD");
      assert.equal((await sql`select 1 from operations where kind = 'capture' and admitted_at is not null`.execute(f.database.kysely)).rows.length, 0);
    } else {
      success(second);
      // EXPLICIT LOCAL SYNTHETIC OBSERVATION, not actual PayPal verification.
      assert.equal((await f.store.recordObservation(scope, syntheticObservation(capture.operationId, "completed"))).completed, true);
      assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 1);
      const chronology = (await sql<{ event: string }>`select event from protocol_history
        where (event = 'dispatch-admitted' and resource_id = ${capture.operationId})
          or event = 'correction-admitted' or (event = 'payment-observed' and resource_id = ${capture.operationId})
        order by sequence`.execute(f.database.kysely)).rows.map((row) => row.event);
      assert.deepEqual(chronology, ["dispatch-admitted", "correction-admitted", "payment-observed"]);
    }
    assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "review-hold");
  });
}

for (const firstAction of ["revocation", "decision"] as const) {
  test(`real PG grant fence: ${firstAction} commits first; replay cannot bypass revoked access`, async (t) => {
    const f = await fixture(t);
    const unit = await f.addUnit();
    const a = await f.connection();
    const b = await f.connection();
    const decision = decisionInput(unit);
    const revoke = { ...newCommand(), targetActorId: approver.actorId, action: "decide", active: false, basis: "Synthetic grant fence ordering" };
    const [first, second] = await orderedRace({
      database: f.database, event: firstAction === "revocation" ? "grant-changed" : "decision",
      resourceId: firstAction === "revocation" ? approver.actorId : unit.unitId, firstPid: a.pid, secondPid: b.pid,
      first: async () => firstAction === "revocation" ? a.store.setGrant(provider, revoke) : a.store.decide(approver, decision),
      second: async () => firstAction === "revocation" ? b.store.decide(approver, decision) : b.store.setGrant(provider, revoke),
    });
    success(first);
    if (firstAction === "revocation") errorCode(second, "ACCESS_DENIED");
    else {
      success(second);
      const historic = (await sql<{ actor_id: string }>`select actor_id from decisions`.execute(f.database.kysely)).rows[0];
      assert.equal(historic?.actor_id, approver.actorId);
    }
    await rejectsCode(f.store.decide(approver, decision), "ACCESS_DENIED");
  });
}

for (const firstAction of ["unknown-correction", "sibling-capture"] as const) {
  test(`real PG cross-packet unknown impact/capture barrier: ${firstAction} commits first`, async (t) => {
    const f = await fixture(t);
    await f.addUnit();
    const sibling = await f.addUnit("unit-b", "packet-b");
    const { payer } = await f.approveAndNominate(sibling);
    const capture = await captureIntent(f.store, payer);
    const lease = await f.store.claimOperation(scope, { operationId: capture.operationId, leaseMilliseconds: 60_000 });
    const correction = correctionInput("unit-a", "unknown-project-concern", true);
    const a = await f.connection();
    const b = await f.connection();
    const [first, second] = await orderedRace({
      database: f.database,
      event: firstAction === "unknown-correction" ? "correction-admitted" : "dispatch-admitted",
      resourceId: firstAction === "unknown-correction" ? correction.concernId : capture.operationId,
      firstPid: a.pid, secondPid: b.pid,
      first: async () => firstAction === "unknown-correction"
        ? a.store.admitCorrection(contributor, correction) : a.store.admitDispatch(lease, payer),
      second: async () => firstAction === "unknown-correction"
        ? b.store.admitDispatch(lease, payer) : b.store.admitCorrection(contributor, correction),
    });
    success(first);
    if (firstAction === "unknown-correction") errorCode(second, "REVIEW_HOLD");
    else {
      success(second);
      assert.equal((await f.store.recordObservation(scope, syntheticObservation(capture.operationId, "completed"))).completed, true);
    }
    assert.equal((await f.store.inspectUnit(provider, "unit-b")).holds[0]?.reason, "impact");
  });
}

for (const firstAction of ["nomination", "decision"] as const) {
  test(`real PG named approver fence: ${firstAction} commits first; unaccepted old conditions require reissue`, async (t) => {
    const f = await fixture(t);
    const unit = await f.addUnit();
    const a = await f.connection();
    const b = await f.connection();
    const replace = { ...newCommand(), approverId: "synthetic-replacement-approver", expectedEpoch: 1, basis: "Explicitly permissioned synthetic nomination replacement" };
    const [first, second] = await orderedRace({
      database: f.database, event: firstAction === "nomination" ? "approver-replaced" : "decision",
      resourceId: firstAction === "nomination" ? replace.approverId : unit.unitId, firstPid: a.pid, secondPid: b.pid,
      first: async () => firstAction === "nomination" ? a.store.replaceApprover(provider, replace) : a.store.decide(approver, decisionInput(unit)),
      second: async () => firstAction === "nomination" ? b.store.decide(approver, decisionInput(unit)) : b.store.replaceApprover(provider, replace),
    });
    success(first);
    if (firstAction === "nomination") {
      errorCode(second, "ACCESS_DENIED");
      await rejectsCode(f.store.decide({ ...approver, actorId: replace.approverId }, decisionInput(unit)), "ACCESS_DENIED");
      const v2 = snapshot({ version: 2, approver: { ...unit.approver, actorId: replace.approverId, nominationEpoch: 2 } });
      await f.store.publish(provider, { ...newCommand(), snapshot: v2, expectedPreviousVersion: 1 });
      await f.store.decide({ ...approver, actorId: replace.approverId }, decisionInput(v2));
    } else {
      success(second);
      assert.equal((await sql<{ actor_id: string }>`select actor_id from decisions`.execute(f.database.kysely)).rows[0]?.actor_id, approver.actorId);
    }
  });
}

for (const firstAction of ["payer-revocation", "capture"] as const) {
  test(`real PG payer fence: ${firstAction} commits first; admitted recovery survives prospective revocation`, async (t) => {
    const f = await fixture(t);
    const unit = await f.addUnit();
    const { payer, obligationId } = await f.approveAndNominate(unit);
    const capture = await captureIntent(f.store, payer);
    const lease = await f.store.claimOperation(scope, { operationId: capture.operationId, leaseMilliseconds: 60_000 });
    const a = await f.connection();
    const b = await f.connection();
    const revoke = {
      ...newCommand(), obligationId, payerId: payerActor.actorId, active: false, continuityConfirmed: true, basis: "Prospective synthetic obligation payer revocation",
    };
    const [first, second] = await orderedRace({
      database: f.database, event: firstAction === "payer-revocation" ? "payer-nominated" : "dispatch-admitted",
      resourceId: firstAction === "payer-revocation" ? obligationId : capture.operationId, firstPid: a.pid, secondPid: b.pid,
      first: async () => firstAction === "payer-revocation" ? a.store.nominatePayer(provider, revoke) : a.store.admitDispatch(lease, payer),
      second: async () => firstAction === "payer-revocation" ? b.store.admitDispatch(lease, payer) : b.store.nominatePayer(provider, revoke),
    });
    success(first);
    if (firstAction === "payer-revocation") errorCode(second, "ACCESS_DENIED");
    else {
      success(second);
      assert.equal((await f.store.recordObservation(scope, syntheticObservation(capture.operationId, "completed"))).completed, true);
    }
    await rejectsCode(f.store.admitDispatch(lease, payer), "ACCESS_DENIED");
  });
}

for (const firstAction of ["correction", "membership"] as const) {
  test(`real PG unknown project-impact/membership barrier: ${firstAction} commits first across packet boundaries`, async (t) => {
    const f = await fixture(t);
    await f.addUnit();
    const sibling = await f.addUnit("unit-b", "packet-b");
    const a = await f.connection();
    const b = await f.connection();
    const correction = correctionInput("unit-a", "project-concern", true);
    const member = { ...newCommand(), unitId: "unit-new", packetId: "packet-b" };
    const [first, second] = await orderedRace({
      database: f.database, event: firstAction === "correction" ? "correction-admitted" : "unit-created",
      resourceId: firstAction === "correction" ? correction.concernId : member.unitId, firstPid: a.pid, secondPid: b.pid,
      first: async () => firstAction === "correction" ? a.store.admitCorrection(contributor, correction) : a.store.createUnit(provider, member),
      second: async () => firstAction === "correction" ? b.store.createUnit(provider, member) : b.store.admitCorrection(contributor, correction),
    });
    success(first);
    success(second);
    for (const unitId of ["unit-a", "unit-b", "unit-new"]) {
      assert.equal((await f.store.inspectUnit(provider, unitId)).holds.length, 1);
    }
    await rejectsCode(f.store.decide(approver, decisionInput(sibling)), "REVIEW_HOLD");
    await rejectsCode(f.store.publish(provider, { ...newCommand(), expectedPreviousVersion: null, snapshot: snapshot({ unitId: "unit-new", contextRevision: 2 }) }), "REVIEW_HOLD");
    await f.store.placeIndependentHold(provider, { ...newCommand(), unitId: "unit-b", reason: "stop", basis: "Independent stop concern must survive impact review" });
    await f.store.reviewImpact(provider, { ...newCommand(), concernId: correction.concernId, impactRevision: 2, reviews: [
      { unitId: "unit-b", disposition: "independent", explanation: "Reviewed unrelated independent scope" },
      { unitId: "unit-new", disposition: "independent", explanation: "Reviewed added independent membership explicitly" },
    ] });
    assert.deepEqual((await f.store.inspectUnit(provider, "unit-b")).holds.map((row) => row.reason), ["stop"]);
    assert.equal((await f.store.inspectUnit(provider, "unit-new")).holds.length, 0);
    assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds[0]?.reason, "correction");
    await rejectsCode(f.store.reviewImpact(provider, { ...newCommand(), concernId: correction.concernId, impactRevision: 2, reviews: [
      { unitId: "unit-a", disposition: "independent", explanation: "Cannot unilaterally dismiss originating concern" },
    ] }), "INVALID_INPUT");
    await f.store.createUnit(provider, { ...newCommand(), unitId: "unit-later", packetId: "packet-b" });
    assert.equal((await f.store.inspectUnit(provider, "unit-later")).holds[0]?.reason, "impact");
  });
}

for (const firstAction of ["old-intent", "replacement"] as const) {
  test(`real PG old/replacement collection-family barrier: ${firstAction} commits first`, async (t) => {
    const f = await fixture(t);
    const unit = await f.addUnit();
    const { payer, obligationId } = await f.approveAndNominate(unit);
    const replacement = snapshot({ version: 2, rationale: "Explicit unpaid replacement, no duplicate collection",
      financialEffect: { kind: "unpaid-replacement", replacesObligationId: obligationId } });
    await f.store.publish(provider, { ...newCommand(), snapshot: replacement, expectedPreviousVersion: 1 });
    assert.equal((await f.store.inspectUnit(provider, "unit-a")).acceptedVersion, 1);
    const a = await f.connection();
    const b = await f.connection();
    const [first, second] = await orderedRace({
      database: f.database, event: firstAction === "old-intent" ? "payment-intent" : "decision",
      resourceId: firstAction === "old-intent" ? "*" : "unit-a", firstPid: a.pid, secondPid: b.pid,
      first: async () => firstAction === "old-intent" ? a.store.initiatePayment(payer, newCommand()) : a.store.decide(approver, decisionInput(replacement)),
      second: async () => firstAction === "old-intent" ? b.store.decide(approver, decisionInput(replacement)) : b.store.initiatePayment(payer, newCommand()),
    });
    success(first);
    errorCode(second, firstAction === "old-intent" ? "PAYMENT_OUTCOME_UNKNOWN" : "COLLECTION_CONFLICT");
    const active = (await sql<{ id: string; version: number }>`select id,version from obligations where collectible`.execute(f.database.kysely)).rows;
    assert.equal(active.length, 1);
    assert.equal(active[0]?.version, firstAction === "old-intent" ? 1 : 2);
    assert.equal((await sql`select 1 from attempts where resolved_at is null`.execute(f.database.kysely)).rows.length, firstAction === "old-intent" ? 1 : 0);
    if (firstAction === "replacement") {
      await rejectsCode(f.store.initiatePayment(payer, newCommand()), "COLLECTION_CONFLICT");
      const newObligationId = active[0]!.id;
      const nomination = await f.store.nominatePayer(provider, {
        ...newCommand(), obligationId: newObligationId, payerId: payerActor.actorId, active: true,
        continuityConfirmed: true, basis: "Explicit nomination for the nonoverlapping replacement obligation",
      });
      await f.store.initiatePayment({ ...payerActor, obligationId: newObligationId, ...nomination }, newCommand());
      assert.equal((await sql`select 1 from attempts where resolved_at is null`.execute(f.database.kysely)).rows.length, 1);
    }
  });
}

test("known multi-unit corrections take stable sorted unit locks even when callers supply opposite orders", async (t) => {
  const f = await fixture(t);
  await f.addUnit();
  await f.addUnit("unit-b", "packet-b");
  const a = await f.connection();
  const b = await f.connection();
  const firstCommand = { ...correctionInput("unit-a", "multi-a"), scope: { kind: "known", unitIds: ["unit-b", "unit-a"] } };
  const secondCommand = { ...correctionInput("unit-a", "multi-b"), scope: { kind: "known", unitIds: ["unit-a", "unit-b"] } };
  const [first, second] = await orderedRace({
    database: f.database, event: "correction-admitted", resourceId: "multi-a", firstPid: a.pid, secondPid: b.pid,
    first: () => a.store.admitCorrection(contributor, firstCommand), second: () => b.store.admitCorrection(contributor, secondCommand),
  });
  success(first);
  success(second);
  for (const unitId of ["unit-a", "unit-b"]) assert.equal((await f.store.inspectUnit(provider, unitId)).holds.length, 2);
});

test("real PG concurrent payment initiations converge on one unresolved attempt and stable create operation", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const a = await f.connection();
  const b = await f.connection();
  const [first, second] = await orderedRace({
    database: f.database, event: "payment-intent", resourceId: "*", firstPid: a.pid, secondPid: b.pid,
    first: () => a.store.initiatePayment(payer, newCommand()), second: () => b.store.initiatePayment(payer, newCommand()),
  });
  assert.deepEqual(success(first), success(second));
  assert.equal((await sql`select 1 from attempts where resolved_at is null`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await sql`select 1 from operations`.execute(f.database.kysely)).rows.length, 1);
});

test("ordinary independent same-project units coexist while the first unit transaction is deliberately paused", async (t) => {
  const f = await fixture(t);
  const unitA = await f.addUnit();
  const unitB = await f.addUnit("unit-b", "packet-a");
  const a = await f.connection();
  const b = await f.connection();
  const gate = await commitBarrier(f.database, "decision", "unit-a");
  const first = settled(a.store.decide(approver, decisionInput(unitA)));
  try {
    await gate.waitForFirst(a.pid);
    const second = settled(b.store.decide(approver, decisionInput(unitB)));
    const result = await Promise.race([
      second, deadline(3_000).then(() => { throw new Error("Independent unit was over-serialized by an exclusive project/packet fence"); }),
    ]);
    success(result);
    assert.equal((await sql`select 1 from decisions where unit_id = 'unit-b'`.execute(f.database.kysely)).rows.length, 1);
  } finally {
    await gate.release();
    success(await first);
    await gate.dispose();
  }
});
