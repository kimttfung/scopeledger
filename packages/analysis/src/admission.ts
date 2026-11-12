import {
  AUTOMATED_LIMITS,
  ExtractedRunSchema,
  ExtractedSourceInputSchema,
  ExtractedSourceVersionSchema,
  codePointLength,
  extractedTextSha256,
} from "./schemas.js";
import type { ExtractedRun, ExtractedSourceVersion, SourceInventory, SourceReference } from "./schemas.js";
import { diagnostic, failure, invalidSchema, success } from "./results.js";
import type { AnalysisDiagnostic, DeepReadonly, ValidationResult } from "./results.js";

export interface AutomatedAdmission {
  readonly status: "local-validation-admitted" | "manual-required";
  readonly scope: "declared-extracted-records-only";
  readonly modelDispatch: "not-authorized-by-this-module";
  readonly workspaceId: string;
  readonly projectId: string;
  readonly sources: readonly DeepReadonly<ExtractedSourceVersion>[];
  readonly request: DeepReadonly<ExtractedRun["request"]>;
  readonly totals: {
    readonly pdfPages: number;
    readonly sourceCodePoints: number;
    readonly requestCodePoints: number;
    readonly combinedCodePoints: number;
  };
  readonly diagnostics: readonly AnalysisDiagnostic[];
  readonly manualRoute: "not-needed-for-local-admission" | "complete-attributed-source-manifest-required";
}

export function referenceKey(reference: DeepReadonly<SourceReference>): string {
  return `${reference.workspaceId}/${reference.projectId}/${reference.sourceId}/${reference.versionId}`;
}

export function sourceReference(source: DeepReadonly<SourceReference>): SourceReference {
  return {
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    sourceId: source.sourceId,
    versionId: source.versionId,
  };
}

export function scopeDiagnostics(
  reference: { readonly workspaceId: string; readonly projectId: string },
  scope: { readonly workspaceId: string; readonly projectId: string },
  at: string,
): AnalysisDiagnostic[] {
  const errors: AnalysisDiagnostic[] = [];
  if (reference.workspaceId !== scope.workspaceId) errors.push(diagnostic("WRONG_WORKSPACE", at));
  if (reference.projectId !== scope.projectId) errors.push(diagnostic("WRONG_PROJECT", at));
  return errors;
}

export function inventoryDiagnostics(inventory: SourceInventory): AnalysisDiagnostic[] {
  const errors: AnalysisDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [index, source] of inventory.sources.entries()) {
    const at = `sources.${index}`;
    errors.push(...scopeDiagnostics(source, inventory, at));
    const key = referenceKey(source);
    if (seen.has(key)) errors.push(diagnostic("DUPLICATE_SOURCE_VERSION", at));
    seen.add(key);
  }
  return errors;
}

/** Freezes a copy of already-extracted text; does not inspect a file or attest its authenticity. */
export function sealExtractedSourceVersion(input: unknown): ValidationResult<ExtractedSourceVersion> {
  const parsed = ExtractedSourceInputSchema.safeParse(input);
  if (!parsed.success) return invalidSchema();
  return parseExtractedSourceVersion({
    ...parsed.data,
    extractedTextSha256: extractedTextSha256(parsed.data.extractedText),
  });
}

export function parseExtractedSourceVersion(input: unknown): ValidationResult<ExtractedSourceVersion> {
  const parsed = ExtractedSourceVersionSchema.safeParse(input);
  return parsed.success ? success(parsed.data) : invalidSchema();
}

/** All supplied versions are retained and counted, never trimmed, selected away, or fetched. */
export function evaluateAutomatedAdmission(input: unknown): ValidationResult<AutomatedAdmission> {
  const parsed = ExtractedRunSchema.safeParse(input);
  if (!parsed.success) return invalidSchema();
  const run = parsed.data;
  const inventoryErrors = inventoryDiagnostics(run);
  if (inventoryErrors.length > 0) return failure(inventoryErrors);

  const diagnostics: AnalysisDiagnostic[] = [];
  let pdfPages = 0;
  let sourceCodePoints = 0;
  if (run.sources.length === 0) diagnostics.push(diagnostic("MISSING_SOURCES"));
  for (const [index, source] of run.sources.entries()) {
    const at = `sources.${index}`;
    sourceCodePoints += codePointLength(source.extractedText);
    if (source.document.format === "pdf") {
      pdfPages += source.document.declaredPageCount;
      if (source.document.declaredByteLength > AUTOMATED_LIMITS.pdfBytesPerFile) {
        diagnostics.push(diagnostic("PDF_FILE_BYTES_EXCEEDED", at));
      }
      if (source.document.declaredPageCount > AUTOMATED_LIMITS.pdfPagesPerFile) {
        diagnostics.push(diagnostic("PDF_FILE_PAGES_EXCEEDED", at));
      }
    }
    if (source.extraction.status !== "complete") {
      diagnostics.push(diagnostic("SOURCE_TEXT_UNAVAILABLE", at));
    }
    if (source.permissions.studioSharing !== "permitted") {
      diagnostics.push(diagnostic("STUDIO_SHARING_NOT_PERMITTED", at));
    }
    if (source.permissions.modelProcessing !== "permitted") {
      diagnostics.push(diagnostic("MODEL_PROCESSING_NOT_PERMITTED", at));
    }
    if (source.permissions.modelInputReview.status !== "cleared") {
      diagnostics.push(diagnostic("MODEL_INPUT_NOT_CLEARED", at));
    }
  }

  const requestCodePoints = codePointLength(run.request.text);
  const combinedCodePoints = sourceCodePoints + requestCodePoints;
  if (pdfPages > AUTOMATED_LIMITS.pdfPagesPerRun) diagnostics.push(diagnostic("RUN_PDF_PAGES_EXCEEDED"));
  if (combinedCodePoints > AUTOMATED_LIMITS.codePointsPerRun) diagnostics.push(diagnostic("RUN_CODE_POINTS_EXCEEDED"));
  if (requestCodePoints > AUTOMATED_LIMITS.codePointsPerRequest) diagnostics.push(diagnostic("REQUEST_CODE_POINTS_EXCEEDED"));
  const admitted = diagnostics.length === 0;
  return success({
    status: admitted ? "local-validation-admitted" : "manual-required",
    scope: "declared-extracted-records-only",
    modelDispatch: "not-authorized-by-this-module",
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    sources: run.sources,
    request: run.request,
    totals: { pdfPages, sourceCodePoints, requestCodePoints, combinedCodePoints },
    diagnostics,
    manualRoute: admitted ? "not-needed-for-local-admission" : "complete-attributed-source-manifest-required",
  });
}
