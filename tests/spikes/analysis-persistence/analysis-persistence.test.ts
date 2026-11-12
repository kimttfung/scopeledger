import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
  ANALYSIS_DEMO_SCOPE,
  AnalysisPersistenceError,
  createIsolatedProofDatabase,
  migration001,
  migration002,
  newProofSchema,
  PostgresAnalysisStore,
  ProtocolDatabase,
  sql,
  validateProofSchema,
} from "@scopeledger/db";
import type {
  AnalysisRunInput,
  AnalysisSourceVersionInput,
} from "@scopeledger/db";

function requiredDatabaseUrl(): string {
  const url = process.env.IP01_DATABASE_URL;
  assert.ok(
    url,
    "IP01_DATABASE_URL is required: analysis persistence tests must use isolated real PostgreSQL",
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

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const exactText = "Included layout. Populated page is additional.";
const subjectDigest = "a".repeat(64);
const reviewedAt = new Date("2026-11-11T20:00:00.000Z");

function persistenceInput(runId = randomUUID()): Readonly<{
  source: AnalysisSourceVersionInput;
  run: AnalysisRunInput;
}> {
  const sourceReference = {
    ...ANALYSIS_DEMO_SCOPE,
    versionId: runId,
  };
  return {
    source: {
      ...sourceReference,
      exactText,
      exactTextDigest: digest(exactText),
      parserReference: "scopeledger.pdfjs.v1",
      extractionStatus: "complete",
      declaredByteLength: 20,
      declaredPageCount: 1,
      extractedPageCount: 1,
      codePointCount: 46,
      recordedAt: reviewedAt,
      provenance: {
        origin: "other",
        suppliedBy: "authenticated-provider",
        contentAttestation: "synthetic-or-permitted",
        attestedAt: reviewedAt,
      },
      permissions: {
        studioSharing: "permitted",
        modelProcessing: "permitted",
        modelInputReview: "cleared",
        reviewedBySubjectDigest: subjectDigest,
        reviewedAt,
      },
      coverage: [{
        pageNumber: 1,
        status: "extracted",
        start: 0,
        end: 46,
      }],
    },
    run: {
      ...ANALYSIS_DEMO_SCOPE,
      runId,
      requestedBySubjectDigest: subjectDigest,
      sourceVersionId: runId,
      providerReference: "google-gemini",
      modelReference: "gemini-test-model",
      candidateSchemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
      configReference: "scopeledger.gemini.server-config.v1",
      status: "candidate-ready",
      candidatePayload: {
        schemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
        humanReviewRequired: true,
        publicationBlocked: true,
        candidates: [{
          claimId: "claim-1",
          interpretation: "The populated page may be additional.",
          evidence: [{
            polarity: "supporting",
            quote: "Populated page is additional.",
            start: 17,
            end: 46,
            sourceReference,
          }, {
            polarity: "charge-weakening",
            quote: "Included layout.",
            start: 0,
            end: 16,
            sourceReference,
          }],
          uncertainty: {
            status: "limited",
            explanation: "Provider interpretation remains required.",
            questions: ["Which source governs this request?"],
          },
          reviewState: "human-review-required",
        }],
        missingContext: ["Original agreement not represented."],
      },
      failureDiagnostic: null,
      createdAt: reviewedAt,
    },
  };
}

function rejectsCode(
  work: Promise<unknown>,
  code: AnalysisPersistenceError["code"],
): Promise<void> {
  return assert.rejects(work, (error: unknown) =>
    error instanceof AnalysisPersistenceError && error.code === code);
}

test("migration 003 remains installed when later reviewed migrations apply", async (t) => {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  assert.deepEqual((await sql<{ version: number }>`
    select version from schema_migrations order by version
  `.execute(isolated.database.kysely)).rows.map((row) => row.version), [1, 2, 3, 4]);
  const relations = (await sql<{ name: string }>`
    select c.relname as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${isolated.schema}
      and c.relname in (
        'analysis_scopes',
        'analysis_source_identities',
        'analysis_source_versions',
        'analysis_source_provenance',
        'analysis_source_permissions',
        'analysis_source_coverage',
        'analysis_runs',
        'analysis_human_reviews'
      )
    order by c.relname collate "C"
  `.execute(isolated.database.kysely)).rows.map((row) => row.name);
  assert.deepEqual(relations, [
    "analysis_human_reviews",
    "analysis_runs",
    "analysis_scopes",
    "analysis_source_coverage",
    "analysis_source_identities",
    "analysis_source_permissions",
    "analysis_source_provenance",
    "analysis_source_versions",
  ]);

  const targets = await migrationTargets(t);
  for (const existing of [1, 2] as const) {
    const database = await targets.create();
    await database.transaction(async (transaction) => {
      await sql.raw(migration001).execute(transaction);
      await sql`insert into workspaces(id,merchant_id,environment)
        values ('upgrade-workspace','upgrade-merchant','sandbox')`
        .execute(transaction);
      if (existing === 2) await sql.raw(migration002).execute(transaction);
    });
    await database.migrate();
    assert.deepEqual((await sql<{ version: number }>`
      select version from schema_migrations order by version
    `.execute(database.kysely)).rows.map((row) => row.version), [1, 2, 3, 4]);
    assert.equal((await sql`select 1 from workspaces
      where id = 'upgrade-workspace'`.execute(database.kysely)).rows.length, 1);
    await database.migrate();
  }
});

test("migrator rejects gapped, unknown, empty, and unversioned histories", async (t) => {
  const targets = await migrationTargets(t);
  for (const versions of [[2], [1, 3], [1, 2, 5], [1, 2, 3, 5], [1, 2, 3, 4, 5]]) {
    const database = await targets.create();
    await database.transaction(async (transaction) => {
      await sql`create table schema_migrations(
        version integer primary key,
        applied_at timestamptz not null default clock_timestamp()
      )`.execute(transaction);
      for (const version of versions) {
        await sql`insert into schema_migrations(version) values (${version})`
          .execute(transaction);
      }
    });
    await assert.rejects(
      database.migrate(),
      /Unsupported protocol migration history/,
    );
  }
  const empty = await targets.create();
  await empty.transaction(async (transaction) => {
    await sql`create table schema_migrations(
      version integer primary key,
      applied_at timestamptz not null default clock_timestamp()
    )`.execute(transaction);
  });
  await assert.rejects(empty.migrate(), /Unsupported protocol migration history/);

  const unversioned = await targets.create();
  await unversioned.transaction(async (transaction) => {
    await sql`create table unknown_analysis_history(value integer not null)`
      .execute(transaction);
  });
  await assert.rejects(
    unversioned.migrate(),
    /Unsupported protocol migration history/,
  );
});

test("source and run storage is immutable, idempotent, bounded, and user-scoped", async (t) => {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  const store = new PostgresAnalysisStore(isolated.database);
  const input = persistenceInput();
  const first = await store.saveRun(input);
  assert.equal(first.duplicate, false);
  assert.equal(first.run.status, "candidate-ready");
  assert.equal(first.run.publicationBlocked, true);
  assert.equal(first.run.humanReviewRequired, true);
  assert.equal(first.run.candidatePayload?.candidates.length, 1);

  const duplicate = await store.saveRun(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.run.runDigest, first.run.runDigest);
  assert.equal((await store.readRun({
    ...ANALYSIS_DEMO_SCOPE,
    runId: input.run.runId,
  }))?.sourceDigest, digest(exactText));
  assert.equal((await store.listRuns({
    ...ANALYSIS_DEMO_SCOPE,
    requestedBySubjectDigest: subjectDigest,
  })).length, 1);
  assert.equal((await store.listRuns({
    ...ANALYSIS_DEMO_SCOPE,
    requestedBySubjectDigest: "b".repeat(64),
  })).length, 0);

  await rejectsCode(store.saveRun({
    source: input.source,
    run: {
      ...input.run,
      modelReference: "different-model",
    },
  }), "RUN_CONFLICT");
  await assert.rejects(sql`update analysis_runs
    set publication_blocked = false
    where run_id = ${input.run.runId}::uuid`.execute(isolated.database.kysely));
  await assert.rejects(sql`delete from analysis_source_versions
    where version_id = ${input.source.versionId}::uuid`
    .execute(isolated.database.kysely));
  assert.equal((await sql<{ count: number }>`select count(*)::integer as count from units`
    .execute(isolated.database.kysely)).rows[0]?.count, 0);
});

test("human reviews append idempotently against immutable run and candidate digests", async (t) => {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  const reviewTime = new Date("2026-11-11T20:05:00.000Z");
  const store = new PostgresAnalysisStore(isolated.database, {
    clock: () => reviewTime,
  });
  const input = persistenceInput();
  const saved = await store.saveRun(input);
  const reviewId = randomUUID();
  const review = {
    ...ANALYSIS_DEMO_SCOPE,
    reviewId,
    runId: input.run.runId,
    reviewerSubjectDigest: subjectDigest,
    disposition: "edit" as const,
    note: "Edit the candidate before any downstream provider preparation.",
  };
  const first = await store.appendReview(review);
  assert.equal(first.duplicate, false);
  assert.equal(first.review.runBasisDigest, saved.run.runDigest);
  assert.equal(first.review.candidateBasisDigest, saved.run.candidateDigest);
  const duplicate = await store.appendReview(review);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await store.readReviews({
    ...ANALYSIS_DEMO_SCOPE,
    runId: input.run.runId,
  })).length, 1);

  await rejectsCode(store.appendReview({
    ...review,
    note: "Different immutable content.",
  }), "REVIEW_CONFLICT");
  await rejectsCode(store.appendReview({
    ...review,
    reviewId: randomUUID(),
    reviewerSubjectDigest: "b".repeat(64),
  }), "REVIEW_FORBIDDEN");
  await assert.rejects(sql`update analysis_human_reviews
    set disposition = 'accept'
    where review_id = ${reviewId}::uuid`.execute(isolated.database.kysely));
  await assert.rejects(sql`delete from analysis_human_reviews
    where review_id = ${reviewId}::uuid`.execute(isolated.database.kysely));
});
