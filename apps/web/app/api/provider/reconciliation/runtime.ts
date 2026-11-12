import { createHash } from "node:crypto";
import {
  parseInput,
  publishedUnitSchema,
  type PublishedUnit,
} from "@scopeledger/contracts";
import {
  PostgresAuthoringStore,
  sql,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import type {
  CorrectionApplicability,
  ReconciliationDependencies,
  ReconciliationInbox,
  ReconciliationQuestion,
  ReconciliationCorrection,
  QuestionResponseStatus,
} from "./service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;

function database() {
  const current = protocolDatabase();
  if (!current) {
    throw Object.assign(new Error("RECONCILIATION_DATABASE_UNAVAILABLE"), {
      code: "RECONCILIATION_DATABASE_UNAVAILABLE",
    });
  }
  return current;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("INVALID_INPUT");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) {
      throw new Error("INVALID_INPUT");
    }
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("INVALID_INPUT");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function conflict(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function projectName(
  displayName: string | null,
  projectId: string,
): string {
  if (displayName) return displayName;
  return projectId.split("-").filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function requestTitle(title: string | null, requestId: string): string {
  if (title) return title;
  return requestId.split("-").filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function correctionClaim(value: unknown): Readonly<{
  statement: string;
  claimedSourceType: string;
  sourceAvailability: "available" | "unavailable";
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      statement: "Correction concern",
      claimedSourceType: "Client-reported context",
      sourceAvailability: "unavailable",
    };
  }
  const claim = value as Record<string, unknown>;
  const source = claim.source;
  const availability = source
    && typeof source === "object"
    && !Array.isArray(source)
    && (source as Record<string, unknown>).availability === "available"
    ? "available"
    : "unavailable";
  return {
    statement: typeof claim.statement === "string"
      ? claim.statement
      : "Correction concern",
    claimedSourceType: typeof claim.claimedSourceType === "string"
      ? claim.claimedSourceType
      : "Client-reported context",
    sourceAvailability: availability,
  };
}

type QuestionListRow = {
  question_id: string;
  project_id: string;
  project_display_name: string | null;
  request_id: string;
  request_title: string | null;
  unit_title: string;
  unit_version: number;
  exact_text: string;
  asked_at: Date;
  response_revision: number | null;
  response_status: QuestionResponseStatus | null;
  response_text: string | null;
  responded_at: Date | null;
};

type CorrectionListRow = {
  concern_id: string;
  project_id: string;
  project_display_name: string | null;
  request_id: string;
  request_title: string | null;
  unit_title: string;
  current_version: number;
  claim: unknown;
  admitted_at: Date;
  correction_hold_active: boolean;
  other_hold_present: boolean;
  response_revision: number | null;
  response_disposition:
    | "accept"
    | "partial"
    | "maintain"
    | "request-information"
    | null;
  response_text: string | null;
  response_recorded_at: Date | null;
  assessment_revision: number | null;
  assessment_applicability: CorrectionApplicability | null;
  assessment_response_revision: number | null;
  assessment_draft_revision: number | null;
  assessed_at: Date | null;
};

async function listInbox(): Promise<ReconciliationInbox> {
  const current = database();
  const questions = (await sql<QuestionListRow>`
    select
      q.question_id::text,
      q.project_id,
      p.provider_display_name as project_display_name,
      q.request_id,
      packet.provider_title as request_title,
      coalesce(v.snapshot->>'title','Published unit') as unit_title,
      q.unit_version,
      q.exact_text,
      q.asked_at,
      response.revision as response_revision,
      response.status as response_status,
      response.response_text,
      response.responded_at
    from client_questions q
    join grants g
      on g.workspace_id = q.workspace_id
      and g.project_id = q.project_id
      and g.actor_id = ${providerActorId}
      and g.action = 'inspect'
      and g.epoch = ${providerGrantEpoch}
      and g.active = true
    join projects p
      on p.workspace_id = q.workspace_id
      and p.id = q.project_id
    join packets packet
      on packet.workspace_id = q.workspace_id
      and packet.project_id = q.project_id
      and packet.id = q.request_id
    join unit_versions v
      on v.workspace_id = q.workspace_id
      and v.project_id = q.project_id
      and v.unit_id = q.unit_id
      and v.version = q.unit_version
    left join lateral (
      select r.revision,r.status,r.response_text,r.responded_at
      from provider_question_responses r
      where r.workspace_id = q.workspace_id
        and r.project_id = q.project_id
        and r.question_id = q.question_id
      order by r.revision desc
      limit 1
    ) response on true
    where q.workspace_id = ${workspaceId}
    order by q.asked_at desc,q.question_id
  `.execute(current.kysely)).rows.map((row): ReconciliationQuestion =>
    Object.freeze({
      questionId: row.question_id,
      projectName: projectName(row.project_display_name, row.project_id),
      requestTitle: requestTitle(row.request_title, row.request_id),
      unitTitle: row.unit_title,
      version: row.unit_version,
      text: row.exact_text,
      asked: {
        label: "Client approver" as const,
        at: row.asked_at.toISOString(),
      },
      status: row.response_status ?? "open",
      latestResponse: row.response_revision === null
        || row.response_status === null
        || row.response_text === null
        || row.responded_at === null
        ? null
        : {
          revision: row.response_revision,
          status: row.response_status,
          text: row.response_text,
          attribution: {
            label: "Provider" as const,
            at: row.responded_at.toISOString(),
          },
        },
      communicationEffect: "communication-only",
    }));

  const corrections = (await sql<CorrectionListRow>`
    select
      c.id as concern_id,
      c.project_id,
      p.provider_display_name as project_display_name,
      c.packet_id as request_id,
      packet.provider_title as request_title,
      coalesce(v.snapshot->>'title','Published unit') as unit_title,
      u.current_version,
      c.claim,
      c.admitted_at,
      exists (
        select 1 from holds h
        where h.workspace_id = c.workspace_id
          and h.project_id = c.project_id
          and h.unit_id = c.origin_unit_id
          and h.concern_id = c.id
          and h.reason = 'correction'
          and h.resolved_at is null
      ) as correction_hold_active,
      exists (
        select 1 from holds h
        where h.workspace_id = c.workspace_id
          and h.project_id = c.project_id
          and h.unit_id = c.origin_unit_id
          and h.resolved_at is null
          and not (
            h.concern_id = c.id
            and h.reason = 'correction'
          )
      ) as other_hold_present,
      response.revision as response_revision,
      response.disposition as response_disposition,
      response.explanation as response_text,
      response.recorded_at as response_recorded_at,
      assessment.assessment_revision,
      assessment.applicability as assessment_applicability,
      assessment.response_revision as assessment_response_revision,
      assessment.draft_revision as assessment_draft_revision,
      assessment.assessed_at
    from corrections c
    join grants g
      on g.workspace_id = c.workspace_id
      and g.project_id = c.project_id
      and g.actor_id = ${providerActorId}
      and g.action = 'inspect'
      and g.epoch = ${providerGrantEpoch}
      and g.active = true
    join projects p
      on p.workspace_id = c.workspace_id
      and p.id = c.project_id
    join packets packet
      on packet.workspace_id = c.workspace_id
      and packet.project_id = c.project_id
      and packet.id = c.packet_id
    join units u
      on u.workspace_id = c.workspace_id
      and u.project_id = c.project_id
      and u.id = c.origin_unit_id
      and u.current_version is not null
    join unit_versions v
      on v.workspace_id = u.workspace_id
      and v.project_id = u.project_id
      and v.unit_id = u.id
      and v.version = u.current_version
    left join lateral (
      select r.revision,r.disposition,r.explanation,r.recorded_at
      from correction_responses r
      where r.workspace_id = c.workspace_id
        and r.project_id = c.project_id
        and r.concern_id = c.id
      order by r.revision desc
      limit 1
    ) response on true
    left join lateral (
      select a.assessment_revision,a.applicability,a.response_revision,
        a.draft_revision,a.assessed_at
      from provider_reconciliation_assessments a
      where a.workspace_id = c.workspace_id
        and a.project_id = c.project_id
        and a.concern_id = c.id
      order by a.assessment_revision desc
      limit 1
    ) assessment on true
    where c.workspace_id = ${workspaceId}
    order by c.admitted_at desc,c.id collate "C"
  `.execute(current.kysely)).rows.map((row): ReconciliationCorrection => {
    const claim = correctionClaim(row.claim);
    return Object.freeze({
      concernId: row.concern_id,
      projectName: projectName(row.project_display_name, row.project_id),
      requestTitle: requestTitle(row.request_title, row.request_id),
      unitTitle: row.unit_title,
      version: row.current_version,
      statement: claim.statement,
      claimedSourceType: claim.claimedSourceType,
      sourceAvailability: claim.sourceAvailability,
      admitted: {
        label: "Client approver" as const,
        at: row.admitted_at.toISOString(),
      },
      correctionHoldActive: row.correction_hold_active,
      otherHoldPresent: row.other_hold_present,
      latestResponse: row.response_revision === null
        || row.response_disposition === null
        || row.response_text === null
        || row.response_recorded_at === null
        ? null
        : {
          revision: row.response_revision,
          disposition: row.response_disposition,
          text: row.response_text,
          attribution: {
            label: "Provider" as const,
            at: row.response_recorded_at.toISOString(),
          },
        },
      latestAssessment: row.assessment_revision === null
        || row.assessment_applicability === null
        || row.assessment_response_revision === null
        || row.assessed_at === null
        ? null
        : {
          revision: row.assessment_revision,
          applicability: row.assessment_applicability,
          responseRevision: row.assessment_response_revision,
          reissueDraftRevision: row.assessment_draft_revision,
          attribution: {
            label: "Provider" as const,
            at: row.assessed_at.toISOString(),
          },
        },
    });
  });
  return Object.freeze({
    questions: Object.freeze(questions),
    corrections: Object.freeze(corrections),
  });
}

async function loadQuestionTarget(questionId: string) {
  const rows = (await sql<{ project_id: string; unit_version: number }>`
    select project_id,unit_version
    from client_questions
    where workspace_id = ${workspaceId}
      and question_id = ${questionId}::uuid
    order by project_id collate "C"
    limit 2
  `.execute(database().kysely)).rows;
  const row = rows.length === 1 ? rows[0] : null;
  return row
    ? Object.freeze({ projectId: row.project_id, version: row.unit_version })
    : null;
}

async function loadCorrectionTarget(concernId: string) {
  const rows = (await sql<{
    project_id: string;
    current_version: number | null;
  }>`
    select c.project_id,u.current_version
    from corrections c
    join units u
      on u.workspace_id = c.workspace_id
      and u.project_id = c.project_id
      and u.id = c.origin_unit_id
    where c.workspace_id = ${workspaceId}
      and c.id = ${concernId}
    order by c.project_id collate "C"
    limit 2
  `.execute(database().kysely)).rows;
  const row = rows.length === 1 ? rows[0] : null;
  return row?.current_version
    ? Object.freeze({ projectId: row.project_id, version: row.current_version })
    : null;
}

async function authorize(
  projectId: string,
  action: "inspect" | "review",
): Promise<boolean> {
  const result = await sql`select 1 from grants
    where workspace_id = ${workspaceId}
      and project_id = ${projectId}
      and actor_id = ${providerActorId}
      and action = ${action}
      and epoch = ${providerGrantEpoch}
      and active = true
    limit 1`.execute(database().kysely);
  return result.rows.length === 1;
}

async function hasInboxGrant(): Promise<boolean> {
  const result = await sql`select 1 from grants
    where workspace_id = ${workspaceId}
      and actor_id = ${providerActorId}
      and action = 'inspect'
      and epoch = ${providerGrantEpoch}
      and active = true
    limit 1`.execute(database().kysely);
  return result.rows.length === 1;
}

async function recordQuestionResponse(input: Readonly<{
  questionId: string;
  expectedVersion: number;
  commandId: string;
  status: QuestionResponseStatus;
  response: string;
}>) {
  const current = database();
  const requestDigest = digest({
    workspaceId,
    actorId: providerActorId,
    ...input,
  });
  return current.transaction(async (transaction) => {
    const questions = (await sql<{
      project_id: string;
      unit_id: string;
      unit_version: number;
      current_version: number | null;
    }>`select q.project_id,q.unit_id,q.unit_version,u.current_version
      from client_questions q
      join units u
        on u.workspace_id = q.workspace_id
        and u.project_id = q.project_id
        and u.id = q.unit_id
      where q.workspace_id = ${workspaceId}
        and q.question_id = ${input.questionId}::uuid
      order by q.project_id collate "C"
      limit 2
      for update of u`.execute(transaction)).rows;
    const question = questions.length === 1 ? questions[0] : null;
    if (!question) conflict("NOT_FOUND", "Question not found");
    const existing = (await sql<{
      request_digest: string;
      revision: number;
      status: QuestionResponseStatus;
      responded_at: Date;
    }>`select request_digest,revision,status,responded_at
      from provider_question_responses
      where workspace_id = ${workspaceId}
        and project_id = ${question.project_id}
        and responded_by = ${providerActorId}
        and command_id = ${input.commandId}::uuid
    `.execute(transaction)).rows[0];
    if (existing) {
      if (existing.request_digest !== requestDigest) {
        conflict(
          "IDEMPOTENCY_CONFLICT",
          "Question response idempotency content differs",
        );
      }
      return Object.freeze({
        duplicate: true,
        revision: existing.revision,
        status: existing.status,
        recordedAt: existing.responded_at.toISOString(),
      });
    }
    const grant = await sql`select 1 from grants
      where workspace_id = ${workspaceId}
        and project_id = ${question.project_id}
        and actor_id = ${providerActorId}
        and action = 'review'
        and epoch = ${providerGrantEpoch}
        and active = true
      for key share`.execute(transaction);
    if (!grant.rows.length) conflict("ACCESS_DENIED", "Review grant is inactive");
    if (
      question.unit_version !== input.expectedVersion
      || question.current_version !== input.expectedVersion
    ) {
      conflict("STALE_UNIT_VERSION", "Question review basis is stale");
    }
    const revision = ((await sql<{ revision: number | null }>`
      select max(revision)::integer as revision
      from provider_question_responses
      where workspace_id = ${workspaceId}
        and project_id = ${question.project_id}
        and question_id = ${input.questionId}::uuid
    `.execute(transaction)).rows[0]?.revision ?? 0) + 1;
    const recordDigest = digest({
      workspaceId,
      projectId: question.project_id,
      questionId: input.questionId,
      revision,
      commandId: input.commandId,
      status: input.status,
      response: input.response,
      respondedBy: providerActorId,
    });
    const inserted = (await sql<{
      revision: number;
      status: QuestionResponseStatus;
      responded_at: Date;
    }>`insert into provider_question_responses(
        workspace_id,project_id,question_id,revision,command_id,
        request_digest,status,response_text,responded_by,record_digest
      ) values (
        ${workspaceId},${question.project_id},${input.questionId}::uuid,
        ${revision},${input.commandId}::uuid,${requestDigest},${input.status},
        ${input.response},${providerActorId},${recordDigest}
      )
      returning revision,status,responded_at
    `.execute(transaction)).rows[0];
    if (!inserted) conflict("QUESTION_RESPONSE_CONFLICT", "Response not recorded");
    return Object.freeze({
      duplicate: false,
      revision: inserted.revision,
      status: inserted.status,
      recordedAt: inserted.responded_at.toISOString(),
    });
  });
}

type CurrentCorrection = Readonly<{
  projectId: string;
  requestId: string;
  unitId: string;
  version: number;
  digest: string;
  snapshot: PublishedUnit;
}>;

async function currentCorrection(
  concernId: string,
  expectedVersion: number,
): Promise<CurrentCorrection> {
  const rows = (await sql<{
    project_id: string;
    request_id: string;
    unit_id: string;
    current_version: number;
    digest: string;
    snapshot: unknown;
    hold_active: boolean;
  }>`select
      c.project_id,
      c.packet_id as request_id,
      c.origin_unit_id as unit_id,
      u.current_version,
      v.digest,
      v.snapshot,
      exists (
        select 1 from holds h
        where h.workspace_id = c.workspace_id
          and h.project_id = c.project_id
          and h.unit_id = c.origin_unit_id
          and h.concern_id = c.id
          and h.reason = 'correction'
          and h.resolved_at is null
      ) as hold_active
    from corrections c
    join units u
      on u.workspace_id = c.workspace_id
      and u.project_id = c.project_id
      and u.id = c.origin_unit_id
      and u.current_version is not null
    join unit_versions v
      on v.workspace_id = u.workspace_id
      and v.project_id = u.project_id
      and v.unit_id = u.id
      and v.version = u.current_version
    where c.workspace_id = ${workspaceId}
      and c.id = ${concernId}
    order by c.project_id collate "C"
    limit 2
  `.execute(database().kysely)).rows;
  const row = rows.length === 1 ? rows[0] : null;
  if (!row) conflict("NOT_FOUND", "Correction not found");
  if (row.current_version !== expectedVersion) {
    conflict("STALE_UNIT_VERSION", "Correction review basis is stale");
  }
  if (!row.hold_active) conflict("REVIEW_HOLD", "Correction hold is inactive");
  return Object.freeze({
    projectId: row.project_id,
    requestId: row.request_id,
    unitId: row.unit_id,
    version: row.current_version,
    digest: row.digest,
    snapshot: parseInput(publishedUnitSchema, row.snapshot),
  });
}

function responseDisposition(applicability: CorrectionApplicability) {
  switch (applicability) {
    case "material-change":
      return "accept" as const;
    case "needs-information":
      return "request-information" as const;
    default:
      return "maintain" as const;
  }
}

async function assessCorrection(input: Readonly<{
  concernId: string;
  expectedVersion: number;
  commandId: string;
  applicability: CorrectionApplicability;
  response: string;
  sourceReview: string;
}>) {
  const current = database();
  const priorRows = (await sql<{
    project_id: string;
    request_digest: string;
    assessment_revision: number;
    response_revision: number;
    applicability: CorrectionApplicability;
    draft_revision: number | null;
    assessed_at: Date;
  }>`select project_id,request_digest,assessment_revision,response_revision,
      applicability,draft_revision,assessed_at
    from provider_reconciliation_assessments
    where workspace_id = ${workspaceId}
      and concern_id = ${input.concernId}
      and assessed_by = ${providerActorId}
      and command_id = ${input.commandId}::uuid
    order by project_id collate "C"
    limit 2
  `.execute(current.kysely)).rows;
  const prior = priorRows.length === 1 ? priorRows[0] : null;
  if (prior) {
    const priorRequestDigest = digest({
      workspaceId,
      actorId: providerActorId,
      projectId: prior.project_id,
      ...input,
    });
    if (prior.request_digest !== priorRequestDigest) {
      conflict("IDEMPOTENCY_CONFLICT", "Assessment idempotency content differs");
    }
    return Object.freeze({
      duplicate: true,
      assessmentRevision: prior.assessment_revision,
      responseRevision: prior.response_revision,
      applicability: prior.applicability,
      reissueDraftRevision: prior.draft_revision,
      assessedAt: prior.assessed_at.toISOString(),
    });
  }
  const basis = await currentCorrection(input.concernId, input.expectedVersion);
  const requestDigest = digest({
    workspaceId,
    actorId: providerActorId,
    projectId: basis.projectId,
    ...input,
  });
  const existing = (await sql<{
    request_digest: string;
    assessment_revision: number;
    response_revision: number;
    applicability: CorrectionApplicability;
    draft_revision: number | null;
    assessed_at: Date;
  }>`select request_digest,assessment_revision,response_revision,
      applicability,draft_revision,assessed_at
    from provider_reconciliation_assessments
    where workspace_id = ${workspaceId}
      and project_id = ${basis.projectId}
      and assessed_by = ${providerActorId}
      and command_id = ${input.commandId}::uuid
  `.execute(current.kysely)).rows[0];
  if (existing) {
    if (existing.request_digest !== requestDigest) {
      conflict("IDEMPOTENCY_CONFLICT", "Assessment idempotency content differs");
    }
    return Object.freeze({
      duplicate: true,
      assessmentRevision: existing.assessment_revision,
      responseRevision: existing.response_revision,
      applicability: existing.applicability,
      reissueDraftRevision: existing.draft_revision,
      assessedAt: existing.assessed_at.toISOString(),
    });
  }

  const receipt = (await sql<{ result: unknown }>`select result
    from command_receipts
    where workspace_id = ${workspaceId}
      and project_id = ${basis.projectId}
      and actor_id = ${providerActorId}
      and command_id = ${input.commandId}::uuid
      and action = 'review'
  `.execute(current.kysely)).rows[0];
  const receiptRevision = receipt?.result
    && typeof receipt.result === "object"
    && !Array.isArray(receipt.result)
    && Number.isSafeInteger(
      (receipt.result as Record<string, unknown>).responseRevision,
    )
    ? Number((receipt.result as Record<string, unknown>).responseRevision)
    : null;
  const responseRevision = receiptRevision
    ?? (((await sql<{ revision: number | null }>`
      select max(revision)::integer as revision
      from correction_responses
      where workspace_id = ${workspaceId}
        and project_id = ${basis.projectId}
        and concern_id = ${input.concernId}
    `.execute(current.kysely)).rows[0]?.revision ?? 0) + 1);
  const store = new OrderedConsentStore(current);
  await store.respondToCorrection({
    workspaceId,
    projectId: basis.projectId,
    actorId: providerActorId,
    grantEpoch: providerGrantEpoch,
  }, {
    commandId: input.commandId,
    concernId: input.concernId,
    responseRevision,
    disposition: responseDisposition(input.applicability),
    sourceReview: input.sourceReview,
    explanation: input.response,
  });

  let draftRevision: number | null = null;
  let draftDigest: string | null = null;
  if (input.applicability === "material-change") {
    const authoring = new PostgresAuthoringStore(current);
    const latestDraft = (await sql<{ revision: number | null }>`
      select max(revision)::integer as revision
      from provider_authoring_draft_versions
      where workspace_id = ${workspaceId}
        and project_id = ${basis.projectId}
        and unit_id = ${basis.unitId}
    `.execute(current.kysely)).rows[0]?.revision ?? null;
    const summary = [
      `Reissue draft derived from exact published unit version ${basis.version}.`,
      `Provider-attributed material correction assessment: ${input.response}`,
    ].join("\n\n");
    const saved = await authoring.saveDraft({
      workspaceId,
      projectId: basis.projectId,
      requestId: basis.requestId,
      unitId: basis.unitId,
      revision: (latestDraft ?? 0) + 1,
      expectedPreviousRevision: latestDraft,
      state: "in-progress",
      title: basis.snapshot.title,
      summary,
      scope: basis.snapshot.scope,
      exclusions: basis.snapshot.exclusions,
      sourceReferences: basis.snapshot.sourceReferences.map((source) => ({
        sourceId: source.id,
        version: source.version,
      })),
      authoredBy: providerActorId,
    });
    draftRevision = saved.draft.revision;
    draftDigest = saved.draft.draftDigest;
  }

  return current.transaction(async (transaction) => {
    const replay = (await sql<{
      request_digest: string;
      assessment_revision: number;
      response_revision: number;
      applicability: CorrectionApplicability;
      draft_revision: number | null;
      assessed_at: Date;
    }>`select request_digest,assessment_revision,response_revision,
        applicability,draft_revision,assessed_at
      from provider_reconciliation_assessments
      where workspace_id = ${workspaceId}
        and project_id = ${basis.projectId}
        and assessed_by = ${providerActorId}
        and command_id = ${input.commandId}::uuid
    `.execute(transaction)).rows[0];
    if (replay) {
      if (replay.request_digest !== requestDigest) {
        conflict("IDEMPOTENCY_CONFLICT", "Assessment idempotency content differs");
      }
      return Object.freeze({
        duplicate: true,
        assessmentRevision: replay.assessment_revision,
        responseRevision: replay.response_revision,
        applicability: replay.applicability,
        reissueDraftRevision: replay.draft_revision,
        assessedAt: replay.assessed_at.toISOString(),
      });
    }
    const grant = await sql`select 1 from grants
      where workspace_id = ${workspaceId}
        and project_id = ${basis.projectId}
        and actor_id = ${providerActorId}
        and action = 'review'
        and epoch = ${providerGrantEpoch}
        and active = true
      for key share`.execute(transaction);
    if (!grant.rows.length) conflict("ACCESS_DENIED", "Review grant is inactive");
    const locked = (await sql<{
      current_version: number | null;
      digest: string | null;
      hold_active: boolean;
    }>`select u.current_version,v.digest,
        exists (
          select 1 from holds h
          where h.workspace_id = u.workspace_id
            and h.project_id = u.project_id
            and h.unit_id = u.id
            and h.concern_id = ${input.concernId}
            and h.reason = 'correction'
            and h.resolved_at is null
        ) as hold_active
      from units u
      left join unit_versions v
        on v.workspace_id = u.workspace_id
        and v.project_id = u.project_id
        and v.unit_id = u.id
        and v.version = u.current_version
      where u.workspace_id = ${workspaceId}
        and u.project_id = ${basis.projectId}
        and u.id = ${basis.unitId}
      for update of u`.execute(transaction)).rows[0];
    if (
      !locked
      || locked.current_version !== basis.version
      || locked.digest !== basis.digest
    ) {
      conflict("STALE_UNIT_VERSION", "Correction review basis changed");
    }
    if (!locked.hold_active) conflict("REVIEW_HOLD", "Correction hold is inactive");
    const assessmentRevision = ((await sql<{ revision: number | null }>`
      select max(assessment_revision)::integer as revision
      from provider_reconciliation_assessments
      where workspace_id = ${workspaceId}
        and project_id = ${basis.projectId}
        and concern_id = ${input.concernId}
    `.execute(transaction)).rows[0]?.revision ?? 0) + 1;
    const recordDigest = digest({
      workspaceId,
      projectId: basis.projectId,
      concernId: input.concernId,
      assessmentRevision,
      commandId: input.commandId,
      applicability: input.applicability,
      requestId: basis.requestId,
      unitId: basis.unitId,
      unitVersion: basis.version,
      unitDigest: basis.digest,
      responseRevision,
      providerResponse: input.response,
      sourceReview: input.sourceReview,
      assessedBy: providerActorId,
      draftRevision,
      draftDigest,
    });
    const inserted = (await sql<{
      assessment_revision: number;
      response_revision: number;
      applicability: CorrectionApplicability;
      draft_revision: number | null;
      assessed_at: Date;
    }>`insert into provider_reconciliation_assessments(
        workspace_id,project_id,concern_id,assessment_revision,command_id,
        request_digest,applicability,request_id,unit_id,unit_version,
        unit_digest,response_revision,provider_response,source_review,
        assessed_by,draft_revision,draft_digest,record_digest
      ) values (
        ${workspaceId},${basis.projectId},${input.concernId},
        ${assessmentRevision},${input.commandId}::uuid,${requestDigest},
        ${input.applicability},${basis.requestId},${basis.unitId},
        ${basis.version},${basis.digest},${responseRevision},${input.response},
        ${input.sourceReview},${providerActorId},${draftRevision},
        ${draftDigest},${recordDigest}
      )
      returning assessment_revision,response_revision,applicability,
        draft_revision,assessed_at
    `.execute(transaction)).rows[0];
    if (!inserted) conflict("ASSESSMENT_CONFLICT", "Assessment not recorded");
    return Object.freeze({
      duplicate: false,
      assessmentRevision: inserted.assessment_revision,
      responseRevision: inserted.response_revision,
      applicability: inserted.applicability,
      reissueDraftRevision: inserted.draft_revision,
      assessedAt: inserted.assessed_at.toISOString(),
    });
  });
}

export function reconciliationDependencies(): ReconciliationDependencies {
  return Object.freeze({
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    hasInboxGrant,
    listInbox,
    loadQuestionTarget,
    loadCorrectionTarget,
    authorize: ({ projectId, action }) => authorize(projectId, action),
    recordQuestionResponse,
    assessCorrection,
  });
}
