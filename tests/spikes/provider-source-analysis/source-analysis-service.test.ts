import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
  ANALYSIS_DEMO_SCOPE,
  type AnalysisHumanReviewRecord,
  type AnalysisRunInput,
  type AnalysisRunRecord,
  type AnalysisSourceVersionInput,
  type SourceIntakeRecord,
} from "@scopeledger/db";
import {
  ObjectStorageNotFoundError,
  type StoredSourceObjectRead,
} from "@scopeledger/object-storage-adapter";
import {
  sealParsedPdfSource,
  type ParsedPdf,
} from "@scopeledger/parser-adapter";
import {
  handleProviderSourceAnalysisGet,
  handleProviderSourceAnalysisPost,
  handleProviderSourceAnalysisReviewPost,
  type AuthorizedProviderSource,
  type PersistedAnalysisSourceDetails,
  type PersistedProviderAnalysis,
  type ProviderSourceAnalysisDependencies,
  type ProviderSourceAnalysisGetResponse,
  type ProviderSourceAnalysisPostResponse,
  type ProviderSourceAnalysisReviewResponse,
} from "../../../apps/web/app/api/provider/source-analysis/service.js";

const fixedTime = new Date("2026-11-12T08:30:00.000Z");
const subjectDigest = "a".repeat(64);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceRecord(
  mediaType: string,
  bytes: Uint8Array,
  overrides: Partial<SourceIntakeRecord> = {},
): SourceIntakeRecord {
  return {
    workspaceId: "demo-workspace",
    projectId: "cedar-roastery",
    sourceId: `source_${"1".repeat(32)}_${"2".repeat(48)}`,
    version: 1,
    availability: "available",
    reviewedBy: "northstar-provider",
    sourceKind: "provider-upload",
    mediaType,
    originalName: mediaType === "application/pdf"
      ? "agreement.pdf"
      : mediaType === "text/markdown"
        ? "request.md"
        : "request.txt",
    declaredByteLength: bytes.byteLength,
    contentDigest: sha256(bytes),
    provenance: {
      origin: "agreement",
      suppliedBy: "northstar-provider",
      originReference: "Provider intake",
      acceptance: {
        kind: "provider-attested-import",
        basis: "The provider confirmed this source may be imported.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model review was recorded.",
      },
    },
    recordedAt: fixedTime,
    recordDigest: "b".repeat(64),
    ...overrides,
  };
}

function authorized(
  source: SourceIntakeRecord,
  overrides: Partial<AuthorizedProviderSource> = {},
): AuthorizedProviderSource {
  return {
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    projectDisplayName: "Cedar Roastery",
    requestId: "packet-review",
    requestTitle: "Website scope review",
    providerActorId: "northstar-provider",
    grantEpoch: 1,
    source,
    ...overrides,
  };
}

function stored(
  source: SourceIntakeRecord,
  bytes: Uint8Array,
): StoredSourceObjectRead {
  return {
    object: {
      schemaVersion: 1,
      objectId: `sha256:${source.contentDigest}`,
      byteLength: bytes.byteLength,
      binding: {
        workspaceId: source.workspaceId,
        projectId: source.projectId,
        sourceId: source.sourceId,
        versionId: String(source.version),
      },
      browserFilename: source.originalName,
      mediaType: source.mediaType,
      storedAt: fixedTime.toISOString(),
    },
    bytes,
  };
}

function parsedPdf(text = "Included layout. New populated page."): ParsedPdf {
  return {
    schemaVersion: 1,
    format: "pdf",
    declaredByteLength: 128,
    declaredPageCount: 2,
    extractedText: text,
    pages: [
      { pageNumber: 1, start: 0, end: 16 },
      {
        pageNumber: 2,
        start: 16,
        end: Array.from(text).length,
      },
    ],
    unavailablePages: [],
    extractorReference: "scopeledger.pdfjs.v1",
  };
}

function details(source: AnalysisSourceVersionInput): PersistedAnalysisSourceDetails {
  return {
    versionId: source.versionId,
    exactText: source.exactText,
    parserReference: source.parserReference,
    extractionStatus: source.extractionStatus,
    declaredByteLength: source.declaredByteLength,
    declaredPageCount: source.declaredPageCount,
    codePointCount: source.codePointCount,
    coverage: source.coverage.map((entry) =>
      entry.status === "extracted"
        ? {
          number: entry.pageNumber,
          status: "extracted" as const,
          start: entry.start,
          end: entry.end,
        }
        : {
          number: entry.pageNumber,
          status: "unavailable" as const,
        }),
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
    candidateDigest: run.candidatePayload
      ? sha256(JSON.stringify(run.candidatePayload))
      : null,
    failureDiagnostic: run.failureDiagnostic,
    humanReviewRequired: true,
    publicationBlocked: true,
    runDigest: sha256(JSON.stringify(run)),
    createdAt: new Date(run.createdAt),
  };
}

function memoryDependencies(
  sources: readonly AuthorizedProviderSource[],
  bytesBySource: ReadonlyMap<string, Uint8Array>,
  overrides: Partial<ProviderSourceAnalysisDependencies> = {},
): ProviderSourceAnalysisDependencies & Readonly<{
  persisted: PersistedProviderAnalysis[];
  generated: unknown[];
  readCount: () => number;
}> {
  const persisted: PersistedProviderAnalysis[] = [];
  const generated: unknown[] = [];
  let reads = 0;
  const dependencies: ProviderSourceAnalysisDependencies = {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true, subjectDigest }),
    listAuthorizedSources: async () => sources,
    readSourceObject: async (target) => {
      reads += 1;
      const bytes = bytesBySource.get(target.source.sourceId);
      if (!bytes) throw new ObjectStorageNotFoundError();
      return stored(target.source, bytes);
    },
    extractPdf: async () => parsedPdf(),
    sealParsedPdfSource,
    generateCandidates: async (run) => {
      generated.push(run);
      const input = run as {
        sources: readonly {
          workspaceId: string;
          projectId: string;
          sourceId: string;
          versionId: string;
          extractedText: string;
        }[];
      };
      const source = input.sources[0]!;
      const points = Array.from(source.extractedText);
      const quote = points.slice(0, Math.min(16, points.length)).join("");
      return {
        model: "gemini-test",
        review: {
          claims: [{
            claimId: "claim-1",
            interpretation: "The source may describe additional work.",
            supportingEvidence: [{
              source: {
                workspaceId: source.workspaceId,
                projectId: source.projectId,
                sourceId: source.sourceId,
                versionId: source.versionId,
              },
              start: 0,
              end: Array.from(quote).length,
              quote,
              polarity: "supporting" as const,
            }],
            chargeWeakeningEvidence: [],
            uncertainty: {
              status: "limited" as const,
              explanation: "Human review remains required.",
              questions: ["Which agreement controls?"],
            },
            reviewState: "human-review-required" as const,
          }],
          coverage: { missingContext: ["Original agreement context."] },
          publicationEligibility: "blocked" as const,
        },
      };
    },
    persistRun: async (input) => {
      const record = runRecord(input.source, input.run);
      persisted.push({
        run: record,
        source: details(input.source),
        reviews: [],
      });
      return record;
    },
    listPersistedRuns: async (requestedBy, limit) =>
      persisted.filter((entry) =>
        entry.run.requestedBySubjectDigest === requestedBy
      ).slice(0, limit),
    appendReview: async (input) => {
      const target = persisted.find((entry) => entry.run.runId === input.runId);
      assert.ok(target);
      const review: AnalysisHumanReviewRecord = {
        workspaceId: ANALYSIS_DEMO_SCOPE.workspaceId,
        projectId: ANALYSIS_DEMO_SCOPE.projectId,
        reviewId: input.reviewId,
        runId: input.runId,
        reviewerSubjectDigest: input.reviewerSubjectDigest,
        reviewedAt: new Date("2026-11-12T09:00:00.000Z"),
        disposition: input.disposition,
        note: input.note,
        runBasisDigest: target.run.runDigest,
        candidateBasisDigest: target.run.candidateDigest,
      };
      (target.reviews as AnalysisHumanReviewRecord[]).push(review);
      return { duplicate: false, review };
    },
    modelReference: () => "gemini-test",
    newRunId: randomUUID,
    now: () => new Date(fixedTime),
    ...overrides,
  };
  return Object.assign(dependencies, {
    persisted,
    generated,
    readCount: () => reads,
  });
}

type GetSuccess = Extract<ProviderSourceAnalysisGetResponse, { ok: true }>;
type PostSuccess = Extract<ProviderSourceAnalysisPostResponse, { ok: true }>;
type PostFailure = Extract<ProviderSourceAnalysisPostResponse, { ok: false }>;
type ReviewSuccess = Extract<
  ProviderSourceAnalysisReviewResponse,
  { ok: true }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGetResponse(
  value: unknown,
): value is ProviderSourceAnalysisGetResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  return value.ok
    ? Array.isArray(value.projects) && Array.isArray(value.runs)
    : typeof value.code === "string" && typeof value.message === "string";
}

function isPostResponse(
  value: unknown,
): value is ProviderSourceAnalysisPostResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  return value.ok
    ? value.code === "SOURCE_ANALYSIS_COMPLETE" && isRecord(value.run)
    : typeof value.code === "string"
      && typeof value.message === "string"
      && (value.run === undefined || isRecord(value.run));
}

function isReviewResponse(
  value: unknown,
): value is ProviderSourceAnalysisReviewResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  return value.ok
    ? typeof value.duplicate === "boolean" && isRecord(value.review)
    : typeof value.code === "string" && typeof value.message === "string";
}

async function responseBody<T>(
  response: Response,
  guard: (value: unknown) => value is T,
): Promise<T> {
  const value: unknown = await response.json();
  assert.ok(guard(value), "response body did not match its API contract");
  return value;
}

function expectGetSuccess(
  body: ProviderSourceAnalysisGetResponse,
): GetSuccess {
  if (!body.ok) assert.fail(`Expected GET success, received ${body.code}`);
  return body;
}

function expectPostSuccess(
  body: ProviderSourceAnalysisPostResponse,
): PostSuccess {
  if (!body.ok) assert.fail(`Expected POST success, received ${body.code}`);
  return body;
}

function expectPostFailure(
  body: ProviderSourceAnalysisPostResponse,
): PostFailure {
  if (body.ok) assert.fail("Expected POST failure");
  return body;
}

function expectReviewSuccess(
  body: ProviderSourceAnalysisReviewResponse,
): ReviewSuccess {
  if (!body.ok) assert.fail(`Expected review success, received ${body.code}`);
  return body;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) assert.fail(message);
  return value;
}

async function getBody(
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<GetSuccess> {
  const response = await handleProviderSourceAnalysisGet(dependencies);
  return expectGetSuccess(await responseBody(response, isGetResponse));
}

async function selection(
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<{
  projectLocator: string;
  requestLocator: string;
  sourceLocator: string;
}> {
  const body = await getBody(dependencies);
  const project = required(body.projects[0], "Expected one project");
  const request = required(project.requests[0], "Expected one request");
  const source = required(request.sources[0], "Expected one source");
  return {
    projectLocator: project.locator,
    requestLocator: request.locator,
    sourceLocator: source.locator,
  };
}

function postRequest(body: object): Request {
  return new Request(
    "http://127.0.0.1:3000/api/provider/source-analysis",
    {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

test("source scope uses opaque session locators and rejects mixed or stale selection", async () => {
  const bytes = new TextEncoder().encode("Exact admitted text.");
  const first = authorized(sourceRecord("text/plain", bytes));
  const secondSource = sourceRecord("text/plain", bytes, {
    projectId: "other-project",
    sourceId: `source_${"3".repeat(32)}_${"4".repeat(48)}`,
    recordDigest: "c".repeat(64),
  });
  const second = authorized(secondSource, {
    projectId: "other-project",
    projectDisplayName: "Other project",
    requestId: "other-request",
    requestTitle: "Other request",
  });
  const deps = memoryDependencies(
    [first, second],
    new Map([
      [first.source.sourceId, bytes],
      [second.source.sourceId, bytes],
    ]),
  );
  const body = await getBody(deps);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /cedar-roastery|packet-review|source_1111/u);
  assert.doesNotMatch(serialized, /"contentDigest"|"recordDigest"/u);
  const firstProject = required(body.projects[0], "Expected first project");
  const secondProject = required(body.projects[1], "Expected second project");
  const firstRequest = required(
    firstProject.requests[0],
    "Expected first project request",
  );
  const secondRequest = required(
    secondProject.requests[0],
    "Expected second project request",
  );
  const firstSource = required(
    firstRequest.sources[0],
    "Expected first request source",
  );
  assert.match(firstProject.locator, /^psap1_[a-f0-9]{40}$/u);
  assert.match(
    firstSource.locator,
    /^psas1_[a-f0-9]{40}$/u,
  );

  const response = await handleProviderSourceAnalysisPost(
    postRequest({
      projectLocator: firstProject.locator,
      requestLocator: secondRequest.locator,
      sourceLocator: firstSource.locator,
      mode: "manual",
    }),
    deps,
  );
  assert.equal(response.status, 404);
  assert.equal(
    expectPostFailure(
      await responseBody(response, isPostResponse),
    ).code,
    "SOURCE_ANALYSIS_SCOPE_NOT_FOUND",
  );
  assert.equal(deps.readCount(), 0);
});

test("PDF, text, and Markdown create format-honest exact coverage without another upload", async () => {
  const text = "Alpha 😀 e\u0301.\nSecond line.";
  for (const mediaType of ["text/plain", "text/markdown"] as const) {
    const bytes = new TextEncoder().encode(text);
    const source = authorized(sourceRecord(mediaType, bytes));
    const deps = memoryDependencies(
      [source],
      new Map([[source.source.sourceId, bytes]]),
    );
    const target = await selection(deps);
    const response = await handleProviderSourceAnalysisPost(
      postRequest({ ...target, mode: "manual" }),
      deps,
    );
    const body = expectPostSuccess(
      await responseBody(response, isPostResponse),
    );
    assert.equal(response.status, 200);
    assert.equal(body.run.extraction.format, mediaType === "text/plain"
      ? "text"
      : "markdown");
    assert.deepEqual(body.run.extraction.coverage, [{
      kind: "section",
      number: 1,
      status: "extracted",
      start: 0,
      end: Array.from(text).length,
    }]);
    assert.equal(deps.persisted[0]?.source.exactText, text);
    assert.match(
      deps.persisted[0]?.source.parserReference ?? "",
      /scopeledger\.utf8-(text|markdown)\.v1/u,
    );
  }

  const pdfBytes = new TextEncoder().encode("%PDF-1.7\nsynthetic");
  const pdfSource = authorized(sourceRecord("application/pdf", pdfBytes));
  let parserCalls = 0;
  const pdfDeps = memoryDependencies(
    [pdfSource],
    new Map([[pdfSource.source.sourceId, pdfBytes]]),
    {
      extractPdf: async () => {
        parserCalls += 1;
        return parsedPdf();
      },
    },
  );
  const response = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(pdfDeps)), mode: "manual" }),
    pdfDeps,
  );
  const body = expectPostSuccess(
    await responseBody(response, isPostResponse),
  );
  assert.equal(response.status, 200);
  assert.equal(parserCalls, 1);
  assert.equal(body.run.extraction.format, "pdf");
  assert.deepEqual(body.run.extraction.coverage, [
    { kind: "page", number: 1, status: "extracted", start: 0, end: 16 },
    {
      kind: "page",
      number: 2,
      status: "extracted",
      start: 16,
      end: Array.from(parsedPdf().extractedText).length,
    },
  ]);
});

test("stored permissions gate parser/manual and Gemini without browser overrides", async () => {
  const bytes = new TextEncoder().encode("Permission-controlled source.");
  const deniedStudio = authorized(sourceRecord("text/plain", bytes, {
    permissions: {
      studioSharing: "denied",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No permission.",
      },
    },
  }));
  const studioDeps = memoryDependencies(
    [deniedStudio],
    new Map([[deniedStudio.source.sourceId, bytes]]),
  );
  const studioResponse = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(studioDeps)), mode: "manual" }),
    studioDeps,
  );
  assert.equal(studioResponse.status, 422);
  assert.equal(
    expectPostFailure(
      await responseBody(studioResponse, isPostResponse),
    ).code,
    "STUDIO_SHARING_NOT_PERMITTED",
  );
  assert.equal(studioDeps.readCount(), 0);

  const deniedModel = authorized(sourceRecord("text/plain", bytes));
  const modelDeps = memoryDependencies(
    [deniedModel],
    new Map([[deniedModel.source.sourceId, bytes]]),
  );
  const modelResponse = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(modelDeps)), mode: "gemini" }),
    modelDeps,
  );
  assert.equal(modelResponse.status, 422);
  assert.equal(
    expectPostFailure(
      await responseBody(modelResponse, isPostResponse),
    ).code,
    "MODEL_INPUT_NOT_ADMITTED",
  );
  assert.equal(modelDeps.generated.length, 0);
  assert.equal(modelDeps.readCount(), 0);

  const overrideResponse = await handleProviderSourceAnalysisPost(
    postRequest({
      ...(await selection(modelDeps)),
      mode: "gemini",
      model: "browser-model",
    }),
    modelDeps,
  );
  assert.equal(overrideResponse.status, 422);
  assert.equal(
    expectPostFailure(
      await responseBody(overrideResponse, isPostResponse),
    ).code,
    "INVALID_SOURCE_ANALYSIS_REQUEST",
  );
});

test("missing, tampered, parser-failed, and model-failed paths return safe bounded errors", async () => {
  const bytes = new TextEncoder().encode("Integrity-controlled source.");
  const source = authorized(sourceRecord("text/plain", bytes));
  const missing = memoryDependencies([source], new Map());
  const missingResponse = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(missing)), mode: "manual" }),
    missing,
  );
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(
    expectPostFailure(
      await responseBody(missingResponse, isPostResponse),
    ),
    {
    ok: false,
    code: "SOURCE_BYTES_MISSING",
    message: "The immutable source bytes are not available.",
    },
  );

  const tampered = memoryDependencies(
    [source],
    new Map([[source.source.sourceId, bytes]]),
    {
      readSourceObject: async () =>
        stored(source.source, new TextEncoder().encode("tampered")),
    },
  );
  const tamperedResponse = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(tampered)), mode: "manual" }),
    tampered,
  );
  assert.equal(tamperedResponse.status, 409);
  assert.equal(
    expectPostFailure(
      await responseBody(tamperedResponse, isPostResponse),
    ).code,
    "SOURCE_INTEGRITY_FAILED",
  );

  const unsupportedSource = authorized(sourceRecord(
    "application/octet-stream",
    bytes,
  ));
  const unsupported = memoryDependencies(
    [unsupportedSource],
    new Map([[unsupportedSource.source.sourceId, bytes]]),
  );
  const unsupportedResponse = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(unsupported)), mode: "manual" }),
    unsupported,
  );
  assert.equal(unsupportedResponse.status, 415);
  assert.equal(
    expectPostFailure(
      await responseBody(unsupportedResponse, isPostResponse),
    ).code,
    "UNSUPPORTED_SOURCE_TYPE",
  );

  const pdfBytes = new TextEncoder().encode("%PDF-1.7\nsynthetic");
  const pdfSource = authorized(sourceRecord("application/pdf", pdfBytes));
  const parserFailed = memoryDependencies(
    [pdfSource],
    new Map([[pdfSource.source.sourceId, pdfBytes]]),
    {
      extractPdf: async () => {
        throw Object.assign(new Error("/private/path/input.pdf"), {
          code: "PARSER_FAILED",
        });
      },
    },
  );
  const parserResponse = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(parserFailed)), mode: "manual" }),
    parserFailed,
  );
  assert.equal(parserResponse.status, 422);
  assert.deepEqual(
    expectPostFailure(
      await responseBody(parserResponse, isPostResponse),
    ),
    {
    ok: false,
    code: "PDF_PARSE_FAILED",
    message: "The admitted PDF could not be parsed by the isolated extractor.",
    },
  );

  const permitted = authorized(sourceRecord("text/plain", bytes, {
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: {
        status: "cleared",
        reviewerId: "northstar-provider",
        reviewedAt: fixedTime,
        basis: "The exact model input was reviewed.",
      },
    },
  }));
  const modelFailed = memoryDependencies(
    [permitted],
    new Map([[permitted.source.sourceId, bytes]]),
    {
      generateCandidates: async () => {
        throw new Error("provider secret diagnostic");
      },
    },
  );
  const modelResponse = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(modelFailed)), mode: "gemini" }),
    modelFailed,
  );
  const modelBody = expectPostFailure(
    await responseBody(modelResponse, isPostResponse),
  );
  assert.equal(modelResponse.status, 502);
  assert.equal(modelBody.code, "MODEL_PROCESSING_FAILED");
  assert.equal(
    required(modelBody.run, "Expected persisted failed model run").status,
    "model-failed",
  );
  assert.doesNotMatch(JSON.stringify(modelBody), /secret|private|digest/u);
  const reloaded = await getBody(modelFailed);
  assert.equal(
    required(reloaded.runs[0], "Expected reloaded failed model run").status,
    "model-failed",
  );
});

test("Gemini evidence, persistence reload, append-only review, and authority effects stay exact", async () => {
  const text = "😀 Included layout. Added populated page.";
  const bytes = new TextEncoder().encode(text);
  const source = authorized(sourceRecord("text/markdown", bytes, {
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: {
        status: "cleared",
        reviewerId: "northstar-provider",
        reviewedAt: fixedTime,
        basis: "The exact model input was reviewed.",
      },
    },
  }));
  const deps = memoryDependencies(
    [source],
    new Map([[source.source.sourceId, bytes]]),
    {
      generateCandidates: async (run) => {
        const input = run as {
          sources: readonly {
            workspaceId: string;
            projectId: string;
            sourceId: string;
            versionId: string;
            extractedText: string;
          }[];
        };
        const exact = input.sources[0]!;
        const points = Array.from(exact.extractedText);
        const start = 19;
        const end = points.length;
        return {
          model: "gemini-server-model",
          review: {
            claims: [{
              claimId: "added-page",
              interpretation: "The populated page may be additional.",
              supportingEvidence: [{
                source: {
                  workspaceId: exact.workspaceId,
                  projectId: exact.projectId,
                  sourceId: exact.sourceId,
                  versionId: exact.versionId,
                },
                start,
                end,
                quote: points.slice(start, end).join(""),
                polarity: "supporting" as const,
              }],
              chargeWeakeningEvidence: [{
                source: {
                  workspaceId: exact.workspaceId,
                  projectId: exact.projectId,
                  sourceId: exact.sourceId,
                  versionId: exact.versionId,
                },
                start: 0,
                end: 19,
                quote: points.slice(0, 19).join(""),
                polarity: "charge-weakening" as const,
              }],
              uncertainty: {
                status: "limited" as const,
                explanation: "Agreement context remains required.",
                questions: ["Was population included?"],
              },
              reviewState: "human-review-required" as const,
            }],
            coverage: { missingContext: ["Signed agreement."] },
            publicationEligibility: "blocked" as const,
          },
        };
      },
    },
  );
  const response = await handleProviderSourceAnalysisPost(
    postRequest({ ...(await selection(deps)), mode: "gemini" }),
    deps,
  );
  const body = expectPostSuccess(
    await responseBody(response, isPostResponse),
  );
  assert.equal(response.status, 200);
  assert.equal(body.run.model.status, "completed");
  if (body.run.model.status !== "completed") {
    assert.fail("Expected completed model analysis");
  }
  const candidate = required(
    body.run.model.candidates[0],
    "Expected one model candidate",
  );
  const evidence = required(
    candidate.evidence[0],
    "Expected candidate evidence",
  );
  assert.equal(evidence.quote, "Added populated page.");
  assert.deepEqual(body.run.effects, {
    treatment: false,
    pricing: false,
    publication: false,
    agreement: false,
    payment: false,
    readiness: false,
    workStart: false,
  });
  assert.equal(body.run.publicationBlocked, true);
  assert.equal(body.run.humanReviewRequired, true);

  const reload = await getBody(deps);
  const reloadedRun = required(reload.runs[0], "Expected reloaded analysis run");
  assert.equal(reloadedRun.model.status, "completed");
  if (reloadedRun.model.status !== "completed") {
    assert.fail("Expected reloaded completed model analysis");
  }
  const reloadedCandidate = required(
    reloadedRun.model.candidates[0],
    "Expected reloaded model candidate",
  );
  assert.deepEqual(
    reloadedCandidate.evidence,
    candidate.evidence,
  );
  assert.deepEqual(reloadedRun.extraction.coverage, [{
    kind: "section",
    number: 1,
    status: "extracted",
    start: 0,
    end: Array.from(text).length,
  }]);

  const reviewResponse = await handleProviderSourceAnalysisReviewPost(
    new Request(
      "http://127.0.0.1:3000/api/provider/source-analysis/reviews",
      {
        method: "POST",
        headers: {
          origin: "http://127.0.0.1:3000",
          host: "127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runLocator: body.run.locator,
          reviewId: randomUUID(),
          disposition: "manual",
          note: "Reviewed exact evidence and missing agreement context.",
        }),
      },
    ),
    deps,
  );
  assert.equal(reviewResponse.status, 201);
  assert.equal(
    expectReviewSuccess(
      await responseBody(reviewResponse, isReviewResponse),
    ).review.disposition,
    "manual",
  );
  const reviewedReload = await getBody(deps);
  const reviewedRun = required(
    reviewedReload.runs[0],
    "Expected reviewed analysis run",
  );
  assert.equal(reviewedRun.reviews.length, 1);
  const savedReview = required(
    reviewedRun.reviews[0],
    "Expected saved provider review",
  );
  assert.equal(
    savedReview.note,
    "Reviewed exact evidence and missing agreement context.",
  );
  assert.doesNotMatch(
    JSON.stringify(savedReview),
    /basisDigest|candidateDigest|runDigest/u,
  );
});
