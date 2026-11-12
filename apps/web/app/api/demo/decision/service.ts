import { z } from "zod";

const requestSchema = z.strictObject({
  decision: z.enum(["approve", "decline"]),
  reviewedResponse: z.boolean(),
  authority: z.boolean(),
});

const protocolErrorCodes = new Set([
  "ACCESS_DENIED",
  "COLLECTION_CONFLICT",
  "DECISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_INPUT",
  "NOT_FOUND",
  "PAYMENT_OUTCOME_UNKNOWN",
  "REVIEW_HOLD",
  "STALE_CONTEXT",
  "STALE_UNIT_VERSION",
]);

type Decision = "approve" | "decline";
type Session = Readonly<{ role: "client-approver" | "payer" }>;

export type CurrentDecisionUnit = Readonly<{
  unitId: string;
  version: number;
  digest: string;
}>;

export type DecisionCommand = Readonly<{
  commandId: string;
  unitId: string;
  version: number;
  digest: string;
  decision: Decision;
  attestation: Readonly<{
    reviewedExactVersion: true;
    authority: boolean;
    statement: string;
  }>;
  resolution: Readonly<{
    acknowledged: true;
    concerns: readonly Readonly<{
      concernId: string;
      responseRevision: number;
    }>[];
  }>;
}>;

export type DecisionDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  readSession: () => Promise<Session | null>;
  loadCurrentUnit: () => Promise<CurrentDecisionUnit | null>;
  decide: (command: DecisionCommand) => Promise<Readonly<{
    unitId: string;
    version: number;
    decision: Decision;
    obligationId: string | null;
  }>>;
  createCommandId: () => string;
}>;

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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
      return json({ ok: false, code: "DECISION_NOT_AUTHORIZED" }, 403);
    case "NOT_FOUND":
      return json({ ok: false, code: "DECISION_NOT_AVAILABLE" }, 404);
    case "INVALID_INPUT":
      return json({ ok: false, code: "INVALID_DECISION_INPUT" }, 422);
    case "DECISION_CONFLICT":
    case "IDEMPOTENCY_CONFLICT":
      return json({ ok: false, code: "DECISION_ALREADY_RECORDED" }, 409);
    case "REVIEW_HOLD":
    case "STALE_CONTEXT":
    case "STALE_UNIT_VERSION":
    case "COLLECTION_CONFLICT":
    case "PAYMENT_OUTCOME_UNKNOWN":
      return json({ ok: false, code: "DECISION_STATE_CHANGED" }, 409);
    default:
      return json({ ok: false, code: "DECISION_RECORDING_FAILED" }, 503);
  }
}

export async function handleDecisionPost(
  request: Request,
  dependencies: DecisionDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({ ok: false, code: "DECISION_ORIGIN_REQUIRED" }, 403);
  }

  let session: Session | null;
  try {
    session = await dependencies.readSession();
  } catch {
    return json({ ok: false, code: "DECISION_ACCESS_UNAVAILABLE" }, 503);
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
    return json({ ok: false, code: "INVALID_DECISION_INPUT" }, 422);
  }
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || !parsed.data.reviewedResponse) {
    return json({ ok: false, code: "INVALID_DECISION_INPUT" }, 422);
  }
  if (parsed.data.decision === "approve" && !parsed.data.authority) {
    return json({ ok: false, code: "APPROVAL_AUTHORITY_REQUIRED" }, 422);
  }

  try {
    const unit = await dependencies.loadCurrentUnit();
    if (!unit) {
      return json({ ok: false, code: "DECISION_NOT_AVAILABLE" }, 404);
    }
    const result = await dependencies.decide({
      commandId: dependencies.createCommandId(),
      unitId: unit.unitId,
      version: unit.version,
      digest: unit.digest,
      decision: parsed.data.decision,
      attestation: {
        reviewedExactVersion: true,
        authority: parsed.data.authority,
        statement: "Verified local client approver reviewed the exact current terms and layout concern response R1.",
      },
      resolution: {
        acknowledged: true,
        concerns: [{
          concernId: "layout-concern",
          responseRevision: 1,
        }],
      },
    });
    return json({
      ok: true,
      recorded: true,
      unitId: result.unitId,
      version: result.version,
      decision: result.decision,
      agreementStatus: result.decision === "approve" ? "approved" : "declined",
      obligationCreated: result.decision === "approve"
        && result.obligationId !== null,
      paymentStatus: "not-initiated",
    }, 200);
  } catch (error) {
    return protocolFailure(error);
  }
}
