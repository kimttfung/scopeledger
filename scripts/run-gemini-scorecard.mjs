import {
  extractedTextSha256,
} from "@scopeledger/analysis";
import {
  GeminiCandidateClient,
  geminiConfigFromEnvironment,
} from "@scopeledger/gemini-adapter";

const workspaceId = "gemini-scorecard-workspace";
const projectId = "gemini-scorecard-project";

function source(sourceId, text, origin = "agreement") {
  return {
    schemaVersion: 1,
    workspaceId,
    projectId,
    sourceId,
    versionId: "v1",
    provenance: {
      origin,
      suppliedBy: "synthetic-provider",
      recordedAt: "2026-11-11T12:00:00Z",
      claimedDate: null,
      effectiveDate: null,
      acceptance: {
        kind: "provider-attested-import",
        attestedBy: "synthetic-provider",
        basis: "Synthetic held-out scorecard source.",
      },
      originReference: null,
      extractorReference: "Synthetic exact-text fixture.",
    },
    document: { format: "pasted-text" },
    extractedText: text,
    extractedTextSha256: extractedTextSha256(text),
    extraction: { status: "complete", unavailableReason: null },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "permitted",
      modelInputReview: {
        status: "cleared",
        reviewerId: "synthetic-provider",
        reviewedAt: "2026-11-11T12:00:00Z",
        basis: "Synthetic source cleared for authenticated model evaluation.",
      },
    },
  };
}

const cases = [
  {
    id: "included-work",
    request: "Please make the second design revision.",
    sources: [source(
      "included-agreement",
      "The fixed price includes two complete design revision rounds.",
    )],
    expected: "charge-weakening",
  },
  {
    id: "genuine-addition",
    request: "Please add a pricing page.",
    sources: [source(
      "addition-agreement",
      "The fixed price includes only the home page and contact page. Additional pages require a new agreement.",
    )],
    expected: "supporting",
  },
  {
    id: "missing-context-correction",
    request: "Please add one populated case-study page using the reusable layout.",
    sources: [
      source(
        "correction-agreement",
        "The reusable layout is included. Populating each case-study page with client-specific content is additional.",
      ),
      source(
        "correction-context",
        "The studio previously promised that future reusable case-study layouts would not be charged again.",
        "correction",
      ),
    ],
    expected: "balanced",
  },
  {
    id: "unresolved-ambiguity",
    request: "Please rewrite all copy across the site.",
    sources: [source(
      "ambiguity-agreement",
      "Minor copy edits are included.",
    )],
    expected: "uncertain",
  },
];

function runFor(testCase) {
  return {
    schemaVersion: 1,
    workspaceId,
    projectId,
    sources: testCase.sources,
    request: {
      kind: "request",
      text: testCase.request,
    },
  };
}

function mechanicalExpectation(testCase, result) {
  const supporting = result.review.claims.reduce(
    (total, claim) => total + claim.supportingEvidence.length,
    0,
  );
  const weakening = result.review.claims.reduce(
    (total, claim) => total + claim.chargeWeakeningEvidence.length,
    0,
  );
  const uncertain = result.review.claims.some(
    (claim) => claim.uncertainty.status !== "none-declared",
  ) || result.review.coverage.missingContext.length > 0;
  const passed = testCase.expected === "supporting"
    ? supporting > 0
    : testCase.expected === "charge-weakening"
      ? weakening > 0
      : testCase.expected === "balanced"
        ? supporting > 0 && weakening > 0
        : uncertain;
  return { supporting, weakening, uncertain, passed };
}

try {
  const config = geminiConfigFromEnvironment();
  const client = new GeminiCandidateClient(config);
  const results = [];
  for (const testCase of cases) {
    let result;
    try {
      result = await client.generateCandidateClaims(runFor(testCase));
    } catch (error) {
      results.push({
        id: testCase.id,
        expected: testCase.expected,
        outputAccepted: false,
        passed: false,
        failureCode: error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "UNKNOWN",
        failure: error instanceof Error ? error.message : "Unknown case failure",
      });
      continue;
    }
    const mechanical = mechanicalExpectation(testCase, result);
    results.push({
      id: testCase.id,
      expected: testCase.expected,
      outputAccepted: true,
      ...mechanical,
      claimCount: result.review.claims.length,
      publicationEligibility: result.review.publicationEligibility,
      diagnostics: result.review.diagnostics.map((diagnostic) => diagnostic.code),
      usage: result.usage,
    });
  }
  console.log(JSON.stringify({
    observedDate: new Date().toISOString(),
    provider: "google-gemini",
    model: config.model,
    caseCount: results.length,
    locallyAccepted: results.filter((result) => result.outputAccepted).length,
    mechanicallyPassed: results.filter((result) => result.passed).length,
    humanSemanticScoringRequired: true,
    results,
  }, null, 2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  const status = error && typeof error === "object" && "status" in error
    ? String(error.status ?? "")
    : "";
  const message = error instanceof Error ? error.message : "Unknown Gemini scorecard error";
  console.error(`Gemini scorecard failed [${code}${status ? ` HTTP ${status}` : ""}]: ${message}`);
  process.exitCode = 1;
}
