import { z } from "zod";

const locatorPatterns = {
  project: /^slr1p_[A-Za-z0-9_-]{43}$/u,
  request: /^slr1r_[A-Za-z0-9_-]{43}$/u,
  unit: /^slr1u_[A-Za-z0-9_-]{43}$/u,
} as const;
const mutationHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "Surrogate-Control": "no-store",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

export type ReviewMutationLocators = Readonly<{
  projectLocator: string;
  requestLocator: string;
  unitLocator: string;
}>;

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("decision"),
    decision: z.enum(["approve", "decline"]),
    reviewedExactVersion: z.boolean(),
    authority: z.boolean(),
    acknowledgedResponses: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("question"),
    text: z.string(),
    allowModel: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("correction"),
    text: z.string(),
    allowModel: z.boolean(),
  }),
]);

const protocolErrorCodes = new Set([
  "ACCESS_DENIED",
  "COLLECTION_CONFLICT",
  "DECISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_INPUT",
  "NOT_FOUND",
  "PAYMENT_OUTCOME_UNKNOWN",
  "QUESTION_CONFLICT",
  "REVIEW_HOLD",
  "STALE_CONTEXT",
  "STALE_UNIT_VERSION",
]);
const TEXT_LIMIT = 10_000;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const invalidQuestionControl = /(?![\t\n])\p{Cc}/u;

export type ReviewMutationSession = Readonly<{
  subject: string;
  role: "client-approver" | "payer";
  challengeId: string;
}>;

export type ReviewMutationBasis = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  unitId: string;
  version: number;
  digest: string;
  actorId: string;
  nominationEpoch: number;
  decideGrantEpoch: number;
  correctGrantEpoch: number | null;
  terminalDecision: "approve" | "decline" | null;
  resolutionConcerns: readonly Readonly<{
    concernId: string;
    responseRevision: number;
  }>[];
}>;

export type ReviewDecisionCommand = Readonly<{
  commandId: string;
  unitId: string;
  version: number;
  digest: string;
  decision: "approve" | "decline";
  attestation: Readonly<{
    reviewedExactVersion: true;
    authority: boolean;
    statement: string;
  }>;
  resolution?: Readonly<{
    acknowledged: true;
    concerns: readonly Readonly<{
      concernId: string;
      responseRevision: number;
    }>[];
  }>;
}>;

export type ReviewQuestionCommand = Readonly<{
  questionId: string;
  requestId: string;
  unitId: string;
  unitVersion: number;
  askedBy: string;
  exactText: string;
  modelProcessing: "permitted" | "denied";
}>;

export type ReviewCorrectionCommand = Readonly<{
  commandId: string;
  concernId: string;
  packetId: string;
  originUnitId: string;
  scope: Readonly<{
    kind: "known";
    unitIds: readonly string[];
  }>;
  claim: Readonly<{
    statement: string;
    claimedSourceType: string;
    source: Readonly<{
      availability: "unavailable";
      explanation: string;
    }>;
    sharingAuthorized: true;
    modelProcessingPermitted: boolean;
  }>;
}>;

export type ReviewMutationDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  readSession: () => Promise<ReviewMutationSession | null>;
  loadMutationBasis: (
    locators: ReviewMutationLocators,
    session: ReviewMutationSession,
  ) => Promise<ReviewMutationBasis>;
  decide: (
    basis: ReviewMutationBasis,
    command: ReviewDecisionCommand,
  ) => Promise<Readonly<{
    decision: "approve" | "decline";
    obligationId: string | null;
  }>>;
  askQuestion: (
    basis: ReviewMutationBasis,
    command: ReviewQuestionCommand,
  ) => Promise<Readonly<{ duplicate: boolean }>>;
  admitCorrection: (
    basis: ReviewMutationBasis,
    command: ReviewCorrectionCommand,
  ) => Promise<Readonly<{
    concernId: string;
    affectedUnitIds: readonly string[];
  }>>;
  createId: (
    kind: "decision-command" | "question" | "correction-command" | "concern",
    basis: ReviewMutationBasis,
    session: ReviewMutationSession,
  ) => string;
}>;

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: mutationHeaders,
  });
}

function validReviewMutationLocators(
  locators: ReviewMutationLocators,
): boolean {
  return locatorPatterns.project.test(locators.projectLocator)
    && locatorPatterns.request.test(locators.requestLocator)
    && locatorPatterns.unit.test(locators.unitLocator);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validText(value: string, question: boolean): boolean {
  return value.trim().length > 0
    && codePointLength(value) <= TEXT_LIMIT
    && !invalidUnicode.test(value)
    && (!question || !invalidQuestionControl.test(value));
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
  return protocolErrorCodes.has(error.code) ? error.code : null;
}

function loadFailure(error: unknown): Response | null {
  if (
    typeof error !== "object"
    || error === null
    || !("name" in error)
    || error.name !== "ReviewLoadError"
    || !("code" in error)
    || typeof error.code !== "string"
  ) {
    return null;
  }
  switch (error.code) {
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "REVIEW_MUTATION_NOT_AUTHORIZED",
      }, 403);
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "REVIEW_MUTATION_NOT_AVAILABLE",
      }, 404);
    case "STALE_RECORD":
    case "MALFORMED_RECORD":
      return json({
        ok: false,
        code: "REVIEW_STATE_CHANGED",
      }, 409);
  }
  return null;
}

function mutationFailure(
  error: unknown,
  kind: "decision" | "question" | "correction",
): Response {
  const code = errorCode(error);
  if (code === "ACCESS_DENIED") {
    return json({
      ok: false,
      code: "REVIEW_MUTATION_NOT_AUTHORIZED",
    }, 403);
  }
  if (code === "NOT_FOUND") {
    return json({
      ok: false,
      code: "REVIEW_MUTATION_NOT_AVAILABLE",
    }, 404);
  }
  if (
    code === "DECISION_CONFLICT"
    || code === "IDEMPOTENCY_CONFLICT"
    || code === "QUESTION_CONFLICT"
  ) {
    return json({
      ok: false,
      code: kind === "decision"
        ? "REVIEW_DECISION_ALREADY_RECORDED"
        : "REVIEW_MUTATION_CONFLICT",
    }, 409);
  }
  if (
    code === "REVIEW_HOLD"
    || code === "STALE_CONTEXT"
    || code === "STALE_UNIT_VERSION"
    || code === "COLLECTION_CONFLICT"
    || code === "PAYMENT_OUTCOME_UNKNOWN"
  ) {
    return json({
      ok: false,
      code: "REVIEW_STATE_CHANGED",
    }, 409);
  }
  if (code === "INVALID_INPUT") {
    return json({
      ok: false,
      code: "INVALID_REVIEW_MUTATION",
    }, 422);
  }
  return json({
    ok: false,
    code: "REVIEW_MUTATION_FAILED",
  }, 503);
}

export async function handleReviewMutationPost(
  request: Request,
  locators: ReviewMutationLocators,
  dependencies: ReviewMutationDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "REVIEW_MUTATION_ORIGIN_REQUIRED",
    }, 403);
  }

  if (!validReviewMutationLocators(locators)) {
    return json({
      ok: false,
      code: "REVIEW_MUTATION_NOT_AVAILABLE",
    }, 404);
  }

  let session: ReviewMutationSession | null;
  try {
    session = await dependencies.readSession();
  } catch {
    return json({
      ok: false,
      code: "REVIEW_ACCESS_UNAVAILABLE",
    }, 503);
  }
  if (!session) {
    return json({
      ok: false,
      code: "CLIENT_ACCESS_REQUIRED",
    }, 401);
  }
  if (session.role !== "client-approver") {
    return json({
      ok: false,
      code: "CLIENT_APPROVER_REQUIRED",
    }, 403);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({
      ok: false,
      code: "INVALID_REVIEW_MUTATION",
    }, 422);
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return json({
      ok: false,
      code: "INVALID_REVIEW_MUTATION",
    }, 422);
  }
  if (
    parsed.data.kind !== "decision"
    && !validText(parsed.data.text, parsed.data.kind === "question")
  ) {
    return json({
      ok: false,
      code: codePointLength(parsed.data.text) > TEXT_LIMIT
        ? "REVIEW_TEXT_LIMIT"
        : "INVALID_REVIEW_MUTATION",
    }, 422);
  }
  if (
    parsed.data.kind === "decision"
    && !parsed.data.reviewedExactVersion
  ) {
    return json({
      ok: false,
      code: "EXACT_VERSION_ACKNOWLEDGEMENT_REQUIRED",
    }, 422);
  }
  if (
    parsed.data.kind === "decision"
    && parsed.data.decision === "approve"
    && !parsed.data.authority
  ) {
    return json({
      ok: false,
      code: "APPROVAL_AUTHORITY_REQUIRED",
    }, 422);
  }

  let basis: ReviewMutationBasis;
  try {
    basis = await dependencies.loadMutationBasis(locators, session);
  } catch (error) {
    return loadFailure(error) ?? json({
      ok: false,
      code: "REVIEW_ACCESS_UNAVAILABLE",
    }, 503);
  }

  if (parsed.data.kind === "decision") {
    if (basis.terminalDecision) {
      return json({
        ok: false,
        code: "REVIEW_DECISION_ALREADY_RECORDED",
      }, 409);
    }
    if (
      basis.resolutionConcerns.length > 0
      && !parsed.data.acknowledgedResponses
    ) {
      return json({
        ok: false,
        code: "RESPONSE_ACKNOWLEDGEMENT_REQUIRED",
      }, 422);
    }
    const resolution = basis.resolutionConcerns.length > 0
      ? {
        acknowledged: true as const,
        concerns: basis.resolutionConcerns,
      }
      : undefined;
    try {
      const result = await dependencies.decide(basis, {
        commandId: dependencies.createId(
          "decision-command",
          basis,
          session,
        ),
        unitId: basis.unitId,
        version: basis.version,
        digest: basis.digest,
        decision: parsed.data.decision,
        attestation: {
          reviewedExactVersion: true,
          authority: parsed.data.authority,
          statement:
            "Verified local client approver reviewed the exact current published terms and explicitly recorded this outcome.",
        },
        ...(resolution ? { resolution } : {}),
      });
      return json({
        ok: true,
        kind: "decision",
        decision: result.decision,
        agreementStatus: result.decision === "approve"
          ? "approved"
          : "declined",
        obligationCreated: result.decision === "approve"
          && result.obligationId !== null,
        paymentStatus: "not-initiated",
        paymentChanged: false,
      }, 200);
    } catch (error) {
      return mutationFailure(error, "decision");
    }
  }

  if (parsed.data.kind === "question") {
    try {
      const result = await dependencies.askQuestion(basis, {
        questionId: dependencies.createId("question", basis, session),
        requestId: basis.requestId,
        unitId: basis.unitId,
        unitVersion: basis.version,
        askedBy: basis.actorId,
        exactText: parsed.data.text,
        modelProcessing: parsed.data.allowModel ? "permitted" : "denied",
      });
      return json({
        ok: true,
        kind: "question",
        duplicate: result.duplicate,
        communicationEffect: "communication-only",
        reviewHoldCreated: false,
        agreementChanged: false,
        paymentChanged: false,
        readinessChanged: false,
        workStartChanged: false,
      }, result.duplicate ? 200 : 201);
    } catch (error) {
      return mutationFailure(error, "question");
    }
  }

  if (basis.correctGrantEpoch === null) {
    return json({
      ok: false,
      code: "REVIEW_MUTATION_NOT_AUTHORIZED",
    }, 403);
  }
  try {
    const result = await dependencies.admitCorrection(basis, {
      commandId: dependencies.createId(
        "correction-command",
        basis,
        session,
      ),
      concernId: `client-${dependencies.createId(
        "concern",
        basis,
        session,
      )}`,
      packetId: basis.requestId,
      originUnitId: basis.unitId,
      scope: {
        kind: "known",
        unitIds: [basis.unitId],
      },
      claim: {
        statement: parsed.data.text,
        claimedSourceType: "Client-reported agreement context",
        source: {
          availability: "unavailable",
          explanation:
            "The client raised the correction without an available source reference.",
        },
        sharingAuthorized: true,
        modelProcessingPermitted: parsed.data.allowModel,
      },
    });
    if (
      result.affectedUnitIds.length !== 1
      || result.affectedUnitIds[0] !== basis.unitId
    ) {
      return json({
        ok: false,
        code: "REVIEW_STATE_CHANGED",
      }, 409);
    }
    return json({
      ok: true,
      kind: "correction",
      reviewStatus: "on-hold",
      reviewHoldCreated: true,
      agreementChanged: false,
      paymentChanged: false,
      readinessChanged: true,
      workStartChanged: false,
    }, 201);
  } catch (error) {
    return mutationFailure(error, "correction");
  }
}
