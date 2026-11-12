export type DeepReadonly<T> =
  T extends readonly (infer Element)[] ? readonly DeepReadonly<Element>[] :
    T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

const messages = {
  INVALID_SCHEMA: "Input does not match the strict local validation schema.",
  WRONG_WORKSPACE: "A reference belongs to a different workspace.",
  WRONG_PROJECT: "A reference belongs to a different project.",
  DUPLICATE_SOURCE_VERSION: "The source inventory repeats an immutable source version.",
  SOURCE_VERSION_NOT_FOUND: "The exact source version is absent from the supplied inventory.",
  MISSING_SOURCES: "No extracted source versions were supplied.",
  PDF_FILE_BYTES_EXCEEDED: "Declared PDF bytes exceed the per-file automated limit.",
  PDF_FILE_PAGES_EXCEEDED: "Declared PDF pages exceed the per-file automated limit.",
  RUN_PDF_PAGES_EXCEEDED: "Declared PDF pages exceed the aggregate automated limit.",
  RUN_CODE_POINTS_EXCEEDED: "Combined source and request code points exceed the automated limit.",
  REQUEST_CODE_POINTS_EXCEEDED: "Request or correction code points exceed the automated limit.",
  SOURCE_TEXT_UNAVAILABLE: "An applicable source has unavailable or incomplete extracted text.",
  STUDIO_SHARING_NOT_PERMITTED: "Studio sharing is not explicitly permitted.",
  MODEL_PROCESSING_NOT_PERMITTED: "Model processing is not explicitly permitted.",
  MODEL_INPUT_NOT_CLEARED: "The source has not been reviewed as permitted commercial model context.",
  LOCAL_ADMISSION_REQUIRED: "Automated local validation is blocked; use attributed manual review.",
  INVALID_POINTER_RANGE: "The pointer is not a nonempty in-bounds Unicode code-point range.",
  POINTER_QUOTE_MISMATCH: "The quote is not exactly equal to the original extracted span.",
  DUPLICATE_CLAIM: "The candidate repeats a claim identifier.",
  CANDIDATE_COVERAGE_INCOMPLETE: "Candidate coverage does not match every admitted source version.",
  CANDIDATE_CONTEXT_GAP: "The candidate declares missing context that requires human resolution.",
  HUMAN_REVIEW_REQUIRED: "Source pointers are validated, but human commercial review is still required.",
  MANIFEST_COVERAGE_INCOMPLETE: "Every inventory source version must occur exactly once in the manifest.",
  SOURCE_UNRESOLVED: "Material or uncertain source applicability remains unresolved.",
  NONMATERIAL_SOURCE_UNRESOLVED: "A declared nonmaterial source remains explicitly unresolved.",
  EVIDENCE_REVIEW_INCOMPLETE: "Supporting and charge-weakening evidence both require recorded review.",
  INVALID_SUPERSESSION: "Supersession must resolve without cycles to a reviewed source version.",
} as const;

export type DiagnosticCode = keyof typeof messages;

export interface AnalysisDiagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly severity: "blocking" | "notice";
  readonly at: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: DeepReadonly<T> }
  | { readonly ok: false; readonly errors: readonly AnalysisDiagnostic[] };

export function diagnostic(
  code: DiagnosticCode,
  at = "$",
  severity: AnalysisDiagnostic["severity"] = "blocking",
): AnalysisDiagnostic {
  return Object.freeze({ code, message: messages[code], severity, at });
}

export function immutable<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export function success<T>(value: T): ValidationResult<T> {
  return Object.freeze({ ok: true, value: immutable(value) });
}

export function failure<T = never>(errors: readonly AnalysisDiagnostic[]): ValidationResult<T> {
  return Object.freeze({ ok: false, errors: Object.freeze([...errors]) });
}

export function invalidSchema<T = never>(): ValidationResult<T> {
  return failure([diagnostic("INVALID_SCHEMA")]);
}
