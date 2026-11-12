import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
type ReviewLocators = Readonly<{
  projectLocator: string;
  requestLocator: string;
  unitLocator: string;
}>;

type ApprovedPaymentTarget = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  unitId: string;
  version: number;
  digest: string;
  obligationId: string;
  projectNominationEpoch: number;
  providerInspectGrantEpoch: number;
  providerPublishGrantEpoch: number;
  projectLabel: string;
  requestLabel: string;
  unitTitle: string;
  currency: "USD";
  gross: string;
  payer: Readonly<{
    workspaceId: string;
    projectId: string;
    actorId: string;
    grantEpoch: number;
    obligationId: string;
    payerEpoch: number;
    nominationEpoch: number;
  }> | null;
  admittedCaptureRecovery?: boolean;
  activatedAt: string | null;
}>;

type ProviderAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type ProviderPaymentActivation = Readonly<{
  status: "ready" | "active";
  confirmationLocator: string;
  projectLabel: string;
  requestLabel: string;
  unitTitle: string;
  amount: Readonly<{
    currency: "USD";
    gross: string;
  }>;
  payer: Readonly<{
    label: "Fixed local demo payer";
    localChannelVerification: "separate";
  }>;
  authority: Readonly<{
    pay: true;
    inspect: false;
    decide: false;
    correct: false;
    publish: false;
    nominate: false;
  }>;
  obligationScope: "exact-approved-obligation";
  payerUrl: string | null;
  activatedAt: string | null;
}>;

export type ProviderPaymentDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAccess>;
  loadTarget: (
    locators: ReviewLocators,
  ) => Promise<ApprovedPaymentTarget>;
  confirmationLocator: (
    target: ApprovedPaymentTarget,
  ) => string;
  matchesConfirmation: (
    candidate: string,
    target: ApprovedPaymentTarget,
  ) => boolean;
  payerUrl: (
    target: ApprovedPaymentTarget,
    locators: ReviewLocators,
  ) => string;
  activate: (
    target: ApprovedPaymentTarget,
  ) => Promise<Readonly<{ duplicate: boolean }>>;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const confirmationPattern = /^slpc1_[A-Za-z0-9_-]{43}$/u;
const secretPattern = /^[a-f0-9]{64}$/iu;

export class PaymentActivationLocatorCodec {
  private readonly secret: Buffer;

  constructor(secret: string) {
    if (!secretPattern.test(secret)) {
      throw new Error(
        "Payment activation locator secret must be a 32-byte hexadecimal value",
      );
    }
    this.secret = Buffer.from(secret, "hex");
  }

  confirmation(target: ApprovedPaymentTarget): string {
    return `slpc1_${createHmac("sha256", this.secret)
      .update([
        "scopeledger.payment-activation.v1",
        target.workspaceId,
        target.projectId,
        target.requestId,
        target.unitId,
        String(target.version),
        target.digest,
        target.obligationId,
        String(target.projectNominationEpoch),
        target.currency,
        target.gross,
      ].join("\u0000"))
      .digest("base64url")}`;
  }

  matches(
    candidate: string,
    target: ApprovedPaymentTarget,
  ): boolean {
    const expected = this.confirmation(target);
    const left = Buffer.from(candidate, "utf8");
    const right = Buffer.from(expected, "utf8");
    return left.length === right.length && timingSafeEqual(left, right);
  }
}

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function providerFailure(
  access: Exclude<ProviderAccess, { ok: true }>,
): Response {
  return json({ ok: false, code: access.code }, access.status);
}

async function authorize(
  dependencies: ProviderPaymentDependencies,
): Promise<Response | null> {
  try {
    const access = await dependencies.verifyProvider();
    return access.ok ? null : providerFailure(access);
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
    }, 503);
  }
}

function activation(
  target: ApprovedPaymentTarget,
  locators: ReviewLocators,
  dependencies: ProviderPaymentDependencies,
): ProviderPaymentActivation {
  const active = target.payer !== null;
  return Object.freeze({
    status: active ? "active" : "ready",
    confirmationLocator: dependencies.confirmationLocator(target),
    projectLabel: target.projectLabel,
    requestLabel: target.requestLabel,
    unitTitle: target.unitTitle,
    amount: Object.freeze({
      currency: target.currency,
      gross: target.gross,
    }),
    payer: Object.freeze({
      label: "Fixed local demo payer",
      localChannelVerification: "separate",
    }),
    authority: Object.freeze({
      pay: true,
      inspect: false,
      decide: false,
      correct: false,
      publish: false,
      nominate: false,
    }),
    obligationScope: "exact-approved-obligation",
    payerUrl: active ? dependencies.payerUrl(target, locators) : null,
    activatedAt: target.activatedAt,
  });
}

function activationFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "PAYMENT_AUTHORITY_NOT_AVAILABLE",
      }, 404);
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "PROVIDER_PAYMENT_GRANT_REQUIRED",
      }, 403);
    case "STALE_CONTEXT":
    case "STALE_RECORD":
    case "MALFORMED_RECORD":
    case "IDEMPOTENCY_CONFLICT":
      return json({
        ok: false,
        code: "PAYMENT_AUTHORITY_CHANGED",
      }, 409);
    default:
      return json({
        ok: false,
        code: "PAYMENT_AUTHORITY_UNAVAILABLE",
      }, 503);
  }
}

export async function handleProviderPaymentPreviewGet(
  locators: ReviewLocators,
  dependencies: ProviderPaymentDependencies,
): Promise<Response> {
  const rejected = await authorize(dependencies);
  if (rejected) return rejected;
  try {
    const target = await dependencies.loadTarget(locators);
    return json({
      ok: true,
      activation: activation(target, locators, dependencies),
    });
  } catch (error) {
    return activationFailure(error);
  }
}

export async function handleProviderPaymentActivatePost(
  request: Request,
  locators: ReviewLocators,
  dependencies: ProviderPaymentDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({ ok: false, code: "SAME_ORIGIN_REQUIRED" }, 403);
  }
  const rejected = await authorize(dependencies);
  if (rejected) return rejected;
  let input;
  try {
    input = await request.json();
  } catch {
    input = null;
  }
  if (
    !exactObject(input, ["confirmationLocator", "confirmed"])
    || input.confirmed !== true
    || typeof input.confirmationLocator !== "string"
    || !confirmationPattern.test(input.confirmationLocator)
  ) {
    return json({
      ok: false,
      code: "INVALID_PAYMENT_AUTHORITY_CONFIRMATION",
    }, 422);
  }
  try {
    const before = await dependencies.loadTarget(locators);
    if (!dependencies.matchesConfirmation(
      input.confirmationLocator,
      before,
    )) {
      return json({
        ok: false,
        code: "PAYMENT_AUTHORITY_CHANGED",
      }, 409);
    }
    const result = await dependencies.activate(before);
    const after = await dependencies.loadTarget(locators);
    if (!after.payer) {
      throw Object.assign(new Error("Payer activation was not durable"), {
        code: "STALE_CONTEXT",
      });
    }
    return json({
      ok: true,
      duplicate: result.duplicate,
      activation: activation(after, locators, dependencies),
    }, 201);
  } catch (error) {
    return activationFailure(error);
  }
}
