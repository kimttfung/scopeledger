import { sql } from "@scopeledger/db";
import type { ProtocolDatabase, ProtocolTransaction } from "@scopeledger/db";
import { RecordsExportError } from "./errors.js";
import { RECORDS_PROJECTION_VERSION } from "./types.js";
import type {
  ExportLimits,
  ProjectHistoryProjection,
  ProjectScope,
  RecordsProjectionReader,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function incomplete(message: string): never {
  throw new RecordsExportError("INCOMPLETE_PROJECTION", message);
}

function object(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    incomplete(`${name} is not a persisted object`);
  }
  return value as JsonRecord;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") incomplete(`${name} is not persisted text`);
  return value;
}

function number(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) incomplete(`${name} is not a persisted integer`);
  return Number(value);
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) incomplete(`${name} is not a persisted array`);
  return value.map((item, index) => string(item, `${name}[${index}]`));
}

function objectArray(value: unknown, name: string): JsonRecord[] {
  if (!Array.isArray(value)) incomplete(`${name} is not a persisted array`);
  return value.map((item, index) => object(item, `${name}[${index}]`));
}

function limited<T>(
  rows: readonly T[],
  limit: number,
  name: string,
): readonly T[] {
  if (rows.length > limit) {
    throw new RecordsExportError(
      "BOUND_EXCEEDED",
      `${name} exceeds the per-kind export limit`,
    );
  }
  return rows;
}

function candidateCount(payload: unknown): number {
  if (payload === null) return 0;
  const candidates = object(payload, "analysis candidate payload").candidates;
  if (!Array.isArray(candidates)) {
    incomplete("Analysis candidate payload is incomplete");
  }
  return candidates.length;
}

function parseClaim(value: unknown): {
  statement: string;
  claimedSourceType: string;
  sourceAvailability: "available" | "unavailable";
  sourceGapExplanation: string | null;
} {
  const claim = object(value, "correction claim");
  const source = object(claim.source, "correction claim source");
  const availability = string(
    source.availability,
    "correction claim source availability",
  );
  if (availability !== "available" && availability !== "unavailable") {
    incomplete("Correction source availability is unsupported");
  }
  return {
    statement: string(claim.statement, "correction claim statement"),
    claimedSourceType: string(
      claim.claimedSourceType,
      "correction claimed source type",
    ),
    sourceAvailability: availability,
    sourceGapExplanation: availability === "unavailable"
      ? string(
        source.explanation,
        "correction unavailable source explanation",
      )
      : null,
  };
}

function parseDecision(value: unknown): {
  attestationStatement: string;
} {
  const attestation = object(value, "decision attestation");
  return {
    attestationStatement: string(
      attestation.statement,
      "decision attestation statement",
    ),
  };
}

function parseResolution(value: unknown): readonly Readonly<{
  correctionKey: string;
  responseRevision: number;
}>[] {
  if (value === null) return [];
  const resolution = object(value, "decision resolution");
  return objectArray(
    resolution.concerns,
    "decision resolution concerns",
  ).map((concern) => ({
    correctionKey: string(concern.concernId, "decision concern identity"),
    responseRevision: number(
      concern.responseRevision,
      "decision response revision",
    ),
  }));
}

function parsePublication(
  row: {
    request_key: string;
    unit_key: string;
    version: number;
    snapshot: unknown;
    published_at: Date;
  },
): ProjectHistoryProjection["publications"][number] {
  const snapshot = object(row.snapshot, "published snapshot");
  if (snapshot.schemaVersion !== "scopeledger.published-unit.v1") {
    incomplete("Published snapshot schema is unsupported");
  }
  const treatment = string(snapshot.treatment, "published treatment");
  if (treatment !== "payable" && treatment !== "additional-waived") {
    incomplete("Published treatment is unsupported");
  }
  const timing = object(snapshot.timing, "published timing");
  const sourceKeys = objectArray(
    snapshot.sourceReferences,
    "published source references",
  ).map((reference) => ({
    sourceKey: string(reference.id, "published source identity"),
    version: number(reference.version, "published source version"),
  }));
  const prerequisiteKeys = objectArray(
    snapshot.prerequisites,
    "published prerequisites",
  ).map((prerequisite) =>
    string(prerequisite.id, "published prerequisite identity"));
  let money: { currency: "USD"; gross: string } | null = null;
  if (treatment === "payable") {
    const payment = object(snapshot.payment, "published payment");
    const financial = object(payment.financial, "published financial basis");
    if (financial.currency !== "USD") {
      incomplete("Only exact persisted USD money is supported");
    }
    money = {
      currency: "USD",
      gross: string(financial.gross, "published gross"),
    };
  }
  return {
    requestKey: row.request_key,
    unitKey: row.unit_key,
    version: row.version,
    title: string(snapshot.title, "published title"),
    scope: stringArray(snapshot.scope, "published scope"),
    exclusions: stringArray(snapshot.exclusions, "published exclusions"),
    rationale: string(snapshot.rationale, "published rationale"),
    treatment,
    timingDescription: string(
      timing.description,
      "published timing description",
    ),
    deliveryDependencies: stringArray(
      timing.deliveryDependencies,
      "published delivery dependencies",
    ),
    sourceKeys,
    prerequisiteKeys,
    money,
    publishedAt: row.published_at,
  };
}

function parseDraftStrings(value: unknown, name: string): readonly string[] {
  return stringArray(value, name);
}

function readLimit(
  limits: Pick<ExportLimits, "maxRecordsPerKind">,
): number {
  if (
    !Number.isSafeInteger(limits.maxRecordsPerKind)
    || limits.maxRecordsPerKind < 1
    || limits.maxRecordsPerKind > 5_000
  ) {
    throw new RecordsExportError(
      "BOUND_EXCEEDED",
      "Reader per-kind limit is invalid",
    );
  }
  return limits.maxRecordsPerKind;
}

async function readProjection(
  transaction: ProtocolTransaction,
  scope: ProjectScope,
  limit: number,
): Promise<ProjectHistoryProjection> {
  const queryLimit = limit + 1;
  const project = (await sql<{
    project_key: string;
    display_name: string | null;
    created_at: Date | null;
  }>`select id as project_key,provider_display_name as display_name,
        provider_created_at as created_at
      from projects
      where workspace_id = ${scope.workspaceId} and id = ${scope.projectId}`
    .execute(transaction)).rows[0];
  const analysisProject = project
    ? undefined
    : (await sql<{
      project_key: string;
      created_at: Date;
    }>`select project_id as project_key,created_at
        from analysis_scopes
        where workspace_id = ${scope.workspaceId}
          and project_id = ${scope.projectId}`
      .execute(transaction)).rows[0];
  if (!project && !analysisProject) {
    throw new RecordsExportError(
      "INCOMPLETE_PROJECTION",
      "Scoped project was not found",
    );
  }

  const requestRows = limited((await sql<{
    request_key: string;
    title: string | null;
    created_at: Date | null;
  }>`select id as request_key,provider_title as title,
        provider_created_at as created_at
      from packets
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by coalesce(provider_created_at,'infinity'::timestamptz),
        id collate "C"
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Requests");

  const unitRows = limited((await sql<{
    unit_key: string;
    request_key: string;
    current_version: number | null;
    accepted_version: number | null;
  }>`select id as unit_key,packet_id as request_key,current_version,accepted_version
      from units
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by id collate "C"
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Units");

  const sourceRows = limited((await sql<{
    source_key: string;
    source_version: number;
    availability: "available" | "unavailable";
    source_kind:
      | "provider-upload"
      | "provider-note"
      | "client-supplied"
      | "external-reference"
      | null;
    media_type: string | null;
    provenance_origin: string | null;
    recorded_at: Date | null;
  }>`select s.id as source_key,s.version as source_version,s.availability,
        i.source_kind,i.media_type,i.provenance_origin,
        coalesce(i.recorded_at,min(v.published_at)) as recorded_at
      from source_versions s
      left join source_intake_records i
        on i.workspace_id = s.workspace_id
        and i.project_id = s.project_id
        and i.source_id = s.id
        and i.source_version = s.version
      left join version_sources vs
        on vs.workspace_id = s.workspace_id
        and vs.project_id = s.project_id
        and vs.source_id = s.id
        and vs.source_version = s.version
      left join unit_versions v
        on v.workspace_id = vs.workspace_id
        and v.project_id = vs.project_id
        and v.unit_id = vs.unit_id
        and v.version = vs.version
      where s.workspace_id = ${scope.workspaceId}
        and s.project_id = ${scope.projectId}
      group by s.id,s.version,s.availability,i.source_kind,i.media_type,
        i.provenance_origin,i.recorded_at
      order by coalesce(i.recorded_at,min(v.published_at),'infinity'::timestamptz),
        s.id collate "C",s.version
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Sources");
  for (const row of sourceRows) {
    if (row.recorded_at === null) {
      incomplete("A persisted source has no chronological basis");
    }
  }

  const analysisSourceRows = limited((await sql<{
    source_key: string;
    version_key: string;
    extraction_status: "complete" | "partial";
    recorded_at: Date;
  }>`select source_id as source_key,version_id::text as version_key,
        extraction_status,recorded_at
      from analysis_source_versions
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by recorded_at,source_id collate "C",version_id
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Analysis sources");
  const analysisCoverageRows = limited((await sql<{
    source_key: string;
    version_key: string;
    page_number: number;
    reason_code: string;
  }>`select source_id as source_key,version_id::text as version_key,
        page_number,reason_code
      from analysis_source_coverage
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
        and status = 'unavailable'
      order by source_id collate "C",version_id,page_number
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Analysis source gaps");

  const draftRows = limited((await sql<{
    request_key: string;
    unit_key: string;
    revision: number;
    state: "in-progress" | "ready-for-client-review";
    title: string;
    summary: string;
    scope_items: unknown;
    exclusion_items: unknown;
    created_at: Date;
  }>`select request_id as request_key,unit_id as unit_key,revision,state,title,
        summary,scope_items,exclusion_items,created_at
      from provider_authoring_draft_versions
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by created_at,unit_id collate "C",revision
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Drafts");
  const draftSourceRows = limited((await sql<{
    unit_key: string;
    revision: number;
    source_key: string;
    source_version: number;
    position: number;
  }>`select unit_id as unit_key,draft_revision as revision,
        source_id as source_key,source_version,position
      from provider_authoring_draft_sources
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by unit_id collate "C",draft_revision,position
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Draft sources");

  const publicationRows = limited((await sql<{
    request_key: string;
    unit_key: string;
    version: number;
    snapshot: unknown;
    published_at: Date;
  }>`select u.packet_id as request_key,v.unit_id as unit_key,v.version,
        v.snapshot,v.published_at
      from unit_versions v
      join units u
        on u.workspace_id = v.workspace_id
        and u.project_id = v.project_id
        and u.id = v.unit_id
      where v.workspace_id = ${scope.workspaceId}
        and v.project_id = ${scope.projectId}
      order by v.published_at,v.unit_id collate "C",v.version
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Publications");

  const correctionRows = limited((await sql<{
    correction_key: string;
    request_key: string;
    unit_key: string;
    scope: "known" | "unknown";
    claim: unknown;
    admitted_at: Date;
  }>`select id as correction_key,packet_id as request_key,
        origin_unit_id as unit_key,scope,claim,admitted_at
      from corrections
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by admitted_at,id collate "C"
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Corrections");
  const correctionResponseRows = limited((await sql<{
    correction_key: string;
    revision: number;
    disposition: "accept" | "partial" | "maintain" | "request-information";
    source_review: string;
    explanation: string;
    recorded_at: Date;
  }>`select concern_id as correction_key,revision,disposition,
        source_review,explanation,recorded_at
      from correction_responses
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by recorded_at,concern_id collate "C",revision
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Correction responses");

  const questionRows = limited((await sql<{
    question_key: string;
    request_key: string;
    unit_key: string;
    unit_version: number;
    exact_text: string;
    model_processing: "permitted" | "denied";
    asked_at: Date;
  }>`select question_id::text as question_key,request_id as request_key,
        unit_id as unit_key,unit_version,exact_text,model_processing,asked_at
      from client_questions
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by asked_at,question_id
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Questions");

  const decisionRows = limited((await sql<{
    unit_key: string;
    version: number;
    decision: "approve" | "decline";
    attestation: unknown;
    resolution: unknown | null;
    recorded_at: Date;
  }>`select unit_id as unit_key,version,decision,attestation,resolution,recorded_at
      from decisions
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by recorded_at,unit_id collate "C",version
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Decisions");

  const obligationRows = limited((await sql<{
    obligation_key: string;
    unit_key: string;
    version: number;
    currency: "USD";
    gross: string;
    collectible: boolean;
    replaces_obligation_key: string | null;
    recorded_at: Date;
  }>`select o.id as obligation_key,o.unit_id as unit_key,o.version,o.currency,
        o.gross,o.collectible,o.replaces_id as replaces_obligation_key,
        d.recorded_at
      from obligations o
      join decisions d
        on d.workspace_id = o.workspace_id
        and d.project_id = o.project_id
        and d.unit_id = o.unit_id
        and d.version = o.version
      where o.workspace_id = ${scope.workspaceId}
        and o.project_id = ${scope.projectId}
      order by d.recorded_at,o.id collate "C"
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Obligations");

  const paymentRows = limited((await sql<{
    payment_key: string;
    obligation_key: string;
    unit_key: string;
    version: number;
    currency: "USD";
    gross: string;
    evidence: unknown;
    verified_at: Date;
  }>`select f.operation_id::text as payment_key,a.obligation_id as obligation_key,
        b.unit_id as unit_key,b.version,f.currency,f.gross,f.evidence,f.verified_at
      from payment_facts f
      join operations o
        on o.workspace_id = f.workspace_id
        and o.project_id = f.project_id
        and o.id = f.operation_id
      join attempts a
        on a.workspace_id = o.workspace_id
        and a.project_id = o.project_id
        and a.id = o.attempt_id
      join obligations b
        on b.workspace_id = a.workspace_id
        and b.project_id = a.project_id
        and b.id = a.obligation_id
      where f.workspace_id = ${scope.workspaceId}
        and f.project_id = ${scope.projectId}
      order by f.verified_at,f.operation_id
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Payments");

  const holdRows = limited((await sql<{
    unit_key: string;
    created_at: Date;
    resolved_at: Date | null;
  }>`select unit_id as unit_key,created_at,resolved_at
      from holds
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by created_at,unit_id collate "C",id collate "C"
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Holds");
  const prerequisiteRows = limited((await sql<{
    unit_key: string;
    version: number;
    prerequisite_key: string;
    satisfied: boolean;
    recorded_at: Date;
  }>`select unit_id as unit_key,version,prerequisite_id as prerequisite_key,
        satisfied,recorded_at
      from prerequisite_observations
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by recorded_at,unit_id collate "C",version,prerequisite_id collate "C"
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Prerequisites");
  const workStartRows = limited((await sql<{
    work_start_key: string;
    unit_key: string;
    version: number;
    started_at: Date;
  }>`select sequence::text as work_start_key,resource_id as unit_key,
        (detail->>'version')::integer as version,recorded_at as started_at
      from protocol_history
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
        and event = 'work-started'
      order by recorded_at,sequence
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Work starts");

  const analysisRows = limited((await sql<{
    analysis_key: string;
    status: "manual-review-ready" | "candidate-ready" | "model-failed";
    candidate_payload: unknown | null;
    human_review_required: true;
    publication_blocked: true;
    created_at: Date;
  }>`select run_id::text as analysis_key,status,candidate_payload,
        human_review_required,publication_blocked,created_at
      from analysis_runs
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by created_at,run_id
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Analysis runs");
  const analysisReviewRows = limited((await sql<{
    review_key: string;
    analysis_key: string;
    disposition: "accept" | "edit" | "reject" | "manual";
    note: string;
    reviewed_at: Date;
  }>`select review_id::text as review_key,run_id::text as analysis_key,
        disposition,note,reviewed_at
      from analysis_human_reviews
      where workspace_id = ${scope.workspaceId}
        and project_id = ${scope.projectId}
      order by reviewed_at,review_id
      limit ${queryLimit}`.execute(transaction)).rows, limit, "Analysis reviews");

  const sources: ProjectHistoryProjection["sources"][number][] =
    sourceRows.map((row) => ({
      sourceKey: row.source_key,
      version: row.source_version,
      sourceKind: row.source_kind ?? "external-reference",
      availability: row.availability,
      mediaType: row.media_type,
      provenanceOrigin: row.provenance_origin ?? "legacy-source",
      suppliedByRole: row.source_kind === "client-supplied"
        ? "client"
        : row.source_kind === null || row.source_kind === "external-reference"
          ? "unknown"
          : "provider",
      providerReviewed: true,
      recordedAt: row.recorded_at as Date,
      unavailableParts: [],
    }));
  for (const source of analysisSourceRows) {
    const sourceKey = `analysis-${source.source_key}-${source.version_key}`;
    sources.push({
      sourceKey,
      version: 1,
      sourceKind: "analysis-provider-upload",
      availability: source.extraction_status === "partial" ? "partial" : "available",
      mediaType: null,
      provenanceOrigin: "analysis-upload",
      suppliedByRole: "provider",
      providerReviewed: true,
      recordedAt: source.recorded_at,
      unavailableParts: analysisCoverageRows
        .filter((coverage) =>
          coverage.source_key === source.source_key
          && coverage.version_key === source.version_key)
        .map((coverage) => ({
          label: `Page ${coverage.page_number}`,
          reason: coverage.reason_code,
        })),
    });
  }
  if (sources.length > limit) {
    throw new RecordsExportError(
      "BOUND_EXCEEDED",
      "Combined sources exceed the per-kind export limit",
    );
  }

  return {
    schemaVersion: RECORDS_PROJECTION_VERSION,
    project: {
      projectKey: project?.project_key ?? analysisProject?.project_key ?? scope.projectId,
      displayName: project?.display_name ?? (
        analysisProject ? "Analysis review record" : null
      ),
      createdAt: project?.created_at ?? analysisProject?.created_at ?? null,
    },
    requests: requestRows.map((row) => ({
      requestKey: row.request_key,
      title: row.title,
      createdAt: row.created_at,
    })),
    sources,
    units: unitRows.map((row) => ({
      unitKey: row.unit_key,
      requestKey: row.request_key,
      currentVersion: row.current_version,
      acceptedVersion: row.accepted_version,
    })),
    drafts: draftRows.map((row) => ({
      requestKey: row.request_key,
      unitKey: row.unit_key,
      revision: row.revision,
      state: row.state,
      title: row.title,
      summary: row.summary,
      scope: parseDraftStrings(row.scope_items, "draft scope"),
      exclusions: parseDraftStrings(
        row.exclusion_items,
        "draft exclusions",
      ),
      sourceKeys: draftSourceRows
        .filter((source) =>
          source.unit_key === row.unit_key
          && source.revision === row.revision)
        .sort((left, right) => left.position - right.position)
        .map((source) => ({
          sourceKey: source.source_key,
          version: source.source_version,
        })),
      createdAt: row.created_at,
    })),
    publications: publicationRows.map(parsePublication),
    corrections: correctionRows.map((row) => ({
      correctionKey: row.correction_key,
      requestKey: row.request_key,
      unitKey: row.unit_key,
      scope: row.scope,
      ...parseClaim(row.claim),
      admittedAt: row.admitted_at,
    })),
    correctionResponses: correctionResponseRows.map((row) => ({
      correctionKey: row.correction_key,
      revision: row.revision,
      disposition: row.disposition,
      sourceReview: row.source_review,
      explanation: row.explanation,
      recordedAt: row.recorded_at,
    })),
    questions: questionRows.map((row) => ({
      questionKey: row.question_key,
      requestKey: row.request_key,
      unitKey: row.unit_key,
      unitVersion: row.unit_version,
      exactText: row.exact_text,
      modelProcessing: row.model_processing,
      askedAt: row.asked_at,
    })),
    decisions: decisionRows.map((row) => ({
      unitKey: row.unit_key,
      version: row.version,
      decision: row.decision,
      ...parseDecision(row.attestation),
      resolvedCorrections: parseResolution(row.resolution),
      recordedAt: row.recorded_at,
    })),
    obligations: obligationRows.map((row) => ({
      obligationKey: row.obligation_key,
      unitKey: row.unit_key,
      version: row.version,
      currency: row.currency,
      gross: row.gross,
      collectible: row.collectible,
      replacesObligationKey: row.replaces_obligation_key,
      recordedAt: row.recorded_at,
    })),
    payments: paymentRows.map((row) => ({
      paymentKey: row.payment_key,
      obligationKey: row.obligation_key,
      unitKey: row.unit_key,
      version: row.version,
      currency: row.currency,
      gross: row.gross,
      verification: object(row.evidence, "payment evidence").kind
        === "authenticated-adapter"
        ? "paypal-verified"
        : "synthetic-proof",
      verifiedAt: row.verified_at,
    })),
    holds: holdRows.map((row) => ({
      unitKey: row.unit_key,
      active: row.resolved_at === null,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    })),
    prerequisites: prerequisiteRows.map((row) => ({
      unitKey: row.unit_key,
      version: row.version,
      prerequisiteKey: row.prerequisite_key,
      satisfied: row.satisfied,
      recordedAt: row.recorded_at,
    })),
    workStarts: workStartRows.map((row) => ({
      workStartKey: row.work_start_key,
      unitKey: row.unit_key,
      version: row.version,
      startedAt: row.started_at,
    })),
    analysisCandidates: analysisRows.map((row) => {
      if (
        row.human_review_required !== true
        || row.publication_blocked !== true
      ) {
        incomplete("Analysis run safety flags are incomplete");
      }
      return {
        analysisKey: row.analysis_key,
        status: row.status,
        candidateCount: candidateCount(row.candidate_payload),
        humanReviewRequired: true,
        publicationBlocked: true,
        createdAt: row.created_at,
      };
    }),
    analysisReviews: analysisReviewRows.map((row) => ({
      reviewKey: row.review_key,
      analysisKey: row.analysis_key,
      disposition: row.disposition,
      note: row.note,
      reviewedAt: row.reviewed_at,
    })),
    capabilities: {
      delivery: "unsupported",
      deliveryAcceptance: "unsupported",
    },
  };
}

export class ProtocolDatabaseRecordsReader implements RecordsProjectionReader {
  constructor(private readonly database: ProtocolDatabase) {}

  async readProject(
    scope: ProjectScope,
    limits: Pick<ExportLimits, "maxRecordsPerKind" | "maxTotalRecords">,
  ): Promise<ProjectHistoryProjection> {
    const limit = readLimit(limits);
    return this.database.transaction((transaction) =>
      readProjection(transaction, scope, limit));
  }
}

export function createProtocolDatabaseRecordsReader(
  database: ProtocolDatabase,
): RecordsProjectionReader {
  return new ProtocolDatabaseRecordsReader(database);
}
