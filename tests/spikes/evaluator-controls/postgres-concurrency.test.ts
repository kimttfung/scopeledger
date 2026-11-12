import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
  ANALYSIS_DEMO_SCOPE,
  createIsolatedProofDatabase,
  PostgresAnalysisStore,
  PostgresAuthoringStore,
  sql,
  type AnalysisRunInput,
  type AnalysisSourceVersionInput,
  type SourceIntakeInput,
} from "@scopeledger/db";
import {
  EvaluatorLimitError,
  readAnalysisLimitState,
  readSourceUploadLimitState,
  type AnalysisLimitScope,
  type EvaluatorLimitConfig,
  withAnalysisAdmission,
  withSourceUploadAdmission,
} from "../../../apps/web/lib/evaluator-limits.js";

const config: EvaluatorLimitConfig = Object.freeze({
  profile: "production",
  analysisRunsPerSubjectProject: 3,
  sourceUploadsPerProjectWindow: 3,
  sourceUploadBytesPerProjectWindow: 300,
  sourceUploadWindowMinutes: 60,
  modelCallsPerSubjectProject: 2,
});
const subjectA = "a".repeat(64);
const subjectB = "b".repeat(64);

function databaseUrl(): string {
  const value = process.env.IP01_DATABASE_URL
    ?? process.env.SCOPELEDGER_DATABASE_URL;
  assert.ok(
    value,
    "IP01_DATABASE_URL or SCOPELEDGER_DATABASE_URL is required for evaluator concurrency validation",
  );
  return value;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function analysisSource(
  versionId: string,
  modelPermitted = false,
): AnalysisSourceVersionInput {
  const text = `Exact evaluator source ${versionId}.`;
  return {
    ...ANALYSIS_DEMO_SCOPE,
    versionId,
    exactText: text,
    exactTextDigest: digest(text),
    parserReference: "scopeledger.utf8-text.v1",
    extractionStatus: "complete",
    declaredByteLength: Buffer.byteLength(text),
    declaredPageCount: 1,
    extractedPageCount: 1,
    codePointCount: Array.from(text).length,
    recordedAt: new Date(),
    provenance: {
      origin: "other",
      suppliedBy: "authenticated-provider",
      contentAttestation: "synthetic-or-permitted",
      attestedAt: new Date(),
    },
    permissions: modelPermitted
      ? {
        studioSharing: "permitted",
        modelProcessing: "permitted",
        modelInputReview: "cleared",
        reviewedBySubjectDigest: subjectA,
        reviewedAt: new Date(),
      }
      : {
        studioSharing: "permitted",
        modelProcessing: "denied",
        modelInputReview: "not-reviewed",
        reviewedBySubjectDigest: null,
        reviewedAt: null,
      },
    coverage: [{
      pageNumber: 1,
      status: "extracted",
      start: 0,
      end: Array.from(text).length,
    }],
  };
}

function analysisRun(
  source: AnalysisSourceVersionInput,
  runId: string,
  subjectDigest: string,
  provider: "manual" | "google-gemini" = "manual",
): AnalysisRunInput {
  return {
    ...ANALYSIS_DEMO_SCOPE,
    runId,
    requestedBySubjectDigest: subjectDigest,
    sourceVersionId: source.versionId,
    providerReference: provider,
    modelReference: provider === "google-gemini" ? "gemini-test" : null,
    candidateSchemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
    configReference: provider === "google-gemini"
      ? "scopeledger.gemini.server-config.v1"
      : "scopeledger.analysis.manual.v1",
    status: provider === "google-gemini"
      ? "model-failed"
      : "manual-review-ready",
    candidatePayload: null,
    failureDiagnostic: provider === "google-gemini"
      ? {
        code: "MODEL_PROCESSING_FAILED",
        message: "Gemini candidate processing did not complete. Manual review remains available.",
      }
      : null,
    createdAt: source.recordedAt,
  };
}

function analysisScope(
  logicalProjectId: string,
  subjectDigest: string,
  sourceVersionIds: readonly string[],
): AnalysisLimitScope {
  return {
    logicalWorkspaceId: "workspace-a",
    logicalProjectId,
    persistenceWorkspaceId: ANALYSIS_DEMO_SCOPE.workspaceId,
    persistenceProjectId: ANALYSIS_DEMO_SCOPE.projectId,
    subjectDigest,
    sourceVersionMode: "listed",
    sourceVersionIds,
  };
}

async function seedWorkspaceAndProjects(
  database: Awaited<ReturnType<typeof createIsolatedProofDatabase>>["database"],
): Promise<PostgresAuthoringStore> {
  await sql`insert into workspaces(id,merchant_id,environment)
    values ('workspace-a','merchant-a','sandbox')`.execute(database.kysely);
  const authoring = new PostgresAuthoringStore(database);
  for (const projectId of ["project-a", "project-b"]) {
    await authoring.createProject({
      workspaceId: "workspace-a",
      projectId,
      displayName: projectId,
      clientId: `client-${projectId}`,
      initialApproverId: `approver-${projectId}`,
      createdBy: "provider-a",
    });
  }
  return authoring;
}

function sourceInput(projectId: string, index: number): SourceIntakeInput {
  const bytes = new Uint8Array(100).fill(index);
  return {
    workspaceId: "workspace-a",
    projectId,
    sourceId: `source_${index.toString(16).padStart(32, "0")}_${index.toString(16).padStart(48, "0")}`,
    version: 1,
    availability: "available",
    reviewedBy: "provider-a",
    sourceKind: "provider-upload",
    mediaType: "text/plain",
    originalName: `source-${index}.txt`,
    declaredByteLength: bytes.byteLength,
    contentDigest: digest(bytes),
    provenance: {
      origin: "request",
      suppliedBy: "provider-a",
      originReference: null,
      acceptance: {
        kind: "provider-attested-import",
        basis: "Synthetic evaluator concurrency fixture.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "Manual review only.",
      },
    },
  };
}

test("PostgreSQL advisory admissions enforce exact boundaries and isolation", async (t) => {
  const isolated = await createIsolatedProofDatabase(databaseUrl());
  t.after(isolated.dispose);
  const authoring = await seedWorkspaceAndProjects(isolated.database);
  const analysis = new PostgresAnalysisStore(isolated.database);

  const sourceResults = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) => {
      const input = sourceInput("project-a", index + 1);
      return withSourceUploadAdmission(
        isolated.database,
        config,
        {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          sourceId: input.sourceId,
          sourceVersion: input.version,
          byteLength: input.declaredByteLength,
        },
        () => authoring.recordSourceIntake(input),
      );
    }),
  );
  assert.equal(
    sourceResults.filter((result) => result.status === "fulfilled").length,
    3,
  );
  const sourceFailures = sourceResults.filter(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected",
  );
  assert.equal(sourceFailures.length, 2);
  assert.ok(sourceFailures.every((result) =>
    result.reason instanceof EvaluatorLimitError
    && (
      result.reason.code === "SOURCE_UPLOAD_LIMIT_REACHED"
      || result.reason.code === "SOURCE_UPLOAD_BYTES_LIMIT_REACHED"
    )
  ));
  assert.deepEqual(
    await readSourceUploadLimitState(isolated.database, config, {
      workspaceId: "workspace-a",
      projectId: "project-a",
    }),
    {
      maximumCount: 3,
      admittedCount: 3,
      remainingCount: 0,
      maximumBytes: 300,
      admittedBytes: 300,
      remainingBytes: 0,
      windowMinutes: 60,
      blocked: true,
    },
  );
  const projectBSource = sourceInput("project-b", 20);
  const projectBAdmission = await withSourceUploadAdmission(
    isolated.database,
    config,
    {
      workspaceId: projectBSource.workspaceId,
      projectId: projectBSource.projectId,
      sourceId: projectBSource.sourceId,
      sourceVersion: projectBSource.version,
      byteLength: projectBSource.declaredByteLength,
    },
    () => authoring.recordSourceIntake(projectBSource),
  );
  assert.equal(projectBAdmission.state.remainingCount, 2);

  const projectASource = analysisSource(uuid(100));
  const projectAScope = analysisScope(
    "project-a",
    subjectA,
    [projectASource.versionId],
  );
  const analysisResults = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      withAnalysisAdmission(
        isolated.database,
        config,
        { ...projectAScope, mode: "manual" },
        async () => {
          const run = analysisRun(
            projectASource,
            uuid(200 + index),
            subjectA,
          );
          await analysis.saveRun({ source: projectASource, run });
          return run.runId;
        },
      )),
  );
  assert.equal(
    analysisResults.filter((result) => result.status === "fulfilled").length,
    3,
  );
  const analysisFailures = analysisResults.filter(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected",
  );
  assert.equal(analysisFailures.length, 2);
  assert.ok(analysisFailures.every((result) =>
    result.reason instanceof EvaluatorLimitError
    && result.reason.code === "ANALYSIS_RUN_LIMIT_REACHED"
  ));
  assert.equal(
    (await readAnalysisLimitState(
      isolated.database,
      config,
      projectAScope,
    )).remainingRuns,
    0,
  );
  assert.equal(
    (await readAnalysisLimitState(
      isolated.database,
      config,
      analysisScope("project-a", subjectB, [projectASource.versionId]),
    )).remainingRuns,
    3,
  );
  const projectBAnalysisSource = analysisSource(uuid(101));
  assert.equal(
    (await readAnalysisLimitState(
      isolated.database,
      config,
      analysisScope(
        "project-b",
        subjectA,
        [projectBAnalysisSource.versionId],
      ),
    )).remainingRuns,
    3,
  );

  const budgetSource = analysisSource(uuid(102), true);
  const budgetScope = analysisScope(
    "project-budget",
    subjectA,
    [budgetSource.versionId],
  );
  for (const index of [300, 301]) {
    await withAnalysisAdmission(
      isolated.database,
      config,
      { ...budgetScope, mode: "gemini" },
      async (decision) => {
        assert.equal(decision.modelDispatchAllowed, true);
        const run = analysisRun(
          budgetSource,
          uuid(index),
          subjectA,
          "google-gemini",
        );
        await analysis.saveRun({ source: budgetSource, run });
      },
    );
  }
  let dispatches = 0;
  await withAnalysisAdmission(
    isolated.database,
    config,
    { ...budgetScope, mode: "gemini" },
    async (decision) => {
      if (decision.modelDispatchAllowed) dispatches += 1;
      assert.equal(decision.modelDispatchAllowed, false);
      const run = analysisRun(
        budgetSource,
        uuid(302),
        subjectA,
        "manual",
      );
      await analysis.saveRun({ source: budgetSource, run });
    },
  );
  assert.equal(dispatches, 0);
  assert.deepEqual(
    await readAnalysisLimitState(
      isolated.database,
      config,
      budgetScope,
    ),
    {
      maximumRuns: 3,
      admittedRuns: 3,
      remainingRuns: 0,
      modelCallBudget: 2,
      admittedModelCalls: 2,
      remainingModelCalls: 0,
      blocked: true,
      modelBlocked: true,
    },
  );

  const sideEffects = (await sql<{
    access_challenges: string;
    decisions: string;
    obligations: string;
    attempts: string;
    publications: string;
  }>`select
      (select count(*)::text from access_challenges) as access_challenges,
      (select count(*)::text from decisions) as decisions,
      (select count(*)::text from obligations) as obligations,
      (select count(*)::text from attempts) as attempts,
      (select count(*)::text from provider_publication_provenance) as publications`
    .execute(isolated.database.kysely)).rows[0];
  assert.deepEqual(sideEffects, {
    access_challenges: "0",
    decisions: "0",
    obligations: "0",
    attempts: "0",
    publications: "0",
  });
});
