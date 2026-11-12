import type {
  PayPalWebhookDomainStore,
  PayPalWebhookProcessingBatch,
  PayPalWebhookProcessingOutcome,
  PayPalWebhookProcessingResult,
  PayPalWebhookProviderClient,
  StoredPayPalWebhookReceipt,
} from "./webhook-processor.js";
import { PayPalWebhookReceiptProcessor } from "./webhook-processor.js";
import {
  type CaptureReconciliationStore,
  type PayPalCaptureReconciliationClient,
} from "./index.js";
import { captureNormalizationAdmission } from "./reconciliation-admission.js";

export const DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS =
  24 * 60 * 60 * 1_000;
export const MAX_FINANCIAL_AUDIT_BATCH_LIMIT = 1_000;

export type FinancialAuditCursor = Readonly<{
  projectId: string;
  operationId: string;
}>;

export type PayPalFinancialAuditTarget = Readonly<{
  workspaceId: string;
  projectId: string;
  operationId: string;
  orderId: string;
  captureId: string | null;
  factVerifiedAt: Date | null;
  activeAttempt: boolean;
}>;

export interface PayPalFinancialAuditTargetSource {
  listTargets(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    projectIds?: readonly string[];
    after?: FinancialAuditCursor;
    limit: number;
  }>): Promise<readonly PayPalFinancialAuditTarget[]>;
}

export type PayPalFinancialAuditOutcome =
  | "exact-refresh"
  | "capture-discovered"
  | "pending"
  | "unknown"
  | "credential-failure"
  | "provider-failure"
  | "authoritative-mismatch"
  | "domain-failure";

export type PayPalFinancialAuditResult = Readonly<{
  cursor: FinancialAuditCursor;
  outcome: PayPalFinancialAuditOutcome;
  staleBeforeAudit: boolean;
  activeAttempt: boolean;
  readinessRestored: boolean;
}>;

export type PayPalFinancialAuditPage = Readonly<{
  results: readonly PayPalFinancialAuditResult[];
  nextCursor: FinancialAuditCursor | null;
}>;

export type PayPalFinancialAuditSummary = Readonly<{
  audited: number;
  activeAttempts: number;
  knownFacts: number;
  staleFacts: number;
  exactRefreshes: number;
  captureDiscoveries: number;
  readinessRestored: number;
  readinessWithheld: number;
  pending: number;
  unknown: number;
  credentialFailures: number;
  providerFailures: number;
  authoritativeMismatches: number;
  domainFailures: number;
  unresolved: number;
}>;

const successfulAuditOutcomes = new Set<PayPalFinancialAuditOutcome>([
  "exact-refresh",
  "capture-discovered",
]);

const credentialErrorCodes = new Set([
  "AUTHENTICATION_FAILED",
  "INVALID_CONFIG",
]);

const authoritativeErrorCodes = new Set([
  "FINANCIAL_MISMATCH",
  "MERCHANT_MISMATCH",
  "PROVIDER_RESPONSE_INVALID",
  "RECONCILIATION_CAPTURE_UNRESOLVED",
  "RECONCILIATION_TARGET_MISMATCH",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCursor(
  left: FinancialAuditCursor,
  right: FinancialAuditCursor,
): number {
  return compareText(left.projectId, right.projectId)
    || compareText(left.operationId, right.operationId);
}

function targetCursor(
  target: PayPalFinancialAuditTarget,
): FinancialAuditCursor {
  return Object.freeze({
    projectId: target.projectId,
    operationId: target.operationId,
  });
}

function auditLimit(value: number): number {
  if (
    !Number.isInteger(value)
    || value < 1
    || value > MAX_FINANCIAL_AUDIT_BATCH_LIMIT
  ) {
    throw new RangeError(
      `Financial audit limit must be an integer from 1 to ${
        MAX_FINANCIAL_AUDIT_BATCH_LIMIT
      }`,
    );
  }
  return value;
}

function auditInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_FINANCIAL_AUDIT_INTERVAL_MILLISECONDS;
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new RangeError("Financial audit interval must be positive");
  }
  return interval;
}

function errorCode(error: unknown): string | null {
  return error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function failedAuditOutcome(error: unknown): PayPalFinancialAuditOutcome {
  const code = errorCode(error);
  if (code && credentialErrorCodes.has(code)) return "credential-failure";
  if (code === "PROVIDER_REJECTED") return "provider-failure";
  if (code && authoritativeErrorCodes.has(code)) {
    return "authoritative-mismatch";
  }
  return "domain-failure";
}

function validTarget(
  target: PayPalFinancialAuditTarget,
  workspaceId: string,
): boolean {
  return target.workspaceId === workspaceId
    && target.projectId.length > 0
    && target.operationId.length > 0
    && target.orderId.length > 0
    && (target.captureId === null || target.captureId.length > 0)
    && (
      target.factVerifiedAt === null
      || Number.isFinite(target.factVerifiedAt.getTime())
    );
}

export class PayPalFinancialAuditor {
  constructor(
    private readonly targets: PayPalFinancialAuditTargetSource,
    private readonly store: CaptureReconciliationStore,
    private readonly client: PayPalCaptureReconciliationClient,
  ) {}

  async auditPage(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    projectIds?: readonly string[];
    after?: FinancialAuditCursor;
    limit: number;
    auditIntervalMilliseconds?: number;
    now?: Date;
  }>): Promise<PayPalFinancialAuditPage> {
    const limit = auditLimit(input.limit);
    const interval = auditInterval(input.auditIntervalMilliseconds);
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new RangeError("Financial audit clock must be valid");
    }
    const listed = await this.targets.listTargets({
      workspaceId: input.workspaceId,
      environment: input.environment,
      merchantId: input.merchantId,
      ...(input.projectIds ? { projectIds: input.projectIds } : {}),
      ...(input.after ? { after: input.after } : {}),
      limit,
    });
    const sorted = this.normalizeTargets(
      listed,
      input.workspaceId,
      limit,
      input.after,
    );
    const results = await this.auditTargets(sorted, {
      workspaceId: input.workspaceId,
      auditIntervalMilliseconds: interval,
      now,
      limit,
    });
    return Object.freeze({
      results,
      nextCursor: sorted.length === limit
        ? targetCursor(sorted[sorted.length - 1]!)
        : null,
    });
  }

  async auditTargets(
    listed: readonly PayPalFinancialAuditTarget[],
    input: Readonly<{
      workspaceId: string;
      limit: number;
      auditIntervalMilliseconds?: number;
      now?: Date;
    }>,
  ): Promise<readonly PayPalFinancialAuditResult[]> {
    const limit = auditLimit(input.limit);
    const interval = auditInterval(input.auditIntervalMilliseconds);
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new RangeError("Financial audit clock must be valid");
    }
    const targets = this.normalizeTargets(
      listed,
      input.workspaceId,
      limit,
    );
    const results: PayPalFinancialAuditResult[] = [];
    for (const target of targets) {
      results.push(await this.auditTarget(target, now, interval));
    }
    return Object.freeze(results);
  }

  private normalizeTargets(
    listed: readonly PayPalFinancialAuditTarget[],
    workspaceId: string,
    limit: number,
    after?: FinancialAuditCursor,
  ): PayPalFinancialAuditTarget[] {
    return [...listed]
      .filter((target) => validTarget(target, workspaceId))
      .sort((left, right) =>
        compareCursor(targetCursor(left), targetCursor(right)))
      .filter((target, index, targets) =>
        index === 0
        || compareCursor(
          targetCursor(target),
          targetCursor(targets[index - 1]!),
        ) !== 0)
      .filter((target) =>
        !after || compareCursor(targetCursor(target), after) > 0)
      .slice(0, limit);
  }

  private async auditTarget(
    target: PayPalFinancialAuditTarget,
    now: Date,
    auditIntervalMilliseconds: number,
  ): Promise<PayPalFinancialAuditResult> {
    const staleBeforeAudit = target.factVerifiedAt !== null
      && target.factVerifiedAt.getTime()
        < now.getTime() - auditIntervalMilliseconds;
    const base = {
      cursor: targetCursor(target),
      staleBeforeAudit,
      activeAttempt: target.activeAttempt,
    };
    try {
      if (target.captureId) {
        const details = await this.client.retrieveCaptureDetails(
          target.captureId,
        );
        if (
          details.captureId !== target.captureId
          || details.orderId !== target.orderId
        ) {
          throw Object.assign(
            new Error("Authoritative capture identity changed"),
            { code: "RECONCILIATION_TARGET_MISMATCH" },
          );
        }
        const admission = await this.store.captureReconciliationAdmission(
          {
            workspaceId: target.workspaceId,
            projectId: target.projectId,
          },
          target.orderId,
        );
        if (
          admission.operationId !== target.operationId
          || admission.kind !== "capture"
        ) {
          throw Object.assign(
            new Error("Capture operation identity changed"),
            { code: "RECONCILIATION_TARGET_MISMATCH" },
          );
        }
        const observation = this.client.captureObservationFromDetails(
          captureNormalizationAdmission(admission),
          details,
        );
        if (
          observation.operationId !== target.operationId
          || observation.orderId !== target.orderId
          || observation.captureId !== target.captureId
          || observation.outcome === "order-created"
        ) {
          throw Object.assign(
            new Error("Normalized capture identity changed"),
            { code: "RECONCILIATION_TARGET_MISMATCH" },
          );
        }
        const reduced = await this.store.recordObservation(
          {
            workspaceId: target.workspaceId,
            projectId: target.projectId,
          },
          observation,
        );
        const outcome: PayPalFinancialAuditOutcome =
          observation.outcome === "completed"
            ? reduced.matchesBasis && reduced.completed
              ? "exact-refresh"
              : "authoritative-mismatch"
            : observation.outcome;
        return Object.freeze({
          ...base,
          outcome,
          readinessRestored:
            outcome === "exact-refresh" && target.factVerifiedAt === null,
        });
      }
      if (
        !this.client.retrieveOrderDetails
        || !this.client.captureObservationFromOrderDetails
      ) {
        throw Object.assign(
          new Error("Order-linked capture discovery is unavailable"),
          { code: "RECONCILIATION_CAPTURE_UNRESOLVED" },
        );
      }
      const details = await this.client.retrieveOrderDetails(target.orderId);
      if (details.orderId !== target.orderId) {
        throw Object.assign(
          new Error("Authoritative Order identity changed"),
          { code: "RECONCILIATION_TARGET_MISMATCH" },
        );
      }
      const admission = await this.store.captureReconciliationAdmission(
        {
          workspaceId: target.workspaceId,
          projectId: target.projectId,
        },
        target.orderId,
      );
      if (
        admission.operationId !== target.operationId
        || admission.kind !== "capture"
      ) {
        throw Object.assign(
          new Error("Capture operation identity changed"),
          { code: "RECONCILIATION_TARGET_MISMATCH" },
        );
      }
      const observation = this.client.captureObservationFromOrderDetails(
        captureNormalizationAdmission(admission),
        details,
      );
      if (
        observation.operationId !== target.operationId
        || observation.orderId !== target.orderId
        || !observation.captureId
        || (
          observation.outcome !== "completed"
          && observation.outcome !== "pending"
        )
      ) {
        throw Object.assign(
          new Error("Normalized Order-linked capture identity changed"),
          { code: "RECONCILIATION_TARGET_MISMATCH" },
        );
      }
      const reduced = await this.store.recordObservation(
        {
          workspaceId: target.workspaceId,
          projectId: target.projectId,
        },
        observation,
      );
      const outcome: PayPalFinancialAuditOutcome =
        observation.outcome === "completed"
          ? reduced.matchesBasis && reduced.completed
            ? "capture-discovered"
            : "authoritative-mismatch"
          : observation.outcome;
      return Object.freeze({
        ...base,
        outcome,
        readinessRestored: outcome === "capture-discovered",
      });
    } catch (error) {
      return Object.freeze({
        ...base,
        outcome: failedAuditOutcome(error),
        readinessRestored: false,
      });
    }
  }
}

export function summarizePayPalFinancialAudit(
  results: readonly PayPalFinancialAuditResult[],
): PayPalFinancialAuditSummary {
  const count = (outcome: PayPalFinancialAuditOutcome) =>
    results.filter((result) => result.outcome === outcome).length;
  return Object.freeze({
    audited: results.length,
    activeAttempts: results.filter((result) => result.activeAttempt).length,
    knownFacts: results.filter((result) => !result.activeAttempt).length,
    staleFacts: results.filter((result) => result.staleBeforeAudit).length,
    exactRefreshes: count("exact-refresh"),
    captureDiscoveries: count("capture-discovered"),
    readinessRestored:
      results.filter((result) => result.readinessRestored).length,
    readinessWithheld: results.filter((result) =>
      result.staleBeforeAudit && !result.readinessRestored).length,
    pending: count("pending"),
    unknown: count("unknown"),
    credentialFailures: count("credential-failure"),
    providerFailures: count("provider-failure"),
    authoritativeMismatches: count("authoritative-mismatch"),
    domainFailures: count("domain-failure"),
    unresolved:
      results.filter((result) =>
        !successfulAuditOutcomes.has(result.outcome)
        || (result.staleBeforeAudit && !result.readinessRestored)).length,
  });
}

export async function runAllPayPalFinancialAuditPages(
  auditor: PayPalFinancialAuditor,
  input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    projectIds?: readonly string[];
    limit: number;
    auditIntervalMilliseconds?: number;
    now?: Date;
  }>,
): Promise<Readonly<{
  pages: number;
  summary: PayPalFinancialAuditSummary;
}>> {
  auditLimit(input.limit);
  let after: FinancialAuditCursor | undefined;
  let pages = 0;
  const results: PayPalFinancialAuditResult[] = [];
  for (;;) {
    const page = await auditor.auditPage({
      ...input,
      ...(after ? { after } : {}),
    });
    pages += 1;
    results.push(...page.results);
    if (!page.nextCursor) break;
    if (after && compareCursor(page.nextCursor, after) <= 0) {
      throw new Error("Financial audit target source did not advance");
    }
    after = page.nextCursor;
  }
  return Object.freeze({
    pages,
    summary: summarizePayPalFinancialAudit(results),
  });
}

function compareReceipt(
  left: StoredPayPalWebhookReceipt,
  right: StoredPayPalWebhookReceipt,
): number {
  return left.providerCreatedAt.getTime() - right.providerCreatedAt.getTime()
    || left.receivedAt.getTime() - right.receivedAt.getTime()
    || compareText(left.eventId, right.eventId);
}

function receiptFailure(
  receipt: StoredPayPalWebhookReceipt,
): PayPalWebhookProcessingResult {
  return Object.freeze({
    eventId: receipt.eventId,
    eventType: receipt.eventType,
    outcome: "unmatched-capture-operation",
  });
}

const terminalWithoutProjectSearch = new Set<PayPalWebhookProcessingOutcome>([
  "credential-failure",
  "provider-failure",
  "invalid-receipt",
  "resource-missing",
  "observed-no-automatic-action",
  "unsupported-event-retained",
]);

const financialTriggerTypes = new Set([
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.COMPLETED",
  "PAYMENT.REFUND.FAILED",
  "PAYMENT.CAPTURE.REVERSED",
]);

export async function processPayPalWebhookTriggersForKnownTargets(input: Readonly<{
  receipts: readonly StoredPayPalWebhookReceipt[];
  targets: readonly PayPalFinancialAuditTarget[];
  domain: PayPalWebhookDomainStore;
  provider: PayPalWebhookProviderClient;
}>): Promise<PayPalWebhookProcessingBatch> {
  const processor = new PayPalWebhookReceiptProcessor(
    { listReceipts: async () => [] },
    input.domain,
    input.provider,
  );
  const scopes = [...new Map(
    input.targets
      .map((target) => [
        `${target.workspaceId}\u0000${target.projectId}`,
        Object.freeze({
          workspaceId: target.workspaceId,
          projectId: target.projectId,
          environment: "sandbox" as const,
          merchantId: input.receipts[0]?.merchantId ?? "",
        }),
      ]),
  ).values()].sort((left, right) =>
    compareText(left.workspaceId, right.workspaceId)
    || compareText(left.projectId, right.projectId));
  const directScopes = new Map(
    input.targets
      .filter((target) => target.captureId !== null)
      .map((target) => [
        target.captureId!,
        scopes.find((scope) =>
          scope.workspaceId === target.workspaceId
          && scope.projectId === target.projectId)!,
      ]),
  );
  const results: PayPalWebhookProcessingResult[] = [];
  for (const receipt of [...input.receipts].sort(compareReceipt)) {
    if (scopes.length === 0) {
      results.push(Object.freeze({
        eventId: receipt.eventId,
        eventType: receipt.eventType,
        outcome: receipt.eventType === "CHECKOUT.ORDER.APPROVED"
          ? "observed-no-automatic-action"
          : financialTriggerTypes.has(receipt.eventType)
            ? "unmatched-capture-operation"
            : "unsupported-event-retained",
      }));
      continue;
    }
    const direct = receipt.resourceType.toLowerCase() === "capture"
      && receipt.resourceId
      ? directScopes.get(receipt.resourceId)
      : undefined;
    const candidates = direct ? [direct] : scopes;
    let finalResult: PayPalWebhookProcessingResult | null = null;
    for (const candidate of candidates) {
      const scope = {
        ...candidate,
        environment: receipt.environment,
        merchantId: receipt.merchantId,
      };
      const processed = await processor.processReceipts(scope, [receipt]);
      const current = processed.results[0]!;
      finalResult = current;
      if (
        current.outcome !== "unmatched-capture-operation"
        || terminalWithoutProjectSearch.has(current.outcome)
      ) {
        break;
      }
    }
    results.push(finalResult ?? receiptFailure(receipt));
  }
  return Object.freeze({ results: Object.freeze(results) });
}
