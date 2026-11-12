import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { ProtocolDatabase, ProtocolTransaction } from "./index.js";

export const ANALYSIS_DEMO_SCOPE = Object.freeze({
  workspaceId: "demo-provider-workspace",
  projectId: "synthetic-pdf-review",
  sourceId: "provider-upload",
});

export const ANALYSIS_CANDIDATE_SCHEMA_REFERENCE =
  "scopeledger.analysis-candidates.v1" as const;

export type AnalysisRunStatus =
  | "manual-review-ready"
  | "candidate-ready"
  | "model-failed";
export type AnalysisReviewDisposition = "accept" | "edit" | "reject" | "manual";
export type AnalysisModelFailureCode =
  | "MODEL_INPUT_NOT_ADMITTED"
  | "MODEL_CONFIGURATION_UNAVAILABLE"
  | "MODEL_PROCESSING_FAILED";

export type AnalysisSourceReference = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
}>;

export type AnalysisCandidatePayload = Readonly<{
  schemaReference: typeof ANALYSIS_CANDIDATE_SCHEMA_REFERENCE;
  humanReviewRequired: true;
  publicationBlocked: true;
  candidates: readonly Readonly<{
    claimId: string;
    interpretation: string;
    evidence: readonly Readonly<{
      polarity: "supporting" | "charge-weakening";
      quote: string;
      start: number;
      end: number;
      sourceReference: AnalysisSourceReference;
    }>[];
    uncertainty: Readonly<{
      status: "uncertain" | "limited" | "none-declared";
      explanation: string;
      questions: readonly string[];
    }>;
    reviewState: "human-review-required";
  }>[];
  missingContext: readonly string[];
}>;

export type AnalysisSourceVersionInput = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
  exactText: string;
  exactTextDigest: string;
  parserReference: string;
  extractionStatus: "complete" | "partial";
  declaredByteLength: number;
  declaredPageCount: number;
  extractedPageCount: number;
  codePointCount: number;
  recordedAt: Date | string;
  provenance: Readonly<{
    origin: "other";
    suppliedBy: "authenticated-provider";
    contentAttestation: "synthetic-or-permitted";
    attestedAt: Date | string;
  }>;
  permissions: Readonly<
    | {
      studioSharing: "permitted";
      modelProcessing: "denied";
      modelInputReview: "not-reviewed";
      reviewedBySubjectDigest: null;
      reviewedAt: null;
    }
    | {
      studioSharing: "permitted";
      modelProcessing: "permitted";
      modelInputReview: "cleared";
      reviewedBySubjectDigest: string;
      reviewedAt: Date | string;
    }
  >;
  coverage: readonly (
    | Readonly<{
      pageNumber: number;
      status: "extracted";
      start: number;
      end: number;
    }>
    | Readonly<{
      pageNumber: number;
      status: "unavailable";
      reasonCode: "parser-reported-unavailable";
    }>
  )[];
}>;

export type AnalysisRunInput = Readonly<{
  workspaceId: string;
  projectId: string;
  runId: string;
  requestedBySubjectDigest: string;
  sourceId: string;
  sourceVersionId: string;
  providerReference: "manual" | "google-gemini";
  modelReference: string | null;
  candidateSchemaReference: typeof ANALYSIS_CANDIDATE_SCHEMA_REFERENCE;
  configReference:
    | "scopeledger.analysis.manual.v1"
    | "scopeledger.gemini.server-config.v1";
  status: AnalysisRunStatus;
  candidatePayload: AnalysisCandidatePayload | null;
  failureDiagnostic: Readonly<{
    code: AnalysisModelFailureCode;
    message: string;
  }> | null;
  createdAt: Date | string;
}>;

export type AnalysisRunRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  runId: string;
  requestedBySubjectDigest: string;
  sourceReference: AnalysisSourceReference;
  sourceDigest: string;
  parserReference: string;
  providerReference: "manual" | "google-gemini";
  modelReference: string | null;
  candidateSchemaReference: typeof ANALYSIS_CANDIDATE_SCHEMA_REFERENCE;
  configReference:
    | "scopeledger.analysis.manual.v1"
    | "scopeledger.gemini.server-config.v1";
  status: AnalysisRunStatus;
  candidatePayload: AnalysisCandidatePayload | null;
  candidateDigest: string | null;
  failureDiagnostic: Readonly<{
    code: AnalysisModelFailureCode;
    message: string;
  }> | null;
  humanReviewRequired: true;
  publicationBlocked: true;
  runDigest: string;
  createdAt: Date;
}>;

export type AnalysisHumanReviewRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  reviewId: string;
  runId: string;
  reviewerSubjectDigest: string;
  reviewedAt: Date;
  disposition: AnalysisReviewDisposition;
  note: string;
  runBasisDigest: string;
  candidateBasisDigest: string | null;
}>;

export type AnalysisPersistenceErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "SOURCE_CONFLICT"
  | "RUN_CONFLICT"
  | "REVIEW_CONFLICT"
  | "REVIEW_FORBIDDEN";

export class AnalysisPersistenceError extends Error {
  constructor(
    public readonly code: AnalysisPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisPersistenceError";
  }
}

type Scope = Readonly<{ workspaceId: string; projectId: string }>;

type RunRow = {
  workspace_id: string;
  project_id: string;
  run_id: string;
  requested_by_subject_digest: string;
  source_id: string;
  source_version_id: string;
  exact_text_digest: string;
  parser_reference: string;
  provider_reference: "manual" | "google-gemini";
  model_reference: string | null;
  candidate_schema_reference: typeof ANALYSIS_CANDIDATE_SCHEMA_REFERENCE;
  config_reference:
    | "scopeledger.analysis.manual.v1"
    | "scopeledger.gemini.server-config.v1";
  status: AnalysisRunStatus;
  candidate_payload: AnalysisCandidatePayload | null;
  candidate_digest: string | null;
  failure_code: AnalysisModelFailureCode | null;
  failure_message: string | null;
  human_review_required: true;
  publication_blocked: true;
  run_digest: string;
  created_at: Date;
};

type ReviewRow = {
  workspace_id: string;
  project_id: string;
  review_id: string;
  run_id: string;
  reviewer_subject_digest: string;
  reviewed_at: Date;
  disposition: AnalysisReviewDisposition;
  note: string;
  run_basis_digest: string;
  candidate_basis_digest: string | null;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeFailureMessages: Readonly<Record<AnalysisModelFailureCode, string>> =
  Object.freeze({
    MODEL_INPUT_NOT_ADMITTED:
      "The extracted source was not admitted for Gemini processing. Manual review remains available.",
    MODEL_CONFIGURATION_UNAVAILABLE:
      "Gemini processing is not configured. Manual review remains available.",
    MODEL_PROCESSING_FAILED:
      "Gemini candidate processing did not complete. Manual review remains available.",
  });

function invalid(message: string): never {
  throw new AnalysisPersistenceError("INVALID_INPUT", message);
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value.toLowerCase();
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function reference(value: unknown, name: string): string {
  if (typeof value !== "string" || !referencePattern.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function instant(value: unknown, name: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) invalid(`${name} is invalid`);
  return parsed;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${name} is invalid`);
  }
  return Number(value);
}

function boundedText(
  value: unknown,
  name: string,
  maximum: number,
  options: { trim?: boolean; allowNewlines?: boolean } = {},
): string {
  if (typeof value !== "string") invalid(`${name} is invalid`);
  const points = Array.from(value);
  const controls = options.allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (
    points.length < 1
    || points.length > maximum
    || controls.test(value)
    || (options.trim !== false && value !== value.trim())
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function scope(input: Scope): Scope {
  const workspaceId = identifier(input.workspaceId, "workspaceId");
  const projectId = identifier(input.projectId, "projectId");
  if (
    workspaceId !== ANALYSIS_DEMO_SCOPE.workspaceId
    || projectId !== ANALYSIS_DEMO_SCOPE.projectId
  ) {
    invalid("analysis scope is invalid");
  }
  return Object.freeze({ workspaceId, projectId });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("canonical value is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) {
      invalid("canonical value is invalid");
    }
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  invalid("canonical value is invalid");
}

function exactSourceReference(
  value: AnalysisSourceReference,
  expected: AnalysisSourceReference,
): AnalysisSourceReference {
  const normalized = Object.freeze({
    workspaceId: identifier(value.workspaceId, "sourceReference.workspaceId"),
    projectId: identifier(value.projectId, "sourceReference.projectId"),
    sourceId: identifier(value.sourceId, "sourceReference.sourceId"),
    versionId: uuid(value.versionId, "sourceReference.versionId"),
  });
  if (
    normalized.workspaceId !== expected.workspaceId
    || normalized.projectId !== expected.projectId
    || normalized.sourceId !== expected.sourceId
    || normalized.versionId !== expected.versionId
  ) {
    invalid("candidate source reference does not match the run source");
  }
  return normalized;
}

function normalizeCandidatePayload(
  input: AnalysisCandidatePayload,
  source: AnalysisSourceReference,
  exactText: string,
): AnalysisCandidatePayload {
  if (
    input.schemaReference !== ANALYSIS_CANDIDATE_SCHEMA_REFERENCE
    || input.humanReviewRequired !== true
    || input.publicationBlocked !== true
    || !Array.isArray(input.candidates)
    || input.candidates.length < 1
    || input.candidates.length > 40
    || !Array.isArray(input.missingContext)
    || input.missingContext.length > 20
  ) {
    invalid("candidate payload is invalid");
  }
  const points = Array.from(exactText);
  const claimIds = new Set<string>();
  const candidates = input.candidates.map((candidate, candidateIndex) => {
    const claimId = identifier(candidate.claimId, `candidates.${candidateIndex}.claimId`);
    if (claimIds.has(claimId)) invalid("candidate claim IDs must be unique");
    claimIds.add(claimId);
    const interpretation = boundedText(
      candidate.interpretation,
      `candidates.${candidateIndex}.interpretation`,
      4_000,
      { allowNewlines: true },
    );
    if (
      candidate.reviewState !== "human-review-required"
      || !Array.isArray(candidate.evidence)
      || candidate.evidence.length < 1
      || candidate.evidence.length > 40
    ) {
      invalid(`candidates.${candidateIndex} is invalid`);
    }
    const evidence = candidate.evidence.map((
      entry: AnalysisCandidatePayload["candidates"][number]["evidence"][number],
      evidenceIndex: number,
    ) => {
      if (
        entry.polarity !== "supporting"
        && entry.polarity !== "charge-weakening"
      ) {
        invalid(`candidates.${candidateIndex}.evidence.${evidenceIndex} is invalid`);
      }
      const start = integer(
        entry.start,
        `candidates.${candidateIndex}.evidence.${evidenceIndex}.start`,
        0,
        points.length,
      );
      const end = integer(
        entry.end,
        `candidates.${candidateIndex}.evidence.${evidenceIndex}.end`,
        start + 1,
        points.length,
      );
      const quote = boundedText(
        entry.quote,
        `candidates.${candidateIndex}.evidence.${evidenceIndex}.quote`,
        10_000,
        { trim: false, allowNewlines: true },
      );
      if (points.slice(start, end).join("") !== quote) {
        invalid("candidate evidence quote does not match the exact source text");
      }
      return Object.freeze({
        polarity: entry.polarity,
        quote,
        start,
        end,
        sourceReference: exactSourceReference(entry.sourceReference, source),
      });
    });
    if (
      candidate.uncertainty.status !== "uncertain"
      && candidate.uncertainty.status !== "limited"
      && candidate.uncertainty.status !== "none-declared"
    ) {
      invalid(`candidates.${candidateIndex}.uncertainty.status is invalid`);
    }
    if (
      !Array.isArray(candidate.uncertainty.questions)
      || candidate.uncertainty.questions.length > 10
    ) {
      invalid(`candidates.${candidateIndex}.uncertainty.questions is invalid`);
    }
    return Object.freeze({
      claimId,
      interpretation,
      evidence: Object.freeze(evidence),
      uncertainty: Object.freeze({
        status: candidate.uncertainty.status,
        explanation: boundedText(
          candidate.uncertainty.explanation,
          `candidates.${candidateIndex}.uncertainty.explanation`,
          4_000,
          { allowNewlines: true },
        ),
        questions: Object.freeze(candidate.uncertainty.questions.map(
          (question: string, questionIndex: number) => boundedText(
            question,
            `candidates.${candidateIndex}.uncertainty.questions.${questionIndex}`,
            4_000,
            { allowNewlines: true },
          ),
        )),
      }),
      reviewState: "human-review-required" as const,
    });
  });
  return Object.freeze({
    schemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
    humanReviewRequired: true,
    publicationBlocked: true,
    candidates: Object.freeze(candidates),
    missingContext: Object.freeze(input.missingContext.map((item, index) =>
      boundedText(item, `missingContext.${index}`, 4_000, {
        allowNewlines: true,
      }))),
  });
}

function normalizeSource(input: AnalysisSourceVersionInput) {
  const target = scope(input);
  const sourceId = identifier(input.sourceId, "sourceId");
  if (sourceId !== ANALYSIS_DEMO_SCOPE.sourceId) invalid("sourceId is invalid");
  const versionId = uuid(input.versionId, "versionId");
  if (typeof input.exactText !== "string" || input.exactText.includes("\u0000")) {
    invalid("exactText is invalid");
  }
  const points = Array.from(input.exactText);
  const codePointCount = integer(input.codePointCount, "codePointCount", 1, 200_000);
  if (points.length !== codePointCount) invalid("codePointCount is invalid");
  const exactTextDigest = digest(input.exactTextDigest, "exactTextDigest");
  if (sha256(input.exactText) !== exactTextDigest) invalid("exactTextDigest is invalid");
  const parserReference = reference(input.parserReference, "parserReference");
  if (input.extractionStatus !== "complete" && input.extractionStatus !== "partial") {
    invalid("extractionStatus is invalid");
  }
  const declaredByteLength = integer(
    input.declaredByteLength,
    "declaredByteLength",
    1,
    10_000_000,
  );
  const declaredPageCount = integer(
    input.declaredPageCount,
    "declaredPageCount",
    1,
    50,
  );
  const extractedPageCount = integer(
    input.extractedPageCount,
    "extractedPageCount",
    1,
    declaredPageCount,
  );
  if (
    input.extractionStatus === "complete"
    && extractedPageCount !== declaredPageCount
  ) {
    invalid("complete source coverage is invalid");
  }
  const recordedAt = instant(input.recordedAt, "recordedAt");
  const attestedAt = instant(input.provenance.attestedAt, "attestedAt");
  if (
    input.provenance.origin !== "other"
    || input.provenance.suppliedBy !== "authenticated-provider"
    || input.provenance.contentAttestation !== "synthetic-or-permitted"
    || attestedAt.getTime() !== recordedAt.getTime()
  ) {
    invalid("source provenance is invalid");
  }
  if (
    input.permissions.studioSharing !== "permitted"
    || (
      input.permissions.modelProcessing === "denied"
      && (
        input.permissions.modelInputReview !== "not-reviewed"
        || input.permissions.reviewedBySubjectDigest !== null
        || input.permissions.reviewedAt !== null
      )
    )
    || (
      input.permissions.modelProcessing === "permitted"
      && (
        input.permissions.modelInputReview !== "cleared"
        || input.permissions.reviewedBySubjectDigest === null
        || input.permissions.reviewedAt === null
      )
    )
  ) {
    invalid("source permissions are invalid");
  }
  const reviewedBySubjectDigest = input.permissions.reviewedBySubjectDigest === null
    ? null
    : digest(
      input.permissions.reviewedBySubjectDigest,
      "reviewedBySubjectDigest",
    );
  const reviewedAt = input.permissions.reviewedAt === null
    ? null
    : instant(input.permissions.reviewedAt, "reviewedAt");
  if (reviewedAt && reviewedAt.getTime() !== recordedAt.getTime()) {
    invalid("reviewedAt is invalid");
  }
  if (
    !Array.isArray(input.coverage)
    || input.coverage.length !== declaredPageCount
  ) {
    invalid("source coverage is invalid");
  }
  let priorEnd = 0;
  let extracted = 0;
  const coverage = input.coverage.map((entry, index) => {
    const pageNumber = integer(entry.pageNumber, "coverage.pageNumber", 1, 50);
    if (pageNumber !== index + 1) invalid("source coverage pages are invalid");
    if (entry.status === "unavailable") {
      if (entry.reasonCode !== "parser-reported-unavailable") {
        invalid("source coverage reason is invalid");
      }
      return Object.freeze({
        pageNumber,
        status: "unavailable" as const,
        start: null,
        end: null,
        reasonCode: "parser-reported-unavailable" as const,
      });
    }
    if (entry.status !== "extracted") invalid("source coverage status is invalid");
    const start = integer(entry.start, "coverage.start", 0, codePointCount);
    const end = integer(entry.end, "coverage.end", start + 1, codePointCount);
    if (start !== priorEnd) invalid("source coverage ranges are invalid");
    priorEnd = end;
    extracted += 1;
    return Object.freeze({
      pageNumber,
      status: "extracted" as const,
      start,
      end,
      reasonCode: null,
    });
  });
  if (extracted !== extractedPageCount || priorEnd !== codePointCount) {
    invalid("source coverage does not match exact text");
  }
  const normalized = {
    ...target,
    sourceId,
    versionId,
    exactText: input.exactText,
    exactTextDigest,
    parserReference,
    extractionStatus: input.extractionStatus,
    declaredByteLength,
    declaredPageCount,
    extractedPageCount,
    codePointCount,
    recordedAt,
    attestedAt,
    modelProcessing: input.permissions.modelProcessing,
    modelInputReview: input.permissions.modelInputReview,
    reviewedBySubjectDigest,
    reviewedAt,
    coverage: Object.freeze(coverage),
  } as const;
  return Object.freeze({
    ...normalized,
    recordDigest: sha256(canonicalJson({
      ...normalized,
      recordedAt: recordedAt.toISOString(),
      attestedAt: attestedAt.toISOString(),
      reviewedAt: reviewedAt?.toISOString() ?? null,
    })),
  });
}

function normalizeRun(input: AnalysisRunInput, source: ReturnType<typeof normalizeSource>) {
  const target = scope(input);
  const runId = uuid(input.runId, "runId");
  const requestedBySubjectDigest = digest(
    input.requestedBySubjectDigest,
    "requestedBySubjectDigest",
  );
  const sourceId = identifier(input.sourceId, "sourceId");
  const sourceVersionId = uuid(input.sourceVersionId, "sourceVersionId");
  if (
    sourceId !== source.sourceId
    || sourceVersionId !== source.versionId
    || target.workspaceId !== source.workspaceId
    || target.projectId !== source.projectId
  ) {
    invalid("run source basis is invalid");
  }
  if (
    input.candidateSchemaReference !== ANALYSIS_CANDIDATE_SCHEMA_REFERENCE
    || (
      input.providerReference !== "manual"
      && input.providerReference !== "google-gemini"
    )
    || (
      input.configReference !== "scopeledger.analysis.manual.v1"
      && input.configReference !== "scopeledger.gemini.server-config.v1"
    )
  ) {
    invalid("run references are invalid");
  }
  const modelReference = input.modelReference === null
    ? null
    : reference(input.modelReference, "modelReference");
  const createdAt = instant(input.createdAt, "createdAt");
  if (createdAt.getTime() !== source.recordedAt.getTime()) {
    invalid("run createdAt is invalid");
  }
  let candidatePayload: AnalysisCandidatePayload | null = null;
  let candidateDigest: string | null = null;
  let failureDiagnostic: {
    code: AnalysisModelFailureCode;
    message: string;
  } | null = null;
  if (input.status === "manual-review-ready") {
    if (
      input.providerReference !== "manual"
      || modelReference !== null
      || input.configReference !== "scopeledger.analysis.manual.v1"
      || input.candidatePayload !== null
      || input.failureDiagnostic !== null
    ) {
      invalid("manual run state is invalid");
    }
  } else if (input.status === "candidate-ready") {
    if (
      input.providerReference !== "google-gemini"
      || modelReference === null
      || input.configReference !== "scopeledger.gemini.server-config.v1"
      || input.candidatePayload === null
      || input.failureDiagnostic !== null
    ) {
      invalid("candidate run state is invalid");
    }
    candidatePayload = normalizeCandidatePayload(
      input.candidatePayload,
      {
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        sourceId,
        versionId: sourceVersionId,
      },
      source.exactText,
    );
    candidateDigest = sha256(canonicalJson(candidatePayload));
  } else if (input.status === "model-failed") {
    if (
      input.providerReference !== "google-gemini"
      || input.configReference !== "scopeledger.gemini.server-config.v1"
      || input.candidatePayload !== null
      || input.failureDiagnostic === null
      || !Object.hasOwn(safeFailureMessages, input.failureDiagnostic.code)
      || safeFailureMessages[input.failureDiagnostic.code]
        !== input.failureDiagnostic.message
    ) {
      invalid("failed run state is invalid");
    }
    failureDiagnostic = {
      code: input.failureDiagnostic.code,
      message: input.failureDiagnostic.message,
    };
  } else {
    invalid("run status is invalid");
  }
  const normalized = {
    ...target,
    runId,
    requestedBySubjectDigest,
    sourceId,
    sourceVersionId,
    providerReference: input.providerReference,
    modelReference,
    candidateSchemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
    configReference: input.configReference,
    status: input.status,
    candidatePayload,
    candidateDigest,
    failureDiagnostic,
    humanReviewRequired: true as const,
    publicationBlocked: true as const,
    createdAt,
  };
  return Object.freeze({
    ...normalized,
    runDigest: sha256(canonicalJson({
      ...normalized,
      createdAt: createdAt.toISOString(),
    })),
  });
}

function runRecord(row: RunRow): AnalysisRunRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    runId: row.run_id,
    requestedBySubjectDigest: row.requested_by_subject_digest,
    sourceReference: Object.freeze({
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      sourceId: row.source_id,
      versionId: row.source_version_id,
    }),
    sourceDigest: row.exact_text_digest,
    parserReference: row.parser_reference,
    providerReference: row.provider_reference,
    modelReference: row.model_reference,
    candidateSchemaReference: row.candidate_schema_reference,
    configReference: row.config_reference,
    status: row.status,
    candidatePayload: row.candidate_payload,
    candidateDigest: row.candidate_digest,
    failureDiagnostic: row.failure_code && row.failure_message
      ? Object.freeze({
        code: row.failure_code,
        message: row.failure_message,
      })
      : null,
    humanReviewRequired: true,
    publicationBlocked: true,
    runDigest: row.run_digest,
    createdAt: instant(row.created_at, "createdAt"),
  });
}

function reviewRecord(row: ReviewRow): AnalysisHumanReviewRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    reviewId: row.review_id,
    runId: row.run_id,
    reviewerSubjectDigest: row.reviewer_subject_digest,
    reviewedAt: instant(row.reviewed_at, "reviewedAt"),
    disposition: row.disposition,
    note: row.note,
    runBasisDigest: row.run_basis_digest,
    candidateBasisDigest: row.candidate_basis_digest,
  });
}

const runSelect = sql<RunRow>`select
  r.workspace_id,r.project_id,r.run_id::text,r.requested_by_subject_digest,
  r.source_id,r.source_version_id::text,s.exact_text_digest,s.parser_reference,
  r.provider_reference,r.model_reference,r.candidate_schema_reference,
  r.config_reference,r.status,r.candidate_payload,r.candidate_digest,
  r.failure_code,r.failure_message,r.human_review_required,
  r.publication_blocked,r.run_digest,r.created_at
from analysis_runs r
join analysis_source_versions s
  on s.workspace_id = r.workspace_id
  and s.project_id = r.project_id
  and s.source_id = r.source_id
  and s.version_id = r.source_version_id`;

export class PostgresAnalysisStore {
  private readonly clock: () => Date;

  constructor(
    private readonly database: ProtocolDatabase,
    options: { clock?: () => Date } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  async saveRun(input: Readonly<{
    source: AnalysisSourceVersionInput;
    run: AnalysisRunInput;
  }>): Promise<Readonly<{ duplicate: boolean; run: AnalysisRunRecord }>> {
    const source = normalizeSource(input.source);
    const run = normalizeRun(input.run, source);
    return this.database.transaction(async (transaction) => {
      const insertedSource = await sql<{ record_digest: string }>`insert into analysis_source_versions(
          workspace_id,project_id,source_id,version_id,exact_text,exact_text_digest,
          parser_reference,extraction_status,declared_byte_length,declared_page_count,
          extracted_page_count,code_point_count,record_digest,recorded_at
        ) values (
          ${source.workspaceId},${source.projectId},${source.sourceId},${source.versionId}::uuid,
          ${source.exactText},${source.exactTextDigest},${source.parserReference},
          ${source.extractionStatus},${source.declaredByteLength},${source.declaredPageCount},
          ${source.extractedPageCount},${source.codePointCount},${source.recordDigest},
          ${source.recordedAt}
        )
        on conflict do nothing
        returning record_digest`.execute(transaction);
      if (insertedSource.rows.length) {
        await sql`insert into analysis_source_provenance(
            workspace_id,project_id,source_id,version_id,origin,supplied_by,
            content_attestation,attested_at
          ) values (
            ${source.workspaceId},${source.projectId},${source.sourceId},
            ${source.versionId}::uuid,'other','authenticated-provider',
            'synthetic-or-permitted',${source.attestedAt}
          )`.execute(transaction);
        await sql`insert into analysis_source_permissions(
            workspace_id,project_id,source_id,version_id,studio_sharing,
            model_processing,model_input_review,reviewed_by_subject_digest,reviewed_at
          ) values (
            ${source.workspaceId},${source.projectId},${source.sourceId},
            ${source.versionId}::uuid,'permitted',${source.modelProcessing},
            ${source.modelInputReview},${source.reviewedBySubjectDigest},${source.reviewedAt}
          )`.execute(transaction);
        for (const entry of source.coverage) {
          await sql`insert into analysis_source_coverage(
              workspace_id,project_id,source_id,version_id,page_number,status,
              start_offset,end_offset,reason_code
            ) values (
              ${source.workspaceId},${source.projectId},${source.sourceId},
              ${source.versionId}::uuid,${entry.pageNumber},${entry.status},
              ${entry.start},${entry.end},${entry.reasonCode}
            )`.execute(transaction);
        }
      } else {
        const existing = (await sql<{ record_digest: string }>`select record_digest
          from analysis_source_versions
          where workspace_id = ${source.workspaceId}
            and project_id = ${source.projectId}
            and source_id = ${source.sourceId}
            and version_id = ${source.versionId}::uuid
        `.execute(transaction)).rows[0];
        if (!existing || existing.record_digest !== source.recordDigest) {
          throw new AnalysisPersistenceError(
            "SOURCE_CONFLICT",
            "The immutable source version already has different content",
          );
        }
      }

      const candidateJson = run.candidatePayload
        ? canonicalJson(run.candidatePayload)
        : null;
      const insertedRun = await sql<RunRow>`insert into analysis_runs(
          workspace_id,project_id,run_id,requested_by_subject_digest,
          source_id,source_version_id,provider_reference,model_reference,
          candidate_schema_reference,config_reference,status,candidate_payload,
          candidate_digest,failure_code,failure_message,human_review_required,
          publication_blocked,run_digest,created_at
        ) values (
          ${run.workspaceId},${run.projectId},${run.runId}::uuid,
          ${run.requestedBySubjectDigest},${run.sourceId},${run.sourceVersionId}::uuid,
          ${run.providerReference},${run.modelReference},${run.candidateSchemaReference},
          ${run.configReference},${run.status},${candidateJson}::jsonb,
          ${run.candidateDigest},${run.failureDiagnostic?.code ?? null},
          ${run.failureDiagnostic?.message ?? null},true,true,${run.runDigest},
          ${run.createdAt}
        )
        on conflict do nothing
        returning workspace_id,project_id,run_id::text,requested_by_subject_digest,
          source_id,source_version_id::text,
          (select exact_text_digest from analysis_source_versions s
            where s.workspace_id = analysis_runs.workspace_id
              and s.project_id = analysis_runs.project_id
              and s.source_id = analysis_runs.source_id
              and s.version_id = analysis_runs.source_version_id) as exact_text_digest,
          (select parser_reference from analysis_source_versions s
            where s.workspace_id = analysis_runs.workspace_id
              and s.project_id = analysis_runs.project_id
              and s.source_id = analysis_runs.source_id
              and s.version_id = analysis_runs.source_version_id) as parser_reference,
          provider_reference,model_reference,candidate_schema_reference,
          config_reference,status,candidate_payload,candidate_digest,failure_code,
          failure_message,human_review_required,publication_blocked,run_digest,created_at
      `.execute(transaction);
      if (insertedRun.rows[0]) {
        return Object.freeze({
          duplicate: false,
          run: runRecord(insertedRun.rows[0]),
        });
      }
      const existing = await this.readRunRow(transaction, {
        workspaceId: run.workspaceId,
        projectId: run.projectId,
      }, run.runId);
      if (!existing || existing.run_digest !== run.runDigest) {
        throw new AnalysisPersistenceError(
          "RUN_CONFLICT",
          "The immutable analysis run already has different content",
        );
      }
      return Object.freeze({ duplicate: true, run: runRecord(existing) });
    });
  }

  async readRun(input: Scope & { runId: string }): Promise<AnalysisRunRecord | null> {
    const target = scope(input);
    const runId = uuid(input.runId, "runId");
    const row = await this.readRunRow(this.database.kysely, target, runId);
    return row ? runRecord(row) : null;
  }

  async listRuns(input: Scope & {
    requestedBySubjectDigest: string;
    limit?: number;
  }): Promise<readonly AnalysisRunRecord[]> {
    const target = scope(input);
    const requestedBySubjectDigest = digest(
      input.requestedBySubjectDigest,
      "requestedBySubjectDigest",
    );
    const limit = integer(input.limit ?? 20, "limit", 1, 50);
    const rows = await sql<RunRow>`${runSelect}
      where r.workspace_id = ${target.workspaceId}
        and r.project_id = ${target.projectId}
        and r.requested_by_subject_digest = ${requestedBySubjectDigest}
      order by r.created_at desc,r.run_id desc
      limit ${limit}`.execute(this.database.kysely);
    return Object.freeze(rows.rows.map(runRecord));
  }

  async appendReview(input: Scope & {
    reviewId: string;
    runId: string;
    reviewerSubjectDigest: string;
    disposition: AnalysisReviewDisposition;
    note: string;
  }): Promise<Readonly<{
    duplicate: boolean;
    review: AnalysisHumanReviewRecord;
  }>> {
    const target = scope(input);
    const reviewId = uuid(input.reviewId, "reviewId");
    const runId = uuid(input.runId, "runId");
    const reviewerSubjectDigest = digest(
      input.reviewerSubjectDigest,
      "reviewerSubjectDigest",
    );
    if (
      input.disposition !== "accept"
      && input.disposition !== "edit"
      && input.disposition !== "reject"
      && input.disposition !== "manual"
    ) {
      invalid("disposition is invalid");
    }
    const note = boundedText(input.note, "note", 2_000, {
      allowNewlines: true,
    });
    const reviewedAt = instant(this.clock(), "reviewedAt");
    return this.database.transaction(async (transaction) => {
      const run = await this.readRunRow(transaction, target, runId, true);
      if (!run) {
        throw new AnalysisPersistenceError("NOT_FOUND", "Analysis run was not found");
      }
      if (run.requested_by_subject_digest !== reviewerSubjectDigest) {
        throw new AnalysisPersistenceError(
          "REVIEW_FORBIDDEN",
          "The provider may review only their own analysis run",
        );
      }
      const inserted = await sql<ReviewRow>`insert into analysis_human_reviews(
          workspace_id,project_id,review_id,run_id,reviewer_subject_digest,
          reviewed_at,disposition,note,run_basis_digest,candidate_basis_digest
        ) values (
          ${target.workspaceId},${target.projectId},${reviewId}::uuid,
          ${runId}::uuid,${reviewerSubjectDigest},${reviewedAt},
          ${input.disposition},${note},${run.run_digest},${run.candidate_digest}
        )
        on conflict do nothing
        returning workspace_id,project_id,review_id::text,run_id::text,
          reviewer_subject_digest,reviewed_at,disposition,note,run_basis_digest,
          candidate_basis_digest`.execute(transaction);
      if (inserted.rows[0]) {
        return Object.freeze({
          duplicate: false,
          review: reviewRecord(inserted.rows[0]),
        });
      }
      const existing = await this.readReviewRow(transaction, target, reviewId);
      if (
        !existing
        || existing.run_id !== runId
        || existing.reviewer_subject_digest !== reviewerSubjectDigest
        || existing.disposition !== input.disposition
        || existing.note !== note
        || existing.run_basis_digest !== run.run_digest
        || existing.candidate_basis_digest !== run.candidate_digest
      ) {
        throw new AnalysisPersistenceError(
          "REVIEW_CONFLICT",
          "The immutable review ID already has different content",
        );
      }
      return Object.freeze({
        duplicate: true,
        review: reviewRecord(existing),
      });
    });
  }

  async readReviews(input: Scope & {
    runId: string;
  }): Promise<readonly AnalysisHumanReviewRecord[]> {
    const target = scope(input);
    const runId = uuid(input.runId, "runId");
    const rows = await sql<ReviewRow>`select workspace_id,project_id,
        review_id::text,run_id::text,reviewer_subject_digest,reviewed_at,
        disposition,note,run_basis_digest,candidate_basis_digest
      from analysis_human_reviews
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and run_id = ${runId}::uuid
      order by reviewed_at,review_id`.execute(this.database.kysely);
    return Object.freeze(rows.rows.map(reviewRecord));
  }

  private async readRunRow(
    executor: ProtocolDatabase["kysely"] | ProtocolTransaction,
    target: Scope,
    runId: string,
    lock = false,
  ): Promise<RunRow | undefined> {
    return (await sql<RunRow>`${runSelect}
      where r.workspace_id = ${target.workspaceId}
        and r.project_id = ${target.projectId}
        and r.run_id = ${runId}::uuid
      ${lock ? sql`for share of r` : sql``}`.execute(executor)).rows[0];
  }

  private async readReviewRow(
    executor: ProtocolDatabase["kysely"] | ProtocolTransaction,
    target: Scope,
    reviewId: string,
  ): Promise<ReviewRow | undefined> {
    return (await sql<ReviewRow>`select workspace_id,project_id,
        review_id::text,run_id::text,reviewer_subject_digest,reviewed_at,
        disposition,note,run_basis_digest,candidate_basis_digest
      from analysis_human_reviews
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and review_id = ${reviewId}::uuid`.execute(executor)).rows[0];
  }
}
