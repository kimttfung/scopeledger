import { sql } from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";
import {
  DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
  PayPalFinancialAuditor,
  PostgresPayPalFinancialAuditSource,
  processPayPalWebhookTriggersForKnownTargets,
  summarizePayPalFinancialAudit,
  summarizePayPalWebhookHealth,
} from "@scopeledger/payment-worker";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import type {
  FinancialAuditDependencies,
  ProviderFinancialAuditRun,
  ProviderFinancialAuditStatus,
} from "./service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;

function database() {
  const current = protocolDatabase();
  if (!current) throw new Error("FINANCIAL_AUDIT_DATABASE_UNAVAILABLE");
  return current;
}

async function grantedProjectIds(): Promise<readonly string[]> {
  const rows = await sql<{ project_id: string }>`select project_id
    from grants
    where workspace_id = ${workspaceId}
      and actor_id = ${providerActorId}
      and action = 'inspect'
      and epoch = ${providerGrantEpoch}
      and active = true
    order by project_id collate "C"`.execute(database().kysely);
  return Object.freeze(rows.rows.map((row) => row.project_id));
}

async function providerBasis(): Promise<Readonly<{
  environment: "sandbox" | "live";
  merchantId: string;
}>> {
  const row = (await sql<{
    environment: "sandbox" | "live";
    merchant_id: string;
  }>`select environment,merchant_id from workspaces
    where id = ${workspaceId}`.execute(database().kysely)).rows[0];
  if (!row) throw new Error("FINANCIAL_AUDIT_WORKSPACE_UNAVAILABLE");
  return Object.freeze({
    environment: row.environment,
    merchantId: row.merchant_id,
  });
}

async function status(): Promise<ProviderFinancialAuditStatus> {
  const basis = await providerBasis();
  let credentialFailures = 0;
  try {
    const config = payPalConfigFromEnvironment();
    if (
      config.environment !== basis.environment
      || config.merchantId !== basis.merchantId
    ) {
      credentialFailures = 1;
    }
  } catch {
    credentialFailures = 1;
  }
  const source = new PostgresPayPalFinancialAuditSource(database());
  const current = await source.status({
    workspaceId,
    environment: basis.environment,
    merchantId: basis.merchantId,
    projectIds: await grantedProjectIds(),
    auditIntervalMilliseconds:
      DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
  });
  return Object.freeze({
    ...current,
    generatedAt: new Date().toISOString(),
    auditIntervalSeconds:
      DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS / 1_000,
    credentialFailures,
  });
}

async function audit(limit: number): Promise<ProviderFinancialAuditRun> {
  const current = database();
  const config = payPalConfigFromEnvironment();
  const basis = await providerBasis();
  if (
    config.environment !== basis.environment
    || config.merchantId !== basis.merchantId
  ) {
    throw new Error("FINANCIAL_AUDIT_PROVIDER_BASIS_MISMATCH");
  }
  const source = new PostgresPayPalFinancialAuditSource(current);
  const projectIds = await grantedProjectIds();
  const targets = await source.listTargets({
    workspaceId,
    environment: config.environment,
    merchantId: config.merchantId,
    projectIds,
    limit,
  });
  const domain = new OrderedConsentStore(current);
  const provider = new PayPalSandboxClient(config);
  const auditor = new PayPalFinancialAuditor(source, domain, provider);
  const auditResults = await auditor.auditTargets(targets, {
    workspaceId,
    limit,
    auditIntervalMilliseconds:
      DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
  });
  const receipts = await source.listReceipts({
    workspaceId,
    environment: config.environment,
    merchantId: config.merchantId,
    limit,
  });
  const targetProjects = new Set(
    targets.map((target) => target.projectId),
  );
  const triggerTargets = [
    ...targets,
    ...projectIds
      .filter((projectId) => !targetProjects.has(projectId))
      .map((projectId) => Object.freeze({
        workspaceId,
        projectId,
        operationId: "scope-only",
        orderId: "scope-only",
        captureId: null,
        factVerifiedAt: null,
        activeAttempt: false,
      })),
  ];
  const triggerBatch = await processPayPalWebhookTriggersForKnownTargets({
    receipts,
    targets: triggerTargets,
    domain,
    provider,
  });
  const currentStatus = await source.status({
    workspaceId,
    environment: config.environment,
    merchantId: config.merchantId,
    projectIds,
    auditIntervalMilliseconds:
      DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS,
  });
  return Object.freeze({
    generatedAt: new Date().toISOString(),
    limit,
    truncated: currentStatus.knownAttempts > targets.length
      || currentStatus.receiptCount > receipts.length,
    audit: summarizePayPalFinancialAudit(auditResults),
    webhooks: summarizePayPalWebhookHealth(triggerBatch, receipts),
  });
}

export function financialAuditDependencies(): FinancialAuditDependencies {
  return {
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    hasInspectGrant: async () => (await grantedProjectIds()).length > 0,
    status,
    audit,
  };
}
