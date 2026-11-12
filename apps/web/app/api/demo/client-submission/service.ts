import { z } from "zod";

const requestSchema = z.strictObject({
  kind: z.enum(["question", "correction"]),
  message: z.string(),
  source: z.string().optional(),
  allowModel: z.boolean(),
});

const protocolErrorCodes = new Set([
  "ACCESS_DENIED",
  "COLLECTION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_INPUT",
  "NOT_FOUND",
  "PAYMENT_OUTCOME_UNKNOWN",
  "REVIEW_HOLD",
  "STALE_CONTEXT",
  "STALE_UNIT_VERSION",
]);

const TEXT_LIMIT = 10_000;
const invalidUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

type Session = Readonly<{ role: "client-approver" | "payer" }>;

export type CurrentSubmissionBasis = Readonly<{
  unitId: string;
  packetId: string;
  version: number;
  digest: string;
}>;

export type CorrectionCommand = Readonly<{
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
    source:
      | Readonly<{
        availability: "unavailable";
        explanation: string;
      }>
      | Readonly<{
        availability: "available";
        reference: string;
        date: null;
      }>;
    sharingAuthorized: true;
    modelProcessingPermitted: boolean;
  }>;
}>;

export type SubmissionDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  readSession: () => Promise<Session | null>;
  loadCurrentBasis: () => Promise<CurrentSubmissionBasis | null>;
  admitCorrection: (command: CorrectionCommand) => Promise<Readonly<{
    concernId: string;
    impactRevision: number;
    affectedUnitIds: readonly string[];
  }>>;
  createCommandId: () => string;
  createConcernId: () => string;
}>;

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validText(value: string): boolean {
  return value.trim().length > 0
    && codePointLength(value) <= TEXT_LIMIT
    && !invalidUnicode.test(value);
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

function protocolFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "ACCESS_DENIED":
      return json({ ok: false, code: "SUBMISSION_NOT_AUTHORIZED" }, 403);
    case "NOT_FOUND":
      return json({ ok: false, code: "SUBMISSION_NOT_AVAILABLE" }, 404);
    case "INVALID_INPUT":
      return json({ ok: false, code: "INVALID_SUBMISSION_INPUT" }, 422);
    case "IDEMPOTENCY_CONFLICT":
    case "REVIEW_HOLD":
    case "STALE_CONTEXT":
    case "STALE_UNIT_VERSION":
    case "COLLECTION_CONFLICT":
    case "PAYMENT_OUTCOME_UNKNOWN":
      return json({ ok: false, code: "SUBMISSION_STATE_CHANGED" }, 409);
    default:
      return json({ ok: false, code: "SUBMISSION_RECORDING_FAILED" }, 503);
  }
}

export async function handleClientSubmissionPost(
  request: Request,
  dependencies: SubmissionDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({ ok: false, code: "SUBMISSION_ORIGIN_REQUIRED" }, 403);
  }

  let session: Session | null;
  try {
    session = await dependencies.readSession();
  } catch {
    return json({ ok: false, code: "SUBMISSION_ACCESS_UNAVAILABLE" }, 503);
  }
  if (!session) {
    return json({ ok: false, code: "CLIENT_ACCESS_REQUIRED" }, 401);
  }
  if (session.role !== "client-approver") {
    return json({ ok: false, code: "CLIENT_APPROVER_REQUIRED" }, 403);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json({ ok: false, code: "INVALID_SUBMISSION_INPUT" }, 422);
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return json({ ok: false, code: "INVALID_SUBMISSION_INPUT" }, 422);
  }
  if (!validText(parsed.data.message)) {
    const code = codePointLength(parsed.data.message) > TEXT_LIMIT
      ? "SUBMISSION_TEXT_LIMIT"
      : "INVALID_SUBMISSION_INPUT";
    return json({ ok: false, code }, 422);
  }
  if (parsed.data.source !== undefined) {
    if (codePointLength(parsed.data.source) > TEXT_LIMIT) {
      return json({ ok: false, code: "SUBMISSION_TEXT_LIMIT" }, 422);
    }
    if (
      parsed.data.source.trim().length > 0
      && invalidUnicode.test(parsed.data.source)
    ) {
      return json({ ok: false, code: "INVALID_SUBMISSION_INPUT" }, 422);
    }
  }

  if (parsed.data.kind === "question") {
    return json({
      ok: false,
      code: "QUESTION_SUBMISSION_UNSUPPORTED",
    }, 409);
  }

  let basis: CurrentSubmissionBasis | null;
  try {
    basis = await dependencies.loadCurrentBasis();
  } catch {
    return json({ ok: false, code: "SUBMISSION_SERVICE_UNAVAILABLE" }, 503);
  }
  if (!basis) {
    return json({ ok: false, code: "SUBMISSION_NOT_AVAILABLE" }, 404);
  }

  const source = parsed.data.source;
  try {
    const result = await dependencies.admitCorrection({
      commandId: dependencies.createCommandId(),
      concernId: dependencies.createConcernId(),
      packetId: basis.packetId,
      originUnitId: basis.unitId,
      scope: {
        kind: "known",
        unitIds: [basis.unitId],
      },
      claim: {
        statement: parsed.data.message,
        claimedSourceType: "Client-reported agreement context",
        source: source?.trim()
          ? {
            availability: "available",
            reference: source,
            date: null,
          }
          : {
            availability: "unavailable",
            explanation: "The client raised the concern without an available source reference.",
          },
        sharingAuthorized: true,
        modelProcessingPermitted: parsed.data.allowModel,
      },
    });
    return json({
      ok: true,
      submitted: true,
      kind: "correction",
      concernId: result.concernId,
      unitId: basis.unitId,
      version: basis.version,
      digest: basis.digest,
      reviewStatus: "on-hold",
      agreementChanged: false,
      paymentChanged: false,
    }, 201);
  } catch (error) {
    return protocolFailure(error);
  }
}
