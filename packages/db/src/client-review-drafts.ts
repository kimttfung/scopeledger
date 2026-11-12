import { sql } from "kysely";
import type {
  ProtocolDatabase,
  ProtocolTransaction,
} from "./index.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const subjectPattern = /^[a-f0-9]{64}$/u;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const invalidControl = /(?![\t\n])\p{Cc}/u;
const TEXT_LIMIT = 10_000;
const EXPIRY_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;

export type ClientReviewDraftKind = "question" | "correction";
export type ClientReviewDraftAuthority = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  unitId: string;
  participantSubjectDigest: string;
  actorId: string;
  nominationEpoch: number;
  kind: ClientReviewDraftKind;
}>;
export type ClientReviewDraftContent = Readonly<{
  exactText: string;
  correctionSourceText: string | null;
  modelProcessing: "permitted" | "denied";
}>;
export type ClientReviewDraftRecord =
  ClientReviewDraftAuthority
  & ClientReviewDraftContent
  & Readonly<{
    revision: number;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date;
  }>;

export type ClientReviewDraftErrorCode =
  | "ACCESS_DENIED"
  | "DRAFT_CONFLICT"
  | "INVALID_INPUT";

export class ClientReviewDraftError extends Error {
  constructor(
    public readonly code: ClientReviewDraftErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClientReviewDraftError";
  }
}

type DraftRow = Readonly<{
  workspace_id: string;
  project_id: string;
  request_id: string;
  unit_id: string;
  participant_subject_digest: string;
  actor_id: string;
  nomination_epoch: number;
  kind: ClientReviewDraftKind;
  revision: number;
  exact_text: string;
  correction_source_text: string | null;
  model_processing: "permitted" | "denied";
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}>;

function fail(
  code: ClientReviewDraftErrorCode,
  message: string,
): never {
  throw new ClientReviewDraftError(code, message);
}

function identifier(value: string, label: string): string {
  if (!identifierPattern.test(value)) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function exactText(
  value: string,
  label: string,
  required: boolean,
): string {
  if (
    typeof value !== "string"
    || Array.from(value).length > TEXT_LIMIT
    || invalidUnicode.test(value)
    || invalidControl.test(value)
    || (required && value.trim().length === 0)
    || (!required && value.length === 0)
  ) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

function normalizeAuthority(
  input: ClientReviewDraftAuthority,
): ClientReviewDraftAuthority {
  if (!subjectPattern.test(input.participantSubjectDigest)) {
    fail("INVALID_INPUT", "participantSubjectDigest is invalid");
  }
  if (input.kind !== "question" && input.kind !== "correction") {
    fail("INVALID_INPUT", "kind is invalid");
  }
  return Object.freeze({
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    projectId: identifier(input.projectId, "projectId"),
    requestId: identifier(input.requestId, "requestId"),
    unitId: identifier(input.unitId, "unitId"),
    participantSubjectDigest: input.participantSubjectDigest,
    actorId: identifier(input.actorId, "actorId"),
    nominationEpoch: positiveInteger(
      input.nominationEpoch,
      "nominationEpoch",
    ),
    kind: input.kind,
  });
}

function normalizeContent(
  kind: ClientReviewDraftKind,
  input: ClientReviewDraftContent,
): ClientReviewDraftContent {
  if (
    input.modelProcessing !== "permitted"
    && input.modelProcessing !== "denied"
  ) {
    fail("INVALID_INPUT", "modelProcessing is invalid");
  }
  const correctionSourceText = input.correctionSourceText === null
    ? null
    : exactText(input.correctionSourceText, "correctionSourceText", true);
  if (kind === "question" && correctionSourceText !== null) {
    fail("INVALID_INPUT", "Question drafts cannot contain correction source text");
  }
  return Object.freeze({
    exactText: exactText(input.exactText, "exactText", true),
    correctionSourceText,
    modelProcessing: input.modelProcessing,
  });
}

function instant(value: Date, label: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    fail("INVALID_INPUT", `${label} is invalid`);
  }
  return result;
}

function sameContent(
  row: DraftRow,
  content: ClientReviewDraftContent,
): boolean {
  return row.exact_text === content.exactText
    && row.correction_source_text === content.correctionSourceText
    && row.model_processing === content.modelProcessing;
}

function record(row: DraftRow): ClientReviewDraftRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    requestId: row.request_id,
    unitId: row.unit_id,
    participantSubjectDigest: row.participant_subject_digest,
    actorId: row.actor_id,
    nominationEpoch: row.nomination_epoch,
    kind: row.kind,
    revision: row.revision,
    exactText: row.exact_text,
    correctionSourceText: row.correction_source_text,
    modelProcessing: row.model_processing,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
  });
}

function lockKey(authority: ClientReviewDraftAuthority): string {
  return [
    "scopeledger-client-review-draft-v1",
    authority.workspaceId,
    authority.projectId,
    authority.requestId,
    authority.unitId,
    authority.participantSubjectDigest,
    authority.actorId,
    String(authority.nominationEpoch),
    authority.kind,
  ].join("/");
}

async function authorize(
  transaction: ProtocolTransaction,
  authority: ClientReviewDraftAuthority,
): Promise<void> {
  const basis = (await sql<{
    approver_id: string;
    nomination_epoch: number;
    current_version: number | null;
  }>`select p.approver_id,p.nomination_epoch,u.current_version
    from projects p
    join units u
      on u.workspace_id = p.workspace_id
      and u.project_id = p.id
      and u.id = ${authority.unitId}
      and u.packet_id = ${authority.requestId}
    where p.workspace_id = ${authority.workspaceId}
      and p.id = ${authority.projectId}
    for key share of p,u`.execute(transaction)).rows[0];
  if (
    !basis
    || basis.current_version === null
    || basis.approver_id !== authority.actorId
    || basis.nomination_epoch !== authority.nominationEpoch
  ) {
    fail("ACCESS_DENIED", "Current scoped client-approver authority is required");
  }
  const requiredActions = authority.kind === "correction"
    ? ["inspect", "decide", "correct"]
    : ["inspect", "decide"];
  const grants = (await sql<{
    action: string;
    active: boolean;
  }>`select action,active from grants
    where workspace_id = ${authority.workspaceId}
      and project_id = ${authority.projectId}
      and actor_id = ${authority.actorId}
      and action = any(${requiredActions}::text[])
    for key share`.execute(transaction)).rows;
  const active = new Map(grants.map((grant) => [
    grant.action,
    grant.active,
  ]));
  if (requiredActions.some((action) => active.get(action) !== true)) {
    fail("ACCESS_DENIED", "Current scoped client-approver authority is required");
  }
}

async function loadRow(
  transaction: ProtocolTransaction,
  authority: ClientReviewDraftAuthority,
): Promise<DraftRow | null> {
  return (await sql<DraftRow>`select workspace_id,project_id,request_id,
      unit_id,participant_subject_digest,actor_id,nomination_epoch,kind,
      revision,exact_text,correction_source_text,model_processing,
      created_at,updated_at,expires_at
    from client_review_drafts
    where workspace_id = ${authority.workspaceId}
      and project_id = ${authority.projectId}
      and request_id = ${authority.requestId}
      and unit_id = ${authority.unitId}
      and participant_subject_digest = ${authority.participantSubjectDigest}
      and actor_id = ${authority.actorId}
      and nomination_epoch = ${authority.nominationEpoch}
      and kind = ${authority.kind}
    for update`.execute(transaction)).rows[0] ?? null;
}

async function removeExpired(
  transaction: ProtocolTransaction,
  authority: ClientReviewDraftAuthority,
  row: DraftRow | null,
  now: Date,
): Promise<DraftRow | null> {
  if (!row || row.expires_at.getTime() > now.getTime()) return row;
  await sql`delete from client_review_drafts
    where workspace_id = ${authority.workspaceId}
      and project_id = ${authority.projectId}
      and request_id = ${authority.requestId}
      and unit_id = ${authority.unitId}
      and participant_subject_digest = ${authority.participantSubjectDigest}
      and actor_id = ${authority.actorId}
      and nomination_epoch = ${authority.nominationEpoch}
      and kind = ${authority.kind}
      and revision = ${row.revision}`.execute(transaction);
  return null;
}

export class PostgresClientReviewDraftStore {
  private readonly clock: () => Date;

  constructor(
    private readonly database: ProtocolDatabase,
    options: Readonly<{ clock?: () => Date }> = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  async read(
    authorityInput: ClientReviewDraftAuthority,
  ): Promise<ClientReviewDraftRecord | null> {
    const authority = normalizeAuthority(authorityInput);
    const now = instant(this.clock(), "clock");
    return this.database.transaction(async (transaction) => {
      await sql`select pg_advisory_xact_lock(
        hashtextextended(${lockKey(authority)},0)
      )`.execute(transaction);
      await authorize(transaction, authority);
      const current = await removeExpired(
        transaction,
        authority,
        await loadRow(transaction, authority),
        now,
      );
      return current ? record(current) : null;
    });
  }

  async save(
    authorityInput: ClientReviewDraftAuthority,
    input: ClientReviewDraftContent & Readonly<{
      expectedRevision: number | null;
    }>,
  ): Promise<Readonly<{
    created: boolean;
    duplicate: boolean;
    draft: ClientReviewDraftRecord;
  }>> {
    const authority = normalizeAuthority(authorityInput);
    const content = normalizeContent(authority.kind, input);
    const expectedRevision = input.expectedRevision === null
      ? null
      : positiveInteger(input.expectedRevision, "expectedRevision");
    const now = instant(this.clock(), "clock");
    const expiresAt = new Date(now.getTime() + EXPIRY_MILLISECONDS);
    return this.database.transaction(async (transaction) => {
      await sql`select pg_advisory_xact_lock(
        hashtextextended(${lockKey(authority)},0)
      )`.execute(transaction);
      await authorize(transaction, authority);
      const current = await removeExpired(
        transaction,
        authority,
        await loadRow(transaction, authority),
        now,
      );
      if (current && sameContent(current, content)) {
        const replay = (await sql<DraftRow>`update client_review_drafts
          set updated_at = ${now},expires_at = ${expiresAt}
          where workspace_id = ${authority.workspaceId}
            and project_id = ${authority.projectId}
            and request_id = ${authority.requestId}
            and unit_id = ${authority.unitId}
            and participant_subject_digest = ${authority.participantSubjectDigest}
            and actor_id = ${authority.actorId}
            and nomination_epoch = ${authority.nominationEpoch}
            and kind = ${authority.kind}
            and revision = ${current.revision}
          returning workspace_id,project_id,request_id,unit_id,
            participant_subject_digest,actor_id,nomination_epoch,kind,
            revision,exact_text,correction_source_text,model_processing,
            created_at,updated_at,expires_at`.execute(transaction)).rows[0];
        if (!replay) fail("DRAFT_CONFLICT", "The draft changed concurrently");
        return Object.freeze({
          created: false,
          duplicate: true,
          draft: record(replay),
        });
      }
      if (
        (current === null && expectedRevision !== null)
        || (current !== null && expectedRevision !== current.revision)
      ) {
        fail("DRAFT_CONFLICT", "The expected draft revision is stale");
      }
      if (!current) {
        const inserted = (await sql<DraftRow>`insert into client_review_drafts(
            workspace_id,project_id,request_id,unit_id,
            participant_subject_digest,actor_id,nomination_epoch,kind,
            revision,exact_text,correction_source_text,model_processing,
            draft_digest,created_at,updated_at,expires_at
          ) values (
            ${authority.workspaceId},${authority.projectId},
            ${authority.requestId},${authority.unitId},
            ${authority.participantSubjectDigest},${authority.actorId},
            ${authority.nominationEpoch},${authority.kind},1,
            ${content.exactText},${content.correctionSourceText},
            ${content.modelProcessing},
            client_review_draft_digest(
              ${authority.workspaceId},${authority.projectId},
              ${authority.requestId},${authority.unitId},
              ${authority.participantSubjectDigest},${authority.actorId},
              ${authority.nominationEpoch},${authority.kind},
              ${content.exactText},${content.correctionSourceText ?? ""},
              ${content.modelProcessing}
            ),
            ${now},${now},${expiresAt}
          )
          returning workspace_id,project_id,request_id,unit_id,
            participant_subject_digest,actor_id,nomination_epoch,kind,
            revision,exact_text,correction_source_text,model_processing,
            created_at,updated_at,expires_at`.execute(transaction)).rows[0];
        if (!inserted) fail("DRAFT_CONFLICT", "The draft was not created");
        return Object.freeze({
          created: true,
          duplicate: false,
          draft: record(inserted),
        });
      }
      const revision = current.revision + 1;
      const updated = (await sql<DraftRow>`update client_review_drafts
        set revision = ${revision},
          exact_text = ${content.exactText},
          correction_source_text = ${content.correctionSourceText},
          model_processing = ${content.modelProcessing},
          draft_digest = client_review_draft_digest(
            ${authority.workspaceId},${authority.projectId},
            ${authority.requestId},${authority.unitId},
            ${authority.participantSubjectDigest},${authority.actorId},
            ${authority.nominationEpoch},${authority.kind},
            ${content.exactText},${content.correctionSourceText ?? ""},
            ${content.modelProcessing}
          ),
          updated_at = ${now},expires_at = ${expiresAt}
        where workspace_id = ${authority.workspaceId}
          and project_id = ${authority.projectId}
          and request_id = ${authority.requestId}
          and unit_id = ${authority.unitId}
          and participant_subject_digest = ${authority.participantSubjectDigest}
          and actor_id = ${authority.actorId}
          and nomination_epoch = ${authority.nominationEpoch}
          and kind = ${authority.kind}
          and revision = ${current.revision}
        returning workspace_id,project_id,request_id,unit_id,
          participant_subject_digest,actor_id,nomination_epoch,kind,
          revision,exact_text,correction_source_text,model_processing,
          created_at,updated_at,expires_at`.execute(transaction)).rows[0];
      if (!updated) fail("DRAFT_CONFLICT", "The draft changed concurrently");
      return Object.freeze({
        created: false,
        duplicate: false,
        draft: record(updated),
      });
    });
  }

  async delete(
    authorityInput: ClientReviewDraftAuthority,
    expectedRevisionInput: number,
  ): Promise<Readonly<{ deleted: boolean }>> {
    const authority = normalizeAuthority(authorityInput);
    const expectedRevision = positiveInteger(
      expectedRevisionInput,
      "expectedRevision",
    );
    const now = instant(this.clock(), "clock");
    return this.database.transaction(async (transaction) => {
      await sql`select pg_advisory_xact_lock(
        hashtextextended(${lockKey(authority)},0)
      )`.execute(transaction);
      await authorize(transaction, authority);
      const current = await removeExpired(
        transaction,
        authority,
        await loadRow(transaction, authority),
        now,
      );
      if (!current) return Object.freeze({ deleted: false });
      if (current.revision !== expectedRevision) {
        fail("DRAFT_CONFLICT", "The expected draft revision is stale");
      }
      const deleted = await sql`delete from client_review_drafts
        where workspace_id = ${authority.workspaceId}
          and project_id = ${authority.projectId}
          and request_id = ${authority.requestId}
          and unit_id = ${authority.unitId}
          and participant_subject_digest = ${authority.participantSubjectDigest}
          and actor_id = ${authority.actorId}
          and nomination_epoch = ${authority.nominationEpoch}
          and kind = ${authority.kind}
          and revision = ${expectedRevision}`.execute(transaction);
      return Object.freeze({ deleted: deleted.numAffectedRows === 1n });
    });
  }
}
