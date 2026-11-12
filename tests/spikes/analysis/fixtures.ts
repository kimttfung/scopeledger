import assert from "node:assert/strict";
import {
  sealExtractedSourceVersion,
  sourceReference,
} from "@scopeledger/analysis";
import type {
  AnalysisDiagnostic,
  DeepReadonly,
  ExtractedSourceInput,
  ExtractedSourceVersion,
  ValidationResult,
} from "@scopeledger/analysis";

// All records in this suite are synthetic local inputs, never observed model output.
export const reviewedAt = "2026-11-09T09:00:00Z";
export const humanReview = {
  reviewerId: "publisher-1",
  reviewedAt,
  provenance: "human-authored/manual-preparation",
  note: "Synthetic fixture: both evidence directions were reviewed manually.",
} as const;

export function must<T>(result: ValidationResult<T>): DeepReadonly<T> {
  assert.equal(result.ok, true, "Expected a valid local record.");
  if (!result.ok) throw new Error("Expected a valid local record.");
  return result.value;
}

export function errorCodes(result: ValidationResult<unknown>): string[] {
  assert.equal(result.ok, false, "Expected validation to reject this input.");
  if (result.ok) throw new Error("Expected validation to reject this input.");
  return result.errors.map((error) => error.code);
}

export function diagnosticCodes(value: { readonly diagnostics: readonly AnalysisDiagnostic[] }): string[] {
  return value.diagnostics.map((entry) => entry.code);
}

export function sourceInput(overrides: Partial<ExtractedSourceInput> = {}): ExtractedSourceInput {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sourceId: "source-1",
    versionId: "version-1",
    provenance: {
      origin: "agreement",
      suppliedBy: "publisher-1",
      recordedAt: reviewedAt,
      claimedDate: null,
      effectiveDate: null,
      acceptance: {
        kind: "provider-attested-import",
        attestedBy: "publisher-1",
        basis: "Synthetic provider attestation, not in-app consent.",
      },
      originReference: null,
      extractorReference: "Synthetic pre-extracted fixture; no parser executed.",
    },
    document: { format: "pasted-text" },
    extractedText: "Original agreement text.",
    extraction: { status: "complete", unavailableReason: null },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: {
        status: "cleared",
        reviewerId: "publisher-1",
        reviewedAt,
        basis: "Synthetic declared permission for local tests only.",
      },
    },
    ...overrides,
  };
}

export function source(overrides: Partial<ExtractedSourceInput> = {}) {
  return must(sealExtractedSourceVersion(sourceInput(overrides)));
}

export function pdfSource(pages: number, bytes = 100, sourceId = "source-1") {
  return source({
    sourceId,
    extractedText: "x".repeat(pages),
    document: {
      format: "pdf",
      declaredByteLength: bytes,
      declaredPageCount: pages,
      pages: Array.from({ length: pages }, (_, index) => ({
        pageNumber: index + 1,
        start: index,
        end: index + 1,
      })),
      unavailablePages: [],
    },
  });
}

export function partialPdf() {
  return source({
    extractedText: "AB",
    extraction: { status: "partial", unavailableReason: "Page 2 has no readable text." },
    document: {
      format: "pdf",
      declaredByteLength: 100,
      declaredPageCount: 3,
      pages: [
        { pageNumber: 1, start: 0, end: 1 },
        { pageNumber: 3, start: 1, end: 2 },
      ],
      unavailablePages: [{ pageNumber: 2, reason: "Image-only page; no parser/OCR claim." }],
    },
  });
}

export function run(
  sources: readonly DeepReadonly<ExtractedSourceVersion>[] = [source()],
  text = "Please compare this request.",
) {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-1",
    projectId: "project-1",
    sources,
    request: { kind: "request", text },
  } as const;
}

export function pointer(
  record: DeepReadonly<ExtractedSourceVersion>,
  start = 0,
  end = Array.from(record.extractedText).length,
) {
  return {
    source: sourceReference(record),
    start,
    end,
    quote: Array.from(record.extractedText).slice(start, end).join(""),
    polarity: "supporting",
  } as const;
}

export function candidates(records: readonly DeepReadonly<ExtractedSourceVersion>[] = [source()]) {
  const first = records[0];
  assert.ok(first);
  return {
    schemaVersion: 1,
    workspaceId: "workspace-1",
    projectId: "project-1",
    claims: [{
      claimId: "claim-1",
      interpretation: "Synthetic proposed interpretation; no semantic conclusion is certified.",
      supportingEvidence: [pointer(first)],
      chargeWeakeningEvidence: [],
      uncertainty: {
        status: "uncertain",
        explanation: "Human review of commercial meaning is required.",
        questions: [],
      },
    }],
    coverage: {
      sources: records.map(sourceReference),
      missingContext: [],
      counterEvidenceScope: "admitted-sources-only",
    },
  } as const;
}

export function inventory(records: readonly DeepReadonly<ExtractedSourceVersion>[]) {
  return { workspaceId: "workspace-1", projectId: "project-1", sources: records };
}

export function manifest(records: readonly DeepReadonly<ExtractedSourceVersion>[]) {
  return {
    schemaVersion: 1,
    workspaceId: "workspace-1",
    projectId: "project-1",
    entries: records.map((record) => ({
      source: sourceReference(record),
      materiality: "material",
      disposition: {
        status: "reviewed",
        representation: "manual-context-reviewed",
        supportingEvidenceReviewed: true,
        chargeWeakeningEvidenceReviewed: true,
        review: humanReview,
      },
    })),
  } as const;
}
