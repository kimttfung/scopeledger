import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  ANALYSIS_DEMO_SCOPE,
  createIsolatedProofDatabase,
  PostgresAnalysisStore,
  sql,
  type SourceIntakeRecord,
} from "@scopeledger/db";
import { sealParsedPdfSource } from "@scopeledger/parser-adapter";
import {
  handleProviderSourceAnalysisGet,
  handleProviderSourceAnalysisPost,
  handleProviderSourceAnalysisReviewPost,
  type AuthorizedProviderSource,
  type ProviderSourceAnalysisDependencies,
  type ProviderSourceAnalysisGetResponse,
  type ProviderSourceAnalysisPostResponse,
} from "../../../apps/web/app/api/provider/source-analysis/service.js";

const fixedTime = new Date("2026-11-12T10:00:00.000Z");
const subjectDigest = "d".repeat(64);
const text = "Exact persisted Unicode 😀 source.";
const bytes = new TextEncoder().encode(text);
const analysisLimits = Object.freeze({
  maximumRuns: 3,
  admittedRuns: 0,
  remainingRuns: 3,
  modelCallBudget: 2,
  admittedModelCalls: 0,
  remainingModelCalls: 2,
  blocked: false,
  modelBlocked: false,
});

function databaseUrl(): string {
  const value = process.env.IP01_DATABASE_URL
    ?? process.env.SCOPELEDGER_DATABASE_URL;
  assert.ok(
    value,
    "IP01_DATABASE_URL or SCOPELEDGER_DATABASE_URL is required for persistence validation",
  );
  return value;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceRecord(): SourceIntakeRecord {
  return {
    workspaceId: "demo-workspace",
    projectId: "cedar-roastery",
    sourceId: `source_${"5".repeat(32)}_${"6".repeat(48)}`,
    version: 1,
    availability: "available",
    reviewedBy: "northstar-provider",
    sourceKind: "provider-upload",
    mediaType: "text/plain",
    originalName: "persisted.txt",
    declaredByteLength: bytes.byteLength,
    contentDigest: digest(bytes),
    provenance: {
      origin: "request",
      suppliedBy: "northstar-provider",
      originReference: "Persisted source fixture",
      acceptance: {
        kind: "provider-attested-import",
        basis: "The provider confirmed this exact source may be imported.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "Manual analysis only.",
      },
    },
    recordedAt: fixedTime,
    recordDigest: "e".repeat(64),
  };
}

function authorized(): AuthorizedProviderSource {
  const source = sourceRecord();
  return {
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    projectDisplayName: "Cedar Roastery",
    requestId: "packet-review",
    requestTitle: "Website scope review",
    providerActorId: "northstar-provider",
    grantEpoch: 1,
    source,
  };
}

type GetSuccess = Extract<ProviderSourceAnalysisGetResponse, { ok: true }>;
type PostSuccess = Extract<ProviderSourceAnalysisPostResponse, { ok: true }>;

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

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) assert.fail(message);
  return value;
}

test("migration 003 stores, reloads, and appends review for the exact admitted source basis", async (t) => {
  const isolated = await createIsolatedProofDatabase(databaseUrl());
  t.after(isolated.dispose);
  const store = new PostgresAnalysisStore(isolated.database, {
    clock: () => new Date("2026-11-12T10:05:00.000Z"),
  });
  const source = authorized();

  const dependencies = (): ProviderSourceAnalysisDependencies => ({
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true, subjectDigest }),
    listAuthorizedSources: async () => [source],
    readSourceObject: async () => ({
      object: {
        schemaVersion: 1,
        objectId: `sha256:${source.source.contentDigest}`,
        byteLength: bytes.byteLength,
        binding: {
          workspaceId: source.workspaceId,
          projectId: source.projectId,
          sourceId: source.source.sourceId,
          versionId: String(source.source.version),
        },
        browserFilename: source.source.originalName,
        mediaType: source.source.mediaType,
        storedAt: fixedTime.toISOString(),
      },
      bytes,
    }),
    extractPdf: async () => {
      throw new Error("PDF parser must not run for text");
    },
    sealParsedPdfSource,
    generateCandidates: async () => {
      throw new Error("Gemini must not run for manual analysis");
    },
    persistRun: async (input) => (await store.saveRun(input)).run,
    listPersistedRuns: async (requestedBySubjectDigest, limit) => {
      const runs = await store.listRuns({
        ...ANALYSIS_DEMO_SCOPE,
        requestedBySubjectDigest,
        limit,
      });
      return Promise.all(runs.map(async (run) => {
        const row = (await sql<{
          exact_text: string;
          parser_reference: string;
          extraction_status: "complete" | "partial";
          declared_byte_length: number;
          declared_page_count: number;
          code_point_count: number;
        }>`select exact_text,parser_reference,extraction_status,
            declared_byte_length,declared_page_count,code_point_count
          from analysis_source_versions
          where workspace_id = ${run.sourceReference.workspaceId}
            and project_id = ${run.sourceReference.projectId}
            and source_id = ${run.sourceReference.sourceId}
            and version_id = ${run.sourceReference.versionId}::uuid`
          .execute(isolated.database.kysely)).rows[0];
        assert.ok(row);
        const coverage = (await sql<{
          page_number: number;
          status: "extracted" | "unavailable";
          start_offset: number | null;
          end_offset: number | null;
        }>`select page_number,status,start_offset,end_offset
          from analysis_source_coverage
          where workspace_id = ${run.sourceReference.workspaceId}
            and project_id = ${run.sourceReference.projectId}
            and source_id = ${run.sourceReference.sourceId}
            and version_id = ${run.sourceReference.versionId}::uuid
          order by page_number`.execute(isolated.database.kysely)).rows;
        return {
          run,
          source: {
            versionId: run.sourceReference.versionId,
            exactText: row.exact_text,
            parserReference: row.parser_reference,
            extractionStatus: row.extraction_status,
            declaredByteLength: Number(row.declared_byte_length),
            declaredPageCount: Number(row.declared_page_count),
            codePointCount: Number(row.code_point_count),
            coverage: coverage.map((entry) =>
              entry.status === "extracted"
                ? {
                  number: entry.page_number,
                  status: "extracted" as const,
                  start: entry.start_offset!,
                  end: entry.end_offset!,
                }
                : {
                  number: entry.page_number,
                  status: "unavailable" as const,
                }),
          },
          reviews: await store.readReviews({
            ...ANALYSIS_DEMO_SCOPE,
            runId: run.runId,
          }),
        };
      }));
    },
    appendReview: (input) => store.appendReview({
      ...ANALYSIS_DEMO_SCOPE,
      ...input,
    }),
    readAnalysisLimits: async () => analysisLimits,
    admitAnalysis: async (_input, work) => work({
      modelDispatchAllowed: true,
      state: analysisLimits,
    }),
    modelReference: () => null,
    newRunId: randomUUID,
    now: () => new Date(fixedTime),
  });

  const initial = await handleProviderSourceAnalysisGet(dependencies());
  const initialBody = expectGetSuccess(
    await responseBody(initial, isGetResponse),
  );
  const project = required(initialBody.projects[0], "Expected one project");
  const request = required(project.requests[0], "Expected one request");
  const selected = required(request.sources[0], "Expected one source");
  const analysis = await handleProviderSourceAnalysisPost(
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
        sourceLocator: selected.locator,
        mode: "manual",
      }),
    }),
    dependencies(),
  );
  assert.equal(analysis.status, 200);
  const analysisBody = expectPostSuccess(
    await responseBody(analysis, isPostResponse),
  );

  const reloaded = await handleProviderSourceAnalysisGet(dependencies());
  const reloadedBody = expectGetSuccess(
    await responseBody(reloaded, isGetResponse),
  );
  assert.equal(reloadedBody.runs.length, 1);
  const reloadedRun = required(reloadedBody.runs[0], "Expected reloaded run");
  assert.equal(reloadedRun.extraction.codePointCount, Array.from(text).length);
  assert.equal(reloadedRun.sourceLocator, selected.locator);
  assert.deepEqual(reloadedRun.extraction.coverage, [{
    kind: "section",
    number: 1,
    status: "extracted",
    start: 0,
    end: Array.from(text).length,
  }]);

  const review = await handleProviderSourceAnalysisReviewPost(
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
          runLocator: analysisBody.run.locator,
          reviewId: randomUUID(),
          disposition: "manual",
          note: "Reviewed the exact persisted section coverage.",
        }),
      },
    ),
    dependencies(),
  );
  assert.equal(review.status, 201);

  const reviewed = await handleProviderSourceAnalysisGet(dependencies());
  const reviewedBody = expectGetSuccess(
    await responseBody(reviewed, isGetResponse),
  );
  const reviewedRun = required(reviewedBody.runs[0], "Expected reviewed run");
  assert.equal(reviewedRun.reviews.length, 1);
  const savedReview = required(
    reviewedRun.reviews[0],
    "Expected persisted review",
  );
  assert.equal(
    savedReview.note,
    "Reviewed the exact persisted section coverage.",
  );
});
