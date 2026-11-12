import { createHash } from "node:crypto";
import { z } from "zod";

export const AUTOMATED_LIMITS = Object.freeze({
  pdfBytesPerFile: 10_000_000,
  pdfPagesPerFile: 50,
  pdfPagesPerRun: 100,
  codePointsPerRun: 200_000,
  codePointsPerRequest: 10_000,
});

export function codePointLength(text: string): number {
  let length = 0;
  for (const _point of text) length += 1;
  return length;
}

function isUnicodeScalarText(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function extractedTextSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const unicodeText = z.string().refine(isUnicodeScalarText);
const boundedText = (limit: number) =>
  unicodeText.refine((value) => codePointLength(value) <= limit);
const explanation = boundedText(2_000).refine((value) => value.trim().length > 0);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime();
const knownDate = z.iso.date().nullable();

export const SourceReferenceSchema = z.strictObject({
  workspaceId: identifier,
  projectId: identifier,
  sourceId: identifier,
  versionId: identifier,
});

const pageRange = z.strictObject({
  pageNumber: integer.min(1),
  start: integer,
  end: integer,
});

const unavailablePage = z.strictObject({
  pageNumber: integer.min(1),
  reason: explanation,
});

const declaredDocument = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal("pdf"),
    declaredByteLength: integer.min(1),
    declaredPageCount: integer.min(1),
    pages: z.array(pageRange),
    unavailablePages: z.array(unavailablePage),
  }),
  z.strictObject({
    format: z.enum(["txt", "markdown", "pasted-text", "manual-transcription"]),
  }),
]);

const acceptance = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("provider-attested-import"),
    attestedBy: identifier,
    basis: explanation,
  }),
  z.strictObject({
    kind: z.literal("in-app-record-reference"),
    recordReference: identifier,
    basis: explanation,
  }),
  z.strictObject({
    kind: z.literal("unverified"),
    basis: explanation,
  }),
]);

const modelInputReview = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("cleared"),
    reviewerId: identifier,
    reviewedAt: instant,
    basis: explanation,
  }),
  z.strictObject({
    status: z.enum(["not-reviewed", "unresolved", "prohibited-financial-data"]),
  }),
]);

export const ExtractedSourceInputSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ...SourceReferenceSchema.shape,
  provenance: z.strictObject({
    origin: z.enum([
      "agreement",
      "amendment",
      "correspondence",
      "request",
      "prior-decision",
      "correction",
      "other",
    ]),
    suppliedBy: identifier,
    recordedAt: instant,
    claimedDate: knownDate,
    effectiveDate: knownDate,
    acceptance,
    originReference: boundedText(2_000).nullable(),
    extractorReference: explanation,
  }),
  document: declaredDocument,
  extractedText: unicodeText,
  extraction: z.strictObject({
    status: z.enum(["complete", "partial", "unavailable"]),
    unavailableReason: explanation.nullable(),
  }),
  permissions: z.strictObject({
    studioSharing: z.enum(["permitted", "denied", "unresolved"]),
    modelProcessing: z.enum(["permitted", "denied", "unresolved"]),
    modelInputReview,
  }),
});

export const ExtractedSourceVersionSchema = ExtractedSourceInputSchema.extend({
  extractedTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((source, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "Invalid extracted-source record." });
  if (extractedTextSha256(source.extractedText) !== source.extractedTextSha256) invalid();

  const length = codePointLength(source.extractedText);
  if (source.extraction.status === "complete") {
    if (source.extractedText.trim().length === 0 || source.extraction.unavailableReason !== null) invalid();
  } else {
    if (source.extraction.unavailableReason === null) invalid();
    if (source.extraction.status === "partial" && source.extractedText.trim().length === 0) invalid();
    if (source.extraction.status === "unavailable" && length !== 0) invalid();
  }

  if (source.document.format !== "pdf") return;
  const { declaredPageCount, pages, unavailablePages } = source.document;
  const seen = new Set<number>();
  let end = 0;
  let previousPage = 0;
  for (const page of pages) {
    if (
      page.pageNumber > declaredPageCount ||
      seen.has(page.pageNumber) ||
      page.pageNumber <= previousPage ||
      page.start !== end ||
      page.end <= page.start ||
      page.end > length
    ) invalid();
    seen.add(page.pageNumber);
    end = page.end;
    previousPage = page.pageNumber;
  }
  for (const page of unavailablePages) {
    if (page.pageNumber > declaredPageCount || seen.has(page.pageNumber)) invalid();
    seen.add(page.pageNumber);
  }
  if (seen.size !== declaredPageCount || end !== length) invalid();
  if (source.extraction.status === "complete" && unavailablePages.length !== 0) invalid();
  if (source.extraction.status === "partial" && (pages.length === 0 || unavailablePages.length === 0)) invalid();
  if (source.extraction.status === "unavailable" && pages.length !== 0) invalid();
});

export const ExtractedRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: identifier,
  projectId: identifier,
  sources: z.array(ExtractedSourceVersionSchema),
  request: z.strictObject({
    kind: z.enum(["request", "correction"]),
    text: unicodeText.refine((value) => value.trim().length > 0),
  }),
});

export const SourcePointerSchema = z.strictObject({
  source: SourceReferenceSchema,
  start: integer,
  end: integer,
  quote: boundedText(10_000).refine((value) => value.length > 0),
  polarity: z.enum(["supporting", "charge-weakening"]),
});

const claim = z.strictObject({
  claimId: identifier,
  interpretation: boundedText(4_000).refine((value) => value.trim().length > 0),
  supportingEvidence: z.array(SourcePointerSchema).max(20),
  chargeWeakeningEvidence: z.array(SourcePointerSchema).max(20),
  uncertainty: z.strictObject({
    status: z.enum(["uncertain", "limited", "none-declared"]),
    explanation,
    questions: z.array(explanation).max(10),
  }),
}).superRefine((value, context) => {
  if (
    value.supportingEvidence.length + value.chargeWeakeningEvidence.length === 0 ||
    value.supportingEvidence.some((pointer) => pointer.polarity !== "supporting") ||
    value.chargeWeakeningEvidence.some((pointer) => pointer.polarity !== "charge-weakening")
  ) context.addIssue({ code: "custom", message: "Invalid claim evidence." });
});

export const CandidateClaimsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: identifier,
  projectId: identifier,
  claims: z.array(claim).min(1).max(40),
  coverage: z.strictObject({
    sources: z.array(SourceReferenceSchema).min(1).max(1_000),
    missingContext: z.array(explanation).max(20),
    counterEvidenceScope: z.literal("admitted-sources-only"),
  }),
});

const review = z.strictObject({
  reviewerId: identifier,
  reviewedAt: instant,
  provenance: z.enum(["provider-reviewed", "human-authored/manual-preparation"]),
  note: explanation,
});

const disposition = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reviewed"),
    representation: z.enum(["evidence-selected", "manual-context-reviewed"]),
    supportingEvidenceReviewed: z.boolean(),
    chargeWeakeningEvidenceReviewed: z.boolean(),
    review,
  }),
  z.strictObject({
    status: z.literal("inapplicable"),
    reason: explanation,
    review,
  }),
  z.strictObject({
    status: z.literal("superseded"),
    by: SourceReferenceSchema,
    reason: explanation,
    review,
  }),
  z.strictObject({
    status: z.literal("unresolved"),
    reason: explanation,
  }),
]);

export const CoverageManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceId: identifier,
  projectId: identifier,
  entries: z.array(z.strictObject({
    source: SourceReferenceSchema,
    materiality: z.enum(["material", "unknown", "non-material"]),
    disposition,
  })),
});

export const SourceInventorySchema = z.strictObject({
  workspaceId: identifier,
  projectId: identifier,
  sources: z.array(ExtractedSourceVersionSchema),
});

export type SourceReference = z.infer<typeof SourceReferenceSchema>;
export type ExtractedSourceInput = z.infer<typeof ExtractedSourceInputSchema>;
export type ExtractedSourceVersion = z.infer<typeof ExtractedSourceVersionSchema>;
export type ExtractedRun = z.infer<typeof ExtractedRunSchema>;
export type SourcePointer = z.infer<typeof SourcePointerSchema>;
export type CandidateClaims = z.infer<typeof CandidateClaimsSchema>;
export type CoverageManifest = z.infer<typeof CoverageManifestSchema>;
export type SourceInventory = z.infer<typeof SourceInventorySchema>;
