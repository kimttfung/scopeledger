import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  ClientReviewDraftError,
  createIsolatedProofDatabase,
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  newProofSchema,
  PostgresClientReviewDraftStore,
  ProtocolDatabase,
  sql,
  type ClientReviewDraftAuthority,
  validateProofSchema,
} from "@scopeledger/db";

const databaseUrl = process.env.IP01_DATABASE_URL
  ?? process.env.SCOPELEDGER_DATABASE_URL;
const workspaceId = "demo-workspace";

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function seedReview(
  database: ProtocolDatabase,
  input: Readonly<{
    projectId: string;
    requestId: string;
    unitId: string;
    approverId: string;
    nominationEpoch?: number;
  }>,
): Promise<void> {
  await sql`insert into projects(
      workspace_id,id,client_id,approver_id,nomination_epoch
    ) values (
      ${workspaceId},${input.projectId},${`${input.projectId}-client`},
      ${input.approverId},${input.nominationEpoch ?? 1}
    )`.execute(database.kysely);
  for (const action of ["inspect", "decide", "correct"] as const) {
    await sql`insert into grants(
        workspace_id,project_id,actor_id,action
      ) values (
        ${workspaceId},${input.projectId},${input.approverId},${action}
      )`.execute(database.kysely);
  }
  await sql`insert into packets(workspace_id,project_id,id)
    values (${workspaceId},${input.projectId},${input.requestId})`
    .execute(database.kysely);
  await sql`insert into units(workspace_id,project_id,id,packet_id)
    values (
      ${workspaceId},${input.projectId},${input.unitId},${input.requestId}
    )`.execute(database.kysely);
  const snapshot = {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    workspaceId,
    projectId: input.projectId,
    unitId: input.unitId,
    version: 1,
    treatment: "additional-waived",
  };
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  await sql`insert into unit_versions(
      workspace_id,project_id,unit_id,version,snapshot,canonical_bytes,
      digest,published_by
    ) values (
      ${workspaceId},${input.projectId},${input.unitId},1,
      ${JSON.stringify(snapshot)}::jsonb,${bytes},${digest(bytes)},
      ${input.approverId}
    )`.execute(database.kysely);
  await sql`update units set current_version = 1
    where workspace_id = ${workspaceId}
      and project_id = ${input.projectId}
      and id = ${input.unitId}`.execute(database.kysely);
}

async function fixture(t: TestContext) {
  assert.ok(databaseUrl, "A PostgreSQL URL is required for client draft tests");
  const isolated = await createIsolatedProofDatabase(databaseUrl);
  t.after(isolated.dispose);
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${workspaceId},'draft-merchant','sandbox')`
    .execute(isolated.database.kysely);
  const suffix = randomUUID().slice(0, 8);
  const projectId = `draft-project-${suffix}`;
  const requestId = `draft-request-${suffix}`;
  const unitId = `draft-unit-${suffix}`;
  const approverId = `draft-approver-${suffix}`;
  await seedReview(isolated.database, {
    projectId,
    requestId,
    unitId,
    approverId,
  });
  const authority: ClientReviewDraftAuthority = {
    workspaceId,
    projectId,
    requestId,
    unitId,
    participantSubjectDigest: "a".repeat(64),
    actorId: approverId,
    nominationEpoch: 1,
    kind: "correction",
  };
  return { ...isolated, authority };
}

test("migration 008 upgrades a contiguous 007 history without rewriting prior records", {
  skip: databaseUrl ? false : "PostgreSQL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  const schema = newProofSchema();
  const database = new ProtocolDatabase({
    connectionString: databaseUrl,
    schema,
  });
  await sql.raw(`CREATE SCHEMA "${validateProofSchema(schema)}"`)
    .execute(database.kysely);
  try {
    for (const migration of [
      migration001,
      migration002,
      migration003,
      migration004,
      migration005,
      migration006,
      migration007,
    ]) {
      await database.transaction(async (transaction) => {
        await sql.raw(migration).execute(transaction);
      });
    }
    await sql`insert into workspaces(id,merchant_id,environment)
      values ('history-workspace','history-merchant','sandbox')`
      .execute(database.kysely);
    await sql`insert into projects(
        workspace_id,id,client_id,approver_id
      ) values (
        'history-workspace','history-project','history-client',
        'history-approver'
      )`.execute(database.kysely);
    await sql`insert into protocol_history(
        workspace_id,project_id,actor_id,event,resource_id,detail
      ) values (
        'history-workspace','history-project','history-approver',
        'history-preserved','history-resource','{"preserved":true}'::jsonb
      )`.execute(database.kysely);

    await database.migrate();

    const versions = (await sql<{ version: number }>`select version
      from schema_migrations order by version`
      .execute(database.kysely)).rows.map((row) => row.version);
    assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const history = (await sql<{
      event: string;
      detail: unknown;
    }>`select event,detail from protocol_history`
      .execute(database.kysely)).rows;
    assert.deepEqual(history, [{
      event: "history-preserved",
      detail: { preserved: true },
    }]);
  } finally {
    try {
      await sql.raw(`DROP SCHEMA "${validateProofSchema(schema)}" CASCADE`)
        .execute(database.kysely);
    } finally {
      await database.close();
    }
  }
});

async function sideEffectCounts(database: ProtocolDatabase) {
  return (await sql<{
    decisions: number;
    questions: number;
    corrections: number;
    holds: number;
    obligations: number;
    attempts: number;
    operations: number;
    history: number;
  }>`select
      (select count(*)::integer from decisions) as decisions,
      (select count(*)::integer from client_questions) as questions,
      (select count(*)::integer from corrections) as corrections,
      (select count(*)::integer from holds) as holds,
      (select count(*)::integer from obligations) as obligations,
      (select count(*)::integer from attempts) as attempts,
      (select count(*)::integer from operations) as operations,
      (select count(*)::integer from protocol_history) as history`
    .execute(database.kysely)).rows[0]!;
}

test("real PostgreSQL preserves exact Unicode, recovers cross-browser, and conflicts stale revisions", {
  skip: databaseUrl ? false : "PostgreSQL is not configured",
}, async (t) => {
  const current = { value: new Date("2026-11-12T12:00:00.000Z") };
  const seeded = await fixture(t);
  const firstBrowser = new PostgresClientReviewDraftStore(
    seeded.database,
    { clock: () => current.value },
  );
  const secondBrowser = new PostgresClientReviewDraftStore(
    seeded.database,
    { clock: () => current.value },
  );
  const before = await sideEffectCounts(seeded.database);
  const text = "  ¿Corrige “Café”? 😀\n契約の文脈\t  ";
  const source = "  Signed scope §4\nنسخة العميل  ";
  const created = await firstBrowser.save(seeded.authority, {
    expectedRevision: null,
    exactText: text,
    correctionSourceText: source,
    modelProcessing: "permitted",
  });
  assert.equal(created.created, true);
  assert.equal(created.draft.revision, 1);
  assert.equal(created.draft.exactText, text);
  assert.equal(created.draft.correctionSourceText, source);
  assert.deepEqual(await sideEffectCounts(seeded.database), before);

  const raw = (await sql<{
    draft_digest: string;
    exact_text: string;
    correction_source_text: string;
  }>`select draft_digest,exact_text,correction_source_text
    from client_review_drafts`.execute(seeded.database.kysely)).rows[0];
  assert.match(raw?.draft_digest ?? "", /^[a-f0-9]{64}$/);
  assert.equal(raw?.exact_text, text);
  assert.equal(raw?.correction_source_text, source);

  const recovered = await secondBrowser.read(seeded.authority);
  assert.equal(recovered?.revision, 1);
  assert.equal(recovered?.exactText, text);

  current.value = new Date("2026-11-13T12:00:00.000Z");
  const replay = await secondBrowser.save(seeded.authority, {
    expectedRevision: null,
    exactText: text,
    correctionSourceText: source,
    modelProcessing: "permitted",
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.draft.revision, 1);
  assert.equal(
    replay.draft.expiresAt.toISOString(),
    "2026-11-20T12:00:00.000Z",
  );

  const changed = await secondBrowser.save(seeded.authority, {
    expectedRevision: 1,
    exactText: `${text}\nSecond browser edit.`,
    correctionSourceText: source,
    modelProcessing: "denied",
  });
  assert.equal(changed.draft.revision, 2);
  await assert.rejects(
    firstBrowser.save(seeded.authority, {
      expectedRevision: 1,
      exactText: `${text}\nStale first browser edit.`,
      correctionSourceText: source,
      modelProcessing: "permitted",
    }),
    (error: unknown) =>
      error instanceof ClientReviewDraftError
      && error.code === "DRAFT_CONFLICT",
  );
  assert.equal((await firstBrowser.read(seeded.authority))?.revision, 2);
  await assert.rejects(
    firstBrowser.delete(seeded.authority, 1),
    (error: unknown) =>
      error instanceof ClientReviewDraftError
      && error.code === "DRAFT_CONFLICT",
  );
  assert.equal((await firstBrowser.delete(seeded.authority, 2)).deleted, true);
  assert.equal(await secondBrowser.read(seeded.authority), null);
});

test("drafts expire at the exact seven-inactive-day boundary", {
  skip: databaseUrl ? false : "PostgreSQL is not configured",
}, async (t) => {
  const current = { value: new Date("2026-11-12T12:00:00.000Z") };
  const seeded = await fixture(t);
  const store = new PostgresClientReviewDraftStore(
    seeded.database,
    { clock: () => current.value },
  );
  const authority = {
    ...seeded.authority,
    kind: "question" as const,
  };
  await store.save(authority, {
    expectedRevision: null,
    exactText: "Does this exact source govern the change?",
    correctionSourceText: null,
    modelProcessing: "denied",
  });
  current.value = new Date("2026-11-19T11:59:59.999Z");
  assert.equal((await store.read(authority))?.revision, 1);
  current.value = new Date("2026-11-19T12:00:00.000Z");
  assert.equal(await store.read(authority), null);
  const remaining = (await sql<{ count: number }>`select
      count(*)::integer as count from client_review_drafts`
    .execute(seeded.database.kysely)).rows[0]?.count;
  assert.equal(remaining, 0);
});

test("replacement participants and revoked grants cannot recover predecessor drafts", {
  skip: databaseUrl ? false : "PostgreSQL is not configured",
}, async (t) => {
  const seeded = await fixture(t);
  const store = new PostgresClientReviewDraftStore(seeded.database);
  await store.save(seeded.authority, {
    expectedRevision: null,
    exactText: "Predecessor private correction.",
    correctionSourceText: null,
    modelProcessing: "denied",
  });
  assert.equal(await store.read({
    ...seeded.authority,
    participantSubjectDigest: "c".repeat(64),
  }), null);
  const replacementId = `${seeded.authority.actorId}-next`;
  await sql`update projects
    set approver_id = ${replacementId},nomination_epoch = 2
    where workspace_id = ${workspaceId}
      and id = ${seeded.authority.projectId}`
    .execute(seeded.database.kysely);
  for (const action of ["inspect", "decide", "correct"] as const) {
    await sql`insert into grants(
        workspace_id,project_id,actor_id,action
      ) values (
        ${workspaceId},${seeded.authority.projectId},${replacementId},${action}
      )`.execute(seeded.database.kysely);
  }
  const replacement = {
    ...seeded.authority,
    actorId: replacementId,
    nominationEpoch: 2,
  };
  assert.equal(await store.read(replacement), null);
  await store.save(replacement, {
    expectedRevision: null,
    exactText: "Replacement participant private correction.",
    correctionSourceText: null,
    modelProcessing: "denied",
  });
  await assert.rejects(
    store.read(seeded.authority),
    (error: unknown) =>
      error instanceof ClientReviewDraftError
      && error.code === "ACCESS_DENIED",
  );

  await sql`update grants set active = false,epoch = epoch + 1
    where workspace_id = ${workspaceId}
      and project_id = ${seeded.authority.projectId}
      and actor_id = ${replacementId}
      and action = 'correct'`.execute(seeded.database.kysely);
  await assert.rejects(
    store.read(replacement),
    (error: unknown) =>
      error instanceof ClientReviewDraftError
      && error.code === "ACCESS_DENIED",
  );

  const otherProject = `other-${randomUUID().slice(0, 8)}`;
  await seedReview(seeded.database, {
    projectId: otherProject,
    requestId: `${otherProject}-request`,
    unitId: `${otherProject}-unit`,
    approverId: replacementId,
    nominationEpoch: 2,
  });
  assert.equal(await store.read({
    ...replacement,
    projectId: otherProject,
    requestId: `${otherProject}-request`,
    unitId: `${otherProject}-unit`,
  }), null);
});
