import type {
  AnalysisCandidate,
  AnalysisManualFallback,
  AnalysisModelSummary,
  AnalysisParserSummary,
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
  versionId: "v1",
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
  details: Partial<Pick<Extract<AnalysisResponse, { ok: false }>, "parser" | "model">> = {},
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

function sourceMetadata(geminiPermitted: boolean, now: Date): unknown {
  const recordedAt = now.toISOString();
  return {
    ...FIXED_SOURCE_REFERENCE,
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

function candidateSummary(result: ModelResultLike): AnalysisModelSummary {
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
  model: AnalysisModelSummary;
  code: string;
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
        dependencies.now?.() ?? new Date(),
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

  if (!submission.geminiPermitted) {
    return {
      status: 200,
      body: {
        ok: true,
        code: "ANALYSIS_COMPLETE",
        parser,
        model: {
          status: "not-requested",
          humanReviewRequired: true,
          publicationBlocked: true,
          candidates: [],
          missingContext: [],
        },
        manualFallback,
      },
    };
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
    return {
      status: 200,
      body: {
        ok: true,
        code: "ANALYSIS_COMPLETE",
        parser,
        model: candidateSummary(result),
        manualFallback,
      },
    };
  } catch (error) {
    const modelFailure = failedModel(error);
    return failure(
      modelFailure.status,
      modelFailure.code,
      modelFailure.message,
      { parser, model: modelFailure.model },
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
