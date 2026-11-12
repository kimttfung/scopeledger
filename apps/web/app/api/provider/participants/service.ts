export type ParticipantOperation =
  | "revoke-approver"
  | "restore-approver"
  | "revoke-payer"
  | "restore-payer";

export type ParticipantStatus =
  | "active"
  | "revoked"
  | "replacement-active"
  | "continuity-changed"
  | "incomplete"
  | "not-assigned";

export type ProviderParticipant = Readonly<{
  selector: string;
  kind: "project-approver" | "obligation-payer";
  projectLabel: string;
  requestLabel: string | null;
  unitTitle: string | null;
  amount: Readonly<{
    currency: "USD";
    gross: string;
  }> | null;
  participantLabel: string;
  status: ParticipantStatus;
  recovery: "none" | "admitted-capture";
  availableOperations: readonly ParticipantOperation[];
}>;

export type ParticipantPreview = Readonly<{
  confirmationLocator: string;
  operation: ParticipantOperation;
  projectLabel: string;
  requestLabel: string | null;
  unitTitle: string | null;
  amount: Readonly<{
    currency: "USD";
    gross: string;
  }> | null;
  participantLabel: string;
  effect: readonly string[];
  preserved: readonly string[];
  requiresReissue: boolean;
  admittedCaptureRecoveryPreserved: boolean;
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

export type ParticipantLifecycleDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAccess>;
  list: () => Promise<readonly ProviderParticipant[]>;
  preview: (
    selector: string,
    operation: ParticipantOperation,
  ) => Promise<ParticipantPreview>;
  confirm: (
    confirmationLocator: string,
  ) => Promise<Readonly<{
    participant: ProviderParticipant;
    duplicate: boolean;
  }>>;
}>;

const privateHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "Surrogate-Control": "no-store",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});
const selectorPattern = /^slpt1_[A-Za-z0-9_-]{43}$/u;
const confirmationPattern =
  /^slpcf1_[A-Za-z0-9_-]{43}_[A-Za-z0-9_-]{43}$/u;
const operations = new Set<ParticipantOperation>([
  "revoke-approver",
  "restore-approver",
  "revoke-payer",
  "restore-payer",
]);

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: privateHeaders });
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

function providerFailure(
  access: Exclude<ProviderAccess, { ok: true }>,
): Response {
  switch (access.code) {
    case "AUTHENTICATION_REQUIRED":
      return json({
        ok: false,
        code: access.code,
        message: "Sign in before managing provider participants.",
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

async function providerAccess(
  dependencies: ParticipantLifecycleDependencies,
): Promise<Response | null> {
  try {
    const access = await dependencies.verifyProvider();
    return access.ok ? null : providerFailure(access);
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
}

function sameOrigin(
  request: Request,
  dependencies: ParticipantLifecycleDependencies,
): Response | null {
  try {
    dependencies.requireSameOrigin(request);
    return null;
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "Participant lifecycle changes must originate from ScopeLedger.",
    }, 403);
  }
}

function lifecycleFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "PROVIDER_GRANT_REQUIRED",
        message: "The current provider product grant is not active.",
      }, 403);
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "PARTICIPANT_NOT_AVAILABLE",
        message: "The selected participant authority is not available.",
      }, 404);
    case "STALE_CONTEXT":
    case "STALE_RECORD":
      return json({
        ok: false,
        code: "PARTICIPANT_STATE_CHANGED",
        message: "Participant authority changed. Refresh before continuing.",
      }, 409);
    case "IDEMPOTENCY_CONFLICT":
      return json({
        ok: false,
        code: "PARTICIPANT_REPLAY_CONFLICT",
        message: "The recorded confirmation conflicts with durable content.",
      }, 409);
    default:
      return json({
        ok: false,
        code: "PARTICIPANT_LIFECYCLE_UNAVAILABLE",
        message: "Provider participant lifecycle is temporarily unavailable.",
      }, 503);
  }
}

export async function handleParticipantsGet(
  dependencies: ParticipantLifecycleDependencies,
): Promise<Response> {
  const rejected = await providerAccess(dependencies);
  if (rejected) return rejected;
  try {
    return json({ ok: true, participants: await dependencies.list() });
  } catch (error) {
    return lifecycleFailure(error);
  }
}

export async function handleParticipantPreviewPost(
  request: Request,
  dependencies: ParticipantLifecycleDependencies,
): Promise<Response> {
  const originFailure = sameOrigin(request, dependencies);
  if (originFailure) return originFailure;
  const rejected = await providerAccess(dependencies);
  if (rejected) return rejected;
  const input = await requestBody(request);
  if (
    !exactObject(input, ["selector", "operation"])
    || typeof input.selector !== "string"
    || !selectorPattern.test(input.selector)
    || typeof input.operation !== "string"
    || !operations.has(input.operation as ParticipantOperation)
  ) {
    return json({
      ok: false,
      code: "INVALID_PARTICIPANT_PREVIEW",
      message: "Select one current participant action to preview.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      preview: await dependencies.preview(
        input.selector,
        input.operation as ParticipantOperation,
      ),
    });
  } catch (error) {
    return lifecycleFailure(error);
  }
}

export async function handleParticipantConfirmPost(
  request: Request,
  dependencies: ParticipantLifecycleDependencies,
): Promise<Response> {
  const originFailure = sameOrigin(request, dependencies);
  if (originFailure) return originFailure;
  const rejected = await providerAccess(dependencies);
  if (rejected) return rejected;
  const input = await requestBody(request);
  if (
    !exactObject(input, ["confirmationLocator", "confirmed"])
    || input.confirmed !== true
    || typeof input.confirmationLocator !== "string"
    || !confirmationPattern.test(input.confirmationLocator)
  ) {
    return json({
      ok: false,
      code: "INVALID_PARTICIPANT_CONFIRMATION",
      message: "Confirm the exact current participant preview.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      ...await dependencies.confirm(input.confirmationLocator),
    }, 201);
  } catch (error) {
    return lifecycleFailure(error);
  }
}
