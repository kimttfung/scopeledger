import {
  commandIdentifier,
  digestSchema,
  identifier,
  moneySchema,
  observationSchema,
  parseInput,
  revision,
  z,
} from "@scopeledger/contracts";
import type { PaymentObservation } from "@scopeledger/contracts";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";

const SANDBOX_API_ORIGIN = "https://api-m.sandbox.paypal.com";
const SANDBOX_APPROVAL_ORIGIN = "https://www.sandbox.paypal.com";
const MAX_RESPONSE_CHARACTERS = 1_000_000;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type PayPalAdapterErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_OPERATION"
  | "AUTHENTICATION_FAILED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_RESPONSE_INVALID"
  | "FINANCIAL_MISMATCH"
  | "MERCHANT_MISMATCH"
  | "APPROVAL_LINK_INVALID"
  | "WEBHOOK_NOT_CONFIGURED"
  | "WEBHOOK_VERIFICATION_FAILED"
  | "WEBHOOK_EVENT_INVALID"
  | "WEBHOOK_STORAGE_FAILED";

export class PayPalAdapterError extends Error {
  public readonly status: number | undefined;
  public readonly debugId: string | undefined;

  constructor(
    public readonly code: PayPalAdapterErrorCode,
    message: string,
    status?: number,
    debugId?: string,
  ) {
    super(message);
    this.name = "PayPalAdapterError";
    this.status = status;
    this.debugId = debugId;
  }
}

function isSafeRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
  } catch {
    return false;
  }
}

const secretSchema = z.string().min(1).max(2_048);
const redirectUrlSchema = z.string().refine(isSafeRedirectUrl, "Expected HTTPS or sandbox loopback URL without credentials or fragment");
const payPalConfigSchema = z.strictObject({
  environment: z.literal("sandbox"),
  clientId: secretSchema,
  clientSecret: secretSchema,
  merchantId: identifier,
  returnUrl: redirectUrlSchema,
  cancelUrl: redirectUrlSchema,
  webhookId: identifier.optional(),
  timeoutMilliseconds: z.number().int().min(1_000).max(60_000).default(15_000),
});

export type PayPalConfig = z.infer<typeof payPalConfigSchema>;

export function parsePayPalConfig(input: unknown): PayPalConfig {
  const parsed = payPalConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new PayPalAdapterError(
      "INVALID_CONFIG",
      `PayPal sandbox configuration is invalid: ${parsed.error.issues.map((issue) => issue.path.join(".") || "$").join(", ")}`,
    );
  }
  return parsed.data;
}

export function payPalConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PayPalConfig {
  const timeout = environment.PAYPAL_TIMEOUT_MS;
  return parsePayPalConfig({
    environment: environment.PAYPAL_ENVIRONMENT,
    clientId: environment.PAYPAL_CLIENT_ID,
    clientSecret: environment.PAYPAL_CLIENT_SECRET,
    merchantId: environment.PAYPAL_MERCHANT_ID,
    returnUrl: environment.PAYPAL_RETURN_URL,
    cancelUrl: environment.PAYPAL_CANCEL_URL,
    ...(environment.PAYPAL_WEBHOOK_ID ? { webhookId: environment.PAYPAL_WEBHOOK_ID } : {}),
    ...(timeout ? { timeoutMilliseconds: Number(timeout) } : {}),
  });
}

const paymentOperationSchema = z.strictObject({
  schemaVersion: z.literal("scopeledger.payment-operation.v1"),
  obligationId: identifier,
  unitId: identifier,
  version: revision,
  kind: z.enum(["create", "capture"]),
  merchantId: identifier,
  environment: z.literal("sandbox"),
  currency: z.literal("USD"),
  gross: moneySchema,
  orderId: identifier.nullable(),
}).superRefine((request, context) => {
  if (request.kind === "create" && request.orderId !== null) {
    context.addIssue({ code: "custom", path: ["orderId"], message: "Create operations cannot supply an Order ID" });
  }
  if (request.kind === "capture" && request.orderId === null) {
    context.addIssue({ code: "custom", path: ["orderId"], message: "Capture operations require the original Order ID" });
  }
});

const dispatchAdmissionSchema = z.strictObject({
  dispatchAllowed: z.literal(true).optional(),
  reconciliationRequired: z.literal(false).optional(),
  operationId: commandIdentifier,
  providerKey: commandIdentifier,
  kind: z.enum(["create", "capture"]),
  request: paymentOperationSchema,
  requestHash: digestSchema,
}).superRefine((admission, context) => {
  if (admission.kind !== admission.request.kind) {
    context.addIssue({ code: "custom", path: ["kind"], message: "Admission and request operation kinds must agree" });
  }
});

export type PayPalDispatchAdmission = z.infer<typeof dispatchAdmissionSchema>;

const tokenResponseSchema = z.looseObject({
  access_token: z.string().min(1).max(4_096),
  expires_in: z.number().int().positive().max(86_400),
});

const amountSchema = z.looseObject({
  currency_code: z.literal("USD"),
  value: moneySchema,
});

const captureSchema = z.looseObject({
  id: identifier,
  status: z.string().min(1).max(64),
  amount: amountSchema,
});

const captureDetailsResponseSchema = z.looseObject({
  id: identifier,
  status: z.string().min(1).max(64),
  amount: amountSchema,
  payee: z.looseObject({ merchant_id: identifier }),
  supplementary_data: z.looseObject({
    related_ids: z.looseObject({ order_id: identifier }),
  }),
});

const captureDetailsSchema = z.strictObject({
  captureId: identifier,
  orderId: identifier,
  status: z.string().min(1).max(64),
  merchantId: identifier,
  currency: z.literal("USD"),
  gross: moneySchema,
  evidence: observationSchema.shape.evidence,
});

export type PayPalCaptureDetails = Readonly<
  z.infer<typeof captureDetailsSchema>
>;

const orderCaptureDetailsSchema = z.strictObject({
  captureId: identifier,
  status: z.string().min(1).max(64),
  currency: z.literal("USD"),
  gross: moneySchema,
});

const orderDetailsSchema = z.strictObject({
  orderId: identifier,
  status: z.string().min(1).max(64),
  merchantId: identifier,
  environment: z.literal("sandbox"),
  currency: z.literal("USD"),
  gross: moneySchema,
  captures: z.array(orderCaptureDetailsSchema).max(10),
});

export type PayPalOrderDetails = Readonly<
  z.infer<typeof orderDetailsSchema>
>;

const refundDetailsSchema = z.strictObject({
  refundId: identifier,
  captureId: identifier,
  status: z.string().min(1).max(64),
  currency: z.literal("USD"),
  gross: moneySchema,
  evidence: observationSchema.shape.evidence,
});

export type PayPalRefundDetails = Readonly<
  z.infer<typeof refundDetailsSchema>
>;

const purchaseUnitSchema = z.looseObject({
  reference_id: z.string().min(1).max(256).optional(),
  amount: amountSchema,
  payee: z.looseObject({ merchant_id: identifier.optional() }).optional(),
  payments: z.looseObject({
    captures: z.array(captureSchema).max(10).optional(),
  }).optional(),
});

const linkSchema = z.looseObject({
  href: z.url(),
  rel: z.string().min(1).max(64),
  method: z.string().min(1).max(16).optional(),
});

const refundDetailsResponseSchema = z.looseObject({
  id: identifier,
  status: z.string().min(1).max(64),
  amount: amountSchema,
  links: z.array(linkSchema).min(1).max(50),
});

const orderResponseSchema = z.looseObject({
  id: identifier,
  status: z.string().min(1).max(64),
  purchase_units: z.array(purchaseUnitSchema).min(1).max(10),
  links: z.array(linkSchema).max(50).optional(),
});

const webhookVerificationResponseSchema = z.looseObject({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});

const webhookVerificationInputSchema = z.strictObject({
  transmissionId: z.string().min(1).max(512),
  transmissionTime: z.string().min(1).max(512),
  transmissionSignature: z.string().min(1).max(4_096),
  certificateUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:"
      && (url.hostname === "api-m.sandbox.paypal.com" || url.hostname === "api.sandbox.paypal.com");
  }, "Expected a PayPal sandbox certificate URL"),
  authenticationAlgorithm: z.string().min(1).max(128),
  event: z.unknown(),
});

export type PayPalWebhookVerificationInput = z.infer<typeof webhookVerificationInputSchema>;

export const PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES = Object.freeze([
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

const webhookEventTypeSchema = z.enum(PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES);
const webhookEventSchema = z.looseObject({
  id: identifier,
  event_type: webhookEventTypeSchema,
  create_time: z.string().min(1).max(128).refine(
    (value) => Number.isFinite(Date.parse(value)),
    "Expected a provider timestamp",
  ),
  resource_type: z.string().min(1).max(128),
  resource: z.looseObject({
    id: z.string().min(1).max(256).optional(),
    status: z.string().min(1).max(128).optional(),
  }),
});

export type PayPalWebhookEventType =
  typeof PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES[number];

export type PayPalWebhookReceipt = Readonly<{
  schemaVersion: "scopeledger.paypal-webhook-receipt.v1";
  eventId: string;
  eventType: PayPalWebhookEventType;
  providerCreatedAt: string;
  resourceType: string;
  resourceId: string | null;
  resourceStatus: string | null;
  verification: "paypal-postback-success";
  receivedAt: string;
}>;

export function normalizeVerifiedPayPalWebhookReceipt(input: {
  readonly event: unknown;
  readonly receivedAt?: string;
}): PayPalWebhookReceipt {
  const parsed = webhookEventSchema.safeParse(input.event);
  if (!parsed.success) {
    throw new PayPalAdapterError(
      "WEBHOOK_EVENT_INVALID",
      "Verified PayPal webhook event did not match the permitted receipt contract",
    );
  }
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(receivedAt))) {
    throw new PayPalAdapterError(
      "WEBHOOK_EVENT_INVALID",
      "Webhook receipt time was invalid",
    );
  }
  return Object.freeze({
    schemaVersion: "scopeledger.paypal-webhook-receipt.v1",
    eventId: parsed.data.id,
    eventType: parsed.data.event_type,
    providerCreatedAt: parsed.data.create_time,
    resourceType: parsed.data.resource_type,
    resourceId: parsed.data.resource.id ?? null,
    resourceStatus: parsed.data.resource.status ?? null,
    verification: "paypal-postback-success",
    receivedAt,
  });
}

export async function persistVerifiedPayPalWebhookReceipt(input: {
  readonly rootDirectory: string;
  readonly event: unknown;
  readonly receivedAt?: string;
}): Promise<{
  readonly duplicate: boolean;
  readonly receipt: PayPalWebhookReceipt;
}> {
  const receipt = normalizeVerifiedPayPalWebhookReceipt(input);
  const root = resolve(input.rootDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const receiptPath = resolve(root, `${receipt.eventId}.json`);
  if (!receiptPath.startsWith(`${root}/`)) {
    throw new PayPalAdapterError(
      "WEBHOOK_STORAGE_FAILED",
      "Webhook receipt path escaped its configured inbox",
    );
  }
  let file;
  try {
    file = await open(receiptPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return Object.freeze({ duplicate: true, receipt });
    }
    throw new PayPalAdapterError(
      "WEBHOOK_STORAGE_FAILED",
      "Verified webhook receipt could not be durably stored",
    );
  } finally {
    await file?.close();
  }
  try {
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    throw new PayPalAdapterError(
      "WEBHOOK_STORAGE_FAILED",
      "Webhook inbox directory could not be durably synchronized",
    );
  }
  return Object.freeze({ duplicate: false, receipt });
}

export type PayPalExecutionResult =
  | {
    readonly kind: "create";
    readonly observation: PaymentObservation;
    readonly approvalUrl: string;
  }
  | {
    readonly kind: "capture";
    readonly observation: PaymentObservation;
  };

type Token = {
  readonly value: string;
  readonly expiresAt: number;
};

type JsonResponse = {
  readonly value: unknown;
  readonly debugId: string | undefined;
};

function safeDebugId(response: Response): string | undefined {
  const value = response.headers.get("paypal-debug-id");
  return value && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARACTERS) {
    throw new PayPalAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      "PayPal response exceeded the adapter limit",
      response.status,
      safeDebugId(response),
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PayPalAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      "PayPal returned a non-JSON response",
      response.status,
      safeDebugId(response),
    );
  }
}

function parseProviderResponse<T>(
  schema: z.ZodType<T>,
  input: unknown,
  debugId?: string,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new PayPalAdapterError(
      "PROVIDER_RESPONSE_INVALID",
      "PayPal response did not match the reviewed adapter contract",
      undefined,
      debugId,
    );
  }
  return parsed.data;
}

function evidenceReference(operationId: string): string {
  return `paypal_${operationId.replaceAll("-", "")}`;
}

export class PayPalSandboxClient {
  private readonly config: PayPalConfig;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly syntheticTransport: boolean;
  private token: Token | null = null;
  private tokenRequest: Promise<string> | null = null;

  constructor(
    configInput: unknown,
    options: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.config = parsePayPalConfig(configInput);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.syntheticTransport = options.fetch !== undefined;
  }

  async execute(input: unknown): Promise<PayPalExecutionResult> {
    const admission = this.parseAdmission(input);
    return admission.kind === "create"
      ? this.createOrder(admission)
      : this.captureOrder(admission);
  }

  async checkAuthentication(): Promise<{
    readonly environment: "sandbox";
    readonly merchantId: string;
  }> {
    await this.accessToken();
    return Object.freeze({
      environment: this.config.environment,
      merchantId: this.config.merchantId,
    });
  }

  async createOrder(input: unknown): Promise<PayPalExecutionResult & { readonly kind: "create" }> {
    const admission = this.parseAdmission(input, "create");
    const request = admission.request;
    const createdResponse = await this.authorizedJson(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: request.obligationId,
          custom_id: `${request.unitId}-v${request.version}`,
          amount: { currency_code: request.currency, value: request.gross },
        }],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: this.config.returnUrl,
              cancel_url: this.config.cancelUrl,
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      },
      admission.providerKey,
    );
    const created = parseProviderResponse(orderResponseSchema, createdResponse.value, createdResponse.debugId);
    const retrievedResponse = await this.authorizedJson(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(created.id)}`,
    );
    const retrieved = parseProviderResponse(orderResponseSchema, retrievedResponse.value, retrievedResponse.debugId);
    this.assertOrderBasis(retrieved, request);
    const approvalUrl = this.approvalUrl([...created.links ?? [], ...retrieved.links ?? []]);
    const observation = parseInput(observationSchema, {
      operationId: admission.operationId,
      evidence: this.evidence(admission.operationId),
      merchantId: request.merchantId,
      environment: request.environment,
      currency: request.currency,
      gross: request.gross,
      orderId: retrieved.id,
      outcome: "order-created",
    });
    return Object.freeze({ kind: "create", observation, approvalUrl });
  }

  async captureOrder(input: unknown): Promise<PayPalExecutionResult & { readonly kind: "capture" }> {
    const admission = this.parseAdmission(input, "capture");
    const request = admission.request;
    const orderId = request.orderId;
    if (orderId === null) {
      throw new PayPalAdapterError("INVALID_OPERATION", "Capture requires the original Order ID");
    }
    await this.authorizedJson(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {},
      admission.providerKey,
    );
    const retrievedResponse = await this.authorizedJson(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
    const retrieved = parseProviderResponse(orderResponseSchema, retrievedResponse.value, retrievedResponse.debugId);
    this.assertOrderBasis(retrieved, request);
    const captures = retrieved.purchase_units.flatMap((unit) => unit.payments?.captures ?? []);
    if (captures.length !== 1) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Expected exactly one capture for the selected single-unit payment flow",
        undefined,
        retrievedResponse.debugId,
      );
    }
    const capture = captures[0];
    if (!capture) {
      throw new PayPalAdapterError("PROVIDER_RESPONSE_INVALID", "Capture response was missing");
    }
    if (capture.amount.currency_code !== request.currency || capture.amount.value !== request.gross) {
      throw new PayPalAdapterError(
        "FINANCIAL_MISMATCH",
        "PayPal capture amount did not match the admitted financial basis",
        undefined,
        retrievedResponse.debugId,
      );
    }
    const outcome = capture.status === "COMPLETED"
      ? "completed"
      : capture.status === "PENDING" ? "pending" : "unknown";
    const observation = parseInput(observationSchema, {
      operationId: admission.operationId,
      evidence: this.evidence(admission.operationId),
      merchantId: request.merchantId,
      environment: request.environment,
      currency: request.currency,
      gross: request.gross,
      orderId: retrieved.id,
      captureId: capture.id,
      outcome,
    });
    return Object.freeze({ kind: "capture", observation });
  }

  async retrieveCaptureDetails(captureIdInput: unknown): Promise<PayPalCaptureDetails> {
    const captureId = parseInput(identifier, captureIdInput);
    const response = await this.authorizedJson(
      "GET",
      `/v2/payments/captures/${encodeURIComponent(captureId)}`,
    );
    const capture = parseProviderResponse(
      captureDetailsResponseSchema,
      response.value,
      response.debugId,
    );
    if (capture.id !== captureId) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "PayPal capture retrieval returned a different resource identity",
        undefined,
        response.debugId,
      );
    }
    if (capture.payee.merchant_id !== this.config.merchantId) {
      throw new PayPalAdapterError(
        "MERCHANT_MISMATCH",
        "Retrieved PayPal capture did not belong to the configured merchant",
        undefined,
        response.debugId,
      );
    }
    return Object.freeze(parseInput(captureDetailsSchema, {
      captureId: capture.id,
      orderId: capture.supplementary_data.related_ids.order_id,
      status: capture.status,
      merchantId: capture.payee.merchant_id,
      currency: capture.amount.currency_code,
      gross: capture.amount.value,
      evidence: this.captureEvidence(capture.id),
    }));
  }

  async retrieveOrderDetails(orderIdInput: unknown): Promise<PayPalOrderDetails> {
    const orderId = parseInput(identifier, orderIdInput);
    const response = await this.authorizedJson(
      "GET",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
    );
    const order = parseProviderResponse(
      orderResponseSchema,
      response.value,
      response.debugId,
    );
    if (order.id !== orderId) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "PayPal Order retrieval returned a different resource identity",
        undefined,
        response.debugId,
      );
    }
    if (order.purchase_units.length !== 1) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Expected one PayPal purchase unit during capture recovery",
        undefined,
        response.debugId,
      );
    }
    const unit = order.purchase_units[0];
    if (!unit) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Retrieved PayPal Order was missing its purchase unit",
        undefined,
        response.debugId,
      );
    }
    if (unit.payee?.merchant_id !== this.config.merchantId) {
      throw new PayPalAdapterError(
        "MERCHANT_MISMATCH",
        "Retrieved PayPal Order did not identify the configured merchant",
        undefined,
        response.debugId,
      );
    }
    return Object.freeze(parseInput(orderDetailsSchema, {
      orderId: order.id,
      status: order.status,
      merchantId: unit.payee.merchant_id,
      environment: this.config.environment,
      currency: unit.amount.currency_code,
      gross: unit.amount.value,
      captures: (unit.payments?.captures ?? []).map((capture) => ({
        captureId: capture.id,
        status: capture.status,
        currency: capture.amount.currency_code,
        gross: capture.amount.value,
      })),
    }));
  }

  captureObservationFromDetails(
    admissionInput: unknown,
    detailsInput: unknown,
  ): PaymentObservation {
    const admission = this.parseAdmission(admissionInput, "capture");
    const details = parseInput(captureDetailsSchema, detailsInput);
    const request = admission.request;
    if (
      details.orderId !== request.orderId
      || details.merchantId !== request.merchantId
    ) {
      throw new PayPalAdapterError(
        "MERCHANT_MISMATCH",
        "Retrieved capture identity did not match the admitted operation",
      );
    }
    if (
      details.currency !== request.currency
      || details.gross !== request.gross
    ) {
      throw new PayPalAdapterError(
        "FINANCIAL_MISMATCH",
        "Retrieved capture amount did not match the admitted operation",
      );
    }
    const outcome = details.status === "COMPLETED"
      ? "completed"
      : details.status === "PENDING" ? "pending" : "unknown";
    return parseInput(observationSchema, {
      operationId: admission.operationId,
      evidence: details.evidence,
      merchantId: details.merchantId,
      environment: request.environment,
      currency: details.currency,
      gross: details.gross,
      orderId: details.orderId,
      captureId: details.captureId,
      outcome,
    });
  }

  captureObservationFromOrderDetails(
    admissionInput: unknown,
    detailsInput: unknown,
  ): PaymentObservation {
    const admission = this.parseAdmission(admissionInput, "capture");
    const details = parseInput(orderDetailsSchema, detailsInput);
    const request = admission.request;
    if (
      details.orderId !== request.orderId
      || details.merchantId !== request.merchantId
      || details.environment !== request.environment
    ) {
      throw new PayPalAdapterError(
        "MERCHANT_MISMATCH",
        "Retrieved Order identity did not match the admitted capture operation",
      );
    }
    if (
      details.currency !== request.currency
      || details.gross !== request.gross
    ) {
      throw new PayPalAdapterError(
        "FINANCIAL_MISMATCH",
        "Retrieved Order amount did not match the admitted capture operation",
      );
    }
    if (details.captures.length !== 1) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Capture recovery requires exactly one capture linked by the original PayPal Order",
      );
    }
    const capture = details.captures[0];
    if (!capture) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Capture recovery did not find an exact linked capture",
      );
    }
    if (
      capture.currency !== request.currency
      || capture.gross !== request.gross
    ) {
      throw new PayPalAdapterError(
        "FINANCIAL_MISMATCH",
        "Linked PayPal capture amount did not match the admitted operation",
      );
    }
    const outcome = capture.status === "COMPLETED"
      ? "completed"
      : capture.status === "PENDING" ? "pending" : null;
    if (!outcome) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "Linked PayPal capture was not completed or pending",
      );
    }
    return parseInput(observationSchema, {
      operationId: admission.operationId,
      evidence: this.captureEvidence(capture.captureId),
      merchantId: details.merchantId,
      environment: details.environment,
      currency: capture.currency,
      gross: capture.gross,
      orderId: details.orderId,
      captureId: capture.captureId,
      outcome,
    });
  }

  async retrieveRefundDetails(refundIdInput: unknown): Promise<PayPalRefundDetails> {
    const refundId = parseInput(identifier, refundIdInput);
    const response = await this.authorizedJson(
      "GET",
      `/v2/payments/refunds/${encodeURIComponent(refundId)}`,
    );
    const refund = parseProviderResponse(
      refundDetailsResponseSchema,
      response.value,
      response.debugId,
    );
    if (refund.id !== refundId) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "PayPal refund retrieval returned a different resource identity",
        undefined,
        response.debugId,
      );
    }
    const captureLink = refund.links.find((link) => link.rel === "up");
    if (!captureLink) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "PayPal refund did not identify its parent capture",
        undefined,
        response.debugId,
      );
    }
    const url = new URL(captureLink.href);
    const match = /^\/v2\/payments\/captures\/([A-Za-z0-9_-]{1,96})$/.exec(url.pathname);
    if (url.origin !== SANDBOX_API_ORIGIN || !match?.[1]) {
      throw new PayPalAdapterError(
        "PROVIDER_RESPONSE_INVALID",
        "PayPal refund parent link used an unexpected resource origin or shape",
        undefined,
        response.debugId,
      );
    }
    return Object.freeze(parseInput(refundDetailsSchema, {
      refundId: refund.id,
      captureId: match[1],
      status: refund.status,
      currency: refund.amount.currency_code,
      gross: refund.amount.value,
      evidence: this.refundEvidence(refund.id),
    }));
  }

  async verifyWebhook(input: unknown): Promise<true> {
    if (!this.config.webhookId) {
      throw new PayPalAdapterError(
        "WEBHOOK_NOT_CONFIGURED",
        "PAYPAL_WEBHOOK_ID is required before webhook verification",
      );
    }
    const webhook = this.parseWebhookInput(input);
    const response = await this.authorizedJson(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      {
        transmission_id: webhook.transmissionId,
        transmission_time: webhook.transmissionTime,
        cert_url: webhook.certificateUrl,
        auth_algo: webhook.authenticationAlgorithm,
        transmission_sig: webhook.transmissionSignature,
        webhook_id: this.config.webhookId,
        webhook_event: webhook.event,
      },
    );
    const verification = parseProviderResponse(
      webhookVerificationResponseSchema,
      response.value,
      response.debugId,
    );
    if (verification.verification_status !== "SUCCESS") {
      throw new PayPalAdapterError(
        "WEBHOOK_VERIFICATION_FAILED",
        "PayPal did not verify the webhook signature",
        undefined,
        response.debugId,
      );
    }
    return true;
  }

  private parseAdmission(
    input: unknown,
    expectedKind?: "create" | "capture",
  ): PayPalDispatchAdmission {
    const parsed = dispatchAdmissionSchema.safeParse(input);
    if (!parsed.success || (expectedKind && parsed.data.kind !== expectedKind)) {
      throw new PayPalAdapterError(
        "INVALID_OPERATION",
        "Payment dispatch admission did not match the PayPal adapter contract",
      );
    }
    if (parsed.data.request.environment !== this.config.environment) {
      throw new PayPalAdapterError("INVALID_OPERATION", "Operation environment does not match the adapter");
    }
    if (parsed.data.request.merchantId !== this.config.merchantId) {
      throw new PayPalAdapterError("MERCHANT_MISMATCH", "Operation merchant does not match the configured sandbox merchant");
    }
    return parsed.data;
  }

  private evidence(operationId: string): PaymentObservation["evidence"] {
    return this.syntheticTransport
      ? {
        kind: "synthetic-fault",
        scenario: "Injected local PayPal adapter contract fixture; no provider authentication or provider call occurred",
      }
      : {
        kind: "authenticated-adapter",
        verificationReference: evidenceReference(operationId),
      };
  }

  private captureEvidence(captureId: string): PaymentObservation["evidence"] {
    return this.syntheticTransport
      ? {
        kind: "synthetic-fault",
        scenario: "Injected local PayPal capture-retrieval fixture; no provider authentication or provider call occurred",
      }
      : {
        kind: "authenticated-adapter",
        verificationReference: `paypal_capture_${captureId}`,
      };
  }

  private refundEvidence(refundId: string): PaymentObservation["evidence"] {
    return this.syntheticTransport
      ? {
        kind: "synthetic-fault",
        scenario: "Injected local PayPal refund-retrieval fixture; no provider authentication or provider call occurred",
      }
      : {
        kind: "authenticated-adapter",
        verificationReference: `paypal_refund_${refundId}`,
      };
  }

  private parseWebhookInput(input: unknown): PayPalWebhookVerificationInput {
    const parsed = webhookVerificationInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new PayPalAdapterError(
        "WEBHOOK_VERIFICATION_FAILED",
        "Webhook verification input did not match the reviewed adapter contract",
      );
    }
    return parsed.data;
  }

  private assertOrderBasis(
    order: z.infer<typeof orderResponseSchema>,
    request: z.infer<typeof paymentOperationSchema>,
  ): void {
    if (order.purchase_units.length !== 1) {
      throw new PayPalAdapterError("PROVIDER_RESPONSE_INVALID", "Expected one PayPal purchase unit");
    }
    const unit = order.purchase_units[0];
    if (!unit) {
      throw new PayPalAdapterError("PROVIDER_RESPONSE_INVALID", "PayPal Order was missing its purchase unit");
    }
    if (unit.reference_id && unit.reference_id !== request.obligationId) {
      throw new PayPalAdapterError("FINANCIAL_MISMATCH", "PayPal Order reference did not match the admitted obligation");
    }
    if (unit.amount.currency_code !== request.currency || unit.amount.value !== request.gross) {
      throw new PayPalAdapterError("FINANCIAL_MISMATCH", "PayPal Order amount did not match the admitted financial basis");
    }
    if (unit.payee?.merchant_id && unit.payee.merchant_id !== request.merchantId) {
      throw new PayPalAdapterError("MERCHANT_MISMATCH", "PayPal Order payee did not match the configured merchant");
    }
  }

  private approvalUrl(links: readonly z.infer<typeof linkSchema>[]): string {
    const match = links.find((link) => link.rel === "payer-action")
      ?? links.find((link) => link.rel === "approve");
    if (!match) {
      throw new PayPalAdapterError("APPROVAL_LINK_INVALID", "PayPal Order did not include an approval link");
    }
    const url = new URL(match.href);
    if (url.origin !== SANDBOX_APPROVAL_ORIGIN || url.protocol !== "https:" || url.username || url.password) {
      throw new PayPalAdapterError("APPROVAL_LINK_INVALID", "PayPal approval link used an unexpected origin");
    }
    return url.toString();
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now() + 5_000) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    const pending = this.fetchAccessToken().finally(() => {
      this.tokenRequest = null;
    });
    this.tokenRequest = pending;
    return pending;
  }

  private async fetchAccessToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(`${SANDBOX_API_ORIGIN}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(this.config.timeoutMilliseconds),
      });
    } catch {
      throw new PayPalAdapterError("AUTHENTICATION_FAILED", "PayPal OAuth request did not complete");
    }
    const value = await responseJson(response);
    if (!response.ok) {
      throw new PayPalAdapterError(
        "AUTHENTICATION_FAILED",
        "PayPal rejected sandbox authentication",
        response.status,
        safeDebugId(response),
      );
    }
    const token = parseProviderResponse(tokenResponseSchema, value, safeDebugId(response));
    const marginMilliseconds = Math.max(30_000, Math.min(300_000, token.expires_in * 100));
    this.token = {
      value: token.access_token,
      expiresAt: this.now() + token.expires_in * 1_000 - marginMilliseconds,
    };
    return token.access_token;
  }

  private async authorizedJson(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    requestId?: string,
    allowAuthenticationRefresh = true,
  ): Promise<JsonResponse> {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.fetcher(`${SANDBOX_API_ORIGIN}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
          Prefer: "return=representation",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMilliseconds),
      });
    } catch {
      throw new PayPalAdapterError("PROVIDER_REJECTED", "PayPal request outcome is unknown");
    }
    if (response.status === 401 && allowAuthenticationRefresh) {
      this.token = null;
      return this.authorizedJson(method, path, body, requestId, false);
    }
    const value = await responseJson(response);
    if (!response.ok) {
      throw new PayPalAdapterError(
        "PROVIDER_REJECTED",
        "PayPal rejected the reviewed sandbox request",
        response.status,
        safeDebugId(response),
      );
    }
    return { value, debugId: safeDebugId(response) };
  }
}
