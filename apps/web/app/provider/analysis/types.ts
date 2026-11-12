export type AnalysisSourceReference = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
}>;

export type AnalysisParserSummary = Readonly<{
  extractionStatus: "complete" | "partial";
  declaredPageCount: number;
  extractedPageCount: number;
  unavailablePageNumbers: readonly number[];
  codePointCount: number;
  extractorReference: string;
  sourceReference: AnalysisSourceReference;
  pages: readonly Readonly<{
    pageNumber: number;
    start: number;
    end: number;
  }>[];
}>;

export type AnalysisEvidence = Readonly<{
  polarity: "supporting" | "charge-weakening";
  quote: string;
  start: number;
  end: number;
  sourceReference: AnalysisSourceReference;
}>;

export type AnalysisCandidate = Readonly<{
  claimId: string;
  interpretation: string;
  evidence: readonly AnalysisEvidence[];
  uncertainty: Readonly<{
    status: "uncertain" | "limited" | "none-declared";
    explanation: string;
    questions: readonly string[];
  }>;
  reviewState: "human-review-required";
}>;

export type AnalysisModelSummary =
  | Readonly<{
    status: "not-requested";
    humanReviewRequired: true;
    publicationBlocked: true;
    candidates: readonly [];
    missingContext: readonly [];
  }>
  | Readonly<{
    status: "completed";
    humanReviewRequired: true;
    publicationBlocked: true;
    candidates: readonly AnalysisCandidate[];
    missingContext: readonly string[];
  }>
  | Readonly<{
    status: "failed";
    code:
      | "MODEL_INPUT_NOT_ADMITTED"
      | "MODEL_CONFIGURATION_UNAVAILABLE"
      | "MODEL_PROCESSING_FAILED"
      | "MODEL_BUDGET_EXHAUSTED";
    humanReviewRequired: true;
    publicationBlocked: true;
    candidates: readonly [];
    missingContext: readonly [];
  }>;

export type AnalysisManualFallback = Readonly<{
  available: true;
  message: string;
}>;

export type PersistedAnalysisRun = Readonly<{
  runId: string;
  status: "manual-review-ready" | "candidate-ready" | "model-failed";
  recordedAt: string;
  sourceDigest: string;
  providerReference: "manual" | "google-gemini";
  modelReference: string | null;
  humanReviewRequired: true;
  publicationBlocked: true;
}>;

export type AnalysisReviewDisposition =
  | "accept"
  | "edit"
  | "reject"
  | "manual";

export type AnalysisReviewRecord = Readonly<{
  reviewId: string;
  runId: string;
  reviewedAt: string;
  disposition: AnalysisReviewDisposition;
  note: string;
  runBasisDigest: string;
  candidateBasisDigest: string | null;
}>;

export type StoredAnalysisRun = Readonly<{
  runId: string;
  status: PersistedAnalysisRun["status"];
  recordedAt: string;
  sourceDigest: string;
  parserReference: string;
  providerReference: PersistedAnalysisRun["providerReference"];
  modelReference: string | null;
  humanReviewRequired: true;
  publicationBlocked: true;
  candidateCount: number;
  candidates: readonly AnalysisCandidate[];
  missingContext: readonly string[];
  failureCode: string | null;
  reviews: readonly AnalysisReviewRecord[];
}>;

export type AnalysisResponse =
  | Readonly<{
    ok: true;
    code: "ANALYSIS_COMPLETE";
    parser: AnalysisParserSummary;
    model: AnalysisModelSummary;
    run: PersistedAnalysisRun;
    manualFallback: AnalysisManualFallback;
  }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
    parser?: AnalysisParserSummary;
    model?: AnalysisModelSummary;
    run?: PersistedAnalysisRun;
    manualFallback: AnalysisManualFallback;
  }>;

export type AnalysisRunsResponse = Readonly<{
  ok: true;
  runs: readonly StoredAnalysisRun[];
  limits: Readonly<{
    maximumRuns: number;
    admittedRuns: number;
    remainingRuns: number;
    modelCallBudget: number;
    admittedModelCalls: number;
    remainingModelCalls: number;
    blocked: boolean;
    modelBlocked: boolean;
  }>;
}> | Readonly<{
  ok: false;
  code: string;
  message: string;
}>;

export type AnalysisReviewResponse = Readonly<{
  ok: true;
  duplicate: boolean;
  review: AnalysisReviewRecord;
}> | Readonly<{
  ok: false;
  code: string;
  message: string;
}>;
