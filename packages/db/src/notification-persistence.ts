import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { ProtocolDatabase, ProtocolTransaction, SqlExecutor } from "./index.js";

export type NotificationPurpose =
  | "client-question-submitted"
  | "client-correction-submitted"
  | "provider-question-responded"
  | "provider-correction-assessed"
  | "provider-reissue-published"
  | "participant-authority-activated"
  | "participant-authority-revoked"
  | "participant-authority-restored"
  | "payment-exception-observed";

export type NotificationRecipientRole =
  | "provider"
  | "client-approver"
  | "payer";

export type NotificationSourceKind =
  | "client-question"
  | "client-correction"
  | "provider-question-response"
  | "provider-correction-assessment"
  | "provider-publication"
  | "participant-history"
  | "payment-exception-history";

export type NotificationPayloadByPurpose = Readonly<{
  "client-question-submitted": Readonly<{
    questionId: string;
    requestId: string;
    unitId: string;
    unitVersion: number;
  }>;
  "client-correction-submitted": Readonly<{
    concernId: string;
    requestId: string;
    unitId: string;
    unitVersion: number;
  }>;
  "provider-question-responded": Readonly<{
    questionId: string;
    unitId: string;
    unitVersion: number;
    responseRevision: number;
    status: "answered" | "needs-client-information" | "closed";
  }>;
  "provider-correction-assessed": Readonly<{
    concernId: string;
    unitId: string;
    unitVersion: number;
    assessmentRevision: number;
    applicability:
      | "no-material-change"
      | "material-change"
      | "needs-information";
    reissueDraftRevision: number | null;
  }>;
  "provider-reissue-published": Readonly<{
    unitId: string;
    version: number;
    previousVersion: number;
  }>;
  "participant-authority-activated": ParticipantAuthorityPayload;
  "participant-authority-revoked": ParticipantAuthorityPayload;
  "participant-authority-restored": ParticipantAuthorityPayload;
  "payment-exception-observed": Readonly<{
    observationSequence: number;
    unitId: string;
    version: number;
    kind: "refund" | "capture-reversal";
    state:
      | "pending"
      | "partial-refund"
      | "full-refund"
      | "failed"
      | "reversed"
      | "unknown"
      | "mismatch";
  }>;
}>;

export type ParticipantAuthorityPayload = Readonly<{
  role: "client-approver" | "payer";
  change: "activated" | "revoked" | "restored";
  resourceId: string;
  authorityEpoch: number;
  unitId: string | null;
  version: number | null;
}>;

export type NotificationPayload =
  NotificationPayloadByPurpose[NotificationPurpose];

export type NotificationStatus =
  | "pending"
  | "leased"
  | "retry"
  | "delivered"
  | "suppressed"
  | "obsolete"
  | "manual";

export type NotificationAttemptOutcome =
  | "delivered"
  | "recovered"
  | "retry"
  | "suppressed"
  | "obsolete"
  | "manual"
  | "lease-expired";

export type NotificationRecord<P extends NotificationPurpose = NotificationPurpose> =
Readonly<{
  id: string;
  workspaceId: string;
  projectId: string;
  purpose: P;
  recipientRole: NotificationRecipientRole;
  attributedActorId: string;
  sourceKind: NotificationSourceKind;
  sourceKey: string;
  dedupeKey: string;
  payload: NotificationPayloadByPurpose[P];
  status: NotificationStatus;
  maxAttempts: number;
  attemptCount: number;
  availableAt: Date;
  enqueuedAt: Date;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  deliveredAt: Date | null;
  terminalAt: Date | null;
}>;

export type ClaimedNotification = NotificationRecord & Readonly<{
  status: "leased";
  leaseToken: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
  lastAttemptAt: Date;
}>;

export type NotificationIntent<P extends NotificationPurpose = NotificationPurpose> =
Readonly<{
  id?: string;
  workspaceId: string;
  projectId: string;
  purpose: P;
  recipientRole: NotificationRecipientRole;
  attributedActorId: string;
  sourceKind: NotificationSourceKind;
  sourceKey: string;
  dedupeKey: string;
  payload: NotificationPayloadByPurpose[P];
  maxAttempts?: number;
}>;

export type NotificationDispatchDecision =
  | Readonly<{
    outcome: "ready";
    recipientActorId: string;
    authorityEpoch: number;
  }>
  | Readonly<{
    outcome: "suppressed" | "obsolete";
    reasonCode: NotificationTerminalReason;
  }>;

export type NotificationTerminalReason =
  | "AUTHORITY_REVOKED"
  | "AUTHORITY_CHANGED"
  | "SOURCE_MISSING"
  | "VERSION_OBSOLETE"
  | "EVENT_SUPERSEDED"
  | "PAYMENT_NOT_DUE";

export type NotificationReceipt = Readonly<{
  notificationId: string;
  messageId: string;
  status: "reserved" | "delivered";
  reservedAt: Date;
  deliveredAt: Date | null;
}>;

export type NotificationPersistenceErrorCode =
  | "INVALID_INPUT"
  | "NOTIFICATION_CONFLICT"
  | "LEASE_LOST"
  | "INVALID_STATE";

export class NotificationPersistenceError extends Error {
  constructor(
    public readonly code: NotificationPersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NotificationPersistenceError";
  }
}

type NotificationRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  purpose: NotificationPurpose;
  recipient_role: NotificationRecipientRole;
  attributed_actor_id: string;
  source_kind: NotificationSourceKind;
  source_key: string;
  dedupe_key: string;
  payload: unknown;
  status: NotificationStatus;
  max_attempts: number;
  attempt_count: number;
  available_at: Date;
  enqueued_at: Date;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  last_attempt_at: Date | null;
  last_error_code: string | null;
  delivered_at: Date | null;
  terminal_at: Date | null;
};

const purposes = new Set<NotificationPurpose>([
  "client-question-submitted",
  "client-correction-submitted",
  "provider-question-responded",
  "provider-correction-assessed",
  "provider-reissue-published",
  "participant-authority-activated",
  "participant-authority-revoked",
  "participant-authority-restored",
  "payment-exception-observed",
]);
const recipientRoles = new Set<NotificationRecipientRole>([
  "provider",
  "client-approver",
  "payer",
]);
const sourceKinds = new Set<NotificationSourceKind>([
  "client-question",
  "client-correction",
  "provider-question-response",
  "provider-correction-assessment",
  "provider-publication",
  "participant-history",
  "payment-exception-history",
]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const scopedKeyPattern = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$/u;
const workerPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function invalid(message: string): never {
  throw new NotificationPersistenceError("INVALID_INPUT", message);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
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

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 999_999_999) {
    invalid(`${name} is invalid`);
  }
  return Number(value);
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    invalid(`${name} is invalid`);
  }
  return Number(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(`${name} is invalid`);
  }
  return value as T;
}

function payloadFor<P extends NotificationPurpose>(
  purpose: P,
  input: unknown,
): NotificationPayloadByPurpose[P] {
  let payload: NotificationPayload;
  switch (purpose) {
    case "client-question-submitted": {
      if (!exactObject(input, [
        "questionId", "requestId", "unitId", "unitVersion",
      ])) invalid("notification payload shape is invalid");
      payload = Object.freeze({
        questionId: uuid(input.questionId, "questionId"),
        requestId: identifier(input.requestId, "requestId"),
        unitId: identifier(input.unitId, "unitId"),
        unitVersion: positiveInteger(input.unitVersion, "unitVersion"),
      });
      break;
    }
    case "client-correction-submitted": {
      if (!exactObject(input, [
        "concernId", "requestId", "unitId", "unitVersion",
      ])) invalid("notification payload shape is invalid");
      payload = Object.freeze({
        concernId: identifier(input.concernId, "concernId"),
        requestId: identifier(input.requestId, "requestId"),
        unitId: identifier(input.unitId, "unitId"),
        unitVersion: positiveInteger(input.unitVersion, "unitVersion"),
      });
      break;
    }
    case "provider-question-responded": {
      if (!exactObject(input, [
        "questionId", "unitId", "unitVersion", "responseRevision", "status",
      ])) invalid("notification payload shape is invalid");
      payload = Object.freeze({
        questionId: uuid(input.questionId, "questionId"),
        unitId: identifier(input.unitId, "unitId"),
        unitVersion: positiveInteger(input.unitVersion, "unitVersion"),
        responseRevision: positiveInteger(
          input.responseRevision,
          "responseRevision",
        ),
        status: oneOf(input.status, [
          "answered",
          "needs-client-information",
          "closed",
        ] as const, "status"),
      });
      break;
    }
    case "provider-correction-assessed": {
      if (!exactObject(input, [
        "concernId",
        "unitId",
        "unitVersion",
        "assessmentRevision",
        "applicability",
        "reissueDraftRevision",
      ])) invalid("notification payload shape is invalid");
      payload = Object.freeze({
        concernId: identifier(input.concernId, "concernId"),
        unitId: identifier(input.unitId, "unitId"),
        unitVersion: positiveInteger(input.unitVersion, "unitVersion"),
        assessmentRevision: positiveInteger(
          input.assessmentRevision,
          "assessmentRevision",
        ),
        applicability: oneOf(input.applicability, [
          "no-material-change",
          "material-change",
          "needs-information",
        ] as const, "applicability"),
        reissueDraftRevision: input.reissueDraftRevision === null
          ? null
          : positiveInteger(
              input.reissueDraftRevision,
              "reissueDraftRevision",
            ),
      });
      break;
    }
    case "provider-reissue-published": {
      if (!exactObject(input, ["unitId", "version", "previousVersion"])) {
        invalid("notification payload shape is invalid");
      }
      const version = positiveInteger(input.version, "version");
      const previousVersion = positiveInteger(
        input.previousVersion,
        "previousVersion",
      );
      if (previousVersion + 1 !== version) {
        invalid("notification publication versions are invalid");
      }
      payload = Object.freeze({
        unitId: identifier(input.unitId, "unitId"),
        version,
        previousVersion,
      });
      break;
    }
    case "participant-authority-activated":
    case "participant-authority-revoked":
    case "participant-authority-restored": {
      if (!exactObject(input, [
        "role",
        "change",
        "resourceId",
        "authorityEpoch",
        "unitId",
        "version",
      ])) invalid("notification payload shape is invalid");
      const role = oneOf(input.role, [
        "client-approver",
        "payer",
      ] as const, "role");
      const change = oneOf(input.change, [
        "activated",
        "revoked",
        "restored",
      ] as const, "change");
      const expectedChange = purpose.slice(
        "participant-authority-".length,
      );
      if (change !== expectedChange) {
        invalid("participant notification purpose and change differ");
      }
      if (
        role === "client-approver"
        && (input.unitId !== null || input.version !== null)
      ) {
        invalid("approver authority payload cannot carry a unit");
      }
      if (
        role === "payer"
        && (input.unitId === null || input.version === null)
      ) {
        invalid("payer authority payload requires an exact unit");
      }
      payload = Object.freeze({
        role,
        change,
        resourceId: identifier(input.resourceId, "resourceId"),
        authorityEpoch: positiveInteger(
          input.authorityEpoch,
          "authorityEpoch",
        ),
        unitId: input.unitId === null
          ? null
          : identifier(input.unitId, "unitId"),
        version: input.version === null
          ? null
          : positiveInteger(input.version, "version"),
      });
      break;
    }
    case "payment-exception-observed": {
      if (!exactObject(input, [
        "observationSequence", "unitId", "version", "kind", "state",
      ])) invalid("notification payload shape is invalid");
      payload = Object.freeze({
        observationSequence: positiveSafeInteger(
          input.observationSequence,
          "observationSequence",
        ),
        unitId: identifier(input.unitId, "unitId"),
        version: positiveInteger(input.version, "version"),
        kind: oneOf(input.kind, [
          "refund",
          "capture-reversal",
        ] as const, "kind"),
        state: oneOf(input.state, [
          "pending",
          "partial-refund",
          "full-refund",
          "failed",
          "reversed",
          "unknown",
          "mismatch",
        ] as const, "state"),
      });
      break;
    }
  }
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 4096) {
    invalid("notification payload is too large");
  }
  return payload as NotificationPayloadByPurpose[P];
}

function rowRecord(row: NotificationRow): NotificationRecord {
  if (!purposes.has(row.purpose)) invalid("stored notification purpose is invalid");
  return Object.freeze({
    id: uuid(row.id, "id"),
    workspaceId: identifier(row.workspace_id, "workspaceId"),
    projectId: identifier(row.project_id, "projectId"),
    purpose: row.purpose,
    recipientRole: row.recipient_role,
    attributedActorId: identifier(
      row.attributed_actor_id,
      "attributedActorId",
    ),
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    dedupeKey: row.dedupe_key,
    payload: payloadFor(row.purpose, row.payload),
    status: row.status,
    maxAttempts: row.max_attempts,
    attemptCount: row.attempt_count,
    availableAt: new Date(row.available_at),
    enqueuedAt: new Date(row.enqueued_at),
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at
      ? new Date(row.lease_expires_at)
      : null,
    lastAttemptAt: row.last_attempt_at
      ? new Date(row.last_attempt_at)
      : null,
    lastErrorCode: row.last_error_code,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
    terminalAt: row.terminal_at ? new Date(row.terminal_at) : null,
  });
}

function claimedRecord(row: NotificationRow): ClaimedNotification {
  const record = rowRecord(row);
  if (
    record.status !== "leased"
    || !record.leaseToken
    || !record.leaseOwner
    || !record.leaseExpiresAt
    || !record.lastAttemptAt
  ) {
    throw new NotificationPersistenceError(
      "INVALID_STATE",
      "Claimed notification lease is incomplete",
    );
  }
  return record as ClaimedNotification;
}

function normalizedIntent<P extends NotificationPurpose>(
  input: NotificationIntent<P>,
): Required<Omit<NotificationIntent<P>, "id" | "maxAttempts">>
& Readonly<{ id: string; maxAttempts: number }> {
  if (!purposes.has(input.purpose)) invalid("purpose is invalid");
  if (!recipientRoles.has(input.recipientRole)) invalid("recipientRole is invalid");
  if (!sourceKinds.has(input.sourceKind)) invalid("sourceKind is invalid");
  if (!scopedKeyPattern.test(input.sourceKey)) invalid("sourceKey is invalid");
  if (!scopedKeyPattern.test(input.dedupeKey)) invalid("dedupeKey is invalid");
  const maxAttempts = input.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    invalid("maxAttempts is invalid");
  }
  return Object.freeze({
    id: input.id ? uuid(input.id, "id") : randomUUID(),
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    projectId: identifier(input.projectId, "projectId"),
    purpose: input.purpose,
    recipientRole: input.recipientRole,
    attributedActorId: identifier(
      input.attributedActorId,
      "attributedActorId",
    ),
    sourceKind: input.sourceKind,
    sourceKey: input.sourceKey,
    dedupeKey: input.dedupeKey,
    payload: payloadFor(input.purpose, input.payload),
    maxAttempts,
  });
}

function sameIntent(
  existing: NotificationRecord,
  intent: ReturnType<typeof normalizedIntent>,
): boolean {
  return existing.workspaceId === intent.workspaceId
    && existing.projectId === intent.projectId
    && existing.purpose === intent.purpose
    && existing.recipientRole === intent.recipientRole
    && existing.attributedActorId === intent.attributedActorId
    && existing.sourceKind === intent.sourceKind
    && existing.sourceKey === intent.sourceKey
    && existing.dedupeKey === intent.dedupeKey
    && existing.maxAttempts === intent.maxAttempts
    && JSON.stringify(existing.payload) === JSON.stringify(intent.payload);
}

function boundedSeconds(value: number, name: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    invalid(`${name} is invalid`);
  }
  return value;
}

function terminalErrorCode(value: string): string {
  if (!errorCodePattern.test(value)) invalid("errorCode is invalid");
  return value;
}

export class PostgresNotificationOutboxStore {
  constructor(
    readonly database: ProtocolDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async enqueue<P extends NotificationPurpose>(
    input: NotificationIntent<P>,
    executor: SqlExecutor = this.database.kysely,
  ): Promise<Readonly<{
    duplicate: boolean;
    notification: NotificationRecord<P>;
  }>> {
    const intent = normalizedIntent(input);
    const now = this.clock();
    const inserted = (await sql<NotificationRow>`insert into notification_outbox(
        id,workspace_id,project_id,purpose,recipient_role,
        attributed_actor_id,source_kind,source_key,dedupe_key,payload,
        max_attempts,available_at,enqueued_at
      ) values (
        ${intent.id}::uuid,${intent.workspaceId},${intent.projectId},
        ${intent.purpose},${intent.recipientRole},${intent.attributedActorId},
        ${intent.sourceKind},${intent.sourceKey},${intent.dedupeKey},
        ${JSON.stringify(intent.payload)}::jsonb,${intent.maxAttempts},
        ${now},${now}
      )
      on conflict (
        workspace_id,project_id,purpose,recipient_role,dedupe_key
      ) do nothing
      returning *`.execute(executor)).rows[0];
    if (inserted) {
      return Object.freeze({
        duplicate: false,
        notification: rowRecord(inserted) as NotificationRecord<P>,
      });
    }
    const existing = (await sql<NotificationRow>`select *
      from notification_outbox
      where workspace_id = ${intent.workspaceId}
        and project_id = ${intent.projectId}
        and purpose = ${intent.purpose}
        and recipient_role = ${intent.recipientRole}
        and dedupe_key = ${intent.dedupeKey}`.execute(executor)).rows[0];
    if (!existing) {
      throw new NotificationPersistenceError(
        "NOTIFICATION_CONFLICT",
        "Notification idempotency record was not available",
      );
    }
    const notification = rowRecord(existing);
    if (!sameIntent(notification, intent)) {
      throw new NotificationPersistenceError(
        "NOTIFICATION_CONFLICT",
        "Notification idempotency key has different content",
      );
    }
    return Object.freeze({
      duplicate: true,
      notification: notification as NotificationRecord<P>,
    });
  }

  async claimBatch(input: Readonly<{
    workerId: string;
    limit?: number;
    leaseSeconds?: number;
  }>): Promise<readonly ClaimedNotification[]> {
    if (!workerPattern.test(input.workerId)) invalid("workerId is invalid");
    const limit = boundedSeconds(input.limit ?? 10, "limit", 25);
    const leaseSeconds = boundedSeconds(
      input.leaseSeconds ?? 60,
      "leaseSeconds",
      900,
    );
    const now = this.clock();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    return this.database.transaction(async (transaction) => {
      await sql`update notification_delivery_attempts attempt
        set completed_at = ${now},outcome = 'lease-expired',
          error_code = 'LEASE_EXPIRED'
        from notification_outbox outbox
        where attempt.notification_id = outbox.id
          and attempt.attempt_number = outbox.attempt_count
          and attempt.completed_at is null
          and outbox.status = 'leased'
          and outbox.lease_expires_at <= ${now}
          and outbox.attempt_count >= outbox.max_attempts`
        .execute(transaction);
      await sql`update notification_outbox
        set status = 'manual',
          lease_token = null,
          lease_owner = null,
          lease_expires_at = null,
          last_error_code = 'LEASE_EXPIRED',
          terminal_at = ${now}
        where status = 'leased'
          and lease_expires_at <= ${now}
          and attempt_count >= max_attempts`.execute(transaction);
      const rows = (await sql<NotificationRow>`with candidates as (
          select id
          from notification_outbox
          where attempt_count < max_attempts
            and (
              (
                status in ('pending','retry')
                and available_at <= ${now}
              )
              or (
                status = 'leased'
                and lease_expires_at <= ${now}
              )
            )
          order by available_at,enqueued_at,id
          for update skip locked
          limit ${limit}
        )
        update notification_outbox outbox
        set status = 'leased',
          attempt_count = outbox.attempt_count + 1,
          lease_token = gen_random_uuid(),
          lease_owner = ${input.workerId},
          lease_expires_at = ${leaseExpiresAt},
          last_attempt_at = ${now},
          last_error_code = null
        from candidates
        where outbox.id = candidates.id
        returning outbox.*`.execute(transaction)).rows;
      for (const row of rows) {
        if (row.attempt_count > 1) {
          await sql`update notification_delivery_attempts
            set completed_at = ${now},outcome = 'lease-expired',
              error_code = 'LEASE_EXPIRED'
            where notification_id = ${row.id}::uuid
              and attempt_number = ${row.attempt_count - 1}
              and completed_at is null`.execute(transaction);
        }
        await sql`insert into notification_delivery_attempts(
            notification_id,attempt_number,lease_token,worker_id,started_at
          ) values (
            ${row.id}::uuid,${row.attempt_count},${row.lease_token}::uuid,
            ${input.workerId},${now}
          )`.execute(transaction);
      }
      return Object.freeze(rows.map(claimedRecord));
    });
  }

  async reserveReceipt(
    claim: ClaimedNotification,
  ): Promise<NotificationReceipt> {
    return this.database.transaction(async (transaction) => {
      await this.lockClaim(transaction, claim);
      const now = this.clock();
      await sql`insert into notification_delivery_receipts(
          notification_id,message_id,transport,status,reserved_at
        ) values (
          ${claim.id}::uuid,${claim.id}::uuid,'mailpit','reserved',${now}
        )
        on conflict (notification_id) do nothing`.execute(transaction);
      const row = (await sql<{
        notification_id: string;
        message_id: string;
        status: "reserved" | "delivered";
        reserved_at: Date;
        delivered_at: Date | null;
      }>`select notification_id::text,message_id::text,status,
          reserved_at,delivered_at
        from notification_delivery_receipts
        where notification_id = ${claim.id}::uuid`.execute(transaction)).rows[0];
      if (!row || row.message_id.toLowerCase() !== claim.id.toLowerCase()) {
        throw new NotificationPersistenceError(
          "INVALID_STATE",
          "Notification delivery receipt identity differs",
        );
      }
      return Object.freeze({
        notificationId: row.notification_id,
        messageId: row.message_id,
        status: row.status,
        reservedAt: new Date(row.reserved_at),
        deliveredAt: row.delivered_at ? new Date(row.delivered_at) : null,
      });
    });
  }

  async recheckDispatch(
    claim: ClaimedNotification,
    recipientActorIdInput: string,
  ): Promise<NotificationDispatchDecision> {
    const recipientActorId = identifier(
      recipientActorIdInput,
      "recipientActorId",
    );
    return this.database.transaction(async (transaction) => {
      await this.lockClaim(transaction, claim);
      const sourceDecision = await this.sourceDecision(transaction, claim);
      if (sourceDecision) return sourceDecision;
      return this.authorityDecision(
        transaction,
        claim,
        recipientActorId,
      );
    });
  }

  async markDelivered(
    claim: ClaimedNotification,
    recovered: boolean,
  ): Promise<void> {
    await this.complete(claim, {
      status: "delivered",
      outcome: recovered ? "recovered" : "delivered",
      errorCode: null,
      availableAt: null,
    });
  }

  async markSuppressed(
    claim: ClaimedNotification,
    reasonCode: NotificationTerminalReason,
  ): Promise<void> {
    await this.complete(claim, {
      status: "suppressed",
      outcome: "suppressed",
      errorCode: reasonCode,
      availableAt: null,
    });
  }

  async markObsolete(
    claim: ClaimedNotification,
    reasonCode: NotificationTerminalReason,
  ): Promise<void> {
    await this.complete(claim, {
      status: "obsolete",
      outcome: "obsolete",
      errorCode: reasonCode,
      availableAt: null,
    });
  }

  async markManual(
    claim: ClaimedNotification,
    errorCode: string,
  ): Promise<void> {
    await this.complete(claim, {
      status: "manual",
      outcome: "manual",
      errorCode: terminalErrorCode(errorCode),
      availableAt: null,
    });
  }

  async scheduleRetry(
    claim: ClaimedNotification,
    errorCode: string,
    delayMilliseconds: number,
  ): Promise<void> {
    if (
      !Number.isInteger(delayMilliseconds)
      || delayMilliseconds < 1
      || delayMilliseconds > 86_400_000
    ) {
      invalid("retry delay is invalid");
    }
    await this.complete(claim, {
      status: "retry",
      outcome: "retry",
      errorCode: terminalErrorCode(errorCode),
      availableAt: new Date(this.clock().getTime() + delayMilliseconds),
    });
  }

  async read(idInput: string): Promise<NotificationRecord | null> {
    const id = uuid(idInput, "id");
    const row = (await sql<NotificationRow>`select *
      from notification_outbox
      where id = ${id}::uuid`.execute(this.database.kysely)).rows[0];
    return row ? rowRecord(row) : null;
  }

  private async lockClaim(
    transaction: ProtocolTransaction,
    claim: ClaimedNotification,
  ): Promise<NotificationRow> {
    const row = (await sql<NotificationRow>`select *
      from notification_outbox
      where id = ${claim.id}::uuid
        and status = 'leased'
        and lease_token = ${claim.leaseToken}::uuid
        and attempt_count = ${claim.attemptCount}
      for update`.execute(transaction)).rows[0];
    if (!row) {
      throw new NotificationPersistenceError(
        "LEASE_LOST",
        "Notification lease is no longer current",
      );
    }
    return row;
  }

  private async complete(
    claim: ClaimedNotification,
    input: Readonly<{
      status: "retry" | "delivered" | "suppressed" | "obsolete" | "manual";
      outcome: Exclude<NotificationAttemptOutcome, "lease-expired">;
      errorCode: string | null;
      availableAt: Date | null;
    }>,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.lockClaim(transaction, claim);
      const now = this.clock();
      if (input.status === "delivered") {
        const receipt = (await sql<{ status: "reserved" | "delivered" }>`
          select status from notification_delivery_receipts
          where notification_id = ${claim.id}::uuid
          for update`.execute(transaction)).rows[0];
        if (!receipt) {
          throw new NotificationPersistenceError(
            "INVALID_STATE",
            "Delivery cannot complete without a reserved receipt",
          );
        }
        if (receipt.status === "reserved") {
          await sql`update notification_delivery_receipts
            set status = 'delivered',delivered_at = ${now}
            where notification_id = ${claim.id}::uuid`.execute(transaction);
        }
      }
      await sql`update notification_delivery_attempts
        set completed_at = ${now},outcome = ${input.outcome},
          error_code = ${input.errorCode}
        where notification_id = ${claim.id}::uuid
          and attempt_number = ${claim.attemptCount}
          and lease_token = ${claim.leaseToken}::uuid
          and completed_at is null`.execute(transaction);
      const updated = await sql<{ id: string }>`update notification_outbox
        set status = ${input.status},
          available_at = case
            when ${input.status} = 'retry'
              then ${input.availableAt}::timestamptz
            else available_at
          end,
          lease_token = null,
          lease_owner = null,
          lease_expires_at = null,
          last_error_code = ${input.errorCode},
          delivered_at = case
            when ${input.status} = 'delivered' then ${now}::timestamptz
            else delivered_at
          end,
          terminal_at = case
            when ${input.status} in (
              'delivered','suppressed','obsolete','manual'
            ) then ${now}::timestamptz
            else null
          end
        where id = ${claim.id}::uuid
          and status = 'leased'
          and lease_token = ${claim.leaseToken}::uuid
          and attempt_count = ${claim.attemptCount}
        returning id::text`.execute(transaction);
      if (updated.rows.length !== 1) {
        throw new NotificationPersistenceError(
          "LEASE_LOST",
          "Notification lease was lost before completion",
        );
      }
    });
  }

  private async sourceDecision(
    transaction: ProtocolTransaction,
    notification: ClaimedNotification,
  ): Promise<Exclude<NotificationDispatchDecision, { outcome: "ready" }> | null> {
    const obsolete = (
      reasonCode: NotificationTerminalReason,
    ): Exclude<NotificationDispatchDecision, { outcome: "ready" }> =>
      Object.freeze({ outcome: "obsolete", reasonCode });
    switch (notification.purpose) {
      case "client-question-submitted": {
        const payload = notification.payload as
          NotificationPayloadByPurpose["client-question-submitted"];
        const row = (await sql<{ current_version: number | null; answered: boolean }>`
          select u.current_version,
            exists (
              select 1 from provider_question_responses response
              where response.workspace_id = question.workspace_id
                and response.project_id = question.project_id
                and response.question_id = question.question_id
            ) as answered
          from client_questions question
          join units u
            on u.workspace_id = question.workspace_id
            and u.project_id = question.project_id
            and u.id = question.unit_id
          where question.workspace_id = ${notification.workspaceId}
            and question.project_id = ${notification.projectId}
            and question.question_id = ${payload.questionId}::uuid
            and question.request_id = ${payload.requestId}
            and question.unit_id = ${payload.unitId}
            and question.unit_version = ${payload.unitVersion}
        `.execute(transaction)).rows[0];
        if (!row) return obsolete("SOURCE_MISSING");
        if (row.answered) return obsolete("EVENT_SUPERSEDED");
        return row.current_version === payload.unitVersion
          ? null
          : obsolete("VERSION_OBSOLETE");
      }
      case "client-correction-submitted": {
        const payload = notification.payload as
          NotificationPayloadByPurpose["client-correction-submitted"];
        const row = (await sql<{ current_version: number | null; assessed: boolean }>`
          select u.current_version,
            exists (
              select 1 from provider_reconciliation_assessments assessment
              where assessment.workspace_id = correction.workspace_id
                and assessment.project_id = correction.project_id
                and assessment.concern_id = correction.id
            ) as assessed
          from corrections correction
          join units u
            on u.workspace_id = correction.workspace_id
            and u.project_id = correction.project_id
            and u.id = correction.origin_unit_id
          where correction.workspace_id = ${notification.workspaceId}
            and correction.project_id = ${notification.projectId}
            and correction.id = ${payload.concernId}
            and correction.packet_id = ${payload.requestId}
            and correction.origin_unit_id = ${payload.unitId}
        `.execute(transaction)).rows[0];
        if (!row) return obsolete("SOURCE_MISSING");
        if (row.assessed) return obsolete("EVENT_SUPERSEDED");
        return row.current_version === payload.unitVersion
          ? null
          : obsolete("VERSION_OBSOLETE");
      }
      case "provider-question-responded": {
        const payload = notification.payload as
          NotificationPayloadByPurpose["provider-question-responded"];
        const row = (await sql<{ current_version: number | null; latest: number }>`
          select u.current_version,
            (
              select max(newer.revision)::integer
              from provider_question_responses newer
              where newer.workspace_id = response.workspace_id
                and newer.project_id = response.project_id
                and newer.question_id = response.question_id
            ) as latest
          from provider_question_responses response
          join client_questions question
            on question.workspace_id = response.workspace_id
            and question.project_id = response.project_id
            and question.question_id = response.question_id
          join units u
            on u.workspace_id = question.workspace_id
            and u.project_id = question.project_id
            and u.id = question.unit_id
          where response.workspace_id = ${notification.workspaceId}
            and response.project_id = ${notification.projectId}
            and response.question_id = ${payload.questionId}::uuid
            and response.revision = ${payload.responseRevision}
            and response.status = ${payload.status}
            and question.unit_id = ${payload.unitId}
            and question.unit_version = ${payload.unitVersion}
        `.execute(transaction)).rows[0];
        if (!row) return obsolete("SOURCE_MISSING");
        if (row.latest !== payload.responseRevision) {
          return obsolete("EVENT_SUPERSEDED");
        }
        return row.current_version === payload.unitVersion
          ? null
          : obsolete("VERSION_OBSOLETE");
      }
      case "provider-correction-assessed": {
        const payload = notification.payload as
          NotificationPayloadByPurpose["provider-correction-assessed"];
        const row = (await sql<{ current_version: number | null; latest: number }>`
          select u.current_version,
            (
              select max(newer.assessment_revision)::integer
              from provider_reconciliation_assessments newer
              where newer.workspace_id = assessment.workspace_id
                and newer.project_id = assessment.project_id
                and newer.concern_id = assessment.concern_id
            ) as latest
          from provider_reconciliation_assessments assessment
          join units u
            on u.workspace_id = assessment.workspace_id
            and u.project_id = assessment.project_id
            and u.id = assessment.unit_id
          where assessment.workspace_id = ${notification.workspaceId}
            and assessment.project_id = ${notification.projectId}
            and assessment.concern_id = ${payload.concernId}
            and assessment.assessment_revision =
              ${payload.assessmentRevision}
            and assessment.unit_id = ${payload.unitId}
            and assessment.unit_version = ${payload.unitVersion}
            and assessment.applicability = ${payload.applicability}
            and assessment.draft_revision is not distinct from
              ${payload.reissueDraftRevision}
        `.execute(transaction)).rows[0];
        if (!row) return obsolete("SOURCE_MISSING");
        if (row.latest !== payload.assessmentRevision) {
          return obsolete("EVENT_SUPERSEDED");
        }
        return row.current_version === payload.unitVersion
          ? null
          : obsolete("VERSION_OBSOLETE");
      }
      case "provider-reissue-published": {
        const payload = notification.payload as
          NotificationPayloadByPurpose["provider-reissue-published"];
        const row = (await sql<{ current_version: number | null }>`select
            unit.current_version
          from units unit
          join provider_publication_provenance provenance
            on provenance.workspace_id = unit.workspace_id
            and provenance.project_id = unit.project_id
            and provenance.unit_id = unit.id
            and provenance.version = ${payload.version}
          where unit.workspace_id = ${notification.workspaceId}
            and unit.project_id = ${notification.projectId}
            and unit.id = ${payload.unitId}
            and ${notification.sourceKey} =
              provenance.unit_id || ':' || provenance.version::text
        `.execute(transaction)).rows[0];
        if (!row) return obsolete("SOURCE_MISSING");
        return row.current_version === payload.version
          ? null
          : obsolete("VERSION_OBSOLETE");
      }
      case "participant-authority-activated":
      case "participant-authority-revoked":
      case "participant-authority-restored": {
        const payload = notification.payload as ParticipantAuthorityPayload;
        const source = (await sql<{
          event: string;
          resource_id: string;
          authority_epoch: number | null;
        }>`select event,resource_id,
            case
              when event like '%payer%'
                then (detail->>'grantEpoch')::integer
              else (detail#>>'{grantEpochs,inspect}')::integer
            end as authority_epoch
          from protocol_history
          where workspace_id = ${notification.workspaceId}
            and project_id = ${notification.projectId}
            and sequence::text = ${notification.sourceKey}
        `.execute(transaction)).rows[0];
        const expectedEvent = payload.role === "payer"
          ? {
              activated: "local-payer-authority-activated",
              revoked: "payer-authority-revoked",
              restored: "payer-authority-restored",
            }[payload.change]
          : {
              activated: "local-client-approver-activated",
              revoked: "approver-authority-revoked",
              restored: "approver-authority-restored",
            }[payload.change];
        if (
          !source
          || source.event !== expectedEvent
          || source.resource_id !== payload.resourceId
          || source.authority_epoch !== payload.authorityEpoch
        ) {
          return obsolete("SOURCE_MISSING");
        }
        if (payload.role === "payer") {
          const basis = (await sql<{
            current_version: number | null;
            accepted_version: number | null;
            collectible: boolean;
          }>`select unit.current_version,unit.accepted_version,
              obligation.collectible
            from obligations obligation
            join units unit
              on unit.workspace_id = obligation.workspace_id
              and unit.project_id = obligation.project_id
              and unit.id = obligation.unit_id
            where obligation.workspace_id = ${notification.workspaceId}
              and obligation.project_id = ${notification.projectId}
              and obligation.id = ${payload.resourceId}
              and obligation.unit_id = ${payload.unitId}
              and obligation.version = ${payload.version}
          `.execute(transaction)).rows[0];
          if (!basis) return obsolete("SOURCE_MISSING");
          if (
            !basis.collectible
            || basis.current_version !== payload.version
            || basis.accepted_version !== payload.version
          ) {
            return obsolete("PAYMENT_NOT_DUE");
          }
        }
        return null;
      }
      case "payment-exception-observed": {
        const payload = notification.payload as
          NotificationPayloadByPurpose["payment-exception-observed"];
        const row = (await sql<{
          current_version: number | null;
          accepted_version: number | null;
          latest_sequence: string;
        }>`select unit.current_version,unit.accepted_version,
            (
              select max(newer.sequence)::text
              from protocol_history newer
              where newer.workspace_id = history.workspace_id
                and newer.project_id = history.project_id
                and newer.event = 'payment-exception-observed'
                and newer.detail->>'operationId' =
                  history.detail->>'operationId'
            ) as latest_sequence
          from protocol_history history
          join operations operation
            on operation.workspace_id = history.workspace_id
            and operation.project_id = history.project_id
            and operation.id::text = history.detail->>'operationId'
          join attempts attempt
            on attempt.workspace_id = operation.workspace_id
            and attempt.project_id = operation.project_id
            and attempt.id = operation.attempt_id
          join obligations obligation
            on obligation.workspace_id = attempt.workspace_id
            and obligation.project_id = attempt.project_id
            and obligation.id = attempt.obligation_id
          join units unit
            on unit.workspace_id = obligation.workspace_id
            and unit.project_id = obligation.project_id
            and unit.id = obligation.unit_id
          where history.workspace_id = ${notification.workspaceId}
            and history.project_id = ${notification.projectId}
            and history.sequence = ${payload.observationSequence}
            and history.event = 'payment-exception-observed'
            and history.detail->>'kind' = ${payload.kind}
            and history.detail->>'state' = ${payload.state}
            and obligation.unit_id = ${payload.unitId}
            and obligation.version = ${payload.version}
        `.execute(transaction)).rows[0];
        if (!row) return obsolete("SOURCE_MISSING");
        if (row.latest_sequence !== String(payload.observationSequence)) {
          return obsolete("EVENT_SUPERSEDED");
        }
        return row.current_version === payload.version
          && row.accepted_version === payload.version
          ? null
          : obsolete("VERSION_OBSOLETE");
      }
    }
  }

  private async authorityDecision(
    transaction: ProtocolTransaction,
    notification: ClaimedNotification,
    recipientActorId: string,
  ): Promise<NotificationDispatchDecision> {
    const suppressed = (
      reasonCode: NotificationTerminalReason,
    ): NotificationDispatchDecision =>
      Object.freeze({ outcome: "suppressed", reasonCode });
    const obsolete = (
      reasonCode: NotificationTerminalReason,
    ): NotificationDispatchDecision =>
      Object.freeze({ outcome: "obsolete", reasonCode });
    if (notification.recipientRole === "provider") {
      const grant = (await sql<{ epoch: number; active: boolean }>`select
          epoch,active
        from grants
        where workspace_id = ${notification.workspaceId}
          and project_id = ${notification.projectId}
          and actor_id = ${recipientActorId}
          and action = 'inspect'
      `.execute(transaction)).rows[0];
      return grant?.active
        ? Object.freeze({
            outcome: "ready",
            recipientActorId,
            authorityEpoch: grant.epoch,
          })
        : suppressed("AUTHORITY_REVOKED");
    }
    if (notification.recipientRole === "client-approver") {
      const grant = (await sql<{
        approver_id: string;
        epoch: number | null;
        active: boolean | null;
      }>`select project.approver_id,grant.epoch,grant.active
        from projects project
        left join grants grant
          on grant.workspace_id = project.workspace_id
          and grant.project_id = project.id
          and grant.actor_id = project.approver_id
          and grant.action = 'inspect'
        where project.workspace_id = ${notification.workspaceId}
          and project.id = ${notification.projectId}
      `.execute(transaction)).rows[0];
      if (!grant || grant.approver_id !== recipientActorId) {
        return obsolete("AUTHORITY_CHANGED");
      }
      if (!grant.active || grant.epoch === null) {
        return suppressed("AUTHORITY_REVOKED");
      }
      const participant = notification.purpose.startsWith(
        "participant-authority-",
      )
        ? notification.payload as ParticipantAuthorityPayload
        : null;
      if (
        participant
        && participant.authorityEpoch !== grant.epoch
      ) {
        return obsolete("AUTHORITY_CHANGED");
      }
      return Object.freeze({
        outcome: "ready",
        recipientActorId,
        authorityEpoch: grant.epoch,
      });
    }
    const participant = notification.payload as ParticipantAuthorityPayload;
    const nomination = (await sql<{
      actor_id: string;
      epoch: number;
      active: boolean;
      grant_epoch: number | null;
      grant_active: boolean | null;
    }>`select nomination.actor_id,nomination.epoch,nomination.active,
        grant.epoch as grant_epoch,grant.active as grant_active
      from payer_nominations nomination
      left join grants grant
        on grant.workspace_id = nomination.workspace_id
        and grant.project_id = nomination.project_id
        and grant.actor_id = nomination.actor_id
        and grant.action = 'pay'
      where nomination.workspace_id = ${notification.workspaceId}
        and nomination.project_id = ${notification.projectId}
        and nomination.obligation_id = ${participant.resourceId}
    `.execute(transaction)).rows[0];
    if (!nomination) return obsolete("AUTHORITY_CHANGED");
    if (
      nomination.actor_id !== recipientActorId
      || nomination.grant_epoch !== participant.authorityEpoch
    ) {
      return obsolete("AUTHORITY_CHANGED");
    }
    if (!nomination.active || !nomination.grant_active) {
      return suppressed("AUTHORITY_REVOKED");
    }
    return Object.freeze({
      outcome: "ready",
      recipientActorId,
      authorityEpoch: nomination.grant_epoch,
    });
  }
}
