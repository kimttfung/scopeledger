import {
  ProtocolDatabase,
  sql,
} from "@scopeledger/db";
import {
  OrderedConsentStore,
} from "@scopeledger/domain";
import {
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";
import {
  PayPalWebhookReceiptProcessor,
  summarizePayPalWebhookProcessing,
} from "@scopeledger/payment-worker";

const scope = Object.freeze({
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
});
const receiptLimit = 100;

function failureSummary() {
  return {
    processed: 0,
    eventTypes: [],
    outcomes: [{ outcome: "processor-failure", count: 1 }],
  };
}

let database = null;
let summary = null;
let failed = false;

try {
  const connectionString = process.env.SCOPELEDGER_DATABASE_URL;
  const schema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
  if (!connectionString || !schema) {
    throw new Error("Database configuration is required");
  }

  const config = payPalConfigFromEnvironment();
  database = new ProtocolDatabase({
    connectionString,
    schema,
  });
  const receiptSource = {
    async listReceipts(input) {
      const rows = await sql`
        select workspace_id, environment, merchant_id, event_id, event_type,
          resource_type, resource_id, resource_status, provider_created_at,
          received_at, verification_reference
        from paypal_webhook_receipts
        where workspace_id = ${input.workspaceId}
          and environment = ${input.environment}
          and merchant_id = ${input.merchantId}
        order by provider_created_at, received_at, event_id collate "C"
        limit ${input.limit}
      `.execute(database.kysely);
      return rows.rows.map((row) => Object.freeze({
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
    },
  };
  const processor = new PayPalWebhookReceiptProcessor(
    receiptSource,
    new OrderedConsentStore(database),
    new PayPalSandboxClient(config),
  );
  const batch = await processor.process({
    ...scope,
    environment: config.environment,
    merchantId: config.merchantId,
  }, {
    limit: receiptLimit,
  });
  summary = summarizePayPalWebhookProcessing(batch);
} catch {
  failed = true;
} finally {
  if (database) {
    try {
      await database.close();
    } catch {
      failed = true;
    }
  }
}

console.log(JSON.stringify(failed || !summary ? failureSummary() : summary, null, 2));
if (failed) process.exitCode = 1;
