import { createHash, randomUUID } from "node:crypto";
import {
  ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
  ANALYSIS_DEMO_SCOPE,
  AnalysisPersistenceError,
  type AnalysisCandidatePayload,
  type AnalysisHumanReviewRecord,
  type AnalysisModelFailureCode,
  type AnalysisReviewDisposition,
  type AnalysisRunInput,
  type AnalysisRunRecord,
  type AnalysisSourceVersionInput,
  type SourceIntakeRecord,
} from "@scopeledger/db";
import type {
  ParsedPdf,
} from "@scopeledger/parser-adapter";
import type {
  StoredSourceObjectRead,
} from "@scopeledger/object-storage-adapter";

const MAX_SOURCE_CODE_POINTS = 200_000;
const MAX_RUNS = 50;
const locatorPattern = /^(psap|psar|psas|psan)1_[a-f0-9]{40}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

const effects = Object.freeze({
  treatment: false,
  pricing: false,
  publication: false,
  agreement: false,
  payment: false,
  readiness: false,
  workStart: false,
});

const modelFailureMessages: Readonly<Record<
  AnalysisModelFailureCode,
  string
>> = Object.freeze({
  MODEL_INPUT_NOT_ADMITTED:
    "The admitted source is not cleared for Gemini processing. Manual analysis remains available.",
  MODEL_CONFIGURATION_UNAVAILABLE:
    "Gemini processing is not configured. Manual analysis remains available.",
  MODEL_PROCESSING_FAILED:
    "Gemini candidate processing did not complete. Manual analysis remains available.",
});

type ProviderAccess =
  | Readonly<{ ok: true; subjectDigest: string }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
    message?: string;
  }>;

export type AuthorizedProviderSource = Readonly<{
  workspaceId: string;
  projectId: string;
  projectDisplayName: string;
  requestId: string;
  requestTitle: string;
  providerActorId: string;
  grantEpoch: number;
  source: SourceIntakeRecord;
}>;

type ExtractedSourceLike = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
  provenance: Readonly<{
    origin: SourceIntakeRecord["provenance"]["origin"];
    suppliedBy: string;
    recordedAt: string;
    claimedDate: string | null;
    effectiveDate: string | null;
    acceptance:
      | Readonly<{
        kind: "provider-attested-import";
        attestedBy: string;
        basis: string;
      }>
      | Readonly<{
        kind: "in-app-record-reference";
        recordReference: string;
        basis: string;
      }>
      | Readonly<{
        kind: "unverified";
        basis: string;
      }>;
    originReference: string | null;
    extractorReference: string;
  }>;
  document:
    | Readonly<{
      format: "pdf";
      declaredByteLength: number;
      declaredPageCount: number;
      pages: readonly Readonly<{
        pageNumber: number;
        start: number;
        end: number;
      }>[];
      unavailablePages: readonly Readonly<{
        pageNumber: number;
        reason: string;
      }>[];
    }>
    | Readonly<{
      format: "txt" | "markdown" | "pasted-text" | "manual-transcription";
    }>;
  extractedText: string;
  extractedTextSha256: string;
  extraction: Readonly<{
    status: "complete" | "partial" | "unavailable";
    unavailableReason: string | null;
  }>;
  permissions: Readonly<{
    studioSharing: SourceIntakeRecord["permissions"]["studioSharing"];
    modelProcessing: SourceIntakeRecord["permissions"]["modelProcessing"];
    modelInputReview:
      | Readonly<{
        status: "cleared";
        reviewerId: string;
        reviewedAt: string;
        basis: string;
      }>
      | Readonly<{
        status: "not-reviewed" | "unresolved" | "prohibited-financial-data";
      }>;
  }>;
}>;

type SealResult =
  | Readonly<{ ok: true; value: ExtractedSourceLike }>
  | Readonly<{ ok: false; errors: readonly unknown[] }>;

type ModelResultLike = Readonly<{
  model?: string;
  review: Readonly<{
    claims: readonly Readonly<{
      claimId: string;
      interpretation: string;
      supportingEvidence: readonly Readonly<{
        source: Readonly<{
          workspaceId: string;
          projectId: string;
          sourceId: string;
          versionId: string;
        }>;
        start: number;
        end: number;
        quote: string;
        polarity: "supporting" | "charge-weakening";
      }>[];
      chargeWeakeningEvidence: readonly Readonly<{
        source: Readonly<{
          workspaceId: string;
          projectId: string;
          sourceId: string;
          versionId: string;
        }>;
        start: number;
        end: number;
        quote: string;
        polarity: "supporting" | "charge-weakening";
      }>[];
      uncertainty: Readonly<{
        status: "uncertain" | "limited" | "none-declared";
        explanation: string;
        questions: readonly string[];
      }>;
      reviewState: "human-review-required";
    }>[];
    coverage: Readonly<{ missingContext: readonly string[] }>;
    publicationEligibility: "blocked";
  }>;
}>;

export type PersistedAnalysisSourceDetails = Readonly<{
  versionId: string;
  exactText: string;
  parserReference: string;
  extractionStatus: "complete" | "partial";
  declaredByteLength: number;
  declaredPageCount: number;
  codePointCount: number;
  coverage: readonly (
    | Readonly<{
      number: number;
      status: "extracted";
      start: number;
      end: number;
    }>
    | Readonly<{
      number: number;
      status: "unavailable";
    }>
  )[];
}>;

export type PersistedProviderAnalysis = Readonly<{
  run: AnalysisRunRecord;
  source: PersistedAnalysisSourceDetails;
  reviews: readonly AnalysisHumanReviewRecord[];
}>;

export type ProviderSourceAnalysisDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAccess>;
  listAuthorizedSources: () => Promise<readonly AuthorizedProviderSource[]>;
  readSourceObject: (
    source: AuthorizedProviderSource,
  ) => Promise<StoredSourceObjectRead>;
  extractPdf: (bytes: Uint8Array) => Promise<ParsedPdf>;
  sealParsedPdfSource: (
    parsed: ParsedPdf,
    metadata: unknown,
  ) => SealResult;
  generateCandidates: (run: unknown) => Promise<ModelResultLike>;
  persistRun: (input: Readonly<{
    source: AnalysisSourceVersionInput;
    run: AnalysisRunInput;
  }>) => Promise<AnalysisRunRecord>;
  listPersistedRuns: (
    requestedBySubjectDigest: string,
    limit: number,
  ) => Promise<readonly PersistedProviderAnalysis[]>;
  appendReview: (input: Readonly<{
    reviewId: string;
    runId: string;
    reviewerSubjectDigest: string;
    disposition: AnalysisReviewDisposition;
    note: string;
  }>) => Promise<Readonly<{
    duplicate: boolean;
    review: AnalysisHumanReviewRecord;
  }>>;
  modelReference: () => string | null;
  newRunId?: () => string;
  now?: () => Date;
}>;

export type ProviderSourceAnalysisCoverage = Readonly<{
  kind: "page" | "section";
  number: number;
  status: "extracted" | "unavailable";
  start: number | null;
  end: number | null;
}>;

export type ProviderSourceAnalysisCandidate = Readonly<{
  claimId: string;
  interpretation: string;
  evidence: readonly Readonly<{
    polarity: "supporting" | "charge-weakening";
    quote: string;
    start: number;
    end: number;
    sourceLocator: string;
  }>[];
  uncertainty: Readonly<{
    status: "uncertain" | "limited" | "none-declared";
    explanation: string;
    questions: readonly string[];
  }>;
  reviewState: "human-review-required";
}>;

export type ProviderSourceAnalysisReview = Readonly<{
  reviewId: string;
  reviewedAt: string;
  disposition: AnalysisReviewDisposition;
  note: string;
}>;

export type ProviderSourceAnalysisRun = Readonly<{
  locator: string;
  sourceLocator: string;
  sourceDisplayReference: string;
  status: "manual-review-ready" | "candidate-ready" | "model-failed";
  recordedAt: string;
  extraction: Readonly<{
    format: "pdf" | "text" | "markdown";
    status: "complete" | "partial";
    byteLength: number;
    codePointCount: number;
    extractorReference: string;
    coverage: readonly ProviderSourceAnalysisCoverage[];
  }>;
  model:
    | Readonly<{
      status: "not-requested";
      modelReference: null;
      candidates: readonly [];
      missingContext: readonly [];
    }>
    | Readonly<{
      status: "completed";
      modelReference: string;
      candidates: readonly ProviderSourceAnalysisCandidate[];
      missingContext: readonly string[];
    }>
    | Readonly<{
      status: "failed";
      modelReference: string | null;
      code: AnalysisModelFailureCode;
      candidates: readonly [];
      missingContext: readonly [];
    }>;
  reviews: readonly ProviderSourceAnalysisReview[];
  humanReviewRequired: true;
  publicationBlocked: true;
  effects: typeof effects;
}>;

export type ProviderSourceAnalysisProject = Readonly<{
  locator: string;
  displayName: string;
  requests: readonly Readonly<{
    locator: string;
    title: string;
    sources: readonly Readonly<{
      locator: string;
      displayReference: string;
      originalName: string | null;
      mediaType: string;
      byteLength: number;
      provenanceOrigin: SourceIntakeRecord["provenance"]["origin"];
      studioSharing: SourceIntakeRecord["permissions"]["studioSharing"];
      modelProcessing: SourceIntakeRecord["permissions"]["modelProcessing"];
      modelInputReviewStatus:
        SourceIntakeRecord["permissions"]["modelInputReview"]["status"];
      recordedAt: string;
    }>[];
  }>[];
}>;

export type ProviderSourceAnalysisGetResponse =
  | Readonly<{
    ok: true;
    projects: readonly ProviderSourceAnalysisProject[];
    runs: readonly ProviderSourceAnalysisRun[];
    limits: Readonly<{
      sourceBytes: 10_000_000;
      sourceCodePoints: 200_000;
      pdfPages: 50;
    }>;
  }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
  }>;

export type ProviderSourceAnalysisPostResponse =
  | Readonly<{
    ok: true;
    code: "SOURCE_ANALYSIS_COMPLETE";
    run: ProviderSourceAnalysisRun;
  }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
    run?: ProviderSourceAnalysisRun;
  }>;

export type ProviderSourceAnalysisReviewResponse =
  | Readonly<{
    ok: true;
    duplicate: boolean;
    review: ProviderSourceAnalysisReview;
  }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
  }>;

type CatalogEntry = Readonly<{
  authorized: AuthorizedProviderSource;
  projectLocator: string;
  requestLocator: string;
  sourceLocator: string;
  sourceVersionId: string;
  displayReference: string;
}>;

type ExtractedAnalysis = Readonly<{
  source: ExtractedSourceLike;
  format: ProviderSourceAnalysisRun["extraction"]["format"];
  parserReference: string;
  extractionStatus: "complete" | "partial";
  declaredByteLength: number;
  coverage: PersistedAnalysisSourceDetails["coverage"];
}>;

type Submission = Readonly<{
  projectLocator: string;
  requestLocator: string;
  sourceLocator: string;
  mode: "manual" | "gemini";
}>;

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueLocator(
  prefix: "psap1" | "psar1" | "psas1" | "psan1",
  parts: readonly unknown[],
): string {
  return `${prefix}_${sha256(JSON.stringify(parts)).slice(0, 40)}`;
}

function projectLocator(
  subjectDigest: string,
  source: AuthorizedProviderSource,
): string {
  return opaqueLocator("psap1", [
    subjectDigest,
    source.workspaceId,
    source.projectId,
    source.providerActorId,
    source.grantEpoch,
  ]);
}

function requestLocator(
  subjectDigest: string,
  source: AuthorizedProviderSource,
): string {
  return opaqueLocator("psar1", [
    subjectDigest,
    source.workspaceId,
    source.projectId,
    source.requestId,
    source.providerActorId,
    source.grantEpoch,
  ]);
}

function sourceLocator(
  subjectDigest: string,
  source: AuthorizedProviderSource,
): string {
  return opaqueLocator("psas1", [
    subjectDigest,
    source.workspaceId,
    source.projectId,
    source.requestId,
    source.source.sourceId,
    source.source.version,
    source.source.recordDigest,
  ]);
}

export function providerAnalysisSourceVersionId(
  source: AuthorizedProviderSource,
): string {
  const digest = sha256(JSON.stringify([
    source.workspaceId,
    source.projectId,
    source.requestId,
    source.source.sourceId,
    source.source.version,
    source.source.recordDigest,
    source.source.contentDigest,
  ]));
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function runLocator(subjectDigest: string, runId: string): string {
  return opaqueLocator("psan1", [subjectDigest, runId]);
}

function displayReference(locator: string): string {
  return `SRC-${locator.slice(-8).toUpperCase()}`;
}

function catalog(
  subjectDigest: string,
  sources: readonly AuthorizedProviderSource[],
): readonly CatalogEntry[] {
  const seen = new Set<string>();
  const entries = sources.map((authorized) => {
    const locator = sourceLocator(subjectDigest, authorized);
    if (seen.has(locator)) {
      throw new Error("DUPLICATE_SOURCE_LOCATOR");
    }
    seen.add(locator);
    return Object.freeze({
      authorized,
      projectLocator: projectLocator(subjectDigest, authorized),
      requestLocator: requestLocator(subjectDigest, authorized),
      sourceLocator: locator,
      sourceVersionId: providerAnalysisSourceVersionId(authorized),
      displayReference: displayReference(locator),
    });
  });
  return Object.freeze(entries);
}

function projects(entries: readonly CatalogEntry[]): readonly ProviderSourceAnalysisProject[] {
  const projectMap = new Map<string, {
    displayName: string;
    requests: Map<string, {
      title: string;
      sources: ProviderSourceAnalysisProject["requests"][number]["sources"][number][];
    }>;
  }>();
  for (const entry of entries) {
    let project = projectMap.get(entry.projectLocator);
    if (!project) {
      project = {
        displayName: entry.authorized.projectDisplayName,
        requests: new Map(),
      };
      projectMap.set(entry.projectLocator, project);
    }
    let request = project.requests.get(entry.requestLocator);
    if (!request) {
      request = {
        title: entry.authorized.requestTitle,
        sources: [],
      };
      project.requests.set(entry.requestLocator, request);
    }
    const source = entry.authorized.source;
    request.sources.push(Object.freeze({
      locator: entry.sourceLocator,
      displayReference: entry.displayReference,
      originalName: source.originalName,
      mediaType: source.mediaType,
      byteLength: source.declaredByteLength,
      provenanceOrigin: source.provenance.origin,
      studioSharing: source.permissions.studioSharing,
      modelProcessing: source.permissions.modelProcessing,
      modelInputReviewStatus: source.permissions.modelInputReview.status,
      recordedAt: source.recordedAt.toISOString(),
    }));
  }
  return Object.freeze([...projectMap.entries()].map(([locator, project]) =>
    Object.freeze({
      locator,
      displayName: project.displayName,
      requests: Object.freeze([...project.requests.entries()].map(
        ([requestLocatorValue, request]) => Object.freeze({
          locator: requestLocatorValue,
          title: request.title,
          sources: Object.freeze(request.sources),
        }),
      )),
    })));
}

function providerFailure(access: Exclude<ProviderAccess, { ok: true }>): Response {
  return json({
    ok: false,
    code: access.code,
    message: access.message ?? (
      access.code === "AUTHENTICATION_REQUIRED"
        ? "Sign in before accessing provider source analysis."
        : access.code === "PROVIDER_ASSURANCE_REQUIRED"
          ? "Verified email and MFA assurance are required."
          : "Provider authentication is unavailable."
    ),
  }, access.status);
}

async function providerAccess(
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<Extract<ProviderAccess, { ok: true }> | Response> {
  try {
    const access = await dependencies.verifyProvider();
    return access.ok ? access : providerFailure(access);
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
}

function validateSubmission(input: unknown):
  | Readonly<{ ok: true; value: Submission }>
  | Readonly<{ ok: false; response: Response }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "INVALID_SOURCE_ANALYSIS_REQUEST",
        message: "The source analysis request must be a JSON object.",
      }, 400),
    };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !== "mode,projectLocator,requestLocator,sourceLocator"
    || typeof record.projectLocator !== "string"
    || typeof record.requestLocator !== "string"
    || typeof record.sourceLocator !== "string"
    || !locatorPattern.test(record.projectLocator)
    || !locatorPattern.test(record.requestLocator)
    || !locatorPattern.test(record.sourceLocator)
    || (record.mode !== "manual" && record.mode !== "gemini")
  ) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "INVALID_SOURCE_ANALYSIS_REQUEST",
        message: "The source selection or analysis mode is invalid.",
      }, 422),
    };
  }
  return {
    ok: true,
    value: {
      projectLocator: record.projectLocator,
      requestLocator: record.requestLocator,
      sourceLocator: record.sourceLocator,
      mode: record.mode,
    },
  };
}

function selectedSource(
  entries: readonly CatalogEntry[],
  submission: Submission,
): CatalogEntry | null {
  return entries.find((entry) =>
    entry.projectLocator === submission.projectLocator
    && entry.requestLocator === submission.requestLocator
    && entry.sourceLocator === submission.sourceLocator
  ) ?? null;
}

function objectError(error: unknown): Response {
  const code = error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
  if (code === "NOT_FOUND") {
    return json({
      ok: false,
      code: "SOURCE_BYTES_MISSING",
      message: "The immutable source bytes are not available.",
    }, 404);
  }
  if (code === "INTEGRITY_VIOLATION" || code === "CONFLICT") {
    return json({
      ok: false,
      code: "SOURCE_INTEGRITY_FAILED",
      message: "The immutable source bytes did not pass integrity verification.",
    }, 409);
  }
  if (code === "SIZE_LIMIT_EXCEEDED") {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_LIMIT_EXCEEDED",
      message: "The admitted source exceeds the bounded analysis limit.",
    }, 413);
  }
  return json({
    ok: false,
    code: "SOURCE_STORAGE_UNAVAILABLE",
    message: "The immutable source bytes could not be read.",
  }, 503);
}

function verifiedBytes(
  selected: CatalogEntry,
  stored: StoredSourceObjectRead,
): Uint8Array | Response {
  const source = selected.authorized.source;
  const expectedBinding = {
    workspaceId: selected.authorized.workspaceId,
    projectId: selected.authorized.projectId,
    sourceId: source.sourceId,
    versionId: String(source.version),
  };
  if (
    source.availability !== "available"
    || source.sourceKind !== "provider-upload"
    || source.contentDigest === null
    || stored.object.binding.workspaceId !== expectedBinding.workspaceId
    || stored.object.binding.projectId !== expectedBinding.projectId
    || stored.object.binding.sourceId !== expectedBinding.sourceId
    || stored.object.binding.versionId !== expectedBinding.versionId
    || stored.object.byteLength !== source.declaredByteLength
    || stored.bytes.byteLength !== source.declaredByteLength
    || stored.object.objectId !== `sha256:${source.contentDigest}`
    || sha256(stored.bytes) !== source.contentDigest
    || stored.object.mediaType !== source.mediaType
    || stored.object.browserFilename !== source.originalName
  ) {
    return json({
      ok: false,
      code: "SOURCE_INTEGRITY_FAILED",
      message: "The immutable source bytes did not match the admitted source record.",
    }, 409);
  }
  return stored.bytes;
}

function extractedMetadata(
  selected: CatalogEntry,
  extractorReference: string,
): Omit<ExtractedSourceLike, "document" | "extractedText" | "extractedTextSha256" | "extraction"> {
  const source = selected.authorized.source;
  const acceptance = source.provenance.acceptance.kind === "provider-attested-import"
    ? {
      kind: "provider-attested-import" as const,
      attestedBy: source.reviewedBy,
      basis: source.provenance.acceptance.basis,
    }
    : source.provenance.acceptance.kind === "in-app-record-reference"
      ? {
        kind: "in-app-record-reference" as const,
        recordReference: source.sourceId,
        basis: source.provenance.acceptance.basis,
      }
      : {
        kind: "unverified" as const,
        basis: source.provenance.acceptance.basis,
      };
  const review = source.permissions.modelInputReview;
  return {
    schemaVersion: 1,
    ...ANALYSIS_DEMO_SCOPE,
    versionId: selected.sourceVersionId,
    provenance: {
      origin: source.provenance.origin,
      suppliedBy: source.provenance.suppliedBy,
      recordedAt: source.recordedAt.toISOString(),
      claimedDate: null,
      effectiveDate: null,
      acceptance,
      originReference: source.provenance.originReference,
      extractorReference,
    },
    permissions: {
      studioSharing: source.permissions.studioSharing,
      modelProcessing: source.permissions.modelProcessing,
      modelInputReview: review.status === "cleared"
        ? {
          status: "cleared",
          reviewerId: review.reviewerId,
          reviewedAt: review.reviewedAt.toISOString(),
          basis: review.basis,
        }
        : { status: review.status },
    },
  };
}

function parserError(error: unknown): Response {
  const code = error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
  switch (code) {
    case "FILE_TOO_LARGE":
      return json({
        ok: false,
        code: "SOURCE_ANALYSIS_LIMIT_EXCEEDED",
        message: "The admitted PDF exceeds the bounded parser limit.",
      }, 413);
    case "TYPE_MISMATCH":
      return json({
        ok: false,
        code: "SOURCE_TYPE_MISMATCH",
        message: "The admitted source bytes do not match the stored PDF media type.",
      }, 415);
    case "PAGE_LIMIT_EXCEEDED":
      return json({
        ok: false,
        code: "PDF_PAGE_LIMIT_EXCEEDED",
        message: "The admitted PDF exceeds the 50-page extraction limit.",
      }, 422);
    case "PARSER_TIMEOUT":
      return json({
        ok: false,
        code: "PDF_PARSER_TIMEOUT",
        message: "PDF extraction exceeded the bounded processing time.",
      }, 504);
    case "PARSER_FAILED":
      return json({
        ok: false,
        code: "PDF_PARSE_FAILED",
        message: "The admitted PDF could not be parsed by the isolated extractor.",
      }, 422);
    case "PARSER_OUTPUT_INVALID":
      return json({
        ok: false,
        code: "PDF_PARSER_OUTPUT_INVALID",
        message: "The isolated extractor returned an invalid result.",
      }, 502);
    default:
      return json({
        ok: false,
        code: "PDF_PARSER_UNAVAILABLE",
        message: "PDF extraction is temporarily unavailable.",
      }, 503);
  }
}

function textAnalysis(
  selected: CatalogEntry,
  bytes: Uint8Array,
): ExtractedAnalysis | Response {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    return json({
      ok: false,
      code: "INVALID_TEXT_SOURCE",
      message: "The admitted text source is not valid UTF-8.",
    }, 415);
  }
  if (text.includes("\0") || text.trim().length === 0) {
    return json({
      ok: false,
      code: "INVALID_TEXT_SOURCE",
      message: "The admitted text source does not contain reviewable Unicode text.",
    }, 422);
  }
  const codePointCount = Array.from(text).length;
  if (codePointCount > MAX_SOURCE_CODE_POINTS) {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_LIMIT_EXCEEDED",
      message: "The admitted source exceeds the 200,000 code-point analysis limit.",
    }, 413);
  }
  const markdown = selected.authorized.source.mediaType === "text/markdown";
  const parserReference = markdown
    ? "scopeledger.utf8-markdown.v1"
    : "scopeledger.utf8-text.v1";
  return Object.freeze({
    source: Object.freeze({
      ...extractedMetadata(selected, parserReference),
      document: Object.freeze({
        format: markdown ? "markdown" as const : "txt" as const,
      }),
      extractedText: text,
      extractedTextSha256: sha256(text),
      extraction: Object.freeze({
        status: "complete" as const,
        unavailableReason: null,
      }),
    }),
    format: markdown ? "markdown" : "text",
    parserReference,
    extractionStatus: "complete",
    declaredByteLength: bytes.byteLength,
    coverage: Object.freeze([{
      number: 1,
      status: "extracted" as const,
      start: 0,
      end: codePointCount,
    }]),
  });
}

async function extractSource(
  selected: CatalogEntry,
  bytes: Uint8Array,
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<ExtractedAnalysis | Response> {
  const mediaType = selected.authorized.source.mediaType;
  if (mediaType === "text/plain" || mediaType === "text/markdown") {
    return textAnalysis(selected, bytes);
  }
  if (mediaType !== "application/pdf") {
    return json({
      ok: false,
      code: "UNSUPPORTED_SOURCE_TYPE",
      message: "This admitted source type is not supported for analysis.",
    }, 415);
  }
  let parsed: ParsedPdf;
  try {
    parsed = await dependencies.extractPdf(bytes);
  } catch (error) {
    return parserError(error);
  }
  if (Array.from(parsed.extractedText).length > MAX_SOURCE_CODE_POINTS) {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_LIMIT_EXCEEDED",
      message: "The extracted PDF text exceeds the 200,000 code-point analysis limit.",
    }, 413);
  }
  let sealed: SealResult;
  try {
    const metadata = extractedMetadata(selected, parsed.extractorReference);
    sealed = dependencies.sealParsedPdfSource(
      parsed,
      {
        workspaceId: metadata.workspaceId,
        projectId: metadata.projectId,
        sourceId: metadata.sourceId,
        versionId: metadata.versionId,
        provenance: metadata.provenance,
        permissions: metadata.permissions,
      },
    );
  } catch {
    return json({
      ok: false,
      code: "SOURCE_SEAL_FAILED",
      message: "The extracted PDF could not be sealed for analysis.",
    }, 500);
  }
  if (!sealed.ok) {
    return json({
      ok: false,
      code: "SOURCE_SEAL_FAILED",
      message: "The extracted PDF could not be sealed for analysis.",
    }, 500);
  }
  const unavailable = new Set(
    parsed.unavailablePages.map((page) => page.pageNumber),
  );
  const pageMap = new Map(
    parsed.pages.map((page) => [page.pageNumber, page] as const),
  );
  const coverage: PersistedAnalysisSourceDetails["coverage"] = Object.freeze(
    Array.from({ length: parsed.declaredPageCount }, (_, index) => {
      const number = index + 1;
      const page = pageMap.get(number);
      if (page) {
        return Object.freeze({
          number,
          status: "extracted" as const,
          start: page.start,
          end: page.end,
        });
      }
      if (!unavailable.has(number)) {
        throw new Error("INCOMPLETE_PDF_COVERAGE");
      }
      return Object.freeze({
        number,
        status: "unavailable" as const,
      });
    }),
  );
  return Object.freeze({
    source: sealed.value,
    format: "pdf",
    parserReference: parsed.extractorReference,
    extractionStatus: parsed.unavailablePages.length > 0
      ? "partial"
      : "complete",
    declaredByteLength: parsed.declaredByteLength,
    coverage,
  });
}

function persistencePermissions(
  source: SourceIntakeRecord,
  subjectDigest: string,
): AnalysisSourceVersionInput["permissions"] {
  if (
    source.permissions.modelProcessing === "permitted"
    && source.permissions.modelInputReview.status === "cleared"
  ) {
    return {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: "cleared",
      reviewedBySubjectDigest: subjectDigest,
      reviewedAt: source.recordedAt,
    };
  }
  return {
    studioSharing: "permitted",
    modelProcessing: "denied",
    modelInputReview: "not-reviewed",
    reviewedBySubjectDigest: null,
    reviewedAt: null,
  };
}

function candidatePayload(result: ModelResultLike): AnalysisCandidatePayload {
  return {
    schemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
    humanReviewRequired: true,
    publicationBlocked: true,
    candidates: result.review.claims.map((claim) => ({
      claimId: claim.claimId,
      interpretation: claim.interpretation,
      evidence: [
        ...claim.supportingEvidence,
        ...claim.chargeWeakeningEvidence,
      ].map((pointer) => ({
        polarity: pointer.polarity,
        quote: pointer.quote,
        start: pointer.start,
        end: pointer.end,
        sourceReference: pointer.source,
      })),
      uncertainty: claim.uncertainty,
      reviewState: "human-review-required",
    })),
    missingContext: result.review.coverage.missingContext,
  };
}

function persistenceInput(
  selected: CatalogEntry,
  subjectDigest: string,
  runId: string,
  extracted: ExtractedAnalysis,
  run: Readonly<{
    status: AnalysisRunInput["status"];
    providerReference: AnalysisRunInput["providerReference"];
    modelReference: string | null;
    candidatePayload: AnalysisCandidatePayload | null;
    failureDiagnostic: AnalysisRunInput["failureDiagnostic"];
  }>,
): Readonly<{
  source: AnalysisSourceVersionInput;
  run: AnalysisRunInput;
}> {
  const source = selected.authorized.source;
  const exactText = extracted.source.extractedText;
  const extractedCount = extracted.coverage.filter(
    (entry) => entry.status === "extracted",
  ).length;
  const coverage: AnalysisSourceVersionInput["coverage"] =
    extracted.coverage.map((entry) =>
      entry.status === "extracted"
        ? {
          pageNumber: entry.number,
          status: "extracted" as const,
          start: entry.start,
          end: entry.end,
        }
        : {
          pageNumber: entry.number,
          status: "unavailable" as const,
          reasonCode: "parser-reported-unavailable" as const,
        });
  return {
    source: {
      ...ANALYSIS_DEMO_SCOPE,
      versionId: selected.sourceVersionId,
      exactText,
      exactTextDigest: sha256(exactText),
      parserReference: extracted.parserReference,
      extractionStatus: extracted.extractionStatus,
      declaredByteLength: extracted.declaredByteLength,
      declaredPageCount: extracted.coverage.length,
      extractedPageCount: extractedCount,
      codePointCount: Array.from(exactText).length,
      recordedAt: source.recordedAt,
      provenance: {
        origin: "other",
        suppliedBy: "authenticated-provider",
        contentAttestation: "synthetic-or-permitted",
        attestedAt: source.recordedAt,
      },
      permissions: persistencePermissions(source, subjectDigest),
      coverage,
    },
    run: {
      ...ANALYSIS_DEMO_SCOPE,
      runId,
      requestedBySubjectDigest: subjectDigest,
      sourceVersionId: selected.sourceVersionId,
      providerReference: run.providerReference,
      modelReference: run.modelReference,
      candidateSchemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
      configReference: run.providerReference === "manual"
        ? "scopeledger.analysis.manual.v1"
        : "scopeledger.gemini.server-config.v1",
      status: run.status,
      candidatePayload: run.candidatePayload,
      failureDiagnostic: run.failureDiagnostic,
      createdAt: source.recordedAt,
    },
  };
}

function formatFromParserReference(
  parserReference: string,
): ProviderSourceAnalysisRun["extraction"]["format"] {
  if (parserReference === "scopeledger.utf8-text.v1") return "text";
  if (parserReference === "scopeledger.utf8-markdown.v1") return "markdown";
  return "pdf";
}

function analysisReview(
  review: AnalysisHumanReviewRecord,
): ProviderSourceAnalysisReview {
  return Object.freeze({
    reviewId: review.reviewId,
    reviewedAt: review.reviewedAt.toISOString(),
    disposition: review.disposition,
    note: review.note,
  });
}

function validatePersistedSource(
  run: AnalysisRunRecord,
  source: PersistedAnalysisSourceDetails,
): void {
  const points = Array.from(source.exactText);
  if (
    run.sourceReference.workspaceId !== ANALYSIS_DEMO_SCOPE.workspaceId
    || run.sourceReference.projectId !== ANALYSIS_DEMO_SCOPE.projectId
    || run.sourceReference.sourceId !== ANALYSIS_DEMO_SCOPE.sourceId
    || run.sourceReference.versionId !== source.versionId
    || sha256(source.exactText) !== run.sourceDigest
    || points.length !== source.codePointCount
    || source.coverage.length !== source.declaredPageCount
  ) {
    throw new Error("INVALID_PERSISTED_SOURCE_ANALYSIS");
  }
  let end = 0;
  let extracted = 0;
  for (const [index, unit] of source.coverage.entries()) {
    if (unit.number !== index + 1) {
      throw new Error("INVALID_PERSISTED_SOURCE_ANALYSIS");
    }
    if (unit.status === "extracted") {
      if (unit.start !== end || unit.end <= unit.start || unit.end > points.length) {
        throw new Error("INVALID_PERSISTED_SOURCE_ANALYSIS");
      }
      end = unit.end;
      extracted += 1;
    }
  }
  if (end !== points.length || extracted < 1) {
    throw new Error("INVALID_PERSISTED_SOURCE_ANALYSIS");
  }
}

function analysisRun(
  subjectDigest: string,
  entry: CatalogEntry,
  persisted: PersistedProviderAnalysis,
): ProviderSourceAnalysisRun {
  validatePersistedSource(persisted.run, persisted.source);
  const points = Array.from(persisted.source.exactText);
  const payload = persisted.run.candidatePayload;
  const candidates: ProviderSourceAnalysisCandidate[] =
    payload?.candidates.map((candidate) => Object.freeze({
      claimId: candidate.claimId,
      interpretation: candidate.interpretation,
      evidence: Object.freeze(candidate.evidence.map((evidence) => {
        if (
          evidence.sourceReference.workspaceId
            !== persisted.run.sourceReference.workspaceId
          || evidence.sourceReference.projectId
            !== persisted.run.sourceReference.projectId
          || evidence.sourceReference.sourceId
            !== persisted.run.sourceReference.sourceId
          || evidence.sourceReference.versionId
            !== persisted.run.sourceReference.versionId
          || points.slice(evidence.start, evidence.end).join("")
            !== evidence.quote
        ) {
          throw new Error("INVALID_PERSISTED_EVIDENCE");
        }
        return Object.freeze({
          polarity: evidence.polarity,
          quote: evidence.quote,
          start: evidence.start,
          end: evidence.end,
          sourceLocator: entry.sourceLocator,
        });
      })),
      uncertainty: candidate.uncertainty,
      reviewState: "human-review-required" as const,
    })) ?? [];
  const model: ProviderSourceAnalysisRun["model"] =
    persisted.run.status === "manual-review-ready"
      ? {
        status: "not-requested",
        modelReference: null,
        candidates: [],
        missingContext: [],
      }
      : persisted.run.status === "candidate-ready"
        ? {
          status: "completed",
          modelReference: persisted.run.modelReference!,
          candidates: Object.freeze(candidates),
          missingContext: payload?.missingContext ?? [],
        }
        : {
          status: "failed",
          modelReference: persisted.run.modelReference,
          code: persisted.run.failureDiagnostic?.code
            ?? "MODEL_PROCESSING_FAILED",
          candidates: [],
          missingContext: [],
        };
  const kind = formatFromParserReference(persisted.source.parserReference) === "pdf"
    ? "page"
    : "section";
  return Object.freeze({
    locator: runLocator(subjectDigest, persisted.run.runId),
    sourceLocator: entry.sourceLocator,
    sourceDisplayReference: entry.displayReference,
    status: persisted.run.status,
    recordedAt: persisted.run.createdAt.toISOString(),
    extraction: Object.freeze({
      format: formatFromParserReference(persisted.source.parserReference),
      status: persisted.source.extractionStatus,
      byteLength: persisted.source.declaredByteLength,
      codePointCount: persisted.source.codePointCount,
      extractorReference: persisted.source.parserReference,
      coverage: Object.freeze(persisted.source.coverage.map((unit) =>
        Object.freeze({
          kind,
          number: unit.number,
          status: unit.status,
          start: unit.status === "extracted" ? unit.start : null,
          end: unit.status === "extracted" ? unit.end : null,
        }))),
    }),
    model: Object.freeze(model),
    reviews: Object.freeze(persisted.reviews.map(analysisReview)),
    humanReviewRequired: true,
    publicationBlocked: true,
    effects,
  });
}

function modelFailure(error: unknown): Readonly<{
  status: number;
  code: AnalysisModelFailureCode;
}> {
  const code = error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
  if (code === "PROCESSING_NOT_PERMITTED") {
    return { status: 422, code: "MODEL_INPUT_NOT_ADMITTED" };
  }
  if (code === "INVALID_CONFIG") {
    return { status: 503, code: "MODEL_CONFIGURATION_UNAVAILABLE" };
  }
  return { status: 502, code: "MODEL_PROCESSING_FAILED" };
}

function persistedDetails(
  selected: CatalogEntry,
  extracted: ExtractedAnalysis,
): PersistedAnalysisSourceDetails {
  return Object.freeze({
    versionId: selected.sourceVersionId,
    exactText: extracted.source.extractedText,
    parserReference: extracted.parserReference,
    extractionStatus: extracted.extractionStatus,
    declaredByteLength: extracted.declaredByteLength,
    declaredPageCount: extracted.coverage.length,
    codePointCount: Array.from(extracted.source.extractedText).length,
    coverage: extracted.coverage,
  });
}

async function readCatalog(
  subjectDigest: string,
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<readonly CatalogEntry[] | Response> {
  try {
    return catalog(
      subjectDigest,
      await dependencies.listAuthorizedSources(),
    );
  } catch {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_SCOPE_UNAVAILABLE",
      message: "Authorized provider source scope could not be read.",
    }, 503);
  }
}

export async function handleProviderSourceAnalysisGet(
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<Response> {
  const access = await providerAccess(dependencies);
  if (access instanceof Response) return access;
  const entries = await readCatalog(access.subjectDigest, dependencies);
  if (entries instanceof Response) return entries;
  let persisted: readonly PersistedProviderAnalysis[];
  try {
    persisted = await dependencies.listPersistedRuns(
      access.subjectDigest,
      MAX_RUNS,
    );
  } catch {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_READ_FAILED",
      message: "Persisted source analysis could not be read.",
    }, 503);
  }
  const byVersion = new Map(entries.map((entry) => [
    entry.sourceVersionId,
    entry,
  ]));
  try {
    const runs = persisted.flatMap((run) => {
      const entry = byVersion.get(run.run.sourceReference.versionId);
      return entry ? [analysisRun(access.subjectDigest, entry, run)] : [];
    });
    return json({
      ok: true,
      projects: projects(entries),
      runs,
      limits: {
        sourceBytes: 10_000_000,
        sourceCodePoints: 200_000,
        pdfPages: 50,
      },
    } satisfies ProviderSourceAnalysisGetResponse);
  } catch {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_READ_FAILED",
      message: "Persisted source analysis could not be verified.",
    }, 503);
  }
}

export async function handleProviderSourceAnalysisPost(
  request: Request,
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "This analysis must originate from the ScopeLedger application.",
    }, 403);
  }
  const access = await providerAccess(dependencies);
  if (access instanceof Response) return access;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({
      ok: false,
      code: "INVALID_SOURCE_ANALYSIS_REQUEST",
      message: "The source analysis request was not valid JSON.",
    }, 400);
  }
  const validation = validateSubmission(input);
  if (!validation.ok) return validation.response;
  const entries = await readCatalog(access.subjectDigest, dependencies);
  if (entries instanceof Response) return entries;
  const selected = selectedSource(entries, validation.value);
  if (!selected) {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_SCOPE_NOT_FOUND",
      message: "The selected provider source is not available in the active grant scope.",
    }, 404);
  }
  const source = selected.authorized.source;
  if (source.permissions.studioSharing !== "permitted") {
    return json({
      ok: false,
      code: "STUDIO_SHARING_NOT_PERMITTED",
      message: "Stored studio-sharing permission does not permit analysis.",
    }, 422);
  }
  if (
    validation.value.mode === "gemini"
    && (
      source.permissions.modelProcessing !== "permitted"
      || source.permissions.modelInputReview.status !== "cleared"
    )
  ) {
    return json({
      ok: false,
      code: "MODEL_INPUT_NOT_ADMITTED",
      message: modelFailureMessages.MODEL_INPUT_NOT_ADMITTED,
    }, 422);
  }

  let stored: StoredSourceObjectRead;
  try {
    stored = await dependencies.readSourceObject(selected.authorized);
  } catch (error) {
    return objectError(error);
  }
  const verified = verifiedBytes(selected, stored);
  if (verified instanceof Response) return verified;
  let extracted: ExtractedAnalysis | Response;
  try {
    extracted = await extractSource(selected, verified, dependencies);
  } catch {
    return json({
      ok: false,
      code: "SOURCE_EXTRACTION_FAILED",
      message: "The admitted source could not be converted into exact analysis coverage.",
    }, 500);
  }
  if (extracted instanceof Response) return extracted;

  const runId = dependencies.newRunId?.() ?? randomUUID();
  if (!uuidPattern.test(runId)) {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_UNAVAILABLE",
      message: "A durable analysis identity could not be created.",
    }, 503);
  }
  const sourceDetails = persistedDetails(selected, extracted);
  if (validation.value.mode === "manual") {
    let persistedRun: AnalysisRunRecord;
    try {
      persistedRun = await dependencies.persistRun(persistenceInput(
        selected,
        access.subjectDigest,
        runId,
        extracted,
        {
          status: "manual-review-ready",
          providerReference: "manual",
          modelReference: null,
          candidatePayload: null,
          failureDiagnostic: null,
        },
      ));
    } catch {
      return json({
        ok: false,
        code: "SOURCE_ANALYSIS_PERSISTENCE_FAILED",
        message: "Exact extraction completed, but no durable analysis run was saved.",
      }, 503);
    }
    return json({
      ok: true,
      code: "SOURCE_ANALYSIS_COMPLETE",
      run: analysisRun(access.subjectDigest, selected, {
        run: persistedRun,
        source: sourceDetails,
        reviews: [],
      }),
    } satisfies ProviderSourceAnalysisPostResponse);
  }

  try {
    const result = await dependencies.generateCandidates({
      schemaVersion: 1,
      workspaceId: ANALYSIS_DEMO_SCOPE.workspaceId,
      projectId: ANALYSIS_DEMO_SCOPE.projectId,
      sources: [extracted.source],
      request: {
        kind: "request",
        text: "Review this exact admitted provider source for candidate scope interpretations.",
      },
    });
    const configuredModel = result.model ?? dependencies.modelReference();
    if (!configuredModel) {
      throw Object.assign(new Error("MODEL_CONFIGURATION_UNAVAILABLE"), {
        code: "INVALID_CONFIG",
      });
    }
    const payload = candidatePayload(result);
    const persistedRun = await dependencies.persistRun(persistenceInput(
      selected,
      access.subjectDigest,
      runId,
      extracted,
      {
        status: "candidate-ready",
        providerReference: "google-gemini",
        modelReference: configuredModel,
        candidatePayload: payload,
        failureDiagnostic: null,
      },
    ));
    return json({
      ok: true,
      code: "SOURCE_ANALYSIS_COMPLETE",
      run: analysisRun(access.subjectDigest, selected, {
        run: persistedRun,
        source: sourceDetails,
        reviews: [],
      }),
    } satisfies ProviderSourceAnalysisPostResponse);
  } catch (error) {
    const failed = modelFailure(error);
    let persistedRun: AnalysisRunRecord;
    try {
      persistedRun = await dependencies.persistRun(persistenceInput(
        selected,
        access.subjectDigest,
        runId,
        extracted,
        {
          status: "model-failed",
          providerReference: "google-gemini",
          modelReference: dependencies.modelReference(),
          candidatePayload: null,
          failureDiagnostic: {
            code: failed.code,
            message: modelFailureMessages[failed.code],
          },
        },
      ));
    } catch {
      return json({
        ok: false,
        code: "SOURCE_ANALYSIS_PERSISTENCE_FAILED",
        message: "Exact extraction completed, but the failed model attempt was not saved.",
      }, 503);
    }
    return json({
      ok: false,
      code: failed.code,
      message: modelFailureMessages[failed.code],
      run: analysisRun(access.subjectDigest, selected, {
        run: persistedRun,
        source: sourceDetails,
        reviews: [],
      }),
    } satisfies ProviderSourceAnalysisPostResponse, failed.status);
  }
}

function validateReview(input: unknown):
  | Readonly<{
    ok: true;
    value: Readonly<{
      runLocator: string;
      reviewId: string;
      disposition: AnalysisReviewDisposition;
      note: string;
    }>;
  }>
  | Readonly<{ ok: false; response: Response }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "INVALID_SOURCE_ANALYSIS_REVIEW",
        message: "The review request must be a JSON object.",
      }, 400),
    };
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const dispositions = new Set<AnalysisReviewDisposition>([
    "accept",
    "edit",
    "reject",
    "manual",
  ]);
  if (
    keys.join(",") !== "disposition,note,reviewId,runLocator"
    || typeof record.runLocator !== "string"
    || !locatorPattern.test(record.runLocator)
    || typeof record.reviewId !== "string"
    || !uuidPattern.test(record.reviewId)
    || typeof record.disposition !== "string"
    || !dispositions.has(record.disposition as AnalysisReviewDisposition)
    || typeof record.note !== "string"
    || record.note !== record.note.trim()
    || Array.from(record.note).length < 1
    || Array.from(record.note).length > 2_000
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(record.note)
  ) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "INVALID_SOURCE_ANALYSIS_REVIEW",
        message: "The analysis run, disposition, or review note is invalid.",
      }, 422),
    };
  }
  return {
    ok: true,
    value: {
      runLocator: record.runLocator,
      reviewId: record.reviewId.toLowerCase(),
      disposition: record.disposition as AnalysisReviewDisposition,
      note: record.note,
    },
  };
}

function reviewFailure(error: unknown): Response {
  if (error instanceof AnalysisPersistenceError) {
    if (error.code === "NOT_FOUND") {
      return json({
        ok: false,
        code: "SOURCE_ANALYSIS_RUN_NOT_FOUND",
        message: "The analysis run was not found.",
      }, 404);
    }
    if (error.code === "REVIEW_FORBIDDEN") {
      return json({
        ok: false,
        code: "SOURCE_ANALYSIS_REVIEW_FORBIDDEN",
        message: "This provider cannot review that analysis run.",
      }, 403);
    }
    if (error.code === "REVIEW_CONFLICT") {
      return json({
        ok: false,
        code: "SOURCE_ANALYSIS_REVIEW_CONFLICT",
        message: "That review identity is already bound to different content.",
      }, 409);
    }
  }
  return json({
    ok: false,
    code: "SOURCE_ANALYSIS_REVIEW_FAILED",
    message: "The append-only provider review could not be saved.",
  }, 503);
}

export async function handleProviderSourceAnalysisReviewPost(
  request: Request,
  dependencies: ProviderSourceAnalysisDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "This review must originate from the ScopeLedger application.",
    }, 403);
  }
  const access = await providerAccess(dependencies);
  if (access instanceof Response) return access;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      code: "INVALID_SOURCE_ANALYSIS_REVIEW",
      message: "The review request was not valid JSON.",
    }, 400);
  }
  const validation = validateReview(body);
  if (!validation.ok) return validation.response;
  const entries = await readCatalog(access.subjectDigest, dependencies);
  if (entries instanceof Response) return entries;
  const byVersion = new Map(entries.map((entry) => [
    entry.sourceVersionId,
    entry,
  ]));
  let persisted: readonly PersistedProviderAnalysis[];
  try {
    persisted = await dependencies.listPersistedRuns(
      access.subjectDigest,
      MAX_RUNS,
    );
  } catch {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_READ_FAILED",
      message: "Persisted source analysis could not be read.",
    }, 503);
  }
  const selected = persisted.find((run) =>
    byVersion.has(run.run.sourceReference.versionId)
    && runLocator(access.subjectDigest, run.run.runId)
      === validation.value.runLocator
  );
  if (!selected) {
    return json({
      ok: false,
      code: "SOURCE_ANALYSIS_RUN_NOT_FOUND",
      message: "The analysis run is not available in the active grant scope.",
    }, 404);
  }
  try {
    const result = await dependencies.appendReview({
      reviewId: validation.value.reviewId,
      runId: selected.run.runId,
      reviewerSubjectDigest: access.subjectDigest,
      disposition: validation.value.disposition,
      note: validation.value.note,
    });
    return json({
      ok: true,
      duplicate: result.duplicate,
      review: analysisReview(result.review),
    } satisfies ProviderSourceAnalysisReviewResponse, result.duplicate ? 200 : 201);
  } catch (error) {
    return reviewFailure(error);
  }
}
