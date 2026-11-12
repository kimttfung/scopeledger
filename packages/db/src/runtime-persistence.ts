import { timingSafeEqual } from "node:crypto";
import { sql } from "kysely";
import type { ProtocolDatabase, ProtocolTransaction } from "./index.js";

type Scope = Readonly<{ workspaceId: string; projectId: string }>;

export type RuntimePersistenceErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CHALLENGE_EXPIRED"
  | "CHALLENGE_SUPERSEDED"
  | "CHALLENGE_ATTEMPTS_EXHAUSTED"
  | "CHALLENGE_CODE_MISMATCH"
  | "CHALLENGE_ALREADY_VERIFIED"
  | "CHALLENGE_RATE_LIMITED"
  | "WEBHOOK_CONFLICT"
  | "APPROVAL_LINK_CONFLICT"
  | "APPROVAL_LINK_OPERATION_INVALID";

export class RuntimePersistenceError extends Error {
  constructor(
    public readonly code: RuntimePersistenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimePersistenceError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new RuntimePersistenceError("INVALID_INPUT", `${name} is invalid`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) {
    throw new RuntimePersistenceError("INVALID_INPUT", `${name} is invalid`);
  }
  return value.toLowerCase();
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    throw new RuntimePersistenceError("INVALID_INPUT", `${name} is invalid`);
  }
  return value;
}

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum
      || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RuntimePersistenceError("INVALID_INPUT", `${name} is invalid`);
  }
  return value;
}

function optionalBoundedText(
  value: unknown,
  name: string,
  maximum: number,
): string | null {
  return value === null || value === undefined
    ? null
    : boundedText(value, name, maximum);
}

function timestamp(value: unknown, name: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new RuntimePersistenceError("INVALID_INPUT", `${name} is invalid`);
  }
  return parsed;
}

function scope(input: Scope): Scope {
  return Object.freeze({
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    projectId: identifier(input.projectId, "projectId"),
  });
}

type ChallengeRow = {
  workspace_id: string;
  project_id: string;
  id: string;
  recipient_reference: string;
  role: AccessChallengeRole;
  code_digest: string;
  issued_at: Date;
  expires_at: Date;
  attempts: number;
  status: AccessChallengeStatus;
  verified_at: Date | null;
};

export type AccessChallengeRole = "client-approver" | "payer";
export type AccessChallengeStatus = "active" | "verified" | "superseded";
export type AccessChallengeRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  challengeId: string;
  recipientReference: string;
  role: AccessChallengeRole;
  issuedAt: Date;
  expiresAt: Date;
  attempts: number;
  status: AccessChallengeStatus;
  verifiedAt: Date | null;
}>;

function challengeRecord(row: ChallengeRow): AccessChallengeRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    challengeId: row.id,
    recipientReference: row.recipient_reference,
    role: row.role,
    issuedAt: timestamp(row.issued_at, "issuedAt"),
    expiresAt: timestamp(row.expires_at, "expiresAt"),
    attempts: row.attempts,
    status: row.status,
    verifiedAt: row.verified_at ? timestamp(row.verified_at, "verifiedAt") : null,
  });
}

function challengeRole(value: unknown): AccessChallengeRole {
  if (value !== "client-approver" && value !== "payer") {
    throw new RuntimePersistenceError("INVALID_INPUT", "role is invalid");
  }
  return value;
}

function equalDigest(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export class PostgresAccessChallengeStore {
  private readonly clock: () => Date;

  constructor(
    private readonly database: ProtocolDatabase,
    options: { clock?: () => Date } = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  async issue(input: Scope & {
    challengeId: string;
    recipientReference: string;
    role: AccessChallengeRole;
    codeDigest: string;
    expiresAt: Date | string;
  }): Promise<AccessChallengeRecord> {
    const target = scope(input);
    const challengeId = uuid(input.challengeId, "challengeId");
    const recipientReference = boundedText(input.recipientReference, "recipientReference", 320);
    const role = challengeRole(input.role);
    const codeDigest = digest(input.codeDigest, "codeDigest");
    const issuedAt = timestamp(this.clock(), "issuedAt");
    const expiresAt = timestamp(input.expiresAt, "expiresAt");
    if (expiresAt.getTime() <= issuedAt.getTime()) {
      throw new RuntimePersistenceError("INVALID_INPUT", "expiresAt must be after issuedAt");
    }
    return this.database.transaction(async (transaction) => {
      await this.requireProject(transaction, target);
      await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        ${`${target.workspaceId}/${target.projectId}/${recipientReference}/${role}`}, 0
      ))`.execute(transaction);
      const recent = (await sql<{ count: string }>`select count(*)::text as count
        from access_challenges
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and recipient_reference = ${recipientReference}
          and role = ${role}
          and issued_at > ${new Date(issuedAt.getTime() - 10 * 60_000)}
      `.execute(transaction)).rows[0];
      if (Number(recent?.count ?? 0) >= 3) {
        throw new RuntimePersistenceError(
          "CHALLENGE_RATE_LIMITED",
          "Too many recent access challenges",
        );
      }
      await sql`update access_challenges
        set status = 'superseded'
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and recipient_reference = ${recipientReference}
          and role = ${role}
          and status = 'active'`.execute(transaction);
      const inserted = await sql<ChallengeRow>`insert into access_challenges(
          workspace_id,project_id,id,recipient_reference,role,code_digest,issued_at,expires_at
        ) values (
          ${target.workspaceId},${target.projectId},${challengeId}::uuid,
          ${recipientReference},${role},${codeDigest},${issuedAt},${expiresAt}
        )
        returning workspace_id,project_id,id::text,recipient_reference,role,code_digest,
          issued_at,expires_at,attempts,status,verified_at`.execute(transaction);
      return challengeRecord(inserted.rows[0]!);
    });
  }

  async read(input: Scope & { challengeId: string }): Promise<AccessChallengeRecord | null> {
    const target = scope(input);
    const challengeId = uuid(input.challengeId, "challengeId");
    const row = (await sql<ChallengeRow>`select workspace_id,project_id,id::text,
        recipient_reference,role,code_digest,issued_at,expires_at,attempts,status,verified_at
      from access_challenges
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and id = ${challengeId}::uuid`.execute(this.database.kysely)).rows[0];
    return row ? challengeRecord(row) : null;
  }

  async supersede(input: Scope & { challengeId: string }): Promise<AccessChallengeRecord> {
    const target = scope(input);
    const challengeId = uuid(input.challengeId, "challengeId");
    return this.database.transaction(async (transaction) => {
      const row = await this.lockChallenge(transaction, target, challengeId);
      if (row.status !== "active") return challengeRecord(row);
      const updated = await sql<ChallengeRow>`update access_challenges
        set status = 'superseded'
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and id = ${challengeId}::uuid
        returning workspace_id,project_id,id::text,recipient_reference,role,code_digest,
          issued_at,expires_at,attempts,status,verified_at`.execute(transaction);
      return challengeRecord(updated.rows[0]!);
    });
  }

  async verify(input: Scope & {
    challengeId: string;
    candidateCodeDigest: string;
  }): Promise<AccessChallengeRecord> {
    const target = scope(input);
    const challengeId = uuid(input.challengeId, "challengeId");
    const candidateCodeDigest = digest(input.candidateCodeDigest, "candidateCodeDigest");
    const verifiedAt = timestamp(this.clock(), "verifiedAt");
    const result = await this.database.transaction(async (transaction) => {
      const row = await this.lockChallenge(transaction, target, challengeId);
      if (row.status === "verified") {
        return new RuntimePersistenceError(
          "CHALLENGE_ALREADY_VERIFIED",
          "Challenge was already verified",
        );
      }
      if (row.status === "superseded") {
        return new RuntimePersistenceError(
          "CHALLENGE_SUPERSEDED",
          "Challenge was replaced by a newer request",
        );
      }
      if (row.expires_at.getTime() <= verifiedAt.getTime()) {
        return new RuntimePersistenceError("CHALLENGE_EXPIRED", "Challenge expired");
      }
      if (row.attempts >= 5) {
        return new RuntimePersistenceError(
          "CHALLENGE_ATTEMPTS_EXHAUSTED",
          "Challenge attempts are exhausted",
        );
      }
      if (!equalDigest(row.code_digest, candidateCodeDigest)) {
        const attempts = row.attempts + 1;
        await sql`update access_challenges set attempts = ${attempts}
          where workspace_id = ${target.workspaceId}
            and project_id = ${target.projectId}
            and id = ${challengeId}::uuid`.execute(transaction);
        return new RuntimePersistenceError(
          attempts >= 5
            ? "CHALLENGE_ATTEMPTS_EXHAUSTED"
            : "CHALLENGE_CODE_MISMATCH",
          "Verification code did not match",
        );
      }
      const updated = await sql<ChallengeRow>`update access_challenges
        set status = 'verified', verified_at = ${verifiedAt}
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and id = ${challengeId}::uuid
        returning workspace_id,project_id,id::text,recipient_reference,role,code_digest,
          issued_at,expires_at,attempts,status,verified_at`.execute(transaction);
      return challengeRecord(updated.rows[0]!);
    });
    if (result instanceof RuntimePersistenceError) throw result;
    return result;
  }

  private async requireProject(
    transaction: ProtocolTransaction,
    target: Scope,
  ): Promise<void> {
    const project = await sql`select 1 from projects
      where workspace_id = ${target.workspaceId} and id = ${target.projectId}
      for key share`.execute(transaction);
    if (!project.rows.length) {
      throw new RuntimePersistenceError("NOT_FOUND", "Scoped project was not found");
    }
  }

  private async lockChallenge(
    transaction: ProtocolTransaction,
    target: Scope,
    challengeId: string,
  ): Promise<ChallengeRow> {
    const row = (await sql<ChallengeRow>`select workspace_id,project_id,id::text,
        recipient_reference,role,code_digest,issued_at,expires_at,attempts,status,verified_at
      from access_challenges
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and id = ${challengeId}::uuid
      for update`.execute(transaction)).rows[0];
    if (!row) {
      throw new RuntimePersistenceError("NOT_FOUND", "Challenge was not found");
    }
    return row;
  }
}

export const PAYPAL_WEBHOOK_EVENT_TYPES = Object.freeze([
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.COMPLETED",
  "PAYMENT.REFUND.FAILED",
] as const);

export type PayPalWebhookEventType = typeof PAYPAL_WEBHOOK_EVENT_TYPES[number];
export type PayPalEnvironment = "sandbox" | "live";
export type PayPalWebhookReceiptRecord = Readonly<{
  workspaceId: string;
  environment: PayPalEnvironment;
  merchantId: string;
  eventId: string;
  eventType: PayPalWebhookEventType;
  resourceType: string;
  resourceId: string | null;
  resourceStatus: string | null;
  providerCreatedAt: Date;
  receivedAt: Date;
  verificationReference: string;
}>;

type WebhookRow = {
  workspace_id: string;
  environment: PayPalEnvironment;
  merchant_id: string;
  event_id: string;
  event_type: PayPalWebhookEventType;
  resource_type: string;
  resource_id: string | null;
  resource_status: string | null;
  provider_created_at: Date;
  received_at: Date;
  verification_reference: string;
};

function webhookRecord(row: WebhookRow): PayPalWebhookReceiptRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    environment: row.environment,
    merchantId: row.merchant_id,
    eventId: row.event_id,
    eventType: row.event_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    resourceStatus: row.resource_status,
    providerCreatedAt: timestamp(row.provider_created_at, "providerCreatedAt"),
    receivedAt: timestamp(row.received_at, "receivedAt"),
    verificationReference: row.verification_reference,
  });
}

function webhookEventType(value: unknown): PayPalWebhookEventType {
  if (typeof value !== "string"
      || !(PAYPAL_WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)) {
    throw new RuntimePersistenceError("INVALID_INPUT", "eventType is invalid");
  }
  return value as PayPalWebhookEventType;
}

function environment(value: unknown): PayPalEnvironment {
  if (value !== "sandbox" && value !== "live") {
    throw new RuntimePersistenceError("INVALID_INPUT", "environment is invalid");
  }
  return value;
}

function sameWebhookContent(
  existing: PayPalWebhookReceiptRecord,
  incoming: PayPalWebhookReceiptRecord,
): boolean {
  return existing.workspaceId === incoming.workspaceId
    && existing.environment === incoming.environment
    && existing.merchantId === incoming.merchantId
    && existing.eventId === incoming.eventId
    && existing.eventType === incoming.eventType
    && existing.resourceType === incoming.resourceType
    && existing.resourceId === incoming.resourceId
    && existing.resourceStatus === incoming.resourceStatus
    && existing.providerCreatedAt.getTime() === incoming.providerCreatedAt.getTime();
}

export class PostgresPayPalWebhookReceiptStore {
  constructor(private readonly database: ProtocolDatabase) {}

  async insertVerified(input: {
    workspaceId: string;
    environment: PayPalEnvironment;
    merchantId: string;
    eventId: string;
    eventType: PayPalWebhookEventType;
    resourceType: string;
    resourceId: string | null;
    resourceStatus: string | null;
    providerCreatedAt: Date | string;
    receivedAt: Date | string;
    verificationReference: string;
  }): Promise<Readonly<{
    duplicate: boolean;
    receipt: PayPalWebhookReceiptRecord;
  }>> {
    const incoming = Object.freeze({
      workspaceId: identifier(input.workspaceId, "workspaceId"),
      environment: environment(input.environment),
      merchantId: identifier(input.merchantId, "merchantId"),
      eventId: identifier(input.eventId, "eventId"),
      eventType: webhookEventType(input.eventType),
      resourceType: boundedText(input.resourceType, "resourceType", 128),
      resourceId: optionalBoundedText(input.resourceId, "resourceId", 256),
      resourceStatus: optionalBoundedText(input.resourceStatus, "resourceStatus", 128),
      providerCreatedAt: timestamp(input.providerCreatedAt, "providerCreatedAt"),
      receivedAt: timestamp(input.receivedAt, "receivedAt"),
      verificationReference: boundedText(
        input.verificationReference,
        "verificationReference",
        256,
      ),
    }) satisfies PayPalWebhookReceiptRecord;
    return this.database.transaction(async (transaction) => {
      const workspace = await sql`select 1 from workspaces
        where id = ${incoming.workspaceId}
          and merchant_id = ${incoming.merchantId}
          and environment = ${incoming.environment}
        for key share`.execute(transaction);
      if (!workspace.rows.length) {
        throw new RuntimePersistenceError(
          "NOT_FOUND",
          "Workspace PayPal scope was not found",
        );
      }
      const inserted = await sql<WebhookRow>`insert into paypal_webhook_receipts(
          workspace_id,environment,merchant_id,event_id,event_type,resource_type,
          resource_id,resource_status,provider_created_at,received_at,verification_reference
        ) values (
          ${incoming.workspaceId},${incoming.environment},${incoming.merchantId},
          ${incoming.eventId},${incoming.eventType},${incoming.resourceType},
          ${incoming.resourceId},${incoming.resourceStatus},${incoming.providerCreatedAt},
          ${incoming.receivedAt},${incoming.verificationReference}
        )
        on conflict (environment,merchant_id,event_id) do nothing
        returning workspace_id,environment,merchant_id,event_id,event_type,resource_type,
          resource_id,resource_status,provider_created_at,received_at,verification_reference
      `.execute(transaction);
      if (inserted.rows[0]) {
        return Object.freeze({
          duplicate: false,
          receipt: webhookRecord(inserted.rows[0]),
        });
      }
      const existingRow = (await sql<WebhookRow>`select workspace_id,environment,
          merchant_id,event_id,event_type,resource_type,resource_id,resource_status,
          provider_created_at,received_at,verification_reference
        from paypal_webhook_receipts
        where environment = ${incoming.environment}
          and merchant_id = ${incoming.merchantId}
          and event_id = ${incoming.eventId}`.execute(transaction)).rows[0];
      if (!existingRow) {
        throw new RuntimePersistenceError(
          "WEBHOOK_CONFLICT",
          "Webhook receipt conflict could not be resolved",
        );
      }
      const existing = webhookRecord(existingRow);
      if (!sameWebhookContent(existing, incoming)) {
        throw new RuntimePersistenceError(
          "WEBHOOK_CONFLICT",
          "The PayPal event ID was already recorded with different normalized content",
        );
      }
      return Object.freeze({ duplicate: true, receipt: existing });
    });
  }
}

export type PayPalApprovalLinkRecord = Readonly<{
  workspaceId: string;
  projectId: string;
  operationId: string;
  orderId: string;
  approvalUrl: string;
  storedAt: Date;
}>;

type ApprovalLinkRow = {
  workspace_id: string;
  project_id: string;
  operation_id: string;
  order_id: string;
  approval_url: string;
  stored_at: Date;
};

function approvalLinkRecord(row: ApprovalLinkRow): PayPalApprovalLinkRecord {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    operationId: row.operation_id,
    orderId: row.order_id,
    approvalUrl: row.approval_url,
    storedAt: timestamp(row.stored_at, "storedAt"),
  });
}

function approvalUrl(value: unknown): { value: string; environment: PayPalEnvironment } {
  if (typeof value !== "string" || value.length > 2048) {
    throw new RuntimePersistenceError("INVALID_INPUT", "approvalUrl is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RuntimePersistenceError("INVALID_INPUT", "approvalUrl is invalid");
  }
  const targetEnvironment = url.origin === "https://www.sandbox.paypal.com"
    ? "sandbox"
    : url.origin === "https://www.paypal.com"
      ? "live"
      : null;
  if (!targetEnvironment || url.protocol !== "https:" || url.username || url.password) {
    throw new RuntimePersistenceError("INVALID_INPUT", "approvalUrl is invalid");
  }
  return { value: url.toString(), environment: targetEnvironment };
}

export class PostgresPayPalApprovalLinkStore {
  constructor(private readonly database: ProtocolDatabase) {}

  async save(input: {
    workspaceId: string;
    projectId: string;
    operationId: string;
    orderId: string;
    approvalUrl: string;
  }): Promise<void> {
    const target = scope(input);
    const operationId = uuid(input.operationId, "operationId");
    const orderId = identifier(input.orderId, "orderId");
    const url = approvalUrl(input.approvalUrl);
    await this.database.transaction(async (transaction) => {
      const existing = await this.readRow(transaction, target, operationId);
      if (existing) {
        if (existing.order_id !== orderId || existing.approval_url !== url.value) {
          throw new RuntimePersistenceError(
            "APPROVAL_LINK_CONFLICT",
            "An operation cannot change its stored PayPal approval link",
          );
        }
        return;
      }
      const operation = (await sql<{
        kind: "create" | "capture";
        order_id: string | null;
        environment: PayPalEnvironment;
      }>`select o.kind,a.order_id,w.environment
        from operations o
        join attempts a
          on a.workspace_id = o.workspace_id
          and a.project_id = o.project_id
          and a.id = o.attempt_id
        join workspaces w on w.id = o.workspace_id
        where o.workspace_id = ${target.workspaceId}
          and o.project_id = ${target.projectId}
          and o.id = ${operationId}::uuid
        for share of o,a,w`.execute(transaction)).rows[0];
      if (!operation) {
        throw new RuntimePersistenceError("NOT_FOUND", "Payment operation was not found");
      }
      if (operation.kind !== "create" || operation.order_id !== orderId
          || operation.environment !== url.environment) {
        throw new RuntimePersistenceError(
          "APPROVAL_LINK_OPERATION_INVALID",
          "Approval link did not match the recorded create operation",
        );
      }
      const inserted = await sql<ApprovalLinkRow>`insert into paypal_approval_links(
          workspace_id,project_id,operation_id,order_id,approval_url
        ) values (
          ${target.workspaceId},${target.projectId},${operationId}::uuid,
          ${orderId},${url.value}
        )
        on conflict do nothing
        returning workspace_id,project_id,operation_id::text,order_id,approval_url,stored_at
      `.execute(transaction);
      if (inserted.rows.length) return;
      const raced = await this.readRow(transaction, target, operationId);
      if (!raced || raced.order_id !== orderId || raced.approval_url !== url.value) {
        throw new RuntimePersistenceError(
          "APPROVAL_LINK_CONFLICT",
          "An operation cannot change its stored PayPal approval link",
        );
      }
    });
  }

  async read(input: Scope & {
    operationId: string;
  }): Promise<PayPalApprovalLinkRecord | null> {
    const target = scope(input);
    const operationId = uuid(input.operationId, "operationId");
    const row = await this.readRow(this.database.kysely, target, operationId);
    return row ? approvalLinkRecord(row) : null;
  }

  private async readRow(
    executor: ProtocolDatabase["kysely"] | ProtocolTransaction,
    target: Scope,
    operationId: string,
  ): Promise<ApprovalLinkRow | undefined> {
    return (await sql<ApprovalLinkRow>`select workspace_id,project_id,
        operation_id::text,order_id,approval_url,stored_at
      from paypal_approval_links
      where workspace_id = ${target.workspaceId}
        and project_id = ${target.projectId}
        and operation_id = ${operationId}::uuid`.execute(executor)).rows[0];
  }
}
