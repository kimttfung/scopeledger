import type { ProviderAuthoringAccess } from "./service";

type ProviderAction = "inspect" | "publish";

export type LocalClientApproverActivation = Readonly<{
  status: "ready" | "active";
  confirmationLocator: string;
  projectLabel: string;
  activatedAt: string | null;
  authority: Readonly<{
    inspect: true;
    decide: true;
    correct: true;
    pay: false;
  }>;
  localChannelVerification: "separate";
  effect: "prospective-project-only";
}>;

export type ParticipantDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAuthoringAccess>;
  authorize: (
    input: Readonly<{ projectId: string; action: ProviderAction }>,
  ) => Promise<boolean>;
  previewActivation: (
    input: Readonly<{ projectId: string }>,
  ) => Promise<LocalClientApproverActivation>;
  activate: (
    input: Readonly<{
      projectId: string;
      confirmationLocator: string;
    }>,
  ) => Promise<Readonly<{
    activation: LocalClientApproverActivation;
    duplicate: boolean;
  }>>;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const confirmationLocatorPattern = /^slpa1_[A-Za-z0-9_-]{43}$/u;

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

function providerFailure(
  access: Exclude<ProviderAuthoringAccess, { ok: true }>,
): Response {
  switch (access.code) {
    case "AUTHENTICATION_REQUIRED":
      return json({
        ok: false,
        code: access.code,
        message: "Sign in before managing project participants.",
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

async function authorize(
  dependencies: ParticipantDependencies,
  projectId: string,
  action: ProviderAction,
): Promise<Response | null> {
  try {
    const access = await dependencies.verifyProvider();
    if (!access.ok) return providerFailure(access);
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
  try {
    if (await dependencies.authorize({ projectId, action })) return null;
    return json({
      ok: false,
      code: "PROVIDER_GRANT_REQUIRED",
      message: `The protected demo provider ${action} grant is not active.`,
    }, 403);
  } catch {
    return json({
      ok: false,
      code: "PARTICIPANT_AUTHORITY_UNAVAILABLE",
      message: "Provider participant authority could not be verified.",
    }, 503);
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

function participantFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "PARTICIPANT_PROJECT_NOT_FOUND",
        message: "The selected provider-created project is not available.",
      }, 404);
    case "STALE_CONTEXT":
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "PARTICIPANT_AUTHORITY_CHANGED",
        message: "The project approver or authority state changed. Refresh before continuing.",
      }, 409);
    case "IDEMPOTENCY_CONFLICT":
      return json({
        ok: false,
        code: "PARTICIPANT_REPLAY_CONFLICT",
        message: "The server-owned activation identity conflicts with recorded content.",
      }, 409);
    default:
      return json({
        ok: false,
        code: "PARTICIPANT_ACTIVATION_UNAVAILABLE",
        message: "Local client-approver activation is temporarily unavailable.",
      }, 503);
  }
}

function validProject(projectId: string): boolean {
  return identifierPattern.test(projectId);
}

export async function handleParticipantPreviewGet(
  projectId: string,
  dependencies: ParticipantDependencies,
): Promise<Response> {
  if (!validProject(projectId)) {
    return participantFailure(Object.assign(new Error("NOT_FOUND"), {
      code: "NOT_FOUND",
    }));
  }
  const accessFailure = await authorize(dependencies, projectId, "inspect");
  if (accessFailure) return accessFailure;
  try {
    return json({
      ok: true,
      activation: await dependencies.previewActivation({ projectId }),
    });
  } catch (error) {
    return participantFailure(error);
  }
}

export async function handleParticipantActivatePost(
  request: Request,
  projectId: string,
  dependencies: ParticipantDependencies,
): Promise<Response> {
  if (!validProject(projectId)) {
    return participantFailure(Object.assign(new Error("NOT_FOUND"), {
      code: "NOT_FOUND",
    }));
  }
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "Participant activation must originate from ScopeLedger.",
    }, 403);
  }
  const accessFailure = await authorize(dependencies, projectId, "publish");
  if (accessFailure) return accessFailure;
  const input = await requestBody(request);
  if (
    !exactObject(input, ["confirmationLocator", "confirmed"])
    || input.confirmed !== true
    || typeof input.confirmationLocator !== "string"
    || !confirmationLocatorPattern.test(input.confirmationLocator)
  ) {
    return json({
      ok: false,
      code: "INVALID_PARTICIPANT_CONFIRMATION",
      message: "Explicit confirmation of the exact local-demo activation preview is required.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      ...await dependencies.activate({
        projectId,
        confirmationLocator: input.confirmationLocator,
      }),
    }, 201);
  } catch (error) {
    return participantFailure(error);
  }
}
