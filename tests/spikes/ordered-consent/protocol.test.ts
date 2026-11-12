import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { freezePublishedUnit, ProtocolError } from "@scopeledger/contracts";
import { sql, validateProofSchema, validateSchemaName } from "@scopeledger/db";
import {
  approver, contributor, correctionInput, decisionInput, fixture, newCommand, provider,
  rejectsCode, scope, snapshot,
} from "./support/fixture.js";

test("reissue binds changed rationale and rejects old unaccepted versions/digests without rewriting bytes", async (t) => {
  const f = await fixture(t);
  const v1 = await f.addUnit();
  const old = freezePublishedUnit(v1);
  const v2 = snapshot({ version: 2, rationale: "Changed material rationale with unchanged scope and exact price" });
  await f.store.publish(provider, { ...newCommand(), snapshot: v2, expectedPreviousVersion: 1 });
  await rejectsCode(f.store.decide(approver, decisionInput(v1)), "STALE_UNIT_VERSION");
  await rejectsCode(f.store.decide(approver, { ...decisionInput(v2), digest: old.digest }), "STALE_UNIT_VERSION");
  await f.store.decide(approver, decisionInput(v2));
  const stored = await sql<{ canonical_bytes: Buffer; digest: string }>`select canonical_bytes,digest from unit_versions where version = 1`.execute(f.database.kysely);
  assert.deepEqual(stored.rows[0]?.canonical_bytes, old.bytes);
  assert.equal(stored.rows[0]?.digest, old.digest);
  await assert.rejects(sql`update unit_versions set digest = ${"0".repeat(64)} where version = 1`.execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`delete from decisions`.execute(f.database.kysely), { code: "23514" });
});

test("command receipt replay validates current authority first and rejects conflicting payload identities", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit();
  const command = decisionInput(unit);
  const original = await f.store.decide(approver, command);
  assert.deepEqual(await f.store.decide(approver, command), original);
  assert.deepEqual(await f.store.decide(approver, decisionInput(unit)), original);
  await rejectsCode(f.store.decide(approver, { ...command, decision: "decline" }), "IDEMPOTENCY_CONFLICT");
  await rejectsCode(f.store.decide(approver, decisionInput(unit, "decline")), "DECISION_CONFLICT");
  await f.store.setGrant(provider, {
    ...newCommand(), targetActorId: approver.actorId, action: "decide", active: false, basis: "Prospective synthetic grant revocation",
  });
  await rejectsCode(f.store.decide(approver, command), "ACCESS_DENIED");
  assert.equal((await sql`select 1 from decisions`.execute(f.database.kysely)).rows.length, 1);
});

test("returning to the same named actor cannot revive an earlier nomination epoch, including receipt replay", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit();
  const command = decisionInput(unit);
  await f.store.decide(approver, command);
  await f.store.replaceApprover(provider, {
    ...newCommand(), approverId: "temporary-approver", expectedEpoch: 1, basis: "Explicit intermediate nomination",
  });
  await f.store.replaceApprover(provider, {
    ...newCommand(), approverId: approver.actorId, expectedEpoch: 2, basis: "A new nomination, not resurrection of old authority",
  });
  await rejectsCode(f.store.decide({ ...approver, grantEpoch: 3 }, command), "ACCESS_DENIED");
  assert.equal((await sql`select 1 from decisions`.execute(f.database.kysely)).rows.length, 1);
});

test("strict scoped references and composite foreign keys reject cross-workspace/project data", async (t) => {
  const f = await fixture(t);
  await f.store.createUnit(provider, { ...newCommand(), packetId: "packet-a", unitId: "unit-a" });
  await rejectsCode(f.store.createUnit(provider, { ...newCommand(), packetId: "packet-a", unitId: "unit-a" }), "INVALID_INPUT");
  await rejectsCode(f.store.createPacket(provider, { ...newCommand(), packetId: "packet-a" }), "INVALID_INPUT");
  await rejectsCode(f.store.registerContext(provider, {
    ...newCommand(), baseline: { id: "late-material-baseline", version: 1 },
    sources: [{ id: "late-material-source", version: 1, availability: "available" }],
  }), "STALE_CONTEXT");
  await rejectsCode(f.store.publish(provider, {
    ...newCommand(), snapshot: snapshot({ projectId: "other-project" }), expectedPreviousVersion: null,
  }), "INVALID_INPUT");
  await rejectsCode(f.store.publish(provider, {
    ...newCommand(), snapshot: snapshot({ sourceReferences: [{ id: "other-project-source", version: 1, locator: "No association", availability: "available" }] }), expectedPreviousVersion: null,
  }), "INVALID_INPUT");
  await rejectsCode(f.store.decide({ ...approver, workspaceId: "ungranted-workspace" }, decisionInput(snapshot())), "NOT_FOUND");
  await assert.rejects(sql`insert into units(workspace_id,project_id,id,packet_id)
    values (${scope.workspaceId},'other-project','cross-unit','packet-a')`.execute(f.database.kysely), { code: "23503" });
  await assert.rejects(sql`insert into version_sources(workspace_id,project_id,unit_id,version,source_id,source_version)
    values (${scope.workspaceId},'other-project','unit-a',1,'synthetic-source',1)`.execute(f.database.kysely), { code: "23503" });
  for (const bad of ["public", "pg_catalog", "a;drop schema public", "../test"]) assert.throws(() => validateSchemaName(bad));
  for (const bad of ["public", "ip01_abc", "ip01_" + "a".repeat(25)]) assert.throws(() => validateProofSchema(bad));
});

test("waived additions need exact consent but never create obligations; included/uncertain are not units", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit("waived-unit", "packet-a", {
    treatment: "additional-waived", payment: { policy: "not-required", explanation: "Deliberate additional-scope courtesy" },
    financialEffect: { kind: "no-obligation" },
  });
  const result = await f.store.decide(approver, decisionInput(unit));
  assert.equal(result.obligationId, null);
  assert.equal((await f.store.inspectUnit(provider, unit.unitId)).readiness, "ready");
  assert.equal((await sql`select 1 from obligations`.execute(f.database.kysely)).rows.length, 0);
});

test("response/reissue alone never resolves material concerns; resolve-and-decide is exact and atomic", async (t) => {
  const f = await fixture(t);
  await f.addUnit();
  await f.store.admitCorrection(contributor, correctionInput());
  await f.store.respondToCorrection(provider, {
    ...newCommand(), concernId: "synthetic-concern", responseRevision: 1, disposition: "partial",
    sourceReview: "Manual review: unavailable original source, claimed inclusion assessed separately",
    explanation: "Synthetic reviewed reconciliation",
  });
  const v2 = snapshot({ version: 2, rationale: "Explicitly revised terms after manual review",
    reconciliation: [{ concernId: "synthetic-concern", responseRevision: 1 }] });
  await f.store.publish(provider, { ...newCommand(), snapshot: v2, expectedPreviousVersion: 1 });
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds.length, 1);
  await rejectsCode(f.store.decide(approver, decisionInput(v2)), "REVIEW_HOLD");
  await rejectsCode(f.store.decide(approver, {
    ...decisionInput(v2), resolution: { acknowledged: true, concerns: [{ concernId: "synthetic-concern", responseRevision: 2 }] },
  }), "STALE_CONTEXT");
  await f.store.decide(approver, {
    ...decisionInput(v2), resolution: { acknowledged: true, concerns: [{ concernId: "synthetic-concern", responseRevision: 1 }] },
  });
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds.length, 0);
  const correction = (await sql<{ claim: { source: { availability: string }; modelProcessingPermitted: boolean } }>`select claim from corrections`.execute(f.database.kysely)).rows[0];
  assert.equal(correction?.claim.source.availability, "unavailable");
  assert.equal(correction?.claim.modelProcessingPermitted, false);
});

test("resolve-and-decide removes only identified correction holds; every independent hold survives and failed approval rolls back resolution", async (t) => {
  const f = await fixture(t);
  await f.addUnit();
  for (const concernId of ["concern-a", "concern-b"]) {
    await f.store.admitCorrection(contributor, correctionInput("unit-a", concernId));
    await f.store.respondToCorrection(provider, {
      ...newCommand(), concernId, responseRevision: 1, disposition: "maintain",
      sourceReview: "Attributable manual source/applicability review", explanation: "Disagreement remains stated",
    });
  }
  const v2 = snapshot({ version: 2, reconciliation: [
    { concernId: "concern-a", responseRevision: 1 }, { concernId: "concern-b", responseRevision: 1 },
  ] });
  await f.store.publish(provider, { ...newCommand(), snapshot: v2, expectedPreviousVersion: 1 });
  for (const reason of ["source", "stop", "financial", "restore"] as const) {
    await f.store.placeIndependentHold(provider, { ...newCommand(), unitId: "unit-a", reason, basis: `Independent synthetic ${reason} issue` });
  }
  const resolution = { acknowledged: true, concerns: [{ concernId: "concern-a", responseRevision: 1 }] };
  await rejectsCode(f.store.decide(approver, { ...decisionInput(v2), resolution }), "REVIEW_HOLD");
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds.length, 6);
  await f.store.decide(approver, { ...decisionInput(v2, "decline"), resolution });
  const remaining = (await f.store.inspectUnit(provider, "unit-a")).holds;
  assert.equal(remaining.length, 5);
  assert.deepEqual(remaining.filter((hold) => hold.reason !== "correction").map((hold) => hold.reason).sort(), ["financial", "restore", "source", "stop"]);
  assert.equal(remaining.find((hold) => hold.reason === "correction")?.concern_id, "concern-b");
});

test("ordinary voluntary decline leaves concerns unresolved and request-information cannot enable reconciliation publication", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit();
  await f.store.admitCorrection(contributor, correctionInput());
  await f.store.respondToCorrection(provider, {
    ...newCommand(), concernId: "synthetic-concern", responseRevision: 1, disposition: "request-information",
    sourceReview: "Insufficient information, manually reviewed", explanation: "Please clarify the missing promise",
  });
  await rejectsCode(f.store.publish(provider, { ...newCommand(), expectedPreviousVersion: 1,
    snapshot: snapshot({ version: 2, reconciliation: [{ concernId: "synthetic-concern", responseRevision: 1 }] }),
  }), "STALE_CONTEXT");
  await f.store.decide(approver, decisionInput(unit, "decline"));
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds.length, 1);
});

test("unchanged accepted concern resolution is separate and never rewrites historical approval", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit();
  await f.approveAndNominate(unit);
  await f.store.admitCorrection(contributor, correctionInput());
  await f.store.respondToCorrection(provider, {
    ...newCommand(), concernId: "synthetic-concern", responseRevision: 1, disposition: "maintain",
    sourceReview: "Reviewed without changing frozen terms", explanation: "Explicit response for unchanged accepted terms",
  });
  await f.store.resolveAcceptedConcern(approver, {
    ...newCommand(), unitId: unit.unitId, version: unit.version, digest: freezePublishedUnit(unit).digest,
    attestation: { reviewedExactVersion: true, authority: true, statement: "Unchanged accepted terms and identified response reviewed" },
    resolution: { acknowledged: true, concerns: [{ concernId: "synthetic-concern", responseRevision: 1 }] },
  });
  assert.equal((await sql`select 1 from decisions`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).holds.length, 0);
});

test("SQL constraints enforce terminal decision, unresolved attempt, family exclusion and immutable operation identity", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit();
  const { payer, obligationId } = await f.approveAndNominate(unit);
  const intent = await f.store.initiatePayment(payer, newCommand());
  await assert.rejects(sql`insert into decisions select * from decisions`.execute(f.database.kysely), { code: "23505" });
  await assert.rejects(sql`insert into attempts(workspace_id,project_id,id,obligation_id,initiated_by,payer_epoch,nomination_epoch,state)
    values (${scope.workspaceId},${scope.projectId},${randomUUID()}::uuid,${obligationId},'synthetic-payer',1,1,'intent')`.execute(f.database.kysely), { code: "23505" });
  await f.store.createUnit(provider, { ...newCommand(), unitId: "unit-b", packetId: "packet-b" });
  const second = snapshot({ unitId: "unit-b" });
  await f.store.publish(provider, { ...newCommand(), snapshot: second, expectedPreviousVersion: null });
  await sql`insert into decisions(workspace_id,project_id,unit_id,version,decision,actor_id,nomination_epoch,digest,attestation)
    values (${scope.workspaceId},${scope.projectId},'unit-b',1,'approve',${approver.actorId},1,
      ${freezePublishedUnit(second).digest},'{"syntheticConstraintFixture":true}'::jsonb)`.execute(f.database.kysely);
  await assert.rejects(sql`insert into obligations(workspace_id,project_id,id,unit_id,version,family_id,merchant_id,environment,currency,gross)
    values (${scope.workspaceId},${scope.projectId},${randomUUID()},'unit-b',1,'unit-a','synthetic-merchant','sandbox','USD','300.00')`.execute(f.database.kysely),
  { code: "23505", constraint: "one_collectible_family" });
  await assert.rejects(sql`update operations set request_hash = ${"0".repeat(64)} where id = ${intent.operationId}::uuid`.execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`update obligations set collectible = false where id = ${obligationId}`.execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`delete from operations where id = ${intent.operationId}::uuid`.execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`insert into obligations(workspace_id,project_id,id,unit_id,version,family_id,merchant_id,environment,currency,gross)
    values (${scope.workspaceId},${scope.projectId},${randomUUID()},'unit-b',1,'unit-b','synthetic-merchant','sandbox','USD','300.001')`.execute(f.database.kysely),
  { code: "23514" });
  assert.equal((await sql`select 1 from attempts where resolved_at is null`.execute(f.database.kysely)).rows.length, 1);
});

test("transaction rollback and database-only serialization/deadlock retry preserve one durable effect", async (t) => {
  const f = await fixture(t);
  const unit = await f.addUnit();
  await sql.raw(`CREATE SEQUENCE proof_retry_sequence;
    CREATE FUNCTION proof_retry() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event = 'decision' AND nextval('proof_retry_sequence') = 1 THEN
        RAISE EXCEPTION 'injected database serialization failure' USING ERRCODE = '40001';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER proof_retry BEFORE INSERT ON protocol_history FOR EACH ROW EXECUTE FUNCTION proof_retry();`).execute(f.database.kysely);
  await f.store.decide(approver, decisionInput(unit));
  assert.equal((await sql`select 1 from decisions`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await sql`select 1 from obligations`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await sql`select 1 from protocol_history where event = 'decision'`.execute(f.database.kysely)).rows.length, 1);
  const sequence = (await sql<{ last_value: string }>`select last_value from proof_retry_sequence`.execute(f.database.kysely)).rows[0];
  assert.equal(Number(sequence?.last_value), 2);
  let retries = 0;
  await f.database.transaction(async () => {
    retries += 1;
    if (retries === 1) throw Object.assign(new Error("synthetic database deadlock retry"), { code: "40P01" });
  });
  assert.equal(retries, 2);
  let nonRetryable = 0;
  await assert.rejects(f.database.transaction(async () => {
    nonRetryable += 1;
    throw new ProtocolError("INVALID_INPUT", "No generic retry");
  }), ProtocolError);
  assert.equal(nonRetryable, 1);
  await assert.rejects(f.database.transaction(async (transaction) => {
    await sql`insert into packets(workspace_id,project_id,id) values (${scope.workspaceId},${scope.projectId},'rolled-back')`.execute(transaction);
    throw new Error("Intentional local rollback");
  }));
  assert.equal((await sql`select 1 from packets where id = 'rolled-back'`.execute(f.database.kysely)).rows.length, 0);
});
