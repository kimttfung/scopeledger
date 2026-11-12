import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  AuthoringPersistenceError,
  createIsolatedProofDatabase,
  migration001,
  migration002,
  migration003,
  newProofSchema,
  PostgresAuthoringStore,
  ProtocolDatabase,
  sql,
  validateProofSchema,
} from "@scopeledger/db";
import type {
  SourceIntakeInput,
} from "@scopeledger/db";

function requiredDatabaseUrl(): string {
  const url = process.env.IP01_DATABASE_URL;
  assert.ok(
    url,
    "IP01_DATABASE_URL is required: authoring persistence tests must use isolated real PostgreSQL",
  );
  return url;
}

async function migrationTargets(t: TestContext) {
  const control = await createIsolatedProofDatabase(requiredDatabaseUrl());
  const databases: ProtocolDatabase[] = [];
  const schemas: string[] = [];
  t.after(async () => {
    for (const database of databases) await database.close();
    for (const schema of schemas) {
      await sql.raw(`DROP SCHEMA "${validateProofSchema(schema)}" CASCADE`)
        .execute(control.database.kysely);
    }
    await control.dispose();
  });
  return {
    create: async () => {
      const schema = newProofSchema();
      await sql.raw(`CREATE SCHEMA "${validateProofSchema(schema)}"`)
        .execute(control.database.kysely);
      const database = new ProtocolDatabase({
        connectionString: requiredDatabaseUrl(),
        schema,
        maxConnections: 2,
      });
      databases.push(database);
      schemas.push(schema);
      return database;
    },
  };
}

const fixedTime = new Date("2026-11-11T22:30:00.000Z");
const workspaceId = "authoring-workspace";
const projectId = "authoring-project";
const requestId = "request-one";
const unitId = "unit-one";
const sourceId = "source-one";
const providerId = "provider-one";
const clientId = "client-one";
const approverId = "approver-one";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceInput(
  overrides: Partial<SourceIntakeInput> = {},
): SourceIntakeInput {
  return {
    workspaceId,
    projectId,
    sourceId,
    version: 1,
    availability: "available",
    reviewedBy: providerId,
    sourceKind: "provider-upload",
    mediaType: "application/pdf",
    originalName: "Scope – café 😀.pdf",
    declaredByteLength: 18,
    contentDigest: sha256("synthetic-content"),
    provenance: {
      origin: "agreement",
      suppliedBy: providerId,
      originReference: "Signed scope\nSection 4",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Provider attested that this synthetic source may be used.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "Manual authoring only.",
      },
    },
    ...overrides,
  };
}

async function seedAuthoring(t: TestContext, suffix = "") {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  const targetWorkspace = `${workspaceId}${suffix}`;
  const targetProject = `${projectId}${suffix}`;
  const store = new PostgresAuthoringStore(isolated.database, {
    clock: () => fixedTime,
  });
  await sql`insert into workspaces(id,merchant_id,environment)
    values (${targetWorkspace},${`merchant${suffix || "-one"}`} ,'sandbox')`
    .execute(isolated.database.kysely);
  await store.createProject({
    workspaceId: targetWorkspace,
    projectId: targetProject,
    displayName: "Café launch",
    clientId,
    initialApproverId: approverId,
    createdBy: providerId,
  });
  await store.createRequest({
    workspaceId: targetWorkspace,
    projectId: targetProject,
    requestId,
    title: "Homepage scope review",
    createdBy: providerId,
  });
  await store.recordSourceIntake(sourceInput({
    workspaceId: targetWorkspace,
    projectId: targetProject,
  }));
  await store.saveDraft({
    workspaceId: targetWorkspace,
    projectId: targetProject,
    requestId,
    unitId,
    revision: 1,
    expectedPreviousRevision: null,
    state: "in-progress",
    title: "Homepage implementation",
    summary: "Draft exact scope before client review.",
    scope: ["Implement the approved homepage."],
    exclusions: ["No payment effect is created by this draft."],
    sourceReferences: [{ sourceId, version: 1 }],
    authoredBy: providerId,
  });
  await publishVersion(
    isolated.database,
    targetWorkspace,
    targetProject,
    unitId,
    1,
  );
  return {
    ...isolated,
    store,
    workspaceId: targetWorkspace,
    projectId: targetProject,
  };
}

async function publishVersion(
  database: ProtocolDatabase,
  targetWorkspace: string,
  targetProject: string,
  targetUnit: string,
  version: number,
): Promise<void> {
  const snapshot = {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    workspaceId: targetWorkspace,
    projectId: targetProject,
    unitId: targetUnit,
    version,
    treatment: "additional-waived",
  };
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  await sql`insert into unit_versions(
      workspace_id,project_id,unit_id,version,snapshot,canonical_bytes,digest,
      published_by,published_at
    ) values (
      ${targetWorkspace},${targetProject},${targetUnit},${version},
      ${JSON.stringify(snapshot)}::jsonb,${bytes},${sha256(bytes)},${providerId},
      ${fixedTime}
    )`.execute(database.kysely);
}

function rejectsCode(
  work: Promise<unknown>,
  code: AuthoringPersistenceError["code"],
): Promise<void> {
  return assert.rejects(work, (error: unknown) =>
    error instanceof AuthoringPersistenceError && error.code === code);
}

test("reviewed migrations install fresh and upgrade contiguous earlier histories", async (t) => {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  assert.deepEqual((await sql<{ version: number }>`
    select version from schema_migrations order by version
  `.execute(isolated.database.kysely)).rows.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const relations = (await sql<{ name: string }>`
    select c.relname as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${isolated.schema}
      and c.relname in (
        'source_intake_records',
        'provider_authoring_draft_versions',
        'provider_authoring_draft_sources',
        'client_questions'
      )
    order by c.relname collate "C"
  `.execute(isolated.database.kysely)).rows.map((row) => row.name);
  assert.deepEqual(relations, [
    "client_questions",
    "provider_authoring_draft_sources",
    "provider_authoring_draft_versions",
    "source_intake_records",
  ]);

  const targets = await migrationTargets(t);
  for (const existing of [1, 2, 3] as const) {
    const database = await targets.create();
    await database.transaction(async (transaction) => {
      await sql.raw(migration001).execute(transaction);
      await sql`insert into workspaces(id,merchant_id,environment)
        values ('upgrade-workspace','upgrade-merchant','sandbox')`
        .execute(transaction);
      await sql`insert into projects(
          workspace_id,id,client_id,approver_id
        ) values (
          'upgrade-workspace','upgrade-project','upgrade-client','upgrade-approver'
        )`.execute(transaction);
      await sql`insert into packets(workspace_id,project_id,id)
        values ('upgrade-workspace','upgrade-project','upgrade-request')`
        .execute(transaction);
      await sql`insert into source_versions(
          workspace_id,project_id,id,version,availability,reviewed_by
        ) values (
          'upgrade-workspace','upgrade-project','upgrade-source',1,
          'unavailable','upgrade-provider'
        )`.execute(transaction);
      if (existing >= 2) await sql.raw(migration002).execute(transaction);
      if (existing >= 3) await sql.raw(migration003).execute(transaction);
    });
    await database.migrate();
    assert.deepEqual((await sql<{ version: number }>`
      select version from schema_migrations order by version
    `.execute(database.kysely)).rows.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const preserved = (await sql<{
      name: string | null;
      title: string | null;
      availability: string;
    }>`select p.provider_display_name as name,
          r.provider_title as title,s.availability
        from projects p
        join packets r
          on r.workspace_id = p.workspace_id and r.project_id = p.id
        join source_versions s
          on s.workspace_id = p.workspace_id and s.project_id = p.id
        where p.workspace_id = 'upgrade-workspace'
          and p.id = 'upgrade-project'`.execute(database.kysely)).rows[0];
    assert.deepEqual(preserved, {
      name: null,
      title: null,
      availability: "unavailable",
    });
    await database.migrate();
  }
});

test("user-created identities and browser locators remain workspace/project scoped", async (t) => {
  const first = await seedAuthoring(t, "-a");
  const second = await seedAuthoring(t, "-b");
  const questionId = randomUUID();
  await first.store.askQuestion({
    workspaceId: first.workspaceId,
    projectId: first.projectId,
    questionId,
    requestId,
    unitId,
    unitVersion: 1,
    askedBy: approverId,
    exactText: "Which source governs this exact request?",
    modelProcessing: "denied",
  });

  assert.equal(await first.store.readProject({
    workspaceId: second.workspaceId,
    projectId: first.projectId,
  }), null);
  assert.equal(await first.store.readRequest({
    workspaceId: first.workspaceId,
    projectId: second.projectId,
    requestId,
  }), null);
  assert.equal(await first.store.readSourceIntake({
    workspaceId: first.workspaceId,
    projectId: second.projectId,
    sourceId,
    version: 1,
  }), null);
  assert.equal(await first.store.readDraft({
    workspaceId: first.workspaceId,
    projectId: second.projectId,
    requestId,
    unitId,
    revision: 1,
  }), null);
  assert.equal(await first.store.readQuestion({
    workspaceId: second.workspaceId,
    projectId: first.projectId,
    questionId,
  }), null);
  assert.equal((await second.store.readQuestion({
    workspaceId: second.workspaceId,
    projectId: second.projectId,
    questionId,
  })), null);
});

test("project, request, source, draft, and question replay converges or conflicts", async (t) => {
  const f = await seedAuthoring(t);
  const projectReplay = await f.store.createProject({
    workspaceId,
    projectId,
    displayName: "Café launch",
    clientId,
    initialApproverId: approverId,
    createdBy: providerId,
  });
  assert.equal(projectReplay.duplicate, true);
  await rejectsCode(f.store.createProject({
    workspaceId,
    projectId,
    displayName: "Different project",
    clientId,
    initialApproverId: approverId,
    createdBy: providerId,
  }), "PROJECT_CONFLICT");

  assert.equal((await f.store.createRequest({
    workspaceId,
    projectId,
    requestId,
    title: "Homepage scope review",
    createdBy: providerId,
  })).duplicate, true);
  await rejectsCode(f.store.createRequest({
    workspaceId,
    projectId,
    requestId,
    title: "Different request",
    createdBy: providerId,
  }), "REQUEST_CONFLICT");

  assert.equal((await f.store.recordSourceIntake(sourceInput())).duplicate, true);
  await rejectsCode(f.store.recordSourceIntake(sourceInput({
    originalName: "different.pdf",
  })), "SOURCE_CONFLICT");

  const draft = {
    workspaceId,
    projectId,
    requestId,
    unitId,
    revision: 1,
    expectedPreviousRevision: null,
    state: "in-progress" as const,
    title: "Homepage implementation",
    summary: "Draft exact scope before client review.",
    scope: ["Implement the approved homepage."],
    exclusions: ["No payment effect is created by this draft."],
    sourceReferences: [{ sourceId, version: 1 }],
    authoredBy: providerId,
  };
  assert.equal((await f.store.saveDraft(draft)).duplicate, true);
  await rejectsCode(f.store.saveDraft({
    ...draft,
    summary: "Different immutable content.",
  }), "DRAFT_CONFLICT");

  const question = {
    workspaceId,
    projectId,
    questionId: randomUUID(),
    requestId,
    unitId,
    unitVersion: 1,
    askedBy: approverId,
    exactText: "  Was “layout” already included? 😀\nPlease confirm.\t  ",
    modelProcessing: "denied" as const,
  };
  const first = await f.store.askQuestion(question);
  const replay = await f.store.askQuestion(question);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.question.recordDigest, first.question.recordDigest);
  assert.equal(replay.question.exactText, question.exactText);
  await rejectsCode(f.store.askQuestion({
    ...question,
    exactText: "Changed question.",
  }), "QUESTION_CONFLICT");
});

test("database and contracts enforce bounds plus immutable sequential draft history", async (t) => {
  const f = await seedAuthoring(t);
  await rejectsCode(f.store.createRequest({
    workspaceId,
    projectId,
    requestId: "bounded-request",
    title: "x".repeat(201),
    createdBy: providerId,
  }), "INVALID_INPUT");
  await rejectsCode(f.store.recordSourceIntake(sourceInput({
    sourceId: "oversized-source",
    declaredByteLength: 10_000_001,
  })), "INVALID_INPUT");
  await rejectsCode(f.store.askQuestion({
    workspaceId,
    projectId,
    questionId: randomUUID(),
    requestId,
    unitId,
    unitVersion: 1,
    askedBy: approverId,
    exactText: "😀".repeat(10_001),
    modelProcessing: "denied",
  }), "INVALID_INPUT");
  await assert.rejects(sql`insert into client_questions(
      workspace_id,project_id,question_id,request_id,unit_id,unit_version,
      asked_by,exact_text,model_processing,record_digest
    ) values (
      ${workspaceId},${projectId},${randomUUID()}::uuid,${requestId},${unitId},1,
      ${approverId},${"😀".repeat(10_001)},'denied',${"e".repeat(64)}
    )`.execute(f.database.kysely), { code: "23514" });

  await rejectsCode(f.store.saveDraft({
    workspaceId,
    projectId,
    requestId,
    unitId,
    revision: 3,
    expectedPreviousRevision: 1,
    state: "ready-for-client-review",
    title: "Skipped revision",
    summary: "This revision must not be admitted.",
    scope: ["One item"],
    exclusions: [],
    sourceReferences: [{ sourceId, version: 1 }],
    authoredBy: providerId,
  }), "STALE_DRAFT_REVISION");
  const second = await f.store.saveDraft({
    workspaceId,
    projectId,
    requestId,
    unitId,
    revision: 2,
    expectedPreviousRevision: 1,
    state: "ready-for-client-review",
    title: "Homepage implementation",
    summary: "Ready for exact client review.",
    scope: ["Implement the approved homepage."],
    exclusions: [],
    sourceReferences: [{ sourceId, version: 1 }],
    authoredBy: providerId,
  });
  assert.equal(second.draft.revision, 2);

  await assert.rejects(sql`update provider_authoring_draft_versions
    set summary = 'rewritten'
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and unit_id = ${unitId}
      and revision = 2`.execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`delete from source_intake_records
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and source_id = ${sourceId}
      and source_version = 1`.execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`update projects
    set provider_display_name = 'rewritten'
    where workspace_id = ${workspaceId} and id = ${projectId}`
    .execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`insert into provider_authoring_draft_versions(
      workspace_id,project_id,request_id,unit_id,revision,state,title,summary,
      scope_items,exclusion_items,source_count,draft_digest,authored_by
    ) values (
      ${workspaceId},${projectId},${requestId},${unitId},4,'in-progress',
      'Direct skip','Direct SQL cannot skip a revision.','["item"]'::jsonb,
      '[]'::jsonb,0,${"f".repeat(64)},${providerId}
    )`.execute(f.database.kysely), { code: "23514" });
});

test("durable questions preserve attribution and exact Unicode without commercial effects", async (t) => {
  const f = await seedAuthoring(t);
  const before = (await sql<{
    decisions: number;
    corrections: number;
    holds: number;
    obligations: number;
    attempts: number;
    facts: number;
    work_starts: number;
    history: number;
  }>`select
      (select count(*)::integer from decisions) as decisions,
      (select count(*)::integer from corrections) as corrections,
      (select count(*)::integer from holds) as holds,
      (select count(*)::integer from obligations) as obligations,
      (select count(*)::integer from attempts) as attempts,
      (select count(*)::integer from payment_facts) as facts,
      (select count(*)::integer from protocol_history
        where event = 'work-started') as work_starts,
      (select count(*)::integer from protocol_history) as history`
    .execute(f.database.kysely)).rows[0]!;
  const exactText = "\t¿Está incluido el diseño “Café”?\n😀 Please confirm.  ";
  const saved = await f.store.askQuestion({
    workspaceId,
    projectId,
    questionId: randomUUID(),
    requestId,
    unitId,
    unitVersion: 1,
    askedBy: approverId,
    exactText,
    modelProcessing: "permitted",
  });
  assert.equal(saved.question.askedBy, approverId);
  assert.equal(saved.question.exactText, exactText);
  assert.equal(saved.question.communicationEffect, "communication-only");

  const after = (await sql<typeof before>`select
      (select count(*)::integer from decisions) as decisions,
      (select count(*)::integer from corrections) as corrections,
      (select count(*)::integer from holds) as holds,
      (select count(*)::integer from obligations) as obligations,
      (select count(*)::integer from attempts) as attempts,
      (select count(*)::integer from payment_facts) as facts,
      (select count(*)::integer from protocol_history
        where event = 'work-started') as work_starts,
      (select count(*)::integer from protocol_history) as history`
    .execute(f.database.kysely)).rows[0]!;
  assert.deepEqual(after, before);
  const unit = (await sql<{
    current_version: number | null;
    accepted_version: number | null;
  }>`select current_version,accepted_version from units
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and id = ${unitId}`.execute(f.database.kysely)).rows[0];
  assert.deepEqual(unit, { current_version: null, accepted_version: null });
  await assert.rejects(sql`update client_questions
    set exact_text = 'rewritten'
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and question_id = ${saved.question.questionId}::uuid`
    .execute(f.database.kysely), { code: "23514" });
  await assert.rejects(sql`delete from client_questions
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and question_id = ${saved.question.questionId}::uuid`
    .execute(f.database.kysely), { code: "23514" });
});
