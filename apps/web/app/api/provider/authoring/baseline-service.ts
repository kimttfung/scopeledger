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

export type BaselinePreview = Readonly<{
  previewLocator: string;
  sourceLocator: string;
  displayReference: string;
  originalName: string | null;
  mediaType: string;
  provenanceOrigin: string;
  originReference: string | null;
  acceptance: Readonly<{
    kind: "provider-attested-import" | "in-app-record-reference" | "unverified";
    basis: string;
  }>;
  studioSharing: "permitted" | "denied" | "unresolved";
  confirmationAllowed: boolean;
  alreadyConfirmed: boolean;
  confirmedAt: string | null;
}>;

export type BaselineConfirmation = Readonly<{
  displayReference: string;
  baselineVersion: number;
  confirmedAt: string;
  duplicate: boolean;
}>;

export type BaselineDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAccess>;
  authorize: (
    projectId: string,
    requestId: string,
  ) => Promise<"authorized" | "not-found" | "grant-required">;
  previewBaseline: (input: Readonly<{
    projectId: string;
    requestId: string;
    sourceLocator: string;
  }>) => Promise<BaselinePreview>;
  confirmBaseline: (input: Readonly<{
    projectId: string;
    requestId: string;
    sourceLocator: string;
    previewLocator: string;
    idempotencyKey: string;
  }>) => Promise<BaselineConfirmation>;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sourceLocatorPattern = /^sl1_[A-Za-z0-9_-]{1,152}$/u;
const previewLocatorPattern = /^slbp1_[A-Za-z0-9_-]{43}$/u;

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

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function failure(error: unknown): Response {
  switch (errorCode(error)) {
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "BASELINE_SOURCE_NOT_FOUND",
        message: "The selected admitted source is not available in this request.",
      }, 404);
    case "STALE_CONTEXT":
      return json({
        ok: false,
        code: "BASELINE_SOURCE_STALE",
        message: "A newer source version or changed preview requires a fresh baseline preview.",
      }, 409);
    case "REVIEW_HOLD":
      return json({
        ok: false,
        code: "BASELINE_CONFIRMATION_BLOCKED",
        message: "This source lacks the provider attestation or sharing permission required for baseline confirmation.",
      }, 409);
    case "IDEMPOTENCY_CONFLICT":
      return json({
        ok: false,
        code: "BASELINE_REPLAY_CONFLICT",
        message: "This confirmation identity was already used with different content.",
      }, 409);
    case "INVALID_INPUT":
      return json({
        ok: false,
        code: "INVALID_BASELINE_CONFIRMATION",
        message: "The baseline confirmation request is invalid.",
      }, 422);
    default:
      return json({
        ok: false,
        code: "BASELINE_CONFIRMATION_UNAVAILABLE",
        message: "Baseline preview or confirmation is temporarily unavailable.",
      }, 503);
  }
}

async function authorize(
  request: Request,
  projectId: string,
  requestId: string,
  dependencies: BaselineDependencies,
): Promise<Response | null> {
  if (
    !identifierPattern.test(projectId)
    || !identifierPattern.test(requestId)
  ) {
    return json({
      ok: false,
      code: "BASELINE_SOURCE_NOT_FOUND",
      message: "The selected project request is not available.",
    }, 404);
  }
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "This operation must originate from the ScopeLedger application.",
    }, 403);
  }
  try {
    const access = await dependencies.verifyProvider();
    if (!access.ok) {
      return json({
        ok: false,
        code: access.code,
        message: access.code === "AUTHENTICATION_REQUIRED"
          ? "Sign in before confirming a provider baseline."
          : access.code === "PROVIDER_ASSURANCE_REQUIRED"
            ? "Verified email and MFA assurance are required."
            : "Provider authentication is unavailable.",
      }, access.status);
    }
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
  try {
    const result = await dependencies.authorize(projectId, requestId);
    if (result === "authorized") return null;
    return json({
      ok: false,
      code: result === "not-found"
        ? "BASELINE_SOURCE_NOT_FOUND"
        : "PROVIDER_GRANT_REQUIRED",
      message: result === "not-found"
        ? "The selected project request is not available."
        : "The protected demo provider publish grant is not active.",
    }, result === "not-found" ? 404 : 403);
  } catch {
    return json({
      ok: false,
      code: "AUTHORING_AUTHORITY_UNAVAILABLE",
      message: "Provider baseline authority could not be verified.",
    }, 503);
  }
}

export async function handleBaselinePreviewPost(
  request: Request,
  projectId: string,
  requestId: string,
  dependencies: BaselineDependencies,
): Promise<Response> {
  const accessFailure = await authorize(
    request,
    projectId,
    requestId,
    dependencies,
  );
  if (accessFailure) return accessFailure;
  const input = await requestBody(request);
  if (
    !exactObject(input, ["sourceLocator"])
    || typeof input.sourceLocator !== "string"
    || !sourceLocatorPattern.test(input.sourceLocator)
  ) {
    return json({
      ok: false,
      code: "INVALID_BASELINE_PREVIEW",
      message: "Select one exact admitted source version to preview.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      preview: await dependencies.previewBaseline({
        projectId,
        requestId,
        sourceLocator: input.sourceLocator,
      }),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function handleBaselineConfirmPost(
  request: Request,
  projectId: string,
  requestId: string,
  dependencies: BaselineDependencies,
): Promise<Response> {
  const accessFailure = await authorize(
    request,
    projectId,
    requestId,
    dependencies,
  );
  if (accessFailure) return accessFailure;
  const input = await requestBody(request);
  if (
    !exactObject(input, [
      "sourceLocator",
      "previewLocator",
      "idempotencyKey",
      "confirmed",
    ])
    || typeof input.sourceLocator !== "string"
    || !sourceLocatorPattern.test(input.sourceLocator)
    || typeof input.previewLocator !== "string"
    || !previewLocatorPattern.test(input.previewLocator)
    || typeof input.idempotencyKey !== "string"
    || !uuidPattern.test(input.idempotencyKey)
    || input.confirmed !== true
  ) {
    return json({
      ok: false,
      code: "INVALID_BASELINE_CONFIRMATION",
      message: "Explicit confirmation of one exact baseline preview is required.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      baseline: await dependencies.confirmBaseline({
        projectId,
        requestId,
        sourceLocator: input.sourceLocator,
        previewLocator: input.previewLocator,
        idempotencyKey: input.idempotencyKey,
      }),
    }, 201);
  } catch (error) {
    return failure(error);
  }
}
