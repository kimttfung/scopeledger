import {
  sql,
  type ProtocolDatabase,
} from "@scopeledger/db";
import type {
  FinancialAuditCursor,
  PayPalFinancialAuditTarget,
  PayPalFinancialAuditTargetSource,
} from "./financial-audit.js";
import type {
  PayPalWebhookReceiptSource,
  StoredPayPalWebhookReceipt,
} from "./webhook-processor.js";

export type PostgresFinancialAuditStatus = Readonly<{
  knownAttempts: number;
  knownCaptures: number;
  activeAttempts: number;
  staleFacts: number;
  receiptCount: number;
  lastReceiptAt: string | null;
  queueLagSeconds: number | null;
}>;

export type PayPalWebhookReceiptCursor = Readonly<{
  providerCreatedAt: Date;
  receivedAt: Date;
  eventId: string;
}>;

export type PayPalWebhookReceiptPage = Readonly<{
  receipts: readonly StoredPayPalWebhookReceipt[];
  nextCursor: PayPalWebhookReceiptCursor | null;
}>;

type TargetRow = {
  workspace_id: string;
  project_id: string;
  operation_id: string;
  order_id: string;
  capture_id: string | null;
  verified_at: Date | null;
  active_attempt: boolean;
};

type ReceiptRow = {
  workspace_id: string;
  environment: "sandbox" | "live";
  merchant_id: string;
  event_id: string;
  event_type: string;
  resource_type: string;
  resource_id: string | null;
  resource_status: string | null;
  provider_created_at: Date;
  received_at: Date;
  verification_reference: string;
};

function targetFromRow(row: TargetRow): PayPalFinancialAuditTarget {
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    operationId: row.operation_id,
    orderId: row.order_id,
    captureId: row.capture_id,
    factVerifiedAt: row.verified_at,
    activeAttempt: row.active_attempt,
  });
}

export class PostgresPayPalFinancialAuditSource
implements PayPalFinancialAuditTargetSource, PayPalWebhookReceiptSource {
  constructor(private readonly database: ProtocolDatabase) {}

  async listTargets(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    projectIds?: readonly string[];
    after?: FinancialAuditCursor;
    limit: number;
  }>): Promise<readonly PayPalFinancialAuditTarget[]> {
    if (input.projectIds?.length === 0) return Object.freeze([]);
    const rows = await sql<TargetRow>`select
        o.workspace_id,
        o.project_id,
        o.id::text as operation_id,
        a.order_id,
        coalesce(f.capture_id, observed.capture_id) as capture_id,
        f.verified_at,
        a.resolved_at is null as active_attempt
      from operations o
      join attempts a
        on a.workspace_id = o.workspace_id
        and a.project_id = o.project_id
        and a.id = o.attempt_id
      join obligations b
        on b.workspace_id = a.workspace_id
        and b.project_id = a.project_id
        and b.id = a.obligation_id
      left join payment_facts f
        on f.workspace_id = o.workspace_id
        and f.project_id = o.project_id
        and f.operation_id = o.id
      left join lateral (
        select nullif(payload->>'captureId','') as capture_id
        from observations observed
        where observed.workspace_id = o.workspace_id
          and observed.project_id = o.project_id
          and observed.operation_id = o.id
          and observed.matches_basis
          and nullif(observed.payload->>'captureId','') is not null
        order by observed.recorded_at desc,observed.id::text collate "C" desc
        limit 1
      ) observed on true
      where o.workspace_id = ${input.workspaceId}
        and o.kind = 'capture'
        and o.admitted_at is not null
        and a.order_id is not null
        and b.collectible
        and b.environment = ${input.environment}
        and b.merchant_id = ${input.merchantId}
        ${input.projectIds
          ? sql`and o.project_id = any(${[...input.projectIds]}::text[])`
          : sql``}
        ${input.after
          ? sql`and (
              o.project_id collate "C" > ${input.after.projectId}
              or (
                o.project_id = ${input.after.projectId}
                and o.id::text collate "C" > ${input.after.operationId}
              )
            )`
          : sql``}
      order by o.project_id collate "C",o.id::text collate "C"
      limit ${input.limit}`.execute(this.database.kysely);
    return Object.freeze(rows.rows.map(targetFromRow));
  }

  async listReceipts(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    limit: number;
  }>): Promise<readonly StoredPayPalWebhookReceipt[]> {
    return (await this.listReceiptPage(input)).receipts;
  }

  async listReceiptPage(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    after?: PayPalWebhookReceiptCursor;
    limit: number;
  }>): Promise<PayPalWebhookReceiptPage> {
    const rows = await sql<ReceiptRow>`select
        workspace_id,environment,merchant_id,event_id,event_type,resource_type,
        resource_id,resource_status,provider_created_at,received_at,
        verification_reference
      from paypal_webhook_receipts
      where workspace_id = ${input.workspaceId}
        and environment = ${input.environment}
        and merchant_id = ${input.merchantId}
        ${input.after
          ? sql`and (
              provider_created_at > ${input.after.providerCreatedAt}
              or (
                provider_created_at = ${input.after.providerCreatedAt}
                and received_at > ${input.after.receivedAt}
              )
              or (
                provider_created_at = ${input.after.providerCreatedAt}
                and received_at = ${input.after.receivedAt}
                and event_id collate "C" > ${input.after.eventId}
              )
            )`
          : sql``}
      order by provider_created_at,received_at,event_id collate "C"
      limit ${input.limit}`.execute(this.database.kysely);
    const receipts = rows.rows.map((row) => Object.freeze({
      workspaceId: row.workspace_id,
      environment: row.environment,
      merchantId: row.merchant_id,
      eventId: row.event_id,
      eventType: row.event_type,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      resourceStatus: row.resource_status,
      providerCreatedAt: row.provider_created_at,
      receivedAt: row.received_at,
      verificationReference: row.verification_reference,
    }));
    const last = rows.rows[rows.rows.length - 1];
    return Object.freeze({
      receipts: Object.freeze(receipts),
      nextCursor: rows.rows.length === input.limit && last
        ? Object.freeze({
            providerCreatedAt: last.provider_created_at,
            receivedAt: last.received_at,
            eventId: last.event_id,
          })
        : null,
    });
  }

  async listProjectIds(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    projectIds?: readonly string[];
  }>): Promise<readonly string[]> {
    if (input.projectIds?.length === 0) return Object.freeze([]);
    const rows = await sql<{ project_id: string }>`select o.project_id
      from operations o
      join attempts a
        on a.workspace_id = o.workspace_id
        and a.project_id = o.project_id
        and a.id = o.attempt_id
      join obligations b
        on b.workspace_id = a.workspace_id
        and b.project_id = a.project_id
        and b.id = a.obligation_id
      where o.workspace_id = ${input.workspaceId}
        and o.kind = 'capture'
        and o.admitted_at is not null
        and a.order_id is not null
        and b.collectible
        and b.environment = ${input.environment}
        and b.merchant_id = ${input.merchantId}
        ${input.projectIds
          ? sql`and o.project_id = any(${[...input.projectIds]}::text[])`
          : sql``}
      group by o.project_id
      order by o.project_id collate "C"`
      .execute(this.database.kysely);
    return Object.freeze(rows.rows.map((row) => row.project_id));
  }

  async status(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    projectIds?: readonly string[];
    auditIntervalMilliseconds: number;
    now?: Date;
  }>): Promise<PostgresFinancialAuditStatus> {
    if (input.projectIds?.length === 0) {
      return Object.freeze({
        knownAttempts: 0,
        knownCaptures: 0,
        activeAttempts: 0,
        staleFacts: 0,
        receiptCount: 0,
        lastReceiptAt: null,
        queueLagSeconds: null,
      });
    }
    const now = input.now ?? new Date();
    const staleBefore = new Date(
      now.getTime() - input.auditIntervalMilliseconds,
    );
    const targetStatus = (await sql<{
      known_attempts: number;
      known_captures: number;
      active_attempts: number;
      stale_facts: number;
    }>`select
        count(*)::integer as known_attempts,
        count(coalesce(f.capture_id, observed.capture_id))::integer
          as known_captures,
        count(*) filter (where a.resolved_at is null)::integer
          as active_attempts,
        count(*) filter (
          where f.verified_at is not null
            and f.verified_at < ${staleBefore}
        )::integer as stale_facts
      from operations o
      join attempts a
        on a.workspace_id = o.workspace_id
        and a.project_id = o.project_id
        and a.id = o.attempt_id
      join obligations b
        on b.workspace_id = a.workspace_id
        and b.project_id = a.project_id
        and b.id = a.obligation_id
      left join payment_facts f
        on f.workspace_id = o.workspace_id
        and f.project_id = o.project_id
        and f.operation_id = o.id
      left join lateral (
        select nullif(payload->>'captureId','') as capture_id
        from observations observed
        where observed.workspace_id = o.workspace_id
          and observed.project_id = o.project_id
          and observed.operation_id = o.id
          and observed.matches_basis
          and nullif(observed.payload->>'captureId','') is not null
        order by observed.recorded_at desc,observed.id::text collate "C" desc
        limit 1
      ) observed on true
      where o.workspace_id = ${input.workspaceId}
        and o.kind = 'capture'
        and o.admitted_at is not null
        and a.order_id is not null
        and b.collectible
        and b.environment = ${input.environment}
        and b.merchant_id = ${input.merchantId}
        ${input.projectIds
          ? sql`and o.project_id = any(${[...input.projectIds]}::text[])`
          : sql``}`.execute(this.database.kysely)).rows[0]!;
    const receiptStatus = (await sql<{
      receipt_count: number;
      last_receipt_at: Date | null;
      oldest_receipt_at: Date | null;
    }>`select
        count(*)::integer as receipt_count,
        max(received_at) as last_receipt_at,
        min(received_at) as oldest_receipt_at
      from paypal_webhook_receipts
      where workspace_id = ${input.workspaceId}
        and environment = ${input.environment}
        and merchant_id = ${input.merchantId}`
      .execute(this.database.kysely)).rows[0]!;
    return Object.freeze({
      knownAttempts: targetStatus.known_attempts,
      knownCaptures: targetStatus.known_captures,
      activeAttempts: targetStatus.active_attempts,
      staleFacts: targetStatus.stale_facts,
      receiptCount: receiptStatus.receipt_count,
      lastReceiptAt: receiptStatus.last_receipt_at?.toISOString() ?? null,
      queueLagSeconds: receiptStatus.oldest_receipt_at
        ? Math.max(
            0,
            Math.floor(
              (now.getTime() - receiptStatus.oldest_receipt_at.getTime())
                / 1_000,
            ),
          )
        : null,
    });
  }
}
