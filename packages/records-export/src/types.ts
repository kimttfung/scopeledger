export const RECORDS_PROJECTION_VERSION =
  "scopeledger.records-projection.v1" as const;
export const RECORD_EXPORT_SCHEMA_VERSION =
  "scopeledger.project-record.v1" as const;
export const RECORD_EXPORT_SERIALIZATION_VERSION =
  "scopeledger.canonical-json.v1" as const;

export const RECORD_EXPORT_LABELS = Object.freeze({
  title: "ScopeLedger project record",
  notices: Object.freeze([
    "This record is not a legal opinion.",
    "This record is not a delivery receipt.",
    "This record is not a dispute submission.",
    "This record is not proof of satisfactory delivery.",
  ]),
});

export type ProjectScope = Readonly<{
  workspaceId: string;
  projectId: string;
}>;

export type ExportLimits = Readonly<{
  maxRecordsPerKind: number;
  maxTotalRecords: number;
  maxTextCodePoints: number;
  maxJsonBytes: number;
  maxHtmlBytes: number;
}>;

export const DEFAULT_EXPORT_LIMITS: ExportLimits = Object.freeze({
  maxRecordsPerKind: 500,
  maxTotalRecords: 5_000,
  maxTextCodePoints: 10_000,
  maxJsonBytes: 2_000_000,
  maxHtmlBytes: 4_000_000,
});

export type Attribution =
  | "provider-reviewed"
  | "client-supplied"
  | "client-decided"
  | "ai-candidate"
  | "paypal-verified"
  | "system-recorded";

export type DateValue = Date | string;

export type ProjectHistoryProjection = Readonly<{
  schemaVersion: typeof RECORDS_PROJECTION_VERSION;
  project: Readonly<{
    projectKey: string;
    displayName: string | null;
    createdAt: DateValue | null;
  }>;
  requests: readonly Readonly<{
    requestKey: string;
    title: string | null;
    createdAt: DateValue | null;
  }>[];
  sources: readonly Readonly<{
    sourceKey: string;
    version: number | string;
    sourceKind:
      | "provider-upload"
      | "provider-note"
      | "client-supplied"
      | "external-reference"
      | "analysis-provider-upload";
    availability: "available" | "unavailable" | "partial";
    mediaType: string | null;
    provenanceOrigin: string;
    suppliedByRole: "provider" | "client" | "unknown";
    providerReviewed: boolean;
    recordedAt: DateValue;
    unavailableParts: readonly Readonly<{
      label: string;
      reason: string;
    }>[];
  }>[];
  units: readonly Readonly<{
    unitKey: string;
    requestKey: string;
    currentVersion: number | null;
    acceptedVersion: number | null;
  }>[];
  drafts: readonly Readonly<{
    requestKey: string;
    unitKey: string;
    revision: number;
    state: "in-progress" | "ready-for-client-review";
    title: string;
    summary: string;
    scope: readonly string[];
    exclusions: readonly string[];
    sourceKeys: readonly Readonly<{ sourceKey: string; version: number }>[];
    createdAt: DateValue;
  }>[];
  publications: readonly Readonly<{
    requestKey: string;
    unitKey: string;
    version: number;
    title: string;
    scope: readonly string[];
    exclusions: readonly string[];
    rationale: string;
    treatment: "payable" | "additional-waived";
    timingDescription: string;
    deliveryDependencies: readonly string[];
    sourceKeys: readonly Readonly<{ sourceKey: string; version: number }>[];
    prerequisiteKeys: readonly string[];
    money: Readonly<{ currency: "USD"; gross: string }> | null;
    publishedAt: DateValue;
  }>[];
  corrections: readonly Readonly<{
    correctionKey: string;
    requestKey: string;
    unitKey: string;
    scope: "known" | "unknown";
    statement: string;
    claimedSourceType: string;
    sourceAvailability: "available" | "unavailable";
    sourceGapExplanation: string | null;
    admittedAt: DateValue;
  }>[];
  correctionResponses: readonly Readonly<{
    correctionKey: string;
    revision: number;
    disposition: "accept" | "partial" | "maintain" | "request-information";
    sourceReview: string;
    explanation: string;
    recordedAt: DateValue;
  }>[];
  questions: readonly Readonly<{
    questionKey: string;
    requestKey: string;
    unitKey: string;
    unitVersion: number;
    exactText: string;
    modelProcessing: "permitted" | "denied";
    askedAt: DateValue;
  }>[];
  decisions: readonly Readonly<{
    unitKey: string;
    version: number;
    decision: "approve" | "decline";
    attestationStatement: string;
    resolvedCorrections: readonly Readonly<{
      correctionKey: string;
      responseRevision: number;
    }>[];
    recordedAt: DateValue;
  }>[];
  obligations: readonly Readonly<{
    obligationKey: string;
    unitKey: string;
    version: number;
    currency: "USD";
    gross: string;
    collectible: boolean;
    replacesObligationKey: string | null;
    recordedAt: DateValue;
  }>[];
  payments: readonly Readonly<{
    paymentKey: string;
    obligationKey: string;
    unitKey: string;
    version: number;
    currency: "USD";
    gross: string;
    verification: "paypal-verified" | "synthetic-proof";
    verifiedAt: DateValue;
  }>[];
  holds: readonly Readonly<{
    unitKey: string;
    active: boolean;
    createdAt: DateValue;
    resolvedAt: DateValue | null;
  }>[];
  prerequisites: readonly Readonly<{
    unitKey: string;
    version: number;
    prerequisiteKey: string;
    satisfied: boolean;
    recordedAt: DateValue;
  }>[];
  workStarts: readonly Readonly<{
    workStartKey: string;
    unitKey: string;
    version: number;
    startedAt: DateValue;
  }>[];
  analysisCandidates: readonly Readonly<{
    analysisKey: string;
    status: "manual-review-ready" | "candidate-ready" | "model-failed";
    candidateCount: number;
    humanReviewRequired: true;
    publicationBlocked: true;
    createdAt: DateValue;
  }>[];
  analysisReviews: readonly Readonly<{
    reviewKey: string;
    analysisKey: string;
    disposition: "accept" | "edit" | "reject" | "manual";
    note: string;
    reviewedAt: DateValue;
  }>[];
  capabilities: Readonly<{
    delivery: "unsupported";
    deliveryAcceptance: "unsupported";
  }>;
}>;

export interface RecordsProjectionReader {
  readProject(
    scope: ProjectScope,
    limits: Pick<ExportLimits, "maxRecordsPerKind" | "maxTotalRecords">,
  ): Promise<ProjectHistoryProjection>;
}

type ExportFactBase = Readonly<{
  recordRef: string;
  occurredAt: string | null;
  attribution: Attribution;
}>;

export type RecordGap = Readonly<{
  recordRef: string;
  category: "source" | "project" | "request" | "delivery" | "delivery-acceptance";
  status: "unavailable" | "redacted" | "unsupported" | "incomplete";
  reason: string;
}>;

export type RecordExportV1 = Readonly<{
  schemaVersion: typeof RECORD_EXPORT_SCHEMA_VERSION;
  serializationVersion: typeof RECORD_EXPORT_SERIALIZATION_VERSION;
  labels: typeof RECORD_EXPORT_LABELS;
  project: Readonly<{
    recordRef: string;
    displayName: string;
    createdAt: string | null;
    attribution: "provider-reviewed";
  }>;
  capabilities: Readonly<{
    delivery: "unsupported";
    deliveryAcceptance: "unsupported";
  }>;
  facts: Readonly<{
    requests: readonly (ExportFactBase & Readonly<{
      title: string;
    }>)[];
    sources: readonly (ExportFactBase & Readonly<{
      sourceRef: string;
      version: number;
      sourceKind:
        | "provider-upload"
        | "client-supplied"
        | "external-reference"
        | "analysis-provider-upload"
        | "redacted-provider-note";
      availability: "available" | "unavailable" | "partial" | "redacted";
      mediaType: string | null;
      provenanceOrigin: string;
      contentStatus: "not-exported" | "unavailable" | "partially-unavailable" | "redacted";
    }>)[];
    drafts: readonly (ExportFactBase & Readonly<{
      requestRef: string;
      unitRef: string;
      revision: number;
      state: "in-progress" | "ready-for-client-review";
      title: string;
      summary: string;
      scope: readonly string[];
      exclusions: readonly string[];
      sourceRefs: readonly string[];
    }>)[];
    publications: readonly (ExportFactBase & Readonly<{
      requestRef: string;
      unitRef: string;
      version: number;
      title: string;
      scope: readonly string[];
      exclusions: readonly string[];
      rationale: string;
      treatment: "payable" | "additional-waived";
      timingDescription: string;
      deliveryDependencies: readonly string[];
      sourceRefs: readonly string[];
      money: Readonly<{ currency: "USD"; gross: string }> | null;
    }>)[];
    corrections: readonly (ExportFactBase & Readonly<{
      requestRef: string;
      unitRef: string;
      scope: "known" | "unknown";
      statement: string;
      claimedSourceType: string;
      sourceAvailability: "available" | "unavailable";
      sourceGapExplanation: string | null;
      responses: readonly Readonly<{
        recordRef: string;
        revision: number;
        disposition: "accept" | "partial" | "maintain" | "request-information";
        sourceReview: string;
        explanation: string;
        recordedAt: string;
        attribution: "provider-reviewed";
      }>[];
    }>)[];
    questions: readonly (ExportFactBase & Readonly<{
      requestRef: string;
      unitRef: string;
      unitVersion: number;
      exactText: string;
      modelProcessing: "permitted" | "denied";
      communicationEffect: "communication-only";
    }>)[];
    agreements: readonly (ExportFactBase & Readonly<{
      unitRef: string;
      version: number;
      decision: "approve" | "decline";
      attestationStatement: string;
      resolvedCorrectionRefs: readonly string[];
    }>)[];
    obligations: readonly (ExportFactBase & Readonly<{
      unitRef: string;
      version: number;
      currency: "USD";
      gross: string;
      collectible: boolean;
      replacesObligationRef: string | null;
    }>)[];
    payments: readonly (ExportFactBase & Readonly<{
      obligationRef: string;
      unitRef: string;
      version: number;
      currency: "USD";
      gross: string;
      verification: "paypal-verified" | "synthetic-proof";
    }>)[];
    readiness: readonly (ExportFactBase & Readonly<{
      unitRef: string;
      currentVersion: number | null;
      acceptedVersion: number | null;
      status:
        | "awaiting-agreement"
        | "review-hold"
        | "awaiting-payment"
        | "awaiting-prerequisite"
        | "recorded-basis-ready";
      activeHoldCount: number;
      liveCheckRequired: true;
    }>)[];
    workStarts: readonly (ExportFactBase & Readonly<{
      unitRef: string;
      version: number;
    }>)[];
    analysisCandidates: readonly (ExportFactBase & Readonly<{
      status: "manual-review-ready" | "candidate-ready" | "model-failed";
      candidateCount: number;
      humanReviewRequired: true;
      publicationBlocked: true;
    }>)[];
    analysisReviews: readonly (ExportFactBase & Readonly<{
      analysisRef: string;
      disposition: "accept" | "edit" | "reject" | "manual";
      note: string;
    }>)[];
    delivery: readonly never[];
    deliveryAcceptance: readonly never[];
  }>;
  gaps: readonly RecordGap[];
  timeline: readonly Readonly<{
    recordRef: string;
    kind:
      | "project"
      | "request"
      | "source"
      | "draft"
      | "publication"
      | "correction"
      | "correction-response"
      | "question"
      | "agreement"
      | "obligation"
      | "payment"
      | "readiness"
      | "work-start"
      | "analysis-candidate"
      | "analysis-review";
    occurredAt: string;
    attribution: Attribution;
    summary: string;
  }>[];
}>;

export type ProjectRecordExport = Readonly<{
  document: RecordExportV1;
  json: string;
  html: string;
}>;
