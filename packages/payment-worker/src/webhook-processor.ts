import type { PaymentObservation } from "@scopeledger/contracts";
import type {
  DispatchAdmission,
  PaymentExceptionAdmission,
  PaymentExceptionObservation,
  PaymentExceptionReduction,
} from "@scopeledger/domain";
import type {
  PayPalCaptureDetails,
  PayPalOrderDetails,
  PayPalPaymentExceptionDetails,
  PayPalRefundDetails,
} from "@scopeledger/paypal-adapter";
import {
  captureNormalizationAdmission,
} from "./reconciliation-admission.js";

const DEFAULT_RECEIPT_LIMIT = 100;
const MAX_RECEIPT_LIMIT = 1_000;

const CAPTURE_EVENT_TYPES = new Set([
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DENIED",
]);

const REFUND_EVENT_TYPES = new Set([
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.COMPLETED",
  "PAYMENT.REFUND.FAILED",
]);

export type PayPalWebhookScope = Readonly<{
  workspaceId: string;
  projectId: string;
  environment: "sandbox" | "live";
  merchantId: string;
}>;

export type StoredPayPalWebhookReceipt = Readonly<{
  workspaceId: string;
  environment: "sandbox" | "live";
  merchantId: string;
  eventId: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  resourceStatus: string | null;
  providerCreatedAt: Date;
  receivedAt: Date;
  verificationReference: string;
}>;

export interface PayPalWebhookReceiptSource {
  listReceipts(input: Readonly<{
    workspaceId: string;
    environment: "sandbox" | "live";
    merchantId: string;
    limit: number;
  }>): Promise<readonly StoredPayPalWebhookReceipt[]>;
}

export interface PayPalWebhookDomainStore {
  captureReconciliationAdmission(
    scope: Readonly<{ workspaceId: string; projectId: string }>,
    orderId: string,
  ): Promise<DispatchAdmission>;
  recordObservation(
    scope: Readonly<{ workspaceId: string; projectId: string }>,
    observation: PaymentObservation,
  ): Promise<{ matchesBasis: boolean; completed: boolean }>;
  paymentExceptionAdmission(
    scope: Readonly<{ workspaceId: string; projectId: string }>,
    captureId: string,
  ): Promise<PaymentExceptionAdmission>;
  recordPaymentExceptionObservation(
    scope: Readonly<{ workspaceId: string; projectId: string }>,
    observation: PaymentExceptionObservation,
  ): Promise<PaymentExceptionReduction>;
}

export interface PayPalWebhookProviderClient {
  retrieveCaptureDetails(captureId: string): Promise<PayPalCaptureDetails>;
  captureObservationFromDetails(
    admission: DispatchAdmission,
    details: PayPalCaptureDetails,
  ): PaymentObservation;
  retrieveOrderDetails(orderId: string): Promise<PayPalOrderDetails>;
  retrieveRefundDetails(refundId: string): Promise<PayPalRefundDetails>;
  refundExceptionFromDetails(
    admission: PaymentExceptionAdmission,
    refund: PayPalRefundDetails,
    capture: PayPalCaptureDetails,
    order: PayPalOrderDetails,
  ): PayPalPaymentExceptionDetails;
  captureRefundExceptionFromDetails(
    admission: PaymentExceptionAdmission,
    capture: PayPalCaptureDetails,
    order: PayPalOrderDetails,
  ): PayPalPaymentExceptionDetails;
  captureReversalExceptionFromDetails(
    admission: PaymentExceptionAdmission,
    capture: PayPalCaptureDetails,
    order: PayPalOrderDetails,
  ): PayPalPaymentExceptionDetails;
}

export type PayPalWebhookProcessingOutcome =
  | "capture-observation-recorded"
  | "payment-exception-recorded"
  | "observed-no-automatic-action"
  | "resource-missing"
  | "invalid-receipt"
  | "unmatched-capture-operation"
  | "credential-failure"
  | "provider-failure"
  | "authoritative-resource-invalid"
  | "domain-failure"
  | "unsupported-event-retained"
  | "processor-failure";

export type PayPalWebhookProcessingResult = Readonly<{
  eventId: string;
  eventType: string;
  outcome: PayPalWebhookProcessingOutcome;
  matchesBasis?: boolean;
  completed?: boolean;
  exceptionState?: PaymentExceptionObservation["state"];
  duplicate?: boolean;
  holdActive?: boolean;
  operationalFailure?: "credential" | "provider" | "authoritative";
}>;

export type PayPalWebhookProcessingBatch = Readonly<{
  results: readonly PayPalWebhookProcessingResult[];
}>;

export type PayPalWebhookProcessingSummary = Readonly<{
  processed: number;
  eventTypes: readonly Readonly<{ eventType: string; count: number }>[];
  outcomes: readonly Readonly<{
    outcome: PayPalWebhookProcessingOutcome;
    count: number;
  }>[];
}>;

export type PayPalWebhookHealthSummary = Readonly<{
  receipts: number;
  processed: number;
  unresolved: number;
  credentialFailures: number;
  providerFailures: number;
  authoritativeFailures: number;
  lastReceiptAt: string | null;
  queueLagSeconds: number | null;
}>;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function optionalBoundedText(
  value: unknown,
  maximum: number,
): value is string | null {
  return value === null || boundedText(value, maximum);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function receiptLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RECEIPT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECEIPT_LIMIT) {
    throw new RangeError(
      `Webhook receipt limit must be an integer from 1 to ${MAX_RECEIPT_LIMIT}`,
    );
  }
  return limit;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortableTime(value: unknown): number {
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function sortableText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function compareReceipts(
  left: StoredPayPalWebhookReceipt,
  right: StoredPayPalWebhookReceipt,
): number {
  return sortableTime(left.providerCreatedAt) - sortableTime(right.providerCreatedAt)
    || sortableTime(left.receivedAt) - sortableTime(right.receivedAt)
    || compareText(sortableText(left.eventId), sortableText(right.eventId));
}

function safeIdentity(receipt: StoredPayPalWebhookReceipt): {
  eventId: string;
  eventType: string;
} {
  return {
    eventId: boundedText(receipt.eventId, 256)
      ? receipt.eventId
      : "invalid-receipt",
    eventType: boundedText(receipt.eventType, 128)
      ? receipt.eventType
      : "INVALID",
  };
}

function result(
  receipt: StoredPayPalWebhookReceipt,
  outcome: PayPalWebhookProcessingOutcome,
  reduced?: { matchesBasis: boolean; completed: boolean },
): PayPalWebhookProcessingResult {
  return Object.freeze({
    ...safeIdentity(receipt),
    outcome,
    ...(reduced
      ? {
          matchesBasis: reduced.matchesBasis,
          completed: reduced.completed,
        }
      : {}),
  });
}

function exceptionResult(
  receipt: StoredPayPalWebhookReceipt,
  state: PaymentExceptionObservation["state"],
  reduced: PaymentExceptionReduction,
): PayPalWebhookProcessingResult {
  return Object.freeze({
    ...safeIdentity(receipt),
    outcome: "payment-exception-recorded",
    exceptionState: state,
    duplicate: reduced.duplicate,
    holdActive: reduced.holdActive,
  });
}

function validReceipt(
  receipt: StoredPayPalWebhookReceipt,
  scope: PayPalWebhookScope,
): boolean {
  return receipt.workspaceId === scope.workspaceId
    && receipt.environment === scope.environment
    && receipt.merchantId === scope.merchantId
    && boundedText(receipt.eventId, 256)
    && boundedText(receipt.eventType, 128)
    && boundedText(receipt.resourceType, 128)
    && optionalBoundedText(receipt.resourceId, 256)
    && optionalBoundedText(receipt.resourceStatus, 128)
    && validDate(receipt.providerCreatedAt)
    && validDate(receipt.receivedAt)
    && boundedText(receipt.verificationReference, 256);
}

function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function unmatchedCapture(error: unknown): boolean {
  const code = errorCode(error);
  return code === "NOT_FOUND" || code === "RECONCILIATION_REQUIRED";
}

function authoritativeMismatch(error: unknown): boolean {
  const code = errorCode(error);
  return code === "MERCHANT_MISMATCH"
    || code === "FINANCIAL_MISMATCH"
    || code === "PROVIDER_RESPONSE_INVALID";
}

function providerFailure(error: unknown): PayPalWebhookProcessingOutcome {
  const code = errorCode(error);
  return code === "AUTHENTICATION_FAILED" || code === "INVALID_CONFIG"
    ? "credential-failure"
    : "provider-failure";
}

export class PayPalWebhookReceiptProcessor {
  constructor(
    private readonly receipts: PayPalWebhookReceiptSource,
    private readonly domain: PayPalWebhookDomainStore,
    private readonly provider: PayPalWebhookProviderClient,
  ) {}

  async list(
    scope: PayPalWebhookScope,
    options: Readonly<{ limit?: number }> = {},
  ): Promise<readonly StoredPayPalWebhookReceipt[]> {
    const limit = receiptLimit(options.limit);
    const receipts = await this.receipts.listReceipts({
      workspaceId: scope.workspaceId,
      environment: scope.environment,
      merchantId: scope.merchantId,
      limit,
    });
    return Object.freeze([...receipts].sort(compareReceipts).slice(0, limit));
  }

  async process(
    scope: PayPalWebhookScope,
    options: Readonly<{ limit?: number }> = {},
  ): Promise<PayPalWebhookProcessingBatch> {
    const receipts = await this.list(scope, options);
    return this.processReceipts(scope, receipts);
  }

  async processReceipts(
    scope: PayPalWebhookScope,
    receipts: readonly StoredPayPalWebhookReceipt[],
  ): Promise<PayPalWebhookProcessingBatch> {
    const results: PayPalWebhookProcessingResult[] = [];
    for (const receipt of [...receipts].sort(compareReceipts)) {
      try {
        results.push(await this.processReceipt(scope, receipt));
      } catch {
        results.push(result(receipt, "processor-failure"));
      }
    }
    return Object.freeze({ results: Object.freeze(results) });
  }

  private async processReceipt(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
  ): Promise<PayPalWebhookProcessingResult> {
    if (!validReceipt(receipt, scope)) {
      return result(receipt, "invalid-receipt");
    }
    if (CAPTURE_EVENT_TYPES.has(receipt.eventType)) {
      return this.processCapture(scope, receipt);
    }
    if (receipt.eventType === "CHECKOUT.ORDER.APPROVED") {
      return result(receipt, "observed-no-automatic-action");
    }
    if (REFUND_EVENT_TYPES.has(receipt.eventType)) {
      return this.processRefund(scope, receipt);
    }
    if (receipt.eventType === "PAYMENT.CAPTURE.REVERSED") {
      return this.processCaptureReversal(scope, receipt);
    }
    if (receipt.eventType === "CHECKOUT.PAYMENT-APPROVAL.REVERSED") {
      return result(receipt, "unsupported-event-retained");
    }
    return result(receipt, "unsupported-event-retained");
  }

  private async processCapture(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
  ): Promise<PayPalWebhookProcessingResult> {
    if (receipt.resourceId === null) {
      return result(receipt, "resource-missing");
    }
    if (receipt.resourceType.toLowerCase() !== "capture") {
      return result(receipt, "invalid-receipt");
    }

    let details: PayPalCaptureDetails;
    try {
      details = await this.provider.retrieveCaptureDetails(receipt.resourceId);
    } catch (error) {
      return result(receipt, providerFailure(error));
    }

    const domainScope = {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
    };
    let admission: DispatchAdmission;
    try {
      admission = await this.domain.captureReconciliationAdmission(
        domainScope,
        details.orderId,
      );
    } catch (error) {
      return result(
        receipt,
        unmatchedCapture(error)
          ? "unmatched-capture-operation"
          : "domain-failure",
      );
    }

    let observation: PaymentObservation;
    try {
      observation = this.provider.captureObservationFromDetails(
        captureNormalizationAdmission(admission),
        details,
      );
    } catch {
      return result(receipt, "authoritative-resource-invalid");
    }

    try {
      const reduced = await this.domain.recordObservation(
        domainScope,
        observation,
      );
      if (
        typeof reduced.matchesBasis !== "boolean"
        || typeof reduced.completed !== "boolean"
      ) {
        return result(receipt, "domain-failure");
      }
      return result(receipt, "capture-observation-recorded", reduced);
    } catch {
      return result(receipt, "domain-failure");
    }
  }

  private async processRefund(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
  ): Promise<PayPalWebhookProcessingResult> {
    if (receipt.resourceId === null) {
      return result(receipt, "resource-missing");
    }
    const resourceType = receipt.resourceType.toLowerCase();
    if (resourceType === "refund") {
      return this.processRefundResource(scope, receipt);
    }
    if (
      resourceType === "capture"
      && receipt.eventType === "PAYMENT.CAPTURE.REFUNDED"
    ) {
      return this.processCaptureRefund(scope, receipt);
    }
    return result(receipt, "invalid-receipt");
  }

  private async processRefundResource(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
  ): Promise<PayPalWebhookProcessingResult> {
    let refund: PayPalRefundDetails;
    try {
      refund = await this.provider.retrieveRefundDetails(receipt.resourceId!);
    } catch (error) {
      return result(receipt, providerFailure(error));
    }
    const admission = await this.exceptionAdmission(
      scope,
      receipt,
      refund.captureId,
    );
    if (!admission.ok) return admission.result;
    try {
      const capture = await this.provider.retrieveCaptureDetails(
        admission.value.captureId,
      );
      const order = await this.provider.retrieveOrderDetails(
        admission.value.orderId,
      );
      const observation = this.provider.refundExceptionFromDetails(
        admission.value,
        refund,
        capture,
        order,
      );
      return this.recordException(scope, receipt, observation);
    } catch (error) {
      return this.recordRefreshFailure(
        scope,
        receipt,
        admission.value,
        "refund",
        error,
      );
    }
  }

  private async processCaptureRefund(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
  ): Promise<PayPalWebhookProcessingResult> {
    const admission = await this.exceptionAdmission(
      scope,
      receipt,
      receipt.resourceId!,
    );
    if (!admission.ok) return admission.result;
    try {
      const capture = await this.provider.retrieveCaptureDetails(
        admission.value.captureId,
      );
      const order = await this.provider.retrieveOrderDetails(
        admission.value.orderId,
      );
      const observation = this.provider.captureRefundExceptionFromDetails(
        admission.value,
        capture,
        order,
      );
      return this.recordException(scope, receipt, observation);
    } catch (error) {
      return this.recordRefreshFailure(
        scope,
        receipt,
        admission.value,
        "refund",
        error,
      );
    }
  }

  private async processCaptureReversal(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
  ): Promise<PayPalWebhookProcessingResult> {
    if (receipt.resourceId === null) {
      return result(receipt, "resource-missing");
    }
    if (receipt.resourceType.toLowerCase() !== "capture") {
      return result(receipt, "invalid-receipt");
    }
    const admission = await this.exceptionAdmission(
      scope,
      receipt,
      receipt.resourceId,
    );
    if (!admission.ok) return admission.result;
    try {
      const capture = await this.provider.retrieveCaptureDetails(
        admission.value.captureId,
      );
      const order = await this.provider.retrieveOrderDetails(
        admission.value.orderId,
      );
      const observation = this.provider.captureReversalExceptionFromDetails(
        admission.value,
        capture,
        order,
      );
      return this.recordException(scope, receipt, observation);
    } catch (error) {
      return this.recordRefreshFailure(
        scope,
        receipt,
        admission.value,
        "capture-reversal",
        error,
      );
    }
  }

  private async exceptionAdmission(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
    captureId: string,
  ): Promise<
    | Readonly<{ ok: true; value: PaymentExceptionAdmission }>
    | Readonly<{ ok: false; result: PayPalWebhookProcessingResult }>
  > {
    try {
      return Object.freeze({
        ok: true,
        value: await this.domain.paymentExceptionAdmission(
          {
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
          },
          captureId,
        ),
      });
    } catch (error) {
      return Object.freeze({
        ok: false,
        result: result(
          receipt,
          unmatchedCapture(error)
            ? "unmatched-capture-operation"
            : "domain-failure",
        ),
      });
    }
  }

  private async recordRefreshFailure(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
    admission: PaymentExceptionAdmission,
    kind: PaymentExceptionObservation["kind"],
    error: unknown,
  ): Promise<PayPalWebhookProcessingResult> {
    const state = authoritativeMismatch(error) ? "mismatch" : "unknown";
    const recorded = await this.recordException(scope, receipt, Object.freeze({
      provider: "paypal",
      kind,
      state,
      operationId: admission.operationId,
      resourceId: receipt.resourceId!,
      orderId: admission.orderId,
      captureId: admission.captureId,
      merchantId: admission.merchantId,
      environment: admission.environment,
      currency: admission.currency,
      captureGross: admission.gross,
      affectedGross: null,
      providerStatus: state === "mismatch"
        ? "AUTHORITATIVE_RESOURCE_MISMATCH"
        : "AUTHORITATIVE_REFRESH_FAILED",
      evidence: {
        kind: "authenticated-adapter" as const,
        verificationReference: receipt.verificationReference,
      },
    }));
    return Object.freeze({
      ...recorded,
      operationalFailure: state === "mismatch"
        ? "authoritative"
        : providerFailure(error) === "credential-failure"
          ? "credential"
          : "provider",
    });
  }

  private async recordException(
    scope: PayPalWebhookScope,
    receipt: StoredPayPalWebhookReceipt,
    observation: PaymentExceptionObservation,
  ): Promise<PayPalWebhookProcessingResult> {
    try {
      const reduced = await this.domain.recordPaymentExceptionObservation(
        {
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        },
        observation,
      );
      return exceptionResult(receipt, observation.state, reduced);
    } catch {
      return result(receipt, "domain-failure");
    }
  }
}

export function summarizePayPalWebhookProcessing(
  batch: PayPalWebhookProcessingBatch,
): PayPalWebhookProcessingSummary {
  const eventTypes = new Map<string, number>();
  const outcomes = new Map<PayPalWebhookProcessingOutcome, number>();
  for (const processingResult of batch.results) {
    eventTypes.set(
      processingResult.eventType,
      (eventTypes.get(processingResult.eventType) ?? 0) + 1,
    );
    outcomes.set(
      processingResult.outcome,
      (outcomes.get(processingResult.outcome) ?? 0) + 1,
    );
  }
  return Object.freeze({
    processed: batch.results.length,
    eventTypes: Object.freeze(
      [...eventTypes]
        .sort(([left], [right]) => compareText(left, right))
        .map(([eventType, count]) => Object.freeze({ eventType, count })),
    ),
    outcomes: Object.freeze(
      [...outcomes]
        .sort(([left], [right]) => compareText(left, right))
        .map(([outcome, count]) => Object.freeze({ outcome, count })),
    ),
  });
}

const unresolvedOutcomes = new Set<PayPalWebhookProcessingOutcome>([
  "resource-missing",
  "invalid-receipt",
  "unmatched-capture-operation",
  "credential-failure",
  "provider-failure",
  "authoritative-resource-invalid",
  "domain-failure",
  "processor-failure",
]);

export function summarizePayPalWebhookHealth(
  batch: PayPalWebhookProcessingBatch,
  receipts: readonly StoredPayPalWebhookReceipt[],
  now: Date = new Date(),
): PayPalWebhookHealthSummary {
  const validReceivedTimes = receipts
    .map((receipt) => receipt.receivedAt.getTime())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const oldest = validReceivedTimes[0];
  const latest = validReceivedTimes[validReceivedTimes.length - 1];
  const credentialFailures = batch.results.filter((processingResult) =>
    processingResult.outcome === "credential-failure"
    || processingResult.operationalFailure === "credential").length;
  const providerFailures = batch.results.filter((processingResult) =>
    processingResult.outcome === "provider-failure"
    || processingResult.operationalFailure === "provider").length;
  const authoritativeFailures = batch.results.filter((processingResult) =>
    processingResult.outcome === "authoritative-resource-invalid"
    || processingResult.operationalFailure === "authoritative").length;
  const unresolved = batch.results.filter((processingResult) =>
    unresolvedOutcomes.has(processingResult.outcome)
    || processingResult.operationalFailure !== undefined).length;
  return Object.freeze({
    receipts: receipts.length,
    processed: batch.results.length,
    unresolved,
    credentialFailures,
    providerFailures,
    authoritativeFailures,
    lastReceiptAt: latest === undefined
      ? null
      : new Date(latest).toISOString(),
    queueLagSeconds: oldest === undefined
      ? null
      : Math.max(0, Math.floor((now.getTime() - oldest) / 1_000)),
  });
}
