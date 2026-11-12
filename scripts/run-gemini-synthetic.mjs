import {
  extractedTextSha256,
} from "@scopeledger/analysis";
import {
  GeminiCandidateClient,
  geminiConfigFromEnvironment,
} from "@scopeledger/gemini-adapter";

const agreementText = [
  "The reusable case-study layout is included in the original fixed price.",
  "Populating a new case-study page with client-specific content is not included.",
].join(" ");

const run = {
  schemaVersion: 1,
  workspaceId: "gemini-synthetic-workspace",
  projectId: "gemini-synthetic-project",
  sources: [{
    schemaVersion: 1,
    workspaceId: "gemini-synthetic-workspace",
    projectId: "gemini-synthetic-project",
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
        basis: "Synthetic fixture prepared only for the Gemini adapter quality check.",
      },
      originReference: null,
      extractorReference: "Synthetic exact-text fixture; no parser or customer document.",
    },
    document: { format: "pasted-text" },
    extractedText: agreementText,
    extractedTextSha256: extractedTextSha256(agreementText),
    extraction: {
      status: "complete",
      unavailableReason: null,
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: {
        status: "cleared",
        reviewerId: "synthetic-provider",
        reviewedAt: "2026-11-11T12:00:00Z",
        basis: "Synthetic content explicitly cleared for this authenticated model check.",
      },
    },
  }],
  request: {
    kind: "request",
    text: "Please add one populated case-study page using the existing layout.",
  },
};

try {
  const config = geminiConfigFromEnvironment();
  const client = new GeminiCandidateClient(config);
  const result = await client.generateCandidateClaims(run);
  console.log(JSON.stringify({
    authenticatedProviderCall: result.transport === "authenticated-api",
    model: result.model,
    claimCount: result.review.claims.length,
    supportingPointerCount: result.review.claims.reduce(
      (total, claim) => total + claim.supportingEvidence.length,
      0,
    ),
    chargeWeakeningPointerCount: result.review.claims.reduce(
      (total, claim) => total + claim.chargeWeakeningEvidence.length,
      0,
    ),
    publicationEligibility: result.review.publicationEligibility,
    diagnostics: result.review.diagnostics.map((diagnostic) => diagnostic.code),
    usage: result.usage,
  }, null, 2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  const message = error instanceof Error ? error.message : "Unknown Gemini synthetic check error";
  const status = error && typeof error === "object" && "status" in error
    ? String(error.status ?? "")
    : "";
  console.error(`Gemini synthetic check failed [${code}${status ? ` HTTP ${status}` : ""}]: ${message}`);
  process.exitCode = 1;
}
