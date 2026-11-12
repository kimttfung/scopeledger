import assert from "node:assert/strict";
import test from "node:test";
import {
  createIsolatedProofDatabase,
  sql,
} from "@scopeledger/db";
import {
  canonicalJson,
  freezePublishedUnit,
  parseInput,
  publishedUnitSchema,
} from "@scopeledger/contracts";
import {
  createProtocolDatabaseRecordsReader,
  exportProjectRecords,
} from "../../../packages/records-export/src/index.js";

const databaseUrl = process.env.IP01_DATABASE_URL;

test("ProtocolDatabase reader reconstructs scoped persisted facts without authorization logic", {
  skip: databaseUrl ? false : "IP01_DATABASE_URL is not configured",
}, async (t) => {
  assert.ok(databaseUrl);
  const isolated = await createIsolatedProofDatabase(databaseUrl);
  t.after(isolated.dispose);
  const workspaceId = "records-workspace";
  const projectId = "records-project";
  const unitId = "records-unit";
  const fixedTime = new Date("2026-11-02T10:00:00.000Z");
  const snapshot = parseInput(publishedUnitSchema, {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    workspaceId,
    projectId,
    clientId: "records-client",
    unitId,
    version: 1,
    contextRevision: 1,
    title: "Persisted project slice",
    treatment: "payable",
    scope: ["One bounded deliverable"],
    exclusions: [],
    dependencies: [],
    baselineReferences: [{ id: "records-baseline", version: 1 }],
    sourceReferences: [{
      id: "records-source",
      version: 1,
      locator: "Persisted source paragraph",
      availability: "available",
    }],
    rationale: "Provider-reviewed persisted rationale.",
    approver: {
      actorId: "records-approver",
      nominationEpoch: 1,
      condition: "Exact-version authority",
    },
    timing: {
      description: "After recorded readiness",
      deliveryDependencies: [],
    },
    prerequisites: [],
    reconciliation: [],
    payment: {
      policy: "full-prepayment",
      financial: {
        currency: "USD",
        merchantId: "records-merchant",
        environment: "sandbox",
        lines: [{
          id: "line-one",
          description: "One bounded deliverable",
          quantity: "1",
          unitPrice: "125.00",
          amount: "125.00",
        }],
        subtotal: "125.00",
        tax: {
          treatment: "none",
          amount: "0.00",
          declaration: "No tax added in this synthetic record.",
        },
        gross: "125.00",
      },
    },
    financialEffect: { kind: "new" },
  });
  const frozen = freezePublishedUnit(snapshot);

  await isolated.database.transaction(async (transaction) => {
    await sql`insert into workspaces(id,merchant_id,environment)
      values (${workspaceId},'records-merchant','sandbox')`.execute(transaction);
    await sql`insert into projects(workspace_id,id,client_id,approver_id)
      values (${workspaceId},${projectId},'records-client','records-approver')`
      .execute(transaction);
    await sql`insert into packets(workspace_id,project_id,id)
      values (${workspaceId},${projectId},'records-request')`.execute(transaction);
    await sql`insert into units(workspace_id,project_id,id,packet_id)
      values (${workspaceId},${projectId},${unitId},'records-request')`
      .execute(transaction);
    await sql`insert into collection_families(workspace_id,project_id,id)
      values (${workspaceId},${projectId},${unitId})`.execute(transaction);
    await sql`insert into source_versions(
        workspace_id,project_id,id,version,availability,reviewed_by
      ) values (
        ${workspaceId},${projectId},'records-source',1,'available','records-provider'
      )`.execute(transaction);
    await sql`insert into baseline_versions(
        workspace_id,project_id,id,version,confirmed_by
      ) values (
        ${workspaceId},${projectId},'records-baseline',1,'records-provider'
      )`.execute(transaction);
    await sql`insert into unit_versions(
        workspace_id,project_id,unit_id,version,snapshot,canonical_bytes,digest,
        published_by,published_at
      ) values (
        ${workspaceId},${projectId},${unitId},1,
        ${canonicalJson(snapshot)}::jsonb,${frozen.bytes},${frozen.digest},
        'records-provider',${fixedTime}
      )`.execute(transaction);
    await sql`insert into version_sources(
        workspace_id,project_id,unit_id,version,source_id,source_version
      ) values (
        ${workspaceId},${projectId},${unitId},1,'records-source',1
      )`.execute(transaction);
    await sql`insert into version_baselines(
        workspace_id,project_id,unit_id,version,baseline_id,baseline_version
      ) values (
        ${workspaceId},${projectId},${unitId},1,'records-baseline',1
      )`.execute(transaction);
    await sql`update units set current_version = 1,accepted_version = 1
      where workspace_id = ${workspaceId} and project_id = ${projectId}
        and id = ${unitId}`.execute(transaction);
    await sql`insert into decisions(
        workspace_id,project_id,unit_id,version,decision,actor_id,
        nomination_epoch,digest,attestation,resolution,recorded_at
      ) values (
        ${workspaceId},${projectId},${unitId},1,'approve','records-approver',
        1,${frozen.digest},
        ${canonicalJson({
          reviewedExactVersion: true,
          authority: true,
          statement: "I reviewed this exact version.",
        })}::jsonb,
        null,${new Date("2026-11-02T10:01:00.000Z")}
      )`.execute(transaction);
    await sql`insert into obligations(
        workspace_id,project_id,id,unit_id,version,family_id,merchant_id,
        environment,currency,gross,replaces_id
      ) values (
        ${workspaceId},${projectId},'records-obligation',${unitId},1,${unitId},
        'records-merchant','sandbox','USD','125.00',null
      )`.execute(transaction);
    await sql`insert into protocol_history(
        workspace_id,project_id,actor_id,event,resource_id,detail,recorded_at
      ) values (
        ${workspaceId},${projectId},'records-provider','work-started',${unitId},
        ${canonicalJson({ version: 1 })}::jsonb,
        ${new Date("2026-11-02T10:02:00.000Z")}
      )`.execute(transaction);
  });

  const exported = await exportProjectRecords(
    createProtocolDatabaseRecordsReader(isolated.database),
    { workspaceId, projectId },
  );

  assert.equal(exported.document.facts.publications.length, 1);
  assert.equal(exported.document.facts.agreements.length, 1);
  assert.equal(exported.document.facts.obligations[0]?.gross, "125.00");
  assert.equal(exported.document.facts.readiness[0]?.status, "awaiting-payment");
  assert.equal(exported.document.facts.workStarts.length, 1);
  assert.doesNotMatch(exported.json, /records-merchant|records-provider/);
  assert.doesNotMatch(
    exported.json,
    /records-project|records-request|records-unit|records-obligation/,
  );
});
