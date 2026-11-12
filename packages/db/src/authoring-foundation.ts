import { createHash } from "node:crypto";
import { sql } from "kysely";
import type {
  ProtocolDatabase,
  ProtocolTransaction,
  SqlExecutor,
} from "./index.js";

type Scope = Readonly<{ workspaceId: string; projectId: string }>;

export type AuthoringPersistenceErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PROJECT_CONFLICT"
  | "REQUEST_CONFLICT"
  | "SOURCE_CONFLICT"
  | "DRAFT_CONFLICT"
  | "STALE_DRAFT_REVISION"
  | "QUESTION_CONFLICT";

export class AuthoringPersistenceError extends Error {
  constructor(
    public readonly code: AuthoringPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthoringPersistenceError";
  }
}

export type ProviderProjectRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  displayName: string;
  clientId: string;
  initialApproverId: string;
  createdBy: string;
  createdAt: Date;
}>;

export type ProviderRequestRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  title: string;
  createdBy: string;
  createdAt: Date;
}>;

export type SourceAvailability = "available" | "unavailable";
export type SourceIntakeKind =
  | "provider-upload"
  | "provider-note"
  | "client-supplied"
  | "external-reference";
export type SourceOrigin =
  | "agreement"
  | "amendment"
  | "correspondence"
  | "request"
  | "prior-decision"
  | "correction"
  | "other";
export type SourcePermissionState = "permitted" | "denied" | "unresolved";
export type SourceAcceptanceKind =
  | "provider-attested-import"
  | "in-app-record-reference"
  | "unverified";
export type ModelInputReview =
  | Readonly<{
    status: "cleared";
    reviewerId: string;
    reviewedAt: Date | string;
    basis: string;
  }>
  | Readonly<{
    status: "not-reviewed" | "unresolved" | "prohibited-financial-data";
    basis: string;
  }>;

export type SourceIntakeInput = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  version: number;
  availability: SourceAvailability;
  reviewedBy: string;
  sourceKind: SourceIntakeKind;
  mediaType: string;
  originalName: string | null;
  declaredByteLength: number;
  contentDigest: string | null;
  provenance: Readonly<{
    origin: SourceOrigin;
    suppliedBy: string;
    originReference: string | null;
    acceptance: Readonly<{
      kind: SourceAcceptanceKind;
      basis: string;
    }>;
  }>;
  permissions: Readonly<{
    studioSharing: SourcePermissionState;
    modelProcessing: SourcePermissionState;
    modelInputReview: ModelInputReview;
  }>;
}>;

export type SourceIntakeRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  version: number;
  availability: SourceAvailability;
  reviewedBy: string;
  sourceKind: SourceIntakeKind;
  mediaType: string;
  originalName: string | null;
  declaredByteLength: number;
  contentDigest: string | null;
  provenance: Readonly<{
    origin: SourceOrigin;
    suppliedBy: string;
    originReference: string | null;
    acceptance: Readonly<{
      kind: SourceAcceptanceKind;
      basis: string;
    }>;
  }>;
  permissions: Readonly<{
    studioSharing: SourcePermissionState;
    modelProcessing: SourcePermissionState;
    modelInputReview: Readonly<
      | {
        status: "cleared";
        reviewerId: string;
        reviewedAt: Date;
        basis: string;
      }
      | {
        status: "not-reviewed" | "unresolved" | "prohibited-financial-data";
        basis: string;
      }
    >;
  }>;
  recordedAt: Date;
  recordDigest: string;
}>;

export type DraftState = "in-progress" | "ready-for-client-review";
export type DraftSourceReference = Readonly<{
  sourceId: string;
  version: number;
}>;
export type ProviderDraftRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  unitId: string;
  revision: number;
  state: DraftState;
  title: string;
  summary: string;
  scope: readonly string[];
  exclusions: readonly string[];
  sourceReferences: readonly DraftSourceReference[];
  draftDigest: string;
  authoredBy: string;
  createdAt: Date;
}>;

export type ClientQuestionRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  questionId: string;
  requestId: string;
  unitId: string;
  unitVersion: number;
  askedBy: string;
  exactText: string;
  modelProcessing: "permitted" | "denied";
  communicationEffect: "communication-only";
  askedAt: Date;
  recordDigest: string;
}>;

type ProjectRow = {
  workspace_id: string;
  id: string;
  provider_display_name: string;
  provider_initial_client_id: string;
  provider_initial_approver_id: string;
  provider_created_by: string;
  provider_created_at: Date;
  provider_creation_digest: string;
};

type RequestRow = {
  workspace_id: string;
  project_id: string;
  id: string;
  provider_title: string;
  provider_created_by: string;
  provider_created_at: Date;
  provider_creation_digest: string;
};

type SourceRow = {
  workspace_id: string;
  project_id: string;
  source_id: string;
  source_version: number;
  availability: SourceAvailability;
  reviewed_by: string;
  source_kind: SourceIntakeKind;
  media_type: string;
  original_name: string | null;
  declared_byte_length: string | number;
  content_digest: string | null;
  provenance_origin: SourceOrigin;
  supplied_by: string;
  origin_reference: string | null;
  acceptance_kind: SourceAcceptanceKind;
  acceptance_basis: string;
  studio_sharing: SourcePermissionState;
  model_processing: SourcePermissionState;
  model_input_review_status:
    | "cleared"
    | "not-reviewed"
    | "unresolved"
    | "prohibited-financial-data";
  model_reviewed_by: string | null;
  model_reviewed_at: Date | null;
  model_review_basis: string;
  recorded_at: Date;
  record_digest: string;
};

type DraftRow = {
  workspace_id: string;
  project_id: string;
  request_id: string;
  unit_id: string;
  revision: number;
  state: DraftState;
  title: string;
  summary: string;
  scope_items: string[];
  exclusion_items: string[];
  source_count: number;
  draft_digest: string;
  authored_by: string;
  created_at: Date;
};

type DraftSourceRow = {
  source_id: string;
  source_version: number;
};

type QuestionRow = {
  workspace_id: string;
  project_id: string;
  question_id: string;
  request_id: string;
  unit_id: string;
  unit_version: number;
  asked_by: string;
  exact_text: string;
  model_processing: "permitted" | "denied";
  communication_effect: "communication-only";
  asked_at: Date;
  record_digest: string;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const mediaTypePattern =
  /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function invalid(message: string): never {
  throw new AuthoringPersistenceError("INVALID_INPUT", message);
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value.toLowerCase();
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function integer(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${name} is invalid`);
  }
  return Number(value);
}

function instant(value: unknown, name: string): Date {
  const parsed = value instanceof Date
    ? new Date(value.getTime())
    : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) invalid(`${name} is invalid`);
  return parsed;
}

function boundedText(
  value: unknown,
  name: string,
  maximum: number,
  options: {
    preserveWhitespace?: boolean;
    allowLines?: boolean;
    allowWhitespaceOnly?: boolean;
  } = {},
): string {
  if (typeof value !== "string" || invalidUnicode.test(value)) {
    invalid(`${name} is invalid`);
  }
  const points = Array.from(value);
  const controls = options.allowLines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (
    points.length < 1
    || points.length > maximum
    || controls.test(value)
    || (!options.preserveWhitespace && value !== value.trim())
    || (!options.allowWhitespaceOnly && value.trim().length === 0)
  ) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function optionalBoundedText(
  value: unknown,
  name: string,
  maximum: number,
  options: { preserveWhitespace?: boolean; allowLines?: boolean } = {},
): string | null {
  return value === null || value === undefined
    ? null
    : boundedText(value, name, maximum, options);
}

function scope(input: Scope): Scope {
  return Object.freeze({
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    projectId: identifier(input.projectId, "projectId"),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid("canonical number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) {
      invalid("canonical value is invalid");
    }
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  invalid("canonical value is invalid");
}

function recordDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function projectRecord(row: ProjectRow): ProviderProjectRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.id,
    displayName: row.provider_display_name,
    clientId: row.provider_initial_client_id,
    initialApproverId: row.provider_initial_approver_id,
    createdBy: row.provider_created_by,
    createdAt: instant(row.provider_created_at, "createdAt"),
  });
}

function requestRecord(row: RequestRow): ProviderRequestRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    requestId: row.id,
    title: row.provider_title,
    createdBy: row.provider_created_by,
    createdAt: instant(row.provider_created_at, "createdAt"),
  });
}

function sourceRecord(row: SourceRow): SourceIntakeRecord {
  const modelInputReview = row.model_input_review_status === "cleared"
    ? Object.freeze({
      status: "cleared" as const,
      reviewerId: row.model_reviewed_by!,
      reviewedAt: instant(row.model_reviewed_at, "modelReviewedAt"),
      basis: row.model_review_basis,
    })
    : Object.freeze({
      status: row.model_input_review_status,
      basis: row.model_review_basis,
    });
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    sourceId: row.source_id,
    version: row.source_version,
    availability: row.availability,
    reviewedBy: row.reviewed_by,
    sourceKind: row.source_kind,
    mediaType: row.media_type,
    originalName: row.original_name,
    declaredByteLength: Number(row.declared_byte_length),
    contentDigest: row.content_digest,
    provenance: Object.freeze({
      origin: row.provenance_origin,
      suppliedBy: row.supplied_by,
      originReference: row.origin_reference,
      acceptance: Object.freeze({
        kind: row.acceptance_kind,
        basis: row.acceptance_basis,
      }),
    }),
    permissions: Object.freeze({
      studioSharing: row.studio_sharing,
      modelProcessing: row.model_processing,
      modelInputReview,
    }),
    recordedAt: instant(row.recorded_at, "recordedAt"),
    recordDigest: row.record_digest,
  });
}

function draftRecord(
  row: DraftRow,
  sources: readonly DraftSourceRow[],
): ProviderDraftRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    requestId: row.request_id,
    unitId: row.unit_id,
    revision: row.revision,
    state: row.state,
    title: row.title,
    summary: row.summary,
    scope: Object.freeze([...row.scope_items]),
    exclusions: Object.freeze([...row.exclusion_items]),
    sourceReferences: Object.freeze(sources.map((source) => Object.freeze({
      sourceId: source.source_id,
      version: source.source_version,
    }))),
    draftDigest: row.draft_digest,
    authoredBy: row.authored_by,
    createdAt: instant(row.created_at, "createdAt"),
  });
}

function questionRecord(row: QuestionRow): ClientQuestionRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    questionId: row.question_id,
    requestId: row.request_id,
    unitId: row.unit_id,
    unitVersion: row.unit_version,
    askedBy: row.asked_by,
    exactText: row.exact_text,
    modelProcessing: row.model_processing,
    communicationEffect: row.communication_effect,
    askedAt: instant(row.asked_at, "askedAt"),
    recordDigest: row.record_digest,
  });
}

export class PostgresAuthoringStore {
  private readonly clock: () => Date;

  constructor(
    private readonly database: ProtocolDatabase,
    options: { clock?: () => Date } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  async createProject(input: Scope & {
    displayName: string;
    clientId: string;
    initialApproverId: string;
    createdBy: string;
  }): Promise<Readonly<{ duplicate: boolean; project: ProviderProjectRecord }>> {
    const target = scope(input);
    const displayName = boundedText(input.displayName, "displayName", 200);
    const clientId = identifier(input.clientId, "clientId");
    const initialApproverId = identifier(
      input.initialApproverId,
      "initialApproverId",
    );
    const createdBy = identifier(input.createdBy, "createdBy");
    const creationDigest = recordDigest({
      ...target,
      displayName,
      clientId,
      initialApproverId,
      createdBy,
    });
    const createdAt = instant(this.clock(), "createdAt");
    return this.database.transaction(async (transaction) => {
      await this.requireWorkspace(transaction, target.workspaceId);
      const inserted = await sql<ProjectRow>`insert into projects(
          workspace_id,id,client_id,approver_id,
          provider_display_name,provider_created_by,provider_created_at,
          provider_initial_client_id,provider_initial_approver_id,
          provider_creation_digest
        ) values (
          ${target.workspaceId},${target.projectId},${clientId},${initialApproverId},
          ${displayName},${createdBy},${createdAt},${clientId},${initialApproverId},
          ${creationDigest}
        )
        on conflict (workspace_id,id) do nothing
        returning workspace_id,id,provider_display_name,
          provider_initial_client_id,provider_initial_approver_id,
          provider_created_by,provider_created_at,provider_creation_digest`
        .execute(transaction);
      if (inserted.rows[0]) {
        return Object.freeze({
          duplicate: false,
          project: projectRecord(inserted.rows[0]),
        });
      }
      const existing = await this.loadProject(transaction, target);
      if (!existing || existing.digest !== creationDigest) {
        throw new AuthoringPersistenceError(
          "PROJECT_CONFLICT",
          "The scoped project identity already has different creation content",
        );
      }
      return Object.freeze({ duplicate: true, project: existing.record });
    });
  }

  async readProject(input: Scope): Promise<ProviderProjectRecord | null> {
    const loaded = await this.loadProject(this.database.kysely, scope(input));
    return loaded?.record ?? null;
  }

  async createRequest(input: Scope & {
    requestId: string;
    title: string;
    createdBy: string;
  }): Promise<Readonly<{ duplicate: boolean; request: ProviderRequestRecord }>> {
    const target = scope(input);
    const requestId = identifier(input.requestId, "requestId");
    const title = boundedText(input.title, "title", 200);
    const createdBy = identifier(input.createdBy, "createdBy");
    const creationDigest = recordDigest({
      ...target,
      requestId,
      title,
      createdBy,
    });
    const createdAt = instant(this.clock(), "createdAt");
    return this.database.transaction(async (transaction) => {
      await this.requireProject(transaction, target);
      const inserted = await sql<RequestRow>`insert into packets(
          workspace_id,project_id,id,provider_title,provider_created_by,
          provider_created_at,provider_creation_digest
        ) values (
          ${target.workspaceId},${target.projectId},${requestId},${title},
          ${createdBy},${createdAt},${creationDigest}
        )
        on conflict (workspace_id,project_id,id) do nothing
        returning workspace_id,project_id,id,provider_title,provider_created_by,
          provider_created_at,provider_creation_digest`.execute(transaction);
      if (inserted.rows[0]) {
        return Object.freeze({
          duplicate: false,
          request: requestRecord(inserted.rows[0]),
        });
      }
      const existing = await this.loadRequest(transaction, {
        ...target,
        requestId,
      });
      if (!existing || existing.digest !== creationDigest) {
        throw new AuthoringPersistenceError(
          "REQUEST_CONFLICT",
          "The scoped request identity already has different creation content",
        );
      }
      return Object.freeze({ duplicate: true, request: existing.record });
    });
  }

  async readRequest(
    input: Scope & { requestId: string },
  ): Promise<ProviderRequestRecord | null> {
    const target = scope(input);
    const loaded = await this.loadRequest(this.database.kysely, {
      ...target,
      requestId: identifier(input.requestId, "requestId"),
    });
    return loaded?.record ?? null;
  }

  async recordSourceIntake(
    input: SourceIntakeInput,
  ): Promise<Readonly<{ duplicate: boolean; source: SourceIntakeRecord }>> {
    const normalized = this.normalizeSource(input);
    return this.database.transaction(async (transaction) => {
      await this.requireProject(transaction, normalized);
      await sql`insert into source_versions(
          workspace_id,project_id,id,version,availability,reviewed_by
        ) values (
          ${normalized.workspaceId},${normalized.projectId},${normalized.sourceId},
          ${normalized.version},${normalized.availability},${normalized.reviewedBy}
        )
        on conflict (workspace_id,project_id,id,version) do nothing`
        .execute(transaction);
      const basis = (await sql<{
        availability: SourceAvailability;
        reviewed_by: string;
      }>`select availability,reviewed_by from source_versions
        where workspace_id = ${normalized.workspaceId}
          and project_id = ${normalized.projectId}
          and id = ${normalized.sourceId}
          and version = ${normalized.version}
        for key share`.execute(transaction)).rows[0];
      if (
        !basis
        || basis.availability !== normalized.availability
        || basis.reviewed_by !== normalized.reviewedBy
      ) {
        throw new AuthoringPersistenceError(
          "SOURCE_CONFLICT",
          "The scoped source version already has a different basis",
        );
      }
      const review = normalized.permissions.modelInputReview;
      const inserted = await sql<SourceRow>`insert into source_intake_records(
          workspace_id,project_id,source_id,source_version,source_kind,media_type,
          original_name,declared_byte_length,content_digest,provenance_origin,
          supplied_by,origin_reference,acceptance_kind,acceptance_basis,
          studio_sharing,model_processing,model_input_review_status,
          model_reviewed_by,model_reviewed_at,model_review_basis,
          recorded_at,record_digest
        ) values (
          ${normalized.workspaceId},${normalized.projectId},${normalized.sourceId},
          ${normalized.version},${normalized.sourceKind},${normalized.mediaType},
          ${normalized.originalName},${normalized.declaredByteLength},
          ${normalized.contentDigest},${normalized.provenance.origin},
          ${normalized.provenance.suppliedBy},${normalized.provenance.originReference},
          ${normalized.provenance.acceptance.kind},
          ${normalized.provenance.acceptance.basis},
          ${normalized.permissions.studioSharing},
          ${normalized.permissions.modelProcessing},${review.status},
          ${review.status === "cleared" ? review.reviewerId : null},
          ${review.status === "cleared" ? review.reviewedAt : null},
          ${review.basis},${normalized.recordedAt},${normalized.recordDigest}
        )
        on conflict (workspace_id,project_id,source_id,source_version) do nothing
        returning ${this.sourceColumns()}`.execute(transaction);
      if (inserted.rows[0]) {
        return Object.freeze({
          duplicate: false,
          source: sourceRecord(inserted.rows[0]),
        });
      }
      const existing = await this.loadSource(transaction, normalized);
      if (!existing || existing.recordDigest !== normalized.recordDigest) {
        throw new AuthoringPersistenceError(
          "SOURCE_CONFLICT",
          "The scoped source version already has different intake content",
        );
      }
      return Object.freeze({ duplicate: true, source: existing });
    });
  }

  async readSourceIntake(
    input: Scope & { sourceId: string; version: number },
  ): Promise<SourceIntakeRecord | null> {
    const target = scope(input);
    return this.loadSource(this.database.kysely, {
      ...target,
      sourceId: identifier(input.sourceId, "sourceId"),
      version: integer(input.version, "version", 1, 2_147_483_647),
    });
  }

  async saveDraft(input: Scope & {
    requestId: string;
    unitId: string;
    revision: number;
    expectedPreviousRevision: number | null;
    state: DraftState;
    title: string;
    summary: string;
    scope: readonly string[];
    exclusions: readonly string[];
    sourceReferences: readonly DraftSourceReference[];
    authoredBy: string;
  }): Promise<Readonly<{ duplicate: boolean; draft: ProviderDraftRecord }>> {
    const normalized = this.normalizeDraft(input);
    return this.database.transaction(async (transaction) => {
      await this.requireRequest(transaction, normalized);
      await sql`insert into units(workspace_id,project_id,id,packet_id)
        values (
          ${normalized.workspaceId},${normalized.projectId},${normalized.unitId},
          ${normalized.requestId}
        )
        on conflict (workspace_id,project_id,id) do nothing`.execute(transaction);
      const unit = (await sql<{ packet_id: string }>`select packet_id from units
        where workspace_id = ${normalized.workspaceId}
          and project_id = ${normalized.projectId}
          and id = ${normalized.unitId}
        for update`.execute(transaction)).rows[0];
      if (!unit || unit.packet_id !== normalized.requestId) {
        throw new AuthoringPersistenceError(
          "DRAFT_CONFLICT",
          "The scoped unit belongs to a different request",
        );
      }
      const existing = await this.loadDraft(transaction, normalized);
      if (existing) {
        if (existing.draftDigest !== normalized.draftDigest) {
          throw new AuthoringPersistenceError(
            "DRAFT_CONFLICT",
            "The scoped draft revision already has different content",
          );
        }
        return Object.freeze({ duplicate: true, draft: existing });
      }
      const latest = (await sql<{ revision: number | null }>`
        select max(revision)::integer as revision
        from provider_authoring_draft_versions
        where workspace_id = ${normalized.workspaceId}
          and project_id = ${normalized.projectId}
          and unit_id = ${normalized.unitId}`.execute(transaction)).rows[0]
        ?.revision ?? null;
      if (
        normalized.expectedPreviousRevision !== latest
        || normalized.revision !== (latest ?? 0) + 1
      ) {
        throw new AuthoringPersistenceError(
          "STALE_DRAFT_REVISION",
          "Draft revision does not follow the current scoped revision",
        );
      }
      for (const reference of normalized.sourceReferences) {
        const found = await sql`select 1 from source_versions
          where workspace_id = ${normalized.workspaceId}
            and project_id = ${normalized.projectId}
            and id = ${reference.sourceId}
            and version = ${reference.version}
          for key share`.execute(transaction);
        if (!found.rows.length) {
          throw new AuthoringPersistenceError(
            "NOT_FOUND",
            "A scoped draft source version was not found",
          );
        }
      }
      await sql`insert into provider_authoring_draft_versions(
          workspace_id,project_id,request_id,unit_id,revision,state,title,summary,
          scope_items,exclusion_items,source_count,draft_digest,authored_by,created_at
        ) values (
          ${normalized.workspaceId},${normalized.projectId},${normalized.requestId},
          ${normalized.unitId},${normalized.revision},${normalized.state},
          ${normalized.title},${normalized.summary},
          ${JSON.stringify(normalized.scope)}::jsonb,
          ${JSON.stringify(normalized.exclusions)}::jsonb,
          ${normalized.sourceReferences.length},${normalized.draftDigest},
          ${normalized.authoredBy},${normalized.createdAt}
        )`.execute(transaction);
      for (const [index, reference] of normalized.sourceReferences.entries()) {
        await sql`insert into provider_authoring_draft_sources(
            workspace_id,project_id,unit_id,draft_revision,position,
            source_id,source_version
          ) values (
            ${normalized.workspaceId},${normalized.projectId},${normalized.unitId},
            ${normalized.revision},${index + 1},${reference.sourceId},
            ${reference.version}
          )`.execute(transaction);
      }
      return Object.freeze({
        duplicate: false,
        draft: Object.freeze({
          workspaceId: normalized.workspaceId,
          projectId: normalized.projectId,
          requestId: normalized.requestId,
          unitId: normalized.unitId,
          revision: normalized.revision,
          state: normalized.state,
          title: normalized.title,
          summary: normalized.summary,
          scope: normalized.scope,
          exclusions: normalized.exclusions,
          sourceReferences: normalized.sourceReferences,
          draftDigest: normalized.draftDigest,
          authoredBy: normalized.authoredBy,
          createdAt: normalized.createdAt,
        }),
      });
    });
  }

  async readDraft(input: Scope & {
    requestId: string;
    unitId: string;
    revision: number;
  }): Promise<ProviderDraftRecord | null> {
    const target = scope(input);
    return this.loadDraft(this.database.kysely, {
      ...target,
      requestId: identifier(input.requestId, "requestId"),
      unitId: identifier(input.unitId, "unitId"),
      revision: integer(input.revision, "revision", 1, 2_147_483_647),
    });
  }

  async askQuestion(input: Scope & {
    questionId: string;
    requestId: string;
    unitId: string;
    unitVersion: number;
    askedBy: string;
    exactText: string;
    modelProcessing: "permitted" | "denied";
  }): Promise<Readonly<{ duplicate: boolean; question: ClientQuestionRecord }>> {
    const target = scope(input);
    const questionId = uuid(input.questionId, "questionId");
    const requestId = identifier(input.requestId, "requestId");
    const unitId = identifier(input.unitId, "unitId");
    const unitVersion = integer(
      input.unitVersion,
      "unitVersion",
      1,
      2_147_483_647,
    );
    const askedBy = identifier(input.askedBy, "askedBy");
    const exactText = boundedText(input.exactText, "exactText", 10_000, {
      preserveWhitespace: true,
      allowLines: true,
    });
    if (
      input.modelProcessing !== "permitted"
      && input.modelProcessing !== "denied"
    ) {
      invalid("modelProcessing is invalid");
    }
    const recordDigestValue = recordDigest({
      ...target,
      questionId,
      requestId,
      unitId,
      unitVersion,
      askedBy,
      exactText,
      modelProcessing: input.modelProcessing,
      communicationEffect: "communication-only",
    });
    const askedAt = instant(this.clock(), "askedAt");
    return this.database.transaction(async (transaction) => {
      const basis = await sql`select 1
        from units u
        join unit_versions v
          on v.workspace_id = u.workspace_id
          and v.project_id = u.project_id
          and v.unit_id = u.id
        where u.workspace_id = ${target.workspaceId}
          and u.project_id = ${target.projectId}
          and u.id = ${unitId}
          and u.packet_id = ${requestId}
          and v.version = ${unitVersion}
        for key share of u,v`.execute(transaction);
      if (!basis.rows.length) {
        throw new AuthoringPersistenceError(
          "NOT_FOUND",
          "The exact scoped review basis was not found",
        );
      }
      const inserted = await sql<QuestionRow>`insert into client_questions(
          workspace_id,project_id,question_id,request_id,unit_id,unit_version,
          asked_by,exact_text,model_processing,communication_effect,
          asked_at,record_digest
        ) values (
          ${target.workspaceId},${target.projectId},${questionId}::uuid,
          ${requestId},${unitId},${unitVersion},${askedBy},${exactText},
          ${input.modelProcessing},'communication-only',${askedAt},
          ${recordDigestValue}
        )
        on conflict (workspace_id,project_id,question_id) do nothing
        returning workspace_id,project_id,question_id::text,request_id,unit_id,
          unit_version,asked_by,exact_text,model_processing,communication_effect,
          asked_at,record_digest`.execute(transaction);
      if (inserted.rows[0]) {
        return Object.freeze({
          duplicate: false,
          question: questionRecord(inserted.rows[0]),
        });
      }
      const existing = await this.loadQuestion(transaction, {
        ...target,
        questionId,
      });
      if (!existing || existing.recordDigest !== recordDigestValue) {
        throw new AuthoringPersistenceError(
          "QUESTION_CONFLICT",
          "The scoped question identity already has different content",
        );
      }
      return Object.freeze({ duplicate: true, question: existing });
    });
  }

  async readQuestion(
    input: Scope & { questionId: string },
  ): Promise<ClientQuestionRecord | null> {
    const target = scope(input);
    return this.loadQuestion(this.database.kysely, {
      ...target,
      questionId: uuid(input.questionId, "questionId"),
    });
  }

  private normalizeSource(input: SourceIntakeInput): SourceIntakeRecord {
    const target = scope(input);
    const sourceId = identifier(input.sourceId, "sourceId");
    const version = integer(input.version, "version", 1, 2_147_483_647);
    if (input.availability !== "available" && input.availability !== "unavailable") {
      invalid("availability is invalid");
    }
    const reviewedBy = identifier(input.reviewedBy, "reviewedBy");
    if (!([
      "provider-upload",
      "provider-note",
      "client-supplied",
      "external-reference",
    ] as const).includes(input.sourceKind)) {
      invalid("sourceKind is invalid");
    }
    if (typeof input.mediaType !== "string" || !mediaTypePattern.test(input.mediaType)) {
      invalid("mediaType is invalid");
    }
    const originalName = optionalBoundedText(
      input.originalName,
      "originalName",
      255,
    );
    const declaredByteLength = integer(
      input.declaredByteLength,
      "declaredByteLength",
      0,
      10_000_000,
    );
    const contentDigest = input.contentDigest === null
      ? null
      : digest(input.contentDigest, "contentDigest");
    if (
      (input.availability === "available"
        && (declaredByteLength === 0 || contentDigest === null))
      || (input.availability === "unavailable"
        && (declaredByteLength !== 0 || contentDigest !== null))
    ) {
      invalid("availability does not match the declared content");
    }
    if (!([
      "agreement",
      "amendment",
      "correspondence",
      "request",
      "prior-decision",
      "correction",
      "other",
    ] as const).includes(input.provenance.origin)) {
      invalid("provenance.origin is invalid");
    }
    const suppliedBy = identifier(input.provenance.suppliedBy, "suppliedBy");
    const originReference = optionalBoundedText(
      input.provenance.originReference,
      "originReference",
      2_000,
      { preserveWhitespace: true, allowLines: true },
    );
    if (!([
      "provider-attested-import",
      "in-app-record-reference",
      "unverified",
    ] as const).includes(input.provenance.acceptance.kind)) {
      invalid("acceptance.kind is invalid");
    }
    const acceptanceBasis = boundedText(
      input.provenance.acceptance.basis,
      "acceptance.basis",
      2_000,
      { preserveWhitespace: true, allowLines: true },
    );
    const permissionState = (
      value: unknown,
      name: string,
    ): SourcePermissionState => {
      if (value !== "permitted" && value !== "denied" && value !== "unresolved") {
        invalid(`${name} is invalid`);
      }
      return value;
    };
    const studioSharing = permissionState(
      input.permissions.studioSharing,
      "studioSharing",
    );
    const modelProcessing = permissionState(
      input.permissions.modelProcessing,
      "modelProcessing",
    );
    const review = input.permissions.modelInputReview;
    let modelInputReview: SourceIntakeRecord["permissions"]["modelInputReview"];
    if (review.status === "cleared") {
      if (modelProcessing !== "permitted") {
        invalid("cleared model review requires permitted processing");
      }
      modelInputReview = Object.freeze({
        status: "cleared",
        reviewerId: identifier(review.reviewerId, "reviewerId"),
        reviewedAt: instant(review.reviewedAt, "reviewedAt"),
        basis: boundedText(review.basis, "modelReviewBasis", 2_000, {
          preserveWhitespace: true,
          allowLines: true,
        }),
      });
    } else {
      if (
        review.status !== "not-reviewed"
        && review.status !== "unresolved"
        && review.status !== "prohibited-financial-data"
      ) {
        invalid("modelInputReview.status is invalid");
      }
      modelInputReview = Object.freeze({
        status: review.status,
        basis: boundedText(review.basis, "modelReviewBasis", 2_000, {
          preserveWhitespace: true,
          allowLines: true,
        }),
      });
    }
    const digestInput = {
      ...target,
      sourceId,
      version,
      availability: input.availability,
      reviewedBy,
      sourceKind: input.sourceKind,
      mediaType: input.mediaType,
      originalName,
      declaredByteLength,
      contentDigest,
      provenance: {
        origin: input.provenance.origin,
        suppliedBy,
        originReference,
        acceptance: {
          kind: input.provenance.acceptance.kind,
          basis: acceptanceBasis,
        },
      },
      permissions: {
        studioSharing,
        modelProcessing,
        modelInputReview: modelInputReview.status === "cleared"
          ? {
            ...modelInputReview,
            reviewedAt: modelInputReview.reviewedAt.toISOString(),
          }
          : modelInputReview,
      },
    };
    return Object.freeze({
      ...digestInput,
      provenance: Object.freeze({
        ...digestInput.provenance,
        acceptance: Object.freeze(digestInput.provenance.acceptance),
      }),
      permissions: Object.freeze({
        ...digestInput.permissions,
        modelInputReview,
      }),
      recordedAt: instant(this.clock(), "recordedAt"),
      recordDigest: recordDigest(digestInput),
    });
  }

  private normalizeDraft(input: Scope & {
    requestId: string;
    unitId: string;
    revision: number;
    expectedPreviousRevision: number | null;
    state: DraftState;
    title: string;
    summary: string;
    scope: readonly string[];
    exclusions: readonly string[];
    sourceReferences: readonly DraftSourceReference[];
    authoredBy: string;
  }) {
    const target = scope(input);
    const requestId = identifier(input.requestId, "requestId");
    const unitId = identifier(input.unitId, "unitId");
    const revision = integer(input.revision, "revision", 1, 2_147_483_647);
    const expectedPreviousRevision = input.expectedPreviousRevision === null
      ? null
      : integer(
        input.expectedPreviousRevision,
        "expectedPreviousRevision",
        1,
        2_147_483_647,
      );
    if (input.state !== "in-progress" && input.state !== "ready-for-client-review") {
      invalid("state is invalid");
    }
    const title = boundedText(input.title, "title", 200);
    const summary = boundedText(input.summary, "summary", 10_000, {
      preserveWhitespace: true,
      allowLines: true,
    });
    const textArray = (
      value: readonly string[],
      name: string,
      minimum: number,
    ): readonly string[] => {
      if (!Array.isArray(value) || value.length < minimum || value.length > 100) {
        invalid(`${name} is invalid`);
      }
      return Object.freeze(value.map((item, index) =>
        boundedText(item, `${name}.${index}`, 10_000, { allowLines: true })));
    };
    const scopeItems = textArray(input.scope, "scope", 1);
    const exclusions = textArray(input.exclusions, "exclusions", 0);
    if (
      !Array.isArray(input.sourceReferences)
      || input.sourceReferences.length > 100
    ) {
      invalid("sourceReferences is invalid");
    }
    const seen = new Set<string>();
    const sourceReferences = Object.freeze(input.sourceReferences.map(
      (reference, index) => {
        const normalized = Object.freeze({
          sourceId: identifier(
            reference.sourceId,
            `sourceReferences.${index}.sourceId`,
          ),
          version: integer(
            reference.version,
            `sourceReferences.${index}.version`,
            1,
            2_147_483_647,
          ),
        });
        const key = `${normalized.sourceId}\u0000${normalized.version}`;
        if (seen.has(key)) invalid("sourceReferences contains a duplicate");
        seen.add(key);
        return normalized;
      },
    ));
    const authoredBy = identifier(input.authoredBy, "authoredBy");
    const digestInput = {
      ...target,
      requestId,
      unitId,
      revision,
      state: input.state,
      title,
      summary,
      scope: scopeItems,
      exclusions,
      sourceReferences,
      authoredBy,
    };
    return Object.freeze({
      ...digestInput,
      expectedPreviousRevision,
      createdAt: instant(this.clock(), "createdAt"),
      draftDigest: recordDigest(digestInput),
    });
  }

  private sourceColumns() {
    return sql`workspace_id,project_id,source_id,source_version,
      (select availability from source_versions sv
        where sv.workspace_id = source_intake_records.workspace_id
          and sv.project_id = source_intake_records.project_id
          and sv.id = source_intake_records.source_id
          and sv.version = source_intake_records.source_version) as availability,
      (select reviewed_by from source_versions sv
        where sv.workspace_id = source_intake_records.workspace_id
          and sv.project_id = source_intake_records.project_id
          and sv.id = source_intake_records.source_id
          and sv.version = source_intake_records.source_version) as reviewed_by,
      source_kind,media_type,original_name,declared_byte_length,content_digest,
      provenance_origin,supplied_by,origin_reference,acceptance_kind,
      acceptance_basis,studio_sharing,model_processing,model_input_review_status,
      model_reviewed_by,model_reviewed_at,model_review_basis,recorded_at,record_digest`;
  }

  private async requireWorkspace(
    transaction: ProtocolTransaction,
    workspaceId: string,
  ): Promise<void> {
    const found = await sql`select 1 from workspaces where id = ${workspaceId}
      for key share`.execute(transaction);
    if (!found.rows.length) {
      throw new AuthoringPersistenceError(
        "NOT_FOUND",
        "The scoped workspace was not found",
      );
    }
  }

  private async requireProject(
    transaction: ProtocolTransaction,
    target: Scope,
  ): Promise<void> {
    const found = await sql`select 1 from projects
      where workspace_id = ${target.workspaceId} and id = ${target.projectId}
      for key share`.execute(transaction);
    if (!found.rows.length) {
      throw new AuthoringPersistenceError(
        "NOT_FOUND",
        "The scoped project was not found",
      );
    }
  }

  private async requireRequest(
    transaction: ProtocolTransaction,
    target: Scope & { requestId: string },
  ): Promise<void> {
    const found = await sql`select 1 from packets
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and id = ${target.requestId}
      for key share`.execute(transaction);
    if (!found.rows.length) {
      throw new AuthoringPersistenceError(
        "NOT_FOUND",
        "The scoped request was not found",
      );
    }
  }

  private async loadProject(
    executor: SqlExecutor,
    target: Scope,
  ): Promise<Readonly<{ record: ProviderProjectRecord; digest: string }> | null> {
    const row = (await sql<ProjectRow>`select workspace_id,id,
        provider_display_name,provider_initial_client_id,
        provider_initial_approver_id,provider_created_by,provider_created_at,
        provider_creation_digest
      from projects
      where workspace_id = ${target.workspaceId}
        and id = ${target.projectId}
        and provider_creation_digest is not null`.execute(executor)).rows[0];
    return row
      ? Object.freeze({ record: projectRecord(row), digest: row.provider_creation_digest })
      : null;
  }

  private async loadRequest(
    executor: SqlExecutor,
    target: Scope & { requestId: string },
  ): Promise<Readonly<{ record: ProviderRequestRecord; digest: string }> | null> {
    const row = (await sql<RequestRow>`select workspace_id,project_id,id,
        provider_title,provider_created_by,provider_created_at,
        provider_creation_digest
      from packets
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and id = ${target.requestId}
        and provider_creation_digest is not null`.execute(executor)).rows[0];
    return row
      ? Object.freeze({ record: requestRecord(row), digest: row.provider_creation_digest })
      : null;
  }

  private async loadSource(
    executor: SqlExecutor,
    target: Scope & { sourceId: string; version: number },
  ): Promise<SourceIntakeRecord | null> {
    const row = (await sql<SourceRow>`select sir.workspace_id,sir.project_id,
        sir.source_id,sir.source_version,sv.availability,sv.reviewed_by,
        sir.source_kind,sir.media_type,sir.original_name,sir.declared_byte_length,
        sir.content_digest,sir.provenance_origin,sir.supplied_by,
        sir.origin_reference,sir.acceptance_kind,sir.acceptance_basis,
        sir.studio_sharing,sir.model_processing,sir.model_input_review_status,
        sir.model_reviewed_by,sir.model_reviewed_at,sir.model_review_basis,
        sir.recorded_at,sir.record_digest
      from source_intake_records sir
      join source_versions sv
        on sv.workspace_id = sir.workspace_id
        and sv.project_id = sir.project_id
        and sv.id = sir.source_id
        and sv.version = sir.source_version
      where sir.workspace_id = ${target.workspaceId}
        and sir.project_id = ${target.projectId}
        and sir.source_id = ${target.sourceId}
        and sir.source_version = ${target.version}`.execute(executor)).rows[0];
    return row ? sourceRecord(row) : null;
  }

  private async loadDraft(
    executor: SqlExecutor,
    target: Scope & { requestId: string; unitId: string; revision: number },
  ): Promise<ProviderDraftRecord | null> {
    const row = (await sql<DraftRow>`select workspace_id,project_id,request_id,
        unit_id,revision,state,title,summary,scope_items,exclusion_items,
        source_count,draft_digest,authored_by,created_at
      from provider_authoring_draft_versions
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and request_id = ${target.requestId}
        and unit_id = ${target.unitId}
        and revision = ${target.revision}`.execute(executor)).rows[0];
    if (!row) return null;
    const sources = (await sql<DraftSourceRow>`select source_id,source_version
      from provider_authoring_draft_sources
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and unit_id = ${target.unitId}
        and draft_revision = ${target.revision}
      order by position`.execute(executor)).rows;
    if (sources.length !== row.source_count) {
      throw new AuthoringPersistenceError(
        "DRAFT_CONFLICT",
        "The durable draft source inventory is inconsistent",
      );
    }
    return draftRecord(row, sources);
  }

  private async loadQuestion(
    executor: SqlExecutor,
    target: Scope & { questionId: string },
  ): Promise<ClientQuestionRecord | null> {
    const row = (await sql<QuestionRow>`select workspace_id,project_id,
        question_id::text,request_id,unit_id,unit_version,asked_by,exact_text,
        model_processing,communication_effect,asked_at,record_digest
      from client_questions
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and question_id = ${target.questionId}::uuid`.execute(executor)).rows[0];
    return row ? questionRecord(row) : null;
  }
}
