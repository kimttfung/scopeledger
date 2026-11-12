import { createHash, randomUUID } from "node:crypto";
import {
  ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
} from "@scopeledger/db";
import type {
  AnalysisCandidatePayload,
  AnalysisModelFailureCode,
  AnalysisRunInput,
  AnalysisSourceVersionInput,
} from "@scopeledger/db";
import type {
  AnalysisCandidate,
  AnalysisManualFallback,
  AnalysisModelSummary,
  AnalysisParserSummary,
  PersistedAnalysisRun,
  AnalysisResponse,
  AnalysisSourceReference,
} from "../../provider/analysis/types.js";

export const MAX_PDF_BYTES = 10_000_000;
export const MAX_MULTIPART_BYTES = MAX_PDF_BYTES + 256_000;

const FORM_FIELDS = Object.freeze([
  "file",
  "contentAttested",
  "geminiPermitted",
] as const);

const FIXED_SOURCE_REFERENCE = Object.freeze({
  workspaceId: "demo-provider-workspace",
  projectId: "synthetic-pdf-review",
  sourceId: "provider-upload",
});

const manualFallback: AnalysisManualFallback = Object.freeze({
  available: true,
  message: "Use the extracted page references for manual provider review. No candidate can be published from this demo.",
});

export type AnalysisSubmission = Readonly<{
  file: File;
  geminiPermitted: boolean;
}>;

type ParsedPdfLike = Readonly<{
  declaredByteLength: number;
  declaredPageCount: number;
  extractedText: string;
  pages: readonly Readonly<{
    pageNumber: number;
    start: number;
    end: number;
  }>[];
  unavailablePages: readonly Readonly<{
    pageNumber: number;
    reason: string;
  }>[];
  extractorReference: string;
}>;

type SealedSourceLike = Readonly<{
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
  extractedText: string;
  extraction: Readonly<{
    status: "complete" | "partial" | "unavailable";
    unavailableReason: string | null;
  }>;
}>;

type SealResult =
  | Readonly<{ ok: true; value: SealedSourceLike }>
  | Readonly<{ ok: false; errors: readonly unknown[] }>;

type ModelResultLike = Readonly<{
  model?: string;
  review: Readonly<{
    claims: readonly Readonly<{
      claimId: string;
      interpretation: string;
      supportingEvidence: readonly Readonly<{
        source: AnalysisSourceReference;
        start: number;
        end: number;
        quote: string;
        polarity: "supporting" | "charge-weakening";
      }>[];
      chargeWeakeningEvidence: readonly Readonly<{
        source: AnalysisSourceReference;
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
    coverage: Readonly<{
      missingContext: readonly string[];
    }>;
    publicationEligibility: "blocked";
  }>;
}>;

export type AnalysisDependencies = Readonly<{
  extractPdf: (bytes: Uint8Array) => Promise<ParsedPdfLike>;
  sealParsedPdfSource: (
    parsed: ParsedPdfLike,
    metadata: unknown,
  ) => SealResult;
  generateCandidates: (run: unknown) => Promise<ModelResultLike>;
  requestedBySubjectDigest: string;
  persistRun: (input: Readonly<{
    source: AnalysisSourceVersionInput;
    run: AnalysisRunInput;
  }>) => Promise<void>;
  admitAnalysis?: <T>(
    input: Readonly<{ mode: "manual" | "gemini" }>,
    work: (decision: Readonly<{
      modelDispatchAllowed: boolean;
    }>) => Promise<T>,
  ) => Promise<T>;
  newRunId?: () => string;
  modelReference?: () => string | null;
  now?: () => Date;
}>;

export type AnalysisExecution = Readonly<{
  status: number;
  body: AnalysisResponse;
}>;

type FormValue = string | File;

type ValidationFailure = Readonly<{
  ok: false;
  status: number;
  code: string;
  message: string;
}>;

type ValidationSuccess<T> = Readonly<{
  ok: true;
  value: T;
}>;

function failure(
  status: number,
  code: string,
  message: string,
  details: Partial<Pick<
    Extract<AnalysisResponse, { ok: false }>,
    "parser" | "model" | "run"
  >> = {},
): AnalysisExecution {
  return {
    status,
    body: {
      ok: false,
      code,
      message,
      ...details,
      manualFallback,
    },
  };
}

function isFile(value: FormValue): value is File {
  return value instanceof Blob
    && "name" in value
    && typeof value.name === "string";
}

function exactlyOne(formData: FormData, name: string): FormValue | null {
  const values = formData.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

export function validateAnalysisRequestHeaders(
  headers: Headers,
): ValidationFailure | ValidationSuccess<null> {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return {
      ok: false,
      status: 415,
      code: "MULTIPART_REQUIRED",
      message: "Upload one PDF using multipart form data.",
    };
  }
  const rawLength = headers.get("content-length");
  if (!rawLength || !/^[0-9]+$/u.test(rawLength)) {
    return {
      ok: false,
      status: 411,
      code: "CONTENT_LENGTH_REQUIRED",
      message: "A bounded upload length is required.",
    };
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CONTENT_LENGTH",
      message: "The upload length is invalid.",
    };
  }
  if (contentLength > MAX_MULTIPART_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "FILE_TOO_LARGE",
      message: "The PDF must be 10 MB or smaller.",
    };
  }
  return { ok: true, value: null };
}

export function validateAnalysisFormData(
  formData: FormData,
): ValidationFailure | ValidationSuccess<AnalysisSubmission> {
  const allowed = new Set<string>(FORM_FIELDS);
  const names = [...formData.keys()];
  if (names.some((name) => !allowed.has(name))) {
    return {
      ok: false,
      status: 400,
      code: "UNEXPECTED_FORM_FIELD",
      message: "The upload form contains an unsupported field.",
    };
  }

  const fileValue = exactlyOne(formData, "file");
  const attestation = exactlyOne(formData, "contentAttested");
  const geminiPermission = exactlyOne(formData, "geminiPermitted");
  if (
    fileValue === null
    || attestation === null
    || geminiPermission === null
  ) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_UPLOAD_FORM",
      message: "The upload form is incomplete or contains duplicate fields.",
    };
  }
  if (attestation !== "true") {
    return {
      ok: false,
      status: 422,
      code: "CONTENT_ATTESTATION_REQUIRED",
      message: "Confirm that the PDF is synthetic or permitted for this review.",
    };
  }
  if (geminiPermission !== "true" && geminiPermission !== "false") {
    return {
      ok: false,
      status: 400,
      code: "INVALID_GEMINI_PERMISSION",
      message: "Gemini processing permission must be explicit.",
    };
  }
  if (!isFile(fileValue) || fileValue.size === 0) {
    return {
      ok: false,
      status: 422,
      code: "PDF_REQUIRED",
      message: "Choose one non-empty PDF.",
    };
  }
  if (fileValue.size > MAX_PDF_BYTES) {
    return {
      ok: false,
      status: 413,
      code: "FILE_TOO_LARGE",
      message: "The PDF must be 10 MB or smaller.",
    };
  }
  const type = fileValue.type.toLowerCase();
  const hasPdfName = fileValue.name.toLowerCase().endsWith(".pdf");
  if (
    type !== "application/pdf"
    && type !== "application/x-pdf"
    && !(type === "" && hasPdfName)
  ) {
    return {
      ok: false,
      status: 415,
      code: "PDF_REQUIRED",
      message: "The selected file must be a PDF.",
    };
  }
  return {
    ok: true,
    value: {
      file: fileValue,
      geminiPermitted: geminiPermission === "true",
    },
  };
}

function sourceMetadata(
  geminiPermitted: boolean,
  now: Date,
  versionId: string,
): unknown {
  const recordedAt = now.toISOString();
  return {
    ...FIXED_SOURCE_REFERENCE,
    versionId,
    provenance: {
      origin: "other",
      suppliedBy: "authenticated-provider",
      recordedAt,
      claimedDate: null,
      effectiveDate: null,
      acceptance: {
        kind: "provider-attested-import",
        attestedBy: "authenticated-provider",
        basis: "Authenticated provider attested that this demo PDF is synthetic or permitted for review.",
      },
      originReference: null,
      extractorReference: "replaced-by-parser-adapter",
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: geminiPermitted ? "permitted" : "denied",
      modelInputReview: geminiPermitted
        ? {
          status: "cleared",
          reviewerId: "authenticated-provider",
          reviewedAt: recordedAt,
          basis: "Authenticated provider separately permitted this attested demo PDF for Gemini candidate processing.",
        }
        : { status: "not-reviewed" },
    },
  };
}

function parserSummary(
  parsed: ParsedPdfLike,
  source: SealedSourceLike,
): AnalysisParserSummary {
  return {
    extractionStatus: source.extraction.status === "complete"
      ? "complete"
      : "partial",
    declaredPageCount: parsed.declaredPageCount,
    extractedPageCount: parsed.pages.length,
    unavailablePageNumbers: parsed.unavailablePages.map((page) => page.pageNumber),
    codePointCount: Array.from(parsed.extractedText).length,
    extractorReference: parsed.extractorReference,
    sourceReference: {
      workspaceId: source.workspaceId,
      projectId: source.projectId,
      sourceId: source.sourceId,
      versionId: source.versionId,
    },
    pages: parsed.pages.map((page) => ({
      pageNumber: page.pageNumber,
      start: page.start,
      end: page.end,
    })),
  };
}

function candidateSummary(result: ModelResultLike): Extract<
  AnalysisModelSummary,
  { status: "completed" }
> {
  const candidates: AnalysisCandidate[] = result.review.claims.map((claim) => ({
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
  }));
  return {
    status: "completed",
    humanReviewRequired: true,
    publicationBlocked: true,
    candidates,
    missingContext: result.review.coverage.missingContext,
  };
}

function sourceDigest(exactText: string): string {
  return createHash("sha256").update(exactText, "utf8").digest("hex");
}

function candidatePayload(model: Extract<
  AnalysisModelSummary,
  { status: "completed" }
>): AnalysisCandidatePayload {
  return {
    schemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
    humanReviewRequired: true,
    publicationBlocked: true,
    candidates: model.candidates,
    missingContext: model.missingContext,
  };
}

function persistenceInput(
  submission: AnalysisSubmission,
  dependencies: AnalysisDependencies,
  runId: string,
  recordedAt: Date,
  parsed: ParsedPdfLike,
  parser: AnalysisParserSummary,
  run: Readonly<{
    status: PersistedAnalysisRun["status"];
    providerReference: PersistedAnalysisRun["providerReference"];
    modelReference: string | null;
    candidatePayload: AnalysisCandidatePayload | null;
    failureDiagnostic: AnalysisRunInput["failureDiagnostic"];
  }>,
): Readonly<{
  source: AnalysisSourceVersionInput;
  run: AnalysisRunInput;
}> {
  const unavailable = new Set(
    parsed.unavailablePages.map((page) => page.pageNumber),
  );
  const extractedByPage = new Map(
    parsed.pages.map((page) => [page.pageNumber, page] as const),
  );
  const coverage: AnalysisSourceVersionInput["coverage"] = Array.from(
    { length: parsed.declaredPageCount },
    (_, index) => {
      const pageNumber = index + 1;
      const extracted = extractedByPage.get(pageNumber);
      if (extracted) {
        return {
          pageNumber,
          status: "extracted" as const,
          start: extracted.start,
          end: extracted.end,
        };
      }
      if (!unavailable.has(pageNumber)) {
        throw new Error("INCOMPLETE_PARSER_COVERAGE");
      }
      return {
        pageNumber,
        status: "unavailable" as const,
        reasonCode: "parser-reported-unavailable" as const,
      };
    },
  );
  const exactTextDigest = sourceDigest(parsed.extractedText);
  const recordedAtIso = recordedAt.toISOString();
  return {
    source: {
      ...FIXED_SOURCE_REFERENCE,
      versionId: runId,
      exactText: parsed.extractedText,
      exactTextDigest,
      parserReference: parsed.extractorReference,
      extractionStatus: parser.extractionStatus,
      declaredByteLength: parsed.declaredByteLength,
      declaredPageCount: parsed.declaredPageCount,
      extractedPageCount: parsed.pages.length,
      codePointCount: parser.codePointCount,
      recordedAt,
      provenance: {
        origin: "other",
        suppliedBy: "authenticated-provider",
        contentAttestation: "synthetic-or-permitted",
        attestedAt: recordedAt,
      },
      permissions: submission.geminiPermitted
        ? {
          studioSharing: "permitted",
          modelProcessing: "permitted",
          modelInputReview: "cleared",
          reviewedBySubjectDigest: dependencies.requestedBySubjectDigest,
          reviewedAt: recordedAt,
        }
        : {
          studioSharing: "permitted",
          modelProcessing: "denied",
          modelInputReview: "not-reviewed",
          reviewedBySubjectDigest: null,
          reviewedAt: null,
        },
      coverage,
    },
    run: {
      ...FIXED_SOURCE_REFERENCE,
      runId,
      requestedBySubjectDigest: dependencies.requestedBySubjectDigest,
      sourceVersionId: runId,
      providerReference: run.providerReference,
      modelReference: run.modelReference,
      candidateSchemaReference: ANALYSIS_CANDIDATE_SCHEMA_REFERENCE,
      configReference: run.providerReference === "manual"
        ? "scopeledger.analysis.manual.v1"
        : "scopeledger.gemini.server-config.v1",
      status: run.status,
      candidatePayload: run.candidatePayload,
      failureDiagnostic: run.failureDiagnostic,
      createdAt: recordedAtIso,
    },
  };
}

function persistedRun(
  runId: string,
  recordedAt: Date,
  exactTextDigest: string,
  status: PersistedAnalysisRun["status"],
  providerReference: PersistedAnalysisRun["providerReference"],
  modelReference: string | null,
): PersistedAnalysisRun {
  return Object.freeze({
    runId,
    status,
    recordedAt: recordedAt.toISOString(),
    sourceDigest: exactTextDigest,
    providerReference,
    modelReference,
    humanReviewRequired: true,
    publicationBlocked: true,
  });
}

function errorCode(error: unknown): string | null {
  return error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

export function parserFailure(error: unknown): AnalysisExecution {
  switch (errorCode(error)) {
    case "INVALID_INPUT":
      return failure(400, "PDF_INVALID", "The PDF upload is empty or invalid.");
    case "FILE_TOO_LARGE":
      return failure(413, "FILE_TOO_LARGE", "The PDF must be 10 MB or smaller.");
    case "TYPE_MISMATCH":
      return failure(415, "PDF_TYPE_MISMATCH", "The file content does not contain a valid PDF signature.");
    case "PAGE_LIMIT_EXCEEDED":
      return failure(422, "PDF_PAGE_LIMIT_EXCEEDED", "The PDF exceeds the 50-page extraction limit.");
    case "PARSER_TIMEOUT":
      return failure(504, "PDF_PARSER_TIMEOUT", "PDF extraction exceeded the bounded processing time.");
    case "PARSER_FAILED":
      return failure(422, "PDF_PARSE_FAILED", "The PDF could not be parsed by the isolated extractor.");
    case "PARSER_OUTPUT_INVALID":
      return failure(502, "PDF_PARSER_OUTPUT_INVALID", "The isolated extractor returned an invalid result.");
    default:
      return failure(503, "PDF_PARSER_UNAVAILABLE", "PDF extraction is temporarily unavailable.");
  }
}

function failedModel(error: unknown): {
  status: number;
  model: Omit<
    Extract<AnalysisModelSummary, { status: "failed" }>,
    "code"
  > & Readonly<{ code: AnalysisModelFailureCode }>;
  code: AnalysisModelFailureCode;
  message: string;
} {
  const code = errorCode(error);
  if (code === "PROCESSING_NOT_PERMITTED") {
    return {
      status: 422,
      code: "MODEL_INPUT_NOT_ADMITTED",
      message: "The extracted source was not admitted for Gemini processing. Manual review remains available.",
      model: {
        status: "failed",
        code: "MODEL_INPUT_NOT_ADMITTED",
        humanReviewRequired: true,
        publicationBlocked: true,
        candidates: [],
        missingContext: [],
      },
    };
  }
  if (code === "INVALID_CONFIG") {
    return {
      status: 503,
      code: "MODEL_CONFIGURATION_UNAVAILABLE",
      message: "Gemini processing is not configured. Manual review remains available.",
      model: {
        status: "failed",
        code: "MODEL_CONFIGURATION_UNAVAILABLE",
        humanReviewRequired: true,
        publicationBlocked: true,
        candidates: [],
        missingContext: [],
      },
    };
  }
  return {
    status: 502,
    code: "MODEL_PROCESSING_FAILED",
    message: "Gemini candidate processing did not complete. Manual review remains available.",
    model: {
      status: "failed",
      code: "MODEL_PROCESSING_FAILED",
      humanReviewRequired: true,
      publicationBlocked: true,
      candidates: [],
      missingContext: [],
    },
  };
}

export async function executeAnalysisUpload(
  submission: AnalysisSubmission,
  dependencies: AnalysisDependencies,
): Promise<AnalysisExecution> {
  const recordedAt = dependencies.now?.() ?? new Date();
  const runId = dependencies.newRunId?.() ?? randomUUID();
  let parsed: ParsedPdfLike;
  try {
    parsed = await dependencies.extractPdf(
      new Uint8Array(await submission.file.arrayBuffer()),
    );
  } catch (error) {
    return parserFailure(error);
  }

  let sealed: SealResult;
  try {
    sealed = dependencies.sealParsedPdfSource(
      parsed,
      sourceMetadata(
        submission.geminiPermitted,
        recordedAt,
        runId,
      ),
    );
  } catch {
    return failure(
      500,
      "SOURCE_SEAL_FAILED",
      "The extracted source could not be sealed for review.",
    );
  }
  if (!sealed.ok) {
    return failure(
      500,
      "SOURCE_SEAL_FAILED",
      "The extracted source could not be sealed for review.",
    );
  }
  const parser = parserSummary(parsed, sealed.value);
  const exactTextDigest = sourceDigest(parsed.extractedText);
  const admitAnalysis = dependencies.admitAnalysis
    ?? (async <T>(
      _input: Readonly<{ mode: "manual" | "gemini" }>,
      work: (decision: Readonly<{
        modelDispatchAllowed: boolean;
      }>) => Promise<T>,
    ): Promise<T> => work({ modelDispatchAllowed: true }));

  try {
    return await admitAnalysis({
      mode: submission.geminiPermitted ? "gemini" : "manual",
    }, async (admission) => {
      if (!submission.geminiPermitted) {
    const model: AnalysisModelSummary = {
      status: "not-requested",
      humanReviewRequired: true,
      publicationBlocked: true,
      candidates: [],
      missingContext: [],
    };
    try {
      await dependencies.persistRun(persistenceInput(
        submission,
        dependencies,
        runId,
        recordedAt,
        parsed,
        parser,
        {
          status: "manual-review-ready",
          providerReference: "manual",
          modelReference: null,
          candidatePayload: null,
          failureDiagnostic: null,
        },
      ));
    } catch {
      return failure(
        503,
        "ANALYSIS_PERSISTENCE_FAILED",
        "Extraction completed, but no durable analysis run was saved. Retry before relying on this result.",
        { parser, model },
      );
    }
    return {
      status: 200,
      body: {
        ok: true,
        code: "ANALYSIS_COMPLETE",
        parser,
        model,
        run: persistedRun(
          runId,
          recordedAt,
          exactTextDigest,
          "manual-review-ready",
          "manual",
          null,
        ),
        manualFallback,
      },
    };
      }

      if (!admission.modelDispatchAllowed) {
        const model: AnalysisModelSummary = {
          status: "failed",
          code: "MODEL_BUDGET_EXHAUSTED",
          humanReviewRequired: true,
          publicationBlocked: true,
          candidates: [],
          missingContext: [],
        };
        try {
          await dependencies.persistRun(persistenceInput(
            submission,
            dependencies,
            runId,
            recordedAt,
            parsed,
            parser,
            {
              status: "manual-review-ready",
              providerReference: "manual",
              modelReference: null,
              candidatePayload: null,
              failureDiagnostic: null,
            },
          ));
        } catch {
          return failure(
            503,
            "ANALYSIS_PERSISTENCE_FAILED",
            "Extraction completed, but the manual fallback could not be saved. Retry before relying on this result.",
            { parser, model },
          );
        }
        return failure(
          429,
          "MODEL_BUDGET_EXHAUSTED",
          "Gemini dispatch is blocked by the configured model-call budget. The parser result was saved for manual provider review.",
          {
            parser,
            model,
            run: persistedRun(
              runId,
              recordedAt,
              exactTextDigest,
              "manual-review-ready",
              "manual",
              null,
            ),
          },
        );
      }

  try {
    const result = await dependencies.generateCandidates({
      schemaVersion: 1,
      workspaceId: FIXED_SOURCE_REFERENCE.workspaceId,
      projectId: FIXED_SOURCE_REFERENCE.projectId,
      sources: [sealed.value],
      request: {
        kind: "request",
        text: "Review this uploaded provider document for candidate scope interpretations.",
      },
    });
    const model = candidateSummary(result);
    const modelReference = result.model
      ?? dependencies.modelReference?.()
      ?? null;
    try {
      await dependencies.persistRun(persistenceInput(
        submission,
        dependencies,
        runId,
        recordedAt,
        parsed,
        parser,
        {
          status: "candidate-ready",
          providerReference: "google-gemini",
          modelReference,
          candidatePayload: candidatePayload(model),
          failureDiagnostic: null,
        },
      ));
    } catch {
      return failure(
        503,
        "ANALYSIS_PERSISTENCE_FAILED",
        "Candidate processing completed, but no durable analysis run was saved. The candidate must not be relied on or published.",
        { parser, model },
      );
    }
    return {
      status: 200,
      body: {
        ok: true,
        code: "ANALYSIS_COMPLETE",
        parser,
        model,
        run: persistedRun(
          runId,
          recordedAt,
          exactTextDigest,
          "candidate-ready",
          "google-gemini",
          modelReference,
        ),
        manualFallback,
      },
    };
  } catch (error) {
    const modelFailure = failedModel(error);
    const modelReference = dependencies.modelReference?.() ?? null;
    try {
      await dependencies.persistRun(persistenceInput(
        submission,
        dependencies,
        runId,
        recordedAt,
        parsed,
        parser,
        {
          status: "model-failed",
          providerReference: "google-gemini",
          modelReference,
          candidatePayload: null,
          failureDiagnostic: {
            code: modelFailure.code,
            message: modelFailure.message,
          },
        },
      ));
    } catch {
      return failure(
        503,
        "ANALYSIS_PERSISTENCE_FAILED",
        "Extraction completed, but the failed model attempt and manual-review basis could not be saved. Retry before relying on this result.",
        { parser, model: modelFailure.model },
      );
    }
    return failure(
      modelFailure.status,
      modelFailure.code,
      modelFailure.message,
      {
        parser,
        model: modelFailure.model,
        run: persistedRun(
          runId,
          recordedAt,
          exactTextDigest,
          "model-failed",
          "google-gemini",
          modelReference,
        ),
      },
    );
      }
    });
  } catch (error) {
    const code = errorCode(error);
    if (code === "ANALYSIS_RUN_LIMIT_REACHED") {
      return failure(
        429,
        code,
        "This provider subject has reached the analysis-run limit for this project.",
      );
    }
    if (code === "EVALUATOR_CONFIGURATION_INVALID") {
      return failure(
        503,
        code,
        "Evaluator limits are not safely configured.",
      );
    }
    return failure(
      503,
      "ANALYSIS_ADMISSION_UNAVAILABLE",
      "Durable analysis admission is unavailable.",
    );
  }
}

export function responseFailure(
  status: number,
  code: string,
  message: string,
): AnalysisExecution {
  return failure(status, code, message);
}
