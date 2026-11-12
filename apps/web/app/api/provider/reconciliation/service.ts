export type ProviderReconciliationAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type QuestionResponseStatus =
  | "answered"
  | "needs-client-information"
  | "closed";
export type CorrectionApplicability =
  | "no-material-change"
  | "material-change"
  | "needs-information";

type Attribution = Readonly<{
  label: "Client approver" | "Provider";
  at: string;
}>;

export type ReconciliationQuestion = Readonly<{
  questionId: string;
  projectName: string;
  requestTitle: string;
  unitTitle: string;
  version: number;
  text: string;
  asked: Attribution;
  status: "open" | QuestionResponseStatus;
  latestResponse: null | Readonly<{
    revision: number;
    status: QuestionResponseStatus;
    text: string;
    attribution: Attribution;
  }>;
  communicationEffect: "communication-only";
}>;

export type ReconciliationCorrection = Readonly<{
  concernId: string;
  projectName: string;
  requestTitle: string;
  unitTitle: string;
  version: number;
  statement: string;
  claimedSourceType: string;
  sourceAvailability: "available" | "unavailable";
  admitted: Attribution;
  correctionHoldActive: boolean;
  otherHoldPresent: boolean;
  latestResponse: null | Readonly<{
    revision: number;
    disposition: "accept" | "partial" | "maintain" | "request-information";
    text: string;
    attribution: Attribution;
  }>;
  latestAssessment: null | Readonly<{
    revision: number;
    applicability: CorrectionApplicability;
    responseRevision: number;
    reissueDraftRevision: number | null;
    attribution: Attribution;
  }>;
}>;

export type ReconciliationInbox = Readonly<{
  questions: readonly ReconciliationQuestion[];
  corrections: readonly ReconciliationCorrection[];
}>;

type MutationTarget = Readonly<{
  projectId: string;
  version: number;
}>;

export type ReconciliationDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderReconciliationAccess>;
  hasInboxGrant: () => Promise<boolean>;
  listInbox: () => Promise<ReconciliationInbox>;
  loadQuestionTarget: (questionId: string) => Promise<MutationTarget | null>;
  loadCorrectionTarget: (concernId: string) => Promise<MutationTarget | null>;
  authorize: (
    input: Readonly<{
      projectId: string;
      action: "inspect" | "review";
    }>,
  ) => Promise<boolean>;
  recordQuestionResponse: (
    input: Readonly<{
      questionId: string;
      expectedVersion: number;
      commandId: string;
      status: QuestionResponseStatus;
      response: string;
    }>,
  ) => Promise<Readonly<{
    duplicate: boolean;
    revision: number;
    status: QuestionResponseStatus;
    recordedAt: string;
  }>>;
  assessCorrection: (
    input: Readonly<{
      concernId: string;
      expectedVersion: number;
      commandId: string;
      applicability: CorrectionApplicability;
      response: string;
      sourceReview: string;
    }>,
  ) => Promise<Readonly<{
    duplicate: boolean;
    assessmentRevision: number;
    responseRevision: number;
    applicability: CorrectionApplicability;
    reissueDraftRevision: number | null;
    assessedAt: string;
  }>>;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

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

function boundedText(value: unknown): string | null {
  if (typeof value !== "string" || invalidUnicode.test(value)) return null;
  const length = Array.from(value).length;
  return length > 0
    && length <= 5_000
    && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function positiveRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function accessFailure(
  access: Exclude<ProviderReconciliationAccess, { ok: true }>,
): Response {
  const message = access.code === "AUTHENTICATION_REQUIRED"
    ? "Sign in before accessing the provider reconciliation inbox."
    : access.code === "PROVIDER_ASSURANCE_REQUIRED"
      ? "Verified email and MFA assurance are required."
      : "Provider authentication is unavailable.";
  return json({ ok: false, code: access.code, message }, access.status);
}

async function providerAccess(
  dependencies: ReconciliationDependencies,
): Promise<Response | null> {
  try {
    const access = await dependencies.verifyProvider();
    return access.ok ? null : accessFailure(access);
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
}

function sameOriginFailure(): Response {
  return json({
    ok: false,
    code: "SAME_ORIGIN_REQUIRED",
    message: "This operation must originate from the ScopeLedger application.",
  }, 403);
}

function mutationFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "RECONCILIATION_ITEM_NOT_AVAILABLE",
        message: "The selected inbox item is not available to this grant.",
      }, 404);
    case "STALE_CONTEXT":
    case "STALE_UNIT_VERSION":
    case "STALE_DRAFT_REVISION":
      return json({
        ok: false,
        code: "RECONCILIATION_STATE_CHANGED",
        message: "The exact project version changed. Refresh before continuing.",
      }, 409);
    case "IDEMPOTENCY_CONFLICT":
    case "QUESTION_RESPONSE_CONFLICT":
    case "ASSESSMENT_CONFLICT":
    case "DRAFT_CONFLICT":
      return json({
        ok: false,
        code: "RECONCILIATION_REPLAY_CONFLICT",
        message: "This idempotency key was already used for different content.",
      }, 409);
    case "REVIEW_HOLD":
      return json({
        ok: false,
        code: "CORRECTION_HOLD_NOT_ACTIVE",
        message: "The exact correction hold is no longer active.",
      }, 409);
    case "INVALID_INPUT":
      return json({
        ok: false,
        code: "INVALID_RECONCILIATION_INPUT",
        message: "The reconciliation input is invalid.",
      }, 422);
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "RECONCILIATION_ITEM_NOT_AVAILABLE",
        message: "The selected inbox item is not available to this grant.",
      }, 404);
    default:
      return json({
        ok: false,
        code: "RECONCILIATION_UNAVAILABLE",
        message: "Provider reconciliation is temporarily unavailable.",
      }, 503);
  }
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function mutationAccess(
  request: Request,
  dependencies: ReconciliationDependencies,
): Promise<Response | null> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return sameOriginFailure();
  }
  return providerAccess(dependencies);
}

async function resourceAccess(
  dependencies: ReconciliationDependencies,
  target: MutationTarget | null,
): Promise<Response | null> {
  if (!target) {
    return json({
      ok: false,
      code: "RECONCILIATION_ITEM_NOT_AVAILABLE",
      message: "The selected inbox item is not available to this grant.",
    }, 404);
  }
  try {
    if (await dependencies.authorize({
      projectId: target.projectId,
      action: "review",
    })) {
      return null;
    }
  } catch {
    return json({
      ok: false,
      code: "RECONCILIATION_AUTHORITY_UNAVAILABLE",
      message: "Provider product authority could not be verified.",
    }, 503);
  }
  return json({
    ok: false,
    code: "RECONCILIATION_ITEM_NOT_AVAILABLE",
    message: "The selected inbox item is not available to this grant.",
  }, 404);
}

export async function handleReconciliationGet(
  dependencies: ReconciliationDependencies,
): Promise<Response> {
  const failure = await providerAccess(dependencies);
  if (failure) return failure;
  try {
    if (!await dependencies.hasInboxGrant()) {
      return json({
        ok: false,
        code: "PROVIDER_GRANT_REQUIRED",
        message: "A current provider product grant is required.",
      }, 403);
    }
    return json({ ok: true, inbox: await dependencies.listInbox() });
  } catch {
    return json({
      ok: false,
      code: "RECONCILIATION_UNAVAILABLE",
      message: "Provider reconciliation is temporarily unavailable.",
    }, 503);
  }
}

export async function handleQuestionResponsePost(
  request: Request,
  questionId: string,
  dependencies: ReconciliationDependencies,
): Promise<Response> {
  if (!uuidPattern.test(questionId)) {
    return json({
      ok: false,
      code: "RECONCILIATION_ITEM_NOT_AVAILABLE",
      message: "The selected inbox item is not available to this grant.",
    }, 404);
  }
  const accessFailure = await mutationAccess(request, dependencies);
  if (accessFailure) return accessFailure;
  let target: MutationTarget | null;
  try {
    target = await dependencies.loadQuestionTarget(questionId);
  } catch {
    return mutationFailure(new Error("load failed"));
  }
  const productFailure = await resourceAccess(dependencies, target);
  if (productFailure) return productFailure;
  const input = await requestBody(request);
  if (!exactObject(input, [
    "idempotencyKey",
    "expectedVersion",
    "status",
    "response",
  ])) {
    return mutationFailure(Object.assign(new Error(), { code: "INVALID_INPUT" }));
  }
  const expectedVersion = positiveRevision(input.expectedVersion);
  const response = boundedText(input.response);
  const status = typeof input.status === "string"
    && ["answered", "needs-client-information", "closed"].includes(input.status)
    ? input.status as QuestionResponseStatus
    : null;
  if (
    typeof input.idempotencyKey !== "string"
    || !uuidPattern.test(input.idempotencyKey)
    || !expectedVersion
    || !status
    || !response
  ) {
    return mutationFailure(Object.assign(new Error(), { code: "INVALID_INPUT" }));
  }
  try {
    const recorded = await dependencies.recordQuestionResponse({
      questionId,
      expectedVersion,
      commandId: input.idempotencyKey,
      status,
      response,
    });
    return json({
      ok: true,
      duplicate: recorded.duplicate,
      response: {
        revision: recorded.revision,
        status: recorded.status,
        attribution: {
          label: "Provider",
          at: recorded.recordedAt,
        },
      },
      communicationEffect: "communication-only",
      reviewHoldCreated: false,
      agreementChanged: false,
      paymentChanged: false,
    }, recorded.duplicate ? 200 : 201);
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function handleCorrectionAssessmentPost(
  request: Request,
  concernId: string,
  dependencies: ReconciliationDependencies,
): Promise<Response> {
  if (!identifierPattern.test(concernId)) {
    return json({
      ok: false,
      code: "RECONCILIATION_ITEM_NOT_AVAILABLE",
      message: "The selected inbox item is not available to this grant.",
    }, 404);
  }
  const accessFailure = await mutationAccess(request, dependencies);
  if (accessFailure) return accessFailure;
  let target: MutationTarget | null;
  try {
    target = await dependencies.loadCorrectionTarget(concernId);
  } catch {
    return mutationFailure(new Error("load failed"));
  }
  const productFailure = await resourceAccess(dependencies, target);
  if (productFailure) return productFailure;
  const input = await requestBody(request);
  if (!exactObject(input, [
    "idempotencyKey",
    "expectedVersion",
    "applicability",
    "response",
    "sourceReview",
  ])) {
    return mutationFailure(Object.assign(new Error(), { code: "INVALID_INPUT" }));
  }
  const expectedVersion = positiveRevision(input.expectedVersion);
  const response = boundedText(input.response);
  const sourceReview = boundedText(input.sourceReview);
  const applicability = typeof input.applicability === "string"
    && [
      "no-material-change",
      "material-change",
      "needs-information",
    ].includes(input.applicability)
    ? input.applicability as CorrectionApplicability
    : null;
  if (
    typeof input.idempotencyKey !== "string"
    || !uuidPattern.test(input.idempotencyKey)
    || !expectedVersion
    || !applicability
    || !response
    || !sourceReview
  ) {
    return mutationFailure(Object.assign(new Error(), { code: "INVALID_INPUT" }));
  }
  try {
    const assessed = await dependencies.assessCorrection({
      concernId,
      expectedVersion,
      commandId: input.idempotencyKey,
      applicability,
      response,
      sourceReview,
    });
    return json({
      ok: true,
      duplicate: assessed.duplicate,
      assessment: {
        revision: assessed.assessmentRevision,
        applicability: assessed.applicability,
        responseRevision: assessed.responseRevision,
        attribution: {
          label: "Provider",
          at: assessed.assessedAt,
        },
        reissue: assessed.reissueDraftRevision === null
          ? null
          : {
            draftRevision: assessed.reissueDraftRevision,
            state: "in-progress",
            publicationRequired: true,
            priorConsentReused: false,
          },
      },
      correctionHoldCleared: false,
      clientAcknowledgementRequired:
        assessed.applicability !== "needs-information",
      agreementChanged: false,
      paymentChanged: false,
      refundChanged: false,
      recollectionChanged: false,
    }, assessed.duplicate ? 200 : 201);
  } catch (error) {
    return mutationFailure(error);
  }
}
