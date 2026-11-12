import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  GeminiCandidateClient,
  geminiConfigFromEnvironment,
} from "@scopeledger/gemini-adapter";
import {
  extractPdf,
  sealParsedPdfSource,
} from "@scopeledger/parser-adapter";

async function syntheticPdf() {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const pages = [
    "The reusable case-study layout is included in the original fixed price.",
    "Populating a new case-study page with client-specific content is additional work.",
  ];
  for (const text of pages) {
    const page = document.addPage([612, 792]);
    page.drawText(text, {
      x: 48,
      y: 720,
      size: 12,
      font,
    });
  }
  return document.save();
}

try {
  const parsed = await extractPdf(await syntheticPdf());
  const sealed = sealParsedPdfSource(parsed, {
    workspaceId: "analysis-golden-workspace",
    projectId: "analysis-golden-project",
    sourceId: "synthetic-agreement",
    versionId: "v1",
    provenance: {
      origin: "agreement",
      suppliedBy: "synthetic-provider",
      recordedAt: "2026-11-11T12:00:00Z",
      claimedDate: null,
      effectiveDate: null,
      acceptance: {
        kind: "provider-attested-import",
        attestedBy: "synthetic-provider",
        basis: "Synthetic PDF created solely for the integrated analysis proof.",
      },
      originReference: null,
      extractorReference: "caller-value-overridden",
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: {
        status: "cleared",
        reviewerId: "synthetic-provider",
        reviewedAt: "2026-11-11T12:00:00Z",
        basis: "Synthetic content explicitly cleared for Gemini evaluation.",
      },
    },
  });
  if (!sealed.ok) {
    throw new Error(`Source sealing failed: ${sealed.errors.map((error) => error.code).join(",")}`);
  }
  const run = {
    schemaVersion: 1,
    workspaceId: sealed.value.workspaceId,
    projectId: sealed.value.projectId,
    sources: [sealed.value],
    request: {
      kind: "request",
      text: "Please add one populated case-study page using the existing layout.",
    },
  };
  const client = new GeminiCandidateClient(geminiConfigFromEnvironment());
  const result = await client.generateCandidateClaims(run);
  console.log(JSON.stringify({
    parser: {
      reference: sealed.value.provenance.extractorReference,
      pages: sealed.value.document.format === "pdf"
        ? sealed.value.document.declaredPageCount
        : null,
      extractedCodePoints: Array.from(sealed.value.extractedText).length,
      immutable: Object.isFrozen(sealed.value),
    },
    model: {
      provider: "google-gemini",
      model: result.model,
      authenticated: result.transport === "authenticated-api",
      claims: result.review.claims.length,
      supportingPointers: result.review.claims.reduce(
        (total, claim) => total + claim.supportingEvidence.length,
        0,
      ),
      chargeWeakeningPointers: result.review.claims.reduce(
        (total, claim) => total + claim.chargeWeakeningEvidence.length,
        0,
      ),
      publicationEligibility: result.review.publicationEligibility,
      humanReviewRequired: result.review.claims.every(
        (claim) => claim.reviewState === "human-review-required",
      ),
      usage: result.usage,
    },
    privateRecordsUsed: false,
  }, null, 2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  const message = error instanceof Error ? error.message : "Unknown integrated analysis error";
  console.error(`Integrated analysis failed [${code}]: ${message}`);
  process.exitCode = 1;
}
