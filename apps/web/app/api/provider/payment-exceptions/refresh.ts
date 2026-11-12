import { sql } from "@scopeledger/db";
import type { ProtocolDatabase } from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import type { PayPalConfig } from "@scopeledger/paypal-adapter";
import {
  PayPalWebhookReceiptProcessor,
  summarizePayPalWebhookProcessing,
} from "@scopeledger/payment-worker";
import type {
  PayPalWebhookProcessingResult,
  PayPalWebhookProviderClient,
  StoredPayPalWebhookReceipt,
} from "@scopeledger/payment-worker";

const receiptLimit = 100;
const exceptionEventTypes = Object.freeze([
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.COMPLETED",
  "PAYMENT.REFUND.FAILED",
]);

async function exceptionReceiptSource(
  database: ProtocolDatabase,
  input: {
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    limit: number;
  },
): Promise<readonly StoredPayPalWebhookReceipt[]> {
  const rows = await sql<{
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
  }>`select workspace_id,environment,merchant_id,event_id,event_type,
      resource_type,resource_id,resource_status,provider_created_at,received_at,
      verification_reference
    from paypal_webhook_receipts
    where workspace_id = ${input.workspaceId}
      and environment = ${input.environment}
      and merchant_id = ${input.merchantId}
      and event_type = any(${exceptionEventTypes}::text[])
    order by provider_created_at,received_at,event_id collate "C"
    limit ${input.limit}`.execute(database.kysely);
  return Object.freeze(rows.rows.map((row) => Object.freeze({
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
  })));
}

export async function refreshPaymentExceptions(input: Readonly<{
  database: ProtocolDatabase;
  config: PayPalConfig;
  provider: PayPalWebhookProviderClient;
  scope: Readonly<{
    workspaceId: string;
    providerActorId: string;
    providerGrantEpoch: number;
  }>;
}>) {
  const projects = (await sql<{ project_id: string }>`select f.project_id
    from payment_facts f
    join grants g
      on g.workspace_id = f.workspace_id
      and g.project_id = f.project_id
      and g.actor_id = ${input.scope.providerActorId}
      and g.action = 'inspect'
      and g.epoch = ${input.scope.providerGrantEpoch}
      and g.active = true
    where f.workspace_id = ${input.scope.workspaceId}
    group by f.project_id
    order by f.project_id collate "C"`
    .execute(input.database.kysely)).rows;
  const results: PayPalWebhookProcessingResult[] = [];
  for (const project of projects) {
    const processor = new PayPalWebhookReceiptProcessor(
      {
        listReceipts: (request) =>
          exceptionReceiptSource(input.database, request),
      },
      new OrderedConsentStore(input.database),
      input.provider,
    );
    const batch = await processor.process({
      workspaceId: input.scope.workspaceId,
      projectId: project.project_id,
      environment: input.config.environment,
      merchantId: input.config.merchantId,
    }, { limit: receiptLimit });
    results.push(...batch.results);
  }
  return summarizePayPalWebhookProcessing(Object.freeze({
    results: Object.freeze(results),
  }));
}
