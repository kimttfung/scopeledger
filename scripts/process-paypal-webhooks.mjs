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
  DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
  MAX_FINANCIAL_AUDIT_BATCH_LIMIT,
  PostgresPayPalFinancialAuditSource,
  processPayPalWebhookTriggersForKnownTargets,
  summarizePayPalWebhookHealth,
  summarizePayPalWebhookProcessing,
} from "@scopeledger/payment-worker";

const workspaceId = "demo-workspace";

function options(argumentsList) {
  let status = false;
  let limit = 100;
  for (let index = 0; index < argumentsList.length;) {
    const argument = argumentsList[index];
    if (argument === "--status") {
      status = true;
      index += 1;
      continue;
    }
    if (argument === "--limit" || argument.startsWith("--limit=")) {
      const raw = argument === "--limit"
        ? argumentsList[index + 1]
        : argument.slice("--limit=".length);
      if (!raw) throw new Error("Missing webhook limit");
      limit = Number(raw);
      index += argument === "--limit" ? 2 : 1;
      continue;
    }
    throw new Error("Unsupported webhook option");
  }
  if (
    !Number.isInteger(limit)
    || limit < 1
    || limit > MAX_FINANCIAL_AUDIT_BATCH_LIMIT
  ) {
    throw new Error("Invalid webhook limit");
  }
  return Object.freeze({ status, limit });
}

function safeFailure() {
  return {
    processed: 0,
    eventTypes: [],
    outcomes: [{ outcome: "processor-failure", count: 1 }],
    health: {
      receipts: 0,
      processed: 0,
      unresolved: 1,
      credentialFailures: 0,
      providerFailures: 0,
      authoritativeFailures: 0,
      lastReceiptAt: null,
      queueLagSeconds: null,
    },
  };
}

let database = null;
let report = null;
let failed = false;

try {
  const parsed = options(process.argv.slice(2));
  const connectionString = process.env.SCOPELEDGER_DATABASE_URL;
  const schema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
  if (!connectionString || !schema) {
    throw new Error("Database configuration is required");
  }
  database = new ProtocolDatabase({ connectionString, schema });
  const source = new PostgresPayPalFinancialAuditSource(database);
  if (parsed.status) {
    const basis = (await sql`
      select environment,merchant_id from workspaces
      where id = ${workspaceId}
    `.execute(database.kysely)).rows[0];
    if (!basis) throw new Error("Workspace provider basis is unavailable");
    const status = await source.status({
      workspaceId,
      environment: basis.environment,
      merchantId: basis.merchant_id,
      auditIntervalMilliseconds:
        DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
    });
    report = {
      mode: "status",
      receiptCount: status.receiptCount,
      lastReceiptAt: status.lastReceiptAt,
      queueLagSeconds: status.queueLagSeconds,
      providerRead: false,
    };
  } else {
    const config = payPalConfigFromEnvironment();
    const [receipts, projectIds] = await Promise.all([
      source.listReceipts({
        workspaceId,
        environment: config.environment,
        merchantId: config.merchantId,
        limit: parsed.limit,
      }),
      source.listProjectIds({
        workspaceId,
        environment: config.environment,
        merchantId: config.merchantId,
      }),
    ]);
    const targets = projectIds.map((projectId) => Object.freeze({
      workspaceId,
      projectId,
      operationId: "scope-only",
      orderId: "scope-only",
      captureId: null,
      factVerifiedAt: null,
      activeAttempt: false,
    }));
    const batch = await processPayPalWebhookTriggersForKnownTargets({
      receipts,
      targets,
      domain: new OrderedConsentStore(database),
      provider: new PayPalSandboxClient(config),
    });
    const health = summarizePayPalWebhookHealth(batch, receipts);
    report = {
      ...summarizePayPalWebhookProcessing(batch),
      health,
    };
    failed = health.unresolved > 0;
  }
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

console.log(JSON.stringify(report ?? safeFailure(), null, 2));
if (failed) process.exitCode = 1;
