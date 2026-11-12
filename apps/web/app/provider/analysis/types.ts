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
    code: "MODEL_INPUT_NOT_ADMITTED" | "MODEL_CONFIGURATION_UNAVAILABLE" | "MODEL_PROCESSING_FAILED";
    humanReviewRequired: true;
    publicationBlocked: true;
    candidates: readonly [];
    missingContext: readonly [];
  }>;

export type AnalysisManualFallback = Readonly<{
  available: true;
  message: string;
}>;

export type AnalysisResponse =
  | Readonly<{
    ok: true;
    code: "ANALYSIS_COMPLETE";
    parser: AnalysisParserSummary;
    model: AnalysisModelSummary;
    manualFallback: AnalysisManualFallback;
  }>
  | Readonly<{
    ok: false;
    code: string;
    message: string;
    parser?: AnalysisParserSummary;
    model?: AnalysisModelSummary;
    manualFallback: AnalysisManualFallback;
  }>;
