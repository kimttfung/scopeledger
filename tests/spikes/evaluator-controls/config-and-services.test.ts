import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { File } from "node:buffer";
import test from "node:test";
import {
  ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
  ANALYSIS_DEMO_SCOPE,
  type AnalysisRunInput,
  type AnalysisRunRecord,
  type AnalysisSourceVersionInput,
  type SourceIntakeInput,
  type SourceIntakeRecord,
} from "@scopeledger/db";
import {
  executeAnalysisUpload,
} from "../../../apps/web/app/api/analysis/analysis-service.js";
import {
  handleProviderSourceAnalysisGet,
  handleProviderSourceAnalysisPost,
  type AuthorizedProviderSource,
  type ProviderSourceAnalysisDependencies,
  type ProviderSourceAnalysisGetResponse,
} from "../../../apps/web/app/api/provider/source-analysis/service.js";
import {
  handleProviderSourcePost,
  type ProviderSourceDependencies,
  type ProviderSourceTarget,
} from "../../../apps/web/app/api/provider/sources/service.js";
import {
  evaluatorLimitConfigFromEnvironment,
  EvaluatorLimitError,
  LOCAL_H1_EVALUATOR_LIMITS,
} from "../../../apps/web/lib/evaluator-limits.js";

const subjectDigest = "a".repeat(64);
const fixedTime = new Date("2026-11-12T12:00:00.000Z");
const analysisLimits = Object.freeze({
  maximumRuns: 3,
  admittedRuns: 2,
  remainingRuns: 1,
  modelCallBudget: 2,
  admittedModelCalls: 2,
  remainingModelCalls: 0,
  blocked: false,
  modelBlocked: true,
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("local H1 defaults are explicit while production settings fail closed", () => {
  assert.deepEqual(
    evaluatorLimitConfigFromEnvironment({ NODE_ENV: "development" }),
    LOCAL_H1_EVALUATOR_LIMITS,
  );
  assert.throws(
    () => evaluatorLimitConfigFromEnvironment({ NODE_ENV: "production" }),
    (error: unknown) =>
      error instanceof EvaluatorLimitError
      && error.code === "EVALUATOR_CONFIGURATION_INVALID",
  );
  assert.deepEqual(
    evaluatorLimitConfigFromEnvironment({
      NODE_ENV: "production",
      SCOPELEDGER_EVALUATOR_LIMITS_PROFILE: "production",
      SCOPELEDGER_ANALYSIS_RUN_LIMIT: "3",
      SCOPELEDGER_SOURCE_UPLOAD_COUNT_LIMIT: "5",
      SCOPELEDGER_SOURCE_UPLOAD_BYTES_LIMIT: "25000000",
      SCOPELEDGER_SOURCE_UPLOAD_WINDOW_MINUTES: "60",
      SCOPELEDGER_MODEL_CALL_BUDGET: "2",
    }),
    {
      profile: "production",
      analysisRunsPerSubjectProject: 3,
      sourceUploadsPerProjectWindow: 5,
      sourceUploadBytesPerProjectWindow: 25_000_000,
      sourceUploadWindowMinutes: 60,
      modelCallsPerSubjectProject: 2,
    },
  );
  assert.throws(
    () => evaluatorLimitConfigFromEnvironment({
      NODE_ENV: "production",
      SCOPELEDGER_EVALUATOR_LIMITS_PROFILE: "production",
      SCOPELEDGER_ANALYSIS_RUN_LIMIT: "2",
      SCOPELEDGER_SOURCE_UPLOAD_COUNT_LIMIT: "5",
      SCOPELEDGER_SOURCE_UPLOAD_BYTES_LIMIT: "25000000",
      SCOPELEDGER_SOURCE_UPLOAD_WINDOW_MINUTES: "60",
      SCOPELEDGER_MODEL_CALL_BUDGET: "3",
    }),
    (error: unknown) =>
      error instanceof EvaluatorLimitError
      && error.code === "EVALUATOR_CONFIGURATION_INVALID",
  );
  assert.throws(
    () => evaluatorLimitConfigFromEnvironment({
      NODE_ENV: "production",
      SCOPELEDGER_EVALUATOR_LIMITS_PROFILE: "production",
      SCOPELEDGER_ANALYSIS_RUN_LIMIT: "4",
      SCOPELEDGER_SOURCE_UPLOAD_COUNT_LIMIT: "5",
      SCOPELEDGER_SOURCE_UPLOAD_BYTES_LIMIT: "25000000",
      SCOPELEDGER_SOURCE_UPLOAD_WINDOW_MINUTES: "60",
      SCOPELEDGER_MODEL_CALL_BUDGET: "2",
    }),
    (error: unknown) =>
      error instanceof EvaluatorLimitError
      && error.code === "EVALUATOR_CONFIGURATION_INVALID",
  );
});

const parsedPdf = {
  declaredByteLength: 24,
  declaredPageCount: 1,
  extractedText: "Exact parser-only fallback.",
  pages: [{ pageNumber: 1, start: 0, end: 27 }],
  unavailablePages: [],
  extractorReference: "scopeledger.pdfjs.v1",
} as const;

test("protected PDF budget exhaustion saves only a manual parser run", async () => {
  const persisted: Array<Readonly<{
    source: AnalysisSourceVersionInput;
    run: AnalysisRunInput;
  }>> = [];
  let generated = 0;
  const result = await executeAnalysisUpload({
    file: new File(
      [new TextEncoder().encode("%PDF-1.7 synthetic")],
      "synthetic.pdf",
      { type: "application/pdf" },
    ),
    geminiPermitted: true,
  }, {
    extractPdf: async () => parsedPdf,
    sealParsedPdfSource: (_parsed, metadata) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        ...(metadata as {
          workspaceId: string;
          projectId: string;
          sourceId: string;
          versionId: string;
        }),
        extractedText: parsedPdf.extractedText,
        extraction: {
          status: "complete",
          unavailableReason: null,
        },
      },
    }),
    generateCandidates: async () => {
      generated += 1;
      throw new Error("Gemini must not run when the budget is exhausted");
    },
    requestedBySubjectDigest: subjectDigest,
    persistRun: async (input) => {
      persisted.push(input);
    },
    admitAnalysis: async (_input, work) => work({
      modelDispatchAllowed: false,
    }),
    newRunId: () => "11111111-1111-4111-8111-111111111111",
    now: () => fixedTime,
  });

  assert.equal(result.status, 429);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.code, "MODEL_BUDGET_EXHAUSTED");
  assert.equal(result.body.manualFallback.available, true);
  assert.equal(result.body.model?.status, "failed");
  assert.equal(generated, 0);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0]?.run.status, "manual-review-ready");
  assert.equal(persisted[0]?.run.providerReference, "manual");
  assert.equal(persisted[0]?.run.failureDiagnostic, null);
});

function intakeRecord(input: SourceIntakeInput): SourceIntakeRecord {
  const review = input.permissions.modelInputReview;
  return {
    ...input,
    permissions: {
      ...input.permissions,
      modelInputReview: review.status === "cleared"
        ? {
          ...review,
          reviewedAt: review.reviewedAt instanceof Date
            ? review.reviewedAt
            : new Date(review.reviewedAt),
        }
        : review,
    },
    recordedAt: fixedTime,
    recordDigest: "b".repeat(64),
  };
}

function sourceUploadRequest(): Request {
  const body = new FormData();
  body.set("file", new File(
    [new TextEncoder().encode("bounded source")],
    "source.txt",
    { type: "text/plain" },
  ));
  body.set("projectRequestLocator", "project-a/request-a");
  body.set("provenanceOrigin", "request");
  body.set("originReference", "");
  body.set("contentAttestation", "provider-permitted-source");
  body.set("acceptanceBasis", "Provider may import this source.");
  body.set("studioSharing", "permitted");
  body.set("modelProcessing", "denied");
  body.set("modelInputReviewStatus", "not-reviewed");
  body.set("modelReviewBasis", "Manual review only.");
  return new Request("http://127.0.0.1:3000/api/provider/sources", {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
      "content-length": "2048",
    },
    body,
  });
}

test("source limit rejection happens before storage or durable intake", async () => {
  const target: ProviderSourceTarget = {
    workspaceId: "workspace-a",
    projectId: "project-a",
    requestId: "request-a",
    providerActorId: "provider-a",
    grantAction: "publish",
    grantEpoch: 1,
  };
  let stored = 0;
  let persisted = 0;
  const dependencies: ProviderSourceDependencies = {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true, subjectDigest }),
    resolveTarget: () => target,
    authorizeTarget: async () => "authorized",
    listSourceIntake: async () => [],
    putSourceObject: async () => {
      stored += 1;
      throw new Error("must not store");
    },
    persistSourceIntake: async (input) => {
      persisted += 1;
      return { duplicate: false, source: intakeRecord(input) };
    },
    readSourceLimits: async () => ({
      maximumCount: 5,
      admittedCount: 5,
      remainingCount: 0,
      maximumBytes: 25_000_000,
      admittedBytes: 100,
      remainingBytes: 24_999_900,
      windowMinutes: 60,
      blocked: true,
    }),
    admitSourceUpload: async () => {
      throw new EvaluatorLimitError(
        "SOURCE_UPLOAD_LIMIT_REACHED",
        "limit",
      );
    },
    now: () => fixedTime,
  };
  const response = await handleProviderSourcePost(
    sourceUploadRequest(),
    dependencies,
  );
  const body = await response.json() as { code: string };
  assert.equal(response.status, 429);
  assert.equal(body.code, "SOURCE_UPLOAD_LIMIT_REACHED");
  assert.equal(stored, 0);
  assert.equal(persisted, 0);
});

function providerSource(): AuthorizedProviderSource {
  const bytes = new TextEncoder().encode("Exact admitted source.");
  const source: SourceIntakeRecord = {
    workspaceId: "workspace-a",
    projectId: "project-a",
    sourceId: `source_${"1".repeat(32)}_${"2".repeat(48)}`,
    version: 1,
    availability: "available",
    reviewedBy: "provider-a",
    sourceKind: "provider-upload",
    mediaType: "text/plain",
    originalName: "source.txt",
    declaredByteLength: bytes.byteLength,
    contentDigest: sha256(bytes),
    provenance: {
      origin: "request",
      suppliedBy: "provider-a",
      originReference: null,
      acceptance: {
        kind: "provider-attested-import",
        basis: "Provider may import this source.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: {
        status: "cleared",
        reviewerId: "provider-a",
        reviewedAt: fixedTime,
        basis: "Model input was reviewed.",
      },
    },
    recordedAt: fixedTime,
    recordDigest: "c".repeat(64),
  };
  return {
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    projectDisplayName: "Project A",
    requestId: "request-a",
    requestTitle: "Request A",
    providerActorId: "provider-a",
    grantEpoch: 1,
    source,
  };
}

function runRecord(
  source: AnalysisSourceVersionInput,
  run: AnalysisRunInput,
): AnalysisRunRecord {
  return {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    runId: run.runId,
    requestedBySubjectDigest: run.requestedBySubjectDigest,
    sourceReference: {
      workspaceId: run.workspaceId,
      projectId: run.projectId,
      sourceId: run.sourceId,
      versionId: run.sourceVersionId,
    },
    sourceDigest: source.exactTextDigest,
    parserReference: source.parserReference,
    providerReference: run.providerReference,
    modelReference: run.modelReference,
    candidateSchemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
    configReference: run.configReference,
    status: run.status,
    candidatePayload: run.candidatePayload,
    candidateDigest: null,
    failureDiagnostic: run.failureDiagnostic,
    humanReviewRequired: true,
    publicationBlocked: true,
    runDigest: sha256(JSON.stringify(run)),
    createdAt: new Date(run.createdAt),
  };
}

test("admitted-source budget exhaustion persists manual fallback with no authority effects", async () => {
  const authorized = providerSource();
  const bytes = new TextEncoder().encode("Exact admitted source.");
  let generated = 0;
  const dependencies: ProviderSourceAnalysisDependencies = {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true, subjectDigest }),
    listAuthorizedSources: async () => [authorized],
    readSourceObject: async () => ({
      object: {
        schemaVersion: 1,
        objectId: `sha256:${authorized.source.contentDigest}`,
        byteLength: bytes.byteLength,
        binding: {
          workspaceId: authorized.workspaceId,
          projectId: authorized.projectId,
          sourceId: authorized.source.sourceId,
          versionId: String(authorized.source.version),
        },
        browserFilename: authorized.source.originalName,
        mediaType: authorized.source.mediaType,
        storedAt: fixedTime.toISOString(),
      },
      bytes,
    }),
    extractPdf: async () => {
      throw new Error("PDF parser must not run for text");
    },
    sealParsedPdfSource: () => {
      throw new Error("PDF sealing must not run for text");
    },
    generateCandidates: async () => {
      generated += 1;
      throw new Error("Gemini must not run");
    },
    persistRun: async (input) => runRecord(input.source, input.run),
    listPersistedRuns: async () => [],
    appendReview: async () => {
      throw new Error("Review is not part of this test");
    },
    readAnalysisLimits: async () => analysisLimits,
    admitAnalysis: async (_input, work) => work({
      modelDispatchAllowed: false,
      state: analysisLimits,
    }),
    modelReference: () => "gemini-test",
    newRunId: () => "22222222-2222-4222-8222-222222222222",
    now: () => fixedTime,
  };
  const catalogResponse = await handleProviderSourceAnalysisGet(dependencies);
  const catalog = await catalogResponse.json() as ProviderSourceAnalysisGetResponse;
  assert.equal(catalog.ok, true);
  if (!catalog.ok) return;
  const project = catalog.projects[0]!;
  const request = project.requests[0]!;
  const source = request.sources[0]!;
  const response = await handleProviderSourceAnalysisPost(
    new Request("http://127.0.0.1:3000/api/provider/source-analysis", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectLocator: project.locator,
        requestLocator: request.locator,
        sourceLocator: source.locator,
        mode: "gemini",
      }),
    }),
    dependencies,
  );
  const body = await response.json() as {
    ok: boolean;
    code: string;
    run: {
      status: string;
      model: { status: string };
      effects: Record<string, boolean>;
    };
  };
  assert.equal(response.status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.code, "MODEL_BUDGET_EXHAUSTED");
  assert.equal(body.run.status, "manual-review-ready");
  assert.equal(body.run.model.status, "not-requested");
  assert.deepEqual(Object.values(body.run.effects), Array(7).fill(false));
  assert.equal(generated, 0);
});
