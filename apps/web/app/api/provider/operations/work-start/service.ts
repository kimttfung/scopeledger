export type WorkStartReadiness =
  | "awaiting-agreement"
  | "review-hold"
  | "awaiting-payment"
  | "awaiting-prerequisite"
  | "financial-recheck"
  | "ready";

export type WorkStartFact = Readonly<{
  unitId: string;
  version: number;
  startedAt: string;
}>;

export type WorkStartSnapshot = Readonly<{
  unitId: string;
  acceptedVersion: number | null;
  readiness: WorkStartReadiness;
  activeHoldCount: number;
  workStart: WorkStartFact | null;
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

export type WorkStartDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAccess>;
  readSnapshot: () => Promise<WorkStartSnapshot>;
  recordWorkStart: (
    command: Readonly<{ commandId: string }>,
  ) => Promise<WorkStartFact>;
  createCommandId: () => string;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

function providerFailure(access: Exclude<ProviderAccess, { ok: true }>): Response {
  switch (access.code) {
    case "AUTHENTICATION_REQUIRED":
      return json({
        ok: false,
        code: access.code,
        message: "Sign in before accessing provider operations.",
      }, access.status);
    case "PROVIDER_ASSURANCE_REQUIRED":
      return json({
        ok: false,
        code: access.code,
        message: "Verified email and MFA assurance are required.",
      }, access.status);
    default:
      return json({
        ok: false,
        code: access.code,
        message: "Provider authentication is unavailable.",
      }, access.status);
  }
}

function errorCode(error: unknown): string | null {
  if (
    typeof error !== "object"
    || error === null
    || !("code" in error)
    || typeof error.code !== "string"
  ) {
    return null;
  }
  return error.code;
}

function recordingFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "PROVIDER_GRANT_REQUIRED",
        message: "The protected demo provider grant is not active.",
      }, 403);
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "WORK_UNIT_NOT_FOUND",
        message: "The work unit is not available.",
      }, 404);
    case "INVALID_INPUT":
      return json({
        ok: false,
        code: "INVALID_WORK_START_REQUEST",
        message: "The work-start request is invalid.",
      }, 422);
    case "IDEMPOTENCY_CONFLICT":
      return json({
        ok: false,
        code: "WORK_START_REPLAY_CONFLICT",
        message: "The work-start request identity conflicts with earlier content.",
      }, 409);
    case "REVIEW_HOLD":
    case "STALE_CONTEXT":
    case "STALE_UNIT_VERSION":
    case "RECONCILIATION_REQUIRED":
    case "PAYMENT_OUTCOME_UNKNOWN":
      return json({
        ok: false,
        code: "WORK_START_NOT_READY",
        message: "Work start cannot be recorded until the server reports ready with no active hold.",
      }, 409);
    default:
      return json({
        ok: false,
        code: "WORK_START_RECORDING_FAILED",
        message: "Work start could not be recorded.",
      }, 503);
  }
}

async function providerAccess(
  dependencies: WorkStartDependencies,
): Promise<Response | null> {
  let access: ProviderAccess;
  try {
    access = await dependencies.verifyProvider();
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
  return access.ok ? null : providerFailure(access);
}

export async function handleWorkStartGet(
  dependencies: WorkStartDependencies,
): Promise<Response> {
  const accessFailure = await providerAccess(dependencies);
  if (accessFailure) return accessFailure;

  try {
    return json({
      ok: true,
      snapshot: await dependencies.readSnapshot(),
    });
  } catch {
    return json({
      ok: false,
      code: "WORK_START_STATE_UNAVAILABLE",
      message: "Current operational state is unavailable.",
    }, 503);
  }
}

export async function handleWorkStartPost(
  request: Request,
  dependencies: WorkStartDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "This operation must originate from the ScopeLedger application.",
    }, 403);
  }

  const accessFailure = await providerAccess(dependencies);
  if (accessFailure) return accessFailure;

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({
      ok: false,
      code: "INVALID_WORK_START_REQUEST",
      message: "The work-start request must be an empty JSON object.",
    }, 400);
  }
  if (
    !input
    || typeof input !== "object"
    || Array.isArray(input)
    || Object.keys(input).length !== 0
  ) {
    return json({
      ok: false,
      code: "INVALID_WORK_START_REQUEST",
      message: "The browser cannot supply work-start authority or state.",
    }, 422);
  }

  try {
    const workStart = await dependencies.recordWorkStart({
      commandId: dependencies.createCommandId(),
    });
    return json({
      ok: true,
      recorded: true,
      workStart,
    });
  } catch (error) {
    return recordingFailure(error);
  }
}
