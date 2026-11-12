export type ProviderPaymentExceptionAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type ProviderPaymentException = Readonly<{
  observationId: string;
  projectName: string;
  requestTitle: string;
  unitTitle: string;
  kind: "refund" | "capture-reversal";
  state:
    | "partial-refund"
    | "full-refund"
    | "reversed"
    | "failed"
    | "unknown"
    | "mismatch";
  providerStatus: string;
  providerResourceId: string;
  captureId: string;
  currency: "USD";
  captureGross: string;
  affectedGross: string | null;
  observedAt: string;
  activeFinancialHold: boolean;
  readiness: "withheld-financial-exception" | "no-blocking-effect-observed";
  workStart: null | Readonly<{
    version: number;
    recordedAt: string;
  }>;
}>;

export type PaymentExceptionRefreshSummary = Readonly<{
  processed: number;
  eventTypes: readonly Readonly<{ eventType: string; count: number }>[];
  outcomes: readonly Readonly<{ outcome: string; count: number }>[];
}>;

export type PaymentExceptionDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderPaymentExceptionAccess>;
  hasInspectGrant: () => Promise<boolean>;
  listExceptions: () => Promise<readonly ProviderPaymentException[]>;
  refresh: () => Promise<PaymentExceptionRefreshSummary>;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

function accessFailure(
  access: Exclude<ProviderPaymentExceptionAccess, { ok: true }>,
): Response {
  const message = access.code === "AUTHENTICATION_REQUIRED"
    ? "Sign in before viewing payment exceptions."
    : access.code === "PROVIDER_ASSURANCE_REQUIRED"
      ? "Verified email and MFA assurance are required."
      : "Provider authentication is unavailable.";
  return json({ ok: false, code: access.code, message }, access.status);
}

async function authorize(
  dependencies: PaymentExceptionDependencies,
): Promise<Response | null> {
  try {
    const access = await dependencies.verifyProvider();
    if (!access.ok) return accessFailure(access);
    if (!await dependencies.hasInspectGrant()) {
      return json({
        ok: false,
        code: "PROVIDER_GRANT_REQUIRED",
        message: "A current project inspection grant is required.",
      }, 403);
    }
    return null;
  } catch {
    return json({
      ok: false,
      code: "PAYMENT_EXCEPTIONS_UNAVAILABLE",
      message: "Payment exception records are temporarily unavailable.",
    }, 503);
  }
}

export async function handlePaymentExceptionsGet(
  dependencies: PaymentExceptionDependencies,
): Promise<Response> {
  const denied = await authorize(dependencies);
  if (denied) return denied;
  try {
    return json({
      ok: true,
      exceptions: await dependencies.listExceptions(),
      capabilities: {
        authoritativeRefresh: true,
        refundInitiation: false,
        manualOutcomeOverride: false,
      },
    });
  } catch {
    return json({
      ok: false,
      code: "PAYMENT_EXCEPTIONS_UNAVAILABLE",
      message: "Payment exception records are temporarily unavailable.",
    }, 503);
  }
}

export async function handlePaymentExceptionsRefresh(
  request: Request,
  dependencies: PaymentExceptionDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "Refresh must originate from the ScopeLedger application.",
    }, 403);
  }
  const denied = await authorize(dependencies);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      code: "INVALID_REQUEST",
      message: "Refresh request must be valid JSON.",
    }, 400);
  }
  if (
    !body
    || typeof body !== "object"
    || Array.isArray(body)
    || Object.keys(body).length !== 1
    || (body as Record<string, unknown>).action !== "refresh"
  ) {
    return json({
      ok: false,
      code: "INVALID_REQUEST",
      message: "Only an explicit authoritative refresh is supported.",
    }, 400);
  }
  try {
    const summary = await dependencies.refresh();
    return json({
      ok: true,
      summary,
      exceptions: await dependencies.listExceptions(),
      effects: {
        refundInitiated: false,
        paymentAttemptCreated: false,
        agreementChanged: false,
        manualOutcomeOverride: false,
      },
    });
  } catch {
    return json({
      ok: false,
      code: "PAYMENT_REFRESH_UNAVAILABLE",
      message:
        "Authoritative PayPal refresh could not complete. Existing facts and holds were not overridden.",
    }, 503);
  }
}
