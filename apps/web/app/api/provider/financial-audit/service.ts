import type {
  PayPalFinancialAuditSummary,
  PayPalWebhookHealthSummary,
  PostgresFinancialAuditStatus,
} from "@scopeledger/payment-worker";

export type ProviderFinancialAuditAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type ProviderFinancialAuditStatus = PostgresFinancialAuditStatus &
Readonly<{
  generatedAt: string;
  auditIntervalSeconds: number;
  credentialFailures: number;
}>;

export type ProviderFinancialAuditRun = Readonly<{
  generatedAt: string;
  limit: number;
  truncated: boolean;
  audit: PayPalFinancialAuditSummary;
  webhooks: PayPalWebhookHealthSummary;
}>;

export type FinancialAuditDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderFinancialAuditAccess>;
  hasInspectGrant: () => Promise<boolean>;
  status: () => Promise<ProviderFinancialAuditStatus>;
  audit: (limit: number) => Promise<ProviderFinancialAuditRun>;
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
  access: Exclude<ProviderFinancialAuditAccess, { ok: true }>,
): Response {
  const message = access.code === "AUTHENTICATION_REQUIRED"
    ? "Sign in before viewing financial audit health."
    : access.code === "PROVIDER_ASSURANCE_REQUIRED"
      ? "Verified email and MFA assurance are required."
      : "Provider authentication is unavailable.";
  return json({ ok: false, code: access.code, message }, access.status);
}

async function authorize(
  dependencies: FinancialAuditDependencies,
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
      code: "FINANCIAL_AUDIT_UNAVAILABLE",
      message: "Financial audit health is temporarily unavailable.",
    }, 503);
  }
}

export async function handleFinancialAuditGet(
  dependencies: FinancialAuditDependencies,
): Promise<Response> {
  const denied = await authorize(dependencies);
  if (denied) return denied;
  try {
    return json({
      ok: true,
      status: await dependencies.status(),
      capabilities: {
        authoritativeAudit: true,
        paymentDispatch: false,
        refundInitiation: false,
        manualOutcomeOverride: false,
      },
    });
  } catch {
    return json({
      ok: false,
      code: "FINANCIAL_AUDIT_UNAVAILABLE",
      message: "Financial audit health is temporarily unavailable.",
    }, 503);
  }
}

export async function handleFinancialAuditPost(
  request: Request,
  dependencies: FinancialAuditDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "Audit must originate from the ScopeLedger application.",
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
      message: "Audit request must be valid JSON.",
    }, 400);
  }
  const candidate = body as Record<string, unknown> | null;
  if (
    !candidate
    || Array.isArray(candidate)
    || Object.keys(candidate).length !== 2
    || candidate.action !== "audit"
    || !Number.isInteger(candidate.limit)
    || (candidate.limit as number) < 1
    || (candidate.limit as number) > 100
  ) {
    return json({
      ok: false,
      code: "INVALID_REQUEST",
      message:
        "Only an explicit authoritative audit with a limit from 1 to 100 is supported.",
    }, 400);
  }
  try {
    return json({
      ok: true,
      run: await dependencies.audit(candidate.limit as number),
      status: await dependencies.status(),
      effects: {
        paymentDispatched: false,
        refundInitiated: false,
        paymentAttemptCreated: false,
        financialHistoryRewritten: false,
        manualOutcomeOverride: false,
      },
    });
  } catch {
    return json({
      ok: false,
      code: "FINANCIAL_AUDIT_FAILED",
      message:
        "Authoritative audit could not complete. Existing facts, attempts, and holds were not overridden.",
    }, 503);
  }
}
