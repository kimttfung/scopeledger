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
  PayPalFinancialAuditor,
  PostgresPayPalFinancialAuditSource,
  financialAuditExitCode,
  parseFinancialAuditCliArguments,
  processPayPalWebhookTriggersForKnownTargets,
  summarizePayPalFinancialAudit,
  summarizePayPalWebhookHealth,
} from "@scopeledger/payment-worker";

const workspaceId = "demo-workspace";

function emptyAuditSummary() {
  return {
    audited: 0,
    activeAttempts: 0,
    knownFacts: 0,
    staleFacts: 0,
    exactRefreshes: 0,
    captureDiscoveries: 0,
    readinessRestored: 0,
    readinessWithheld: 0,
    pending: 0,
    unknown: 0,
    credentialFailures: 0,
    providerFailures: 0,
    authoritativeMismatches: 0,
    domainFailures: 0,
    unresolved: 0,
  };
}

function mergeAuditSummary(target, current) {
  for (const key of Object.keys(target)) target[key] += current[key];
}

function emptyWebhookHealth() {
  return {
    receipts: 0,
    processed: 0,
    unresolved: 0,
    credentialFailures: 0,
    providerFailures: 0,
    authoritativeFailures: 0,
    lastReceiptAt: null,
    queueLagSeconds: null,
  };
}

function mergeWebhookHealth(target, current) {
  target.receipts += current.receipts;
  target.processed += current.processed;
  target.unresolved += current.unresolved;
  target.credentialFailures += current.credentialFailures;
  target.providerFailures += current.providerFailures;
  target.authoritativeFailures += current.authoritativeFailures;
  if (
    current.lastReceiptAt
    && (!target.lastReceiptAt || current.lastReceiptAt > target.lastReceiptAt)
  ) {
    target.lastReceiptAt = current.lastReceiptAt;
  }
  if (
    current.queueLagSeconds !== null
    && (
      target.queueLagSeconds === null
      || current.queueLagSeconds > target.queueLagSeconds
    )
  ) {
    target.queueLagSeconds = current.queueLagSeconds;
  }
}

function safeFailure(code) {
  return {
    ok: false,
    code,
    message:
      "Authoritative financial audit did not complete. Existing payment history was not overridden.",
  };
}

export async function runFinancialAuditCli(
  argumentsList = process.argv.slice(2),
) {
  let options;
  try {
    options = parseFinancialAuditCliArguments(argumentsList);
  } catch {
    return Object.freeze({
      exitCode: 2,
      report: safeFailure("INVALID_AUDIT_ARGUMENTS"),
    });
  }

  let database = null;
  try {
    const connectionString = process.env.SCOPELEDGER_DATABASE_URL;
    const schema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
    if (!connectionString || !schema) {
      throw new Error("Database configuration is required");
    }
    database = new ProtocolDatabase({ connectionString, schema });
    const source = new PostgresPayPalFinancialAuditSource(database);
    if (options.mode === "status") {
      const basis = (await sql`
        select environment,merchant_id from workspaces
        where id = ${workspaceId}
      `.execute(database.kysely)).rows[0];
      if (!basis) throw new Error("Workspace provider basis is unavailable");
      let credentialFailures = 0;
      try {
        const config = payPalConfigFromEnvironment();
        if (
          config.environment !== basis.environment
          || config.merchantId !== basis.merchant_id
        ) {
          credentialFailures = 1;
        }
      } catch {
        credentialFailures = 1;
      }
      const status = await source.status({
        workspaceId,
        environment: basis.environment,
        merchantId: basis.merchant_id,
        auditIntervalMilliseconds: options.auditIntervalMilliseconds,
      });
      await database.close();
      database = null;
      return Object.freeze({
        exitCode: 0,
        report: Object.freeze({
          ok: true,
          mode: "status",
          limit: options.limit,
          auditIntervalSeconds:
            options.auditIntervalMilliseconds / 1_000,
          status: {
            ...status,
            credentialFailures,
          },
          effects: {
            providerRead: false,
            paymentDispatched: false,
            refundInitiated: false,
            paymentAttemptCreated: false,
          },
        }),
      });
    }

    const config = payPalConfigFromEnvironment();
    const domain = new OrderedConsentStore(database);
    const provider = new PayPalSandboxClient(config);
    const auditor = new PayPalFinancialAuditor(source, domain, provider);
    const audit = emptyAuditSummary();
    const allTargets = [];
    let auditPages = 0;
    let after;
    for (;;) {
      const targets = await source.listTargets({
        workspaceId,
        environment: config.environment,
        merchantId: config.merchantId,
        ...(after ? { after } : {}),
        limit: options.limit,
      });
      if (targets.length === 0) break;
      const results = await auditor.auditTargets(targets, {
        workspaceId,
        limit: options.limit,
        auditIntervalMilliseconds: options.auditIntervalMilliseconds,
      });
      mergeAuditSummary(audit, summarizePayPalFinancialAudit(results));
      allTargets.push(...targets);
      auditPages += 1;
      if (targets.length < options.limit) break;
      const last = targets[targets.length - 1];
      after = {
        projectId: last.projectId,
        operationId: last.operationId,
      };
    }

    const webhooks = emptyWebhookHealth();
    let webhookPages = 0;
    let receiptAfter;
    for (;;) {
      const page = await source.listReceiptPage({
        workspaceId,
        environment: config.environment,
        merchantId: config.merchantId,
        ...(receiptAfter ? { after: receiptAfter } : {}),
        limit: options.limit,
      });
      if (page.receipts.length === 0) break;
      const batch = await processPayPalWebhookTriggersForKnownTargets({
        receipts: page.receipts,
        targets: allTargets,
        domain,
        provider,
      });
      mergeWebhookHealth(
        webhooks,
        summarizePayPalWebhookHealth(batch, page.receipts),
      );
      webhookPages += 1;
      if (!page.nextCursor) break;
      receiptAfter = page.nextCursor;
    }

    await database.close();
    database = null;
    const report = Object.freeze({
      ok: audit.unresolved === 0 && webhooks.unresolved === 0,
      mode: "run",
      limit: options.limit,
      auditIntervalSeconds: options.auditIntervalMilliseconds / 1_000,
      pages: {
        audit: auditPages,
        webhooks: webhookPages,
      },
      audit: Object.freeze(audit),
      webhooks: Object.freeze(webhooks),
      effects: {
        paymentDispatched: false,
        refundInitiated: false,
        paymentAttemptCreated: false,
        financialHistoryRewritten: false,
      },
    });
    return Object.freeze({
      exitCode: financialAuditExitCode({ audit, webhooks }),
      report,
    });
  } catch {
    if (database) {
      try {
        await database.close();
      } catch {
        // The safe operational failure below covers close failures too.
      }
    }
    return Object.freeze({
      exitCode: 1,
      report: safeFailure("FINANCIAL_AUDIT_UNAVAILABLE"),
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runFinancialAuditCli();
  console.log(JSON.stringify(result.report, null, 2));
  process.exitCode = result.exitCode;
}
