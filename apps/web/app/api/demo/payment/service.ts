import type {
  Lease,
  Payer,
} from "@scopeledger/contracts";
import type {
  IntentResult,
} from "@scopeledger/domain";

export type PaymentReadiness =
  | "awaiting-agreement"
  | "review-hold"
  | "awaiting-payment"
  | "awaiting-prerequisite"
  | "financial-recheck"
  | "ready";

export type SafePaymentState =
  | "not-started"
  | "preparing"
  | "awaiting-buyer-approval"
  | "awaiting-capture"
  | "pending"
  | "completed"
  | "reconciliation-required";

export type ProviderPaymentState = "pending" | "unknown" | "completed";

export type PaymentRecoveryState =
  | "refresh-available"
  | "manual-recovery-required";

type PaymentSession = Readonly<{
  role: "client-approver" | "payer";
}>;

export type CurrentPaymentBasis = Readonly<{
  obligationId: string;
  nominationEpoch: number;
  nomination: Readonly<{
    actorId: string;
    payerEpoch: number;
    nominationEpoch: number;
    active: boolean;
  }> | null;
}>;

export type PaymentOperationSnapshot = Readonly<{
  operationId: string;
  kind: "create" | "capture";
  state: "intent" | "admitted" | "pending" | "unknown" | "result";
  approvalUrl: string | null;
  captureId?: string | null;
}>;

export type PaymentAttemptSnapshot = Readonly<{
  attemptId: string;
  state:
    | "intent"
    | "create-admitted"
    | "order-available"
    | "capture-intent"
    | "capture-admitted"
    | "pending"
    | "unknown"
    | "completed";
  orderId: string | null;
  operations: readonly PaymentOperationSnapshot[];
}>;

export type PaymentJourneyDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  readSession: () => Promise<PaymentSession | null>;
  loadCurrentPaymentBasis: () => Promise<CurrentPaymentBasis | null>;
  nominatePayer: (obligationId: string) => Promise<Readonly<{
    payerEpoch: number;
    nominationEpoch: number;
  }>>;
  loadAttempt: (obligationId: string) => Promise<PaymentAttemptSnapshot | null>;
  initiatePayment: (payer: Payer, commandId: string) => Promise<IntentResult>;
  requestCapture: (
    payer: Payer,
    commandId: string,
    attemptId: string,
    orderId: string,
  ) => Promise<IntentResult>;
  claimOperation: (operationId: string) => Promise<Lease>;
  dispatchOperation: (
    lease: Lease,
    payer: Payer,
  ) => Promise<Readonly<{ approvalUrl: string | null }>>;
  reconcileCapture?: (
    target: Readonly<{
      operationId: string;
      orderId: string;
      captureId: string;
    }>,
  ) => Promise<Readonly<{
    outcome: ProviderPaymentState;
    matchesBasis: boolean;
    completed: boolean;
  }>>;
  reconcileOrderCapture?: (
    target: Readonly<{
      operationId: string;
      orderId: string;
    }>,
  ) => Promise<Readonly<{
    outcome: Exclude<ProviderPaymentState, "unknown">;
    matchesBasis: boolean;
    completed: boolean;
  }>>;
  inspectReadiness: () => Promise<PaymentReadiness>;
  createCommandId: () => string;
}>;

type SafePaymentResult = Readonly<{
  state: SafePaymentState;
  readiness: PaymentReadiness;
  approvalUrl?: string;
  providerState?: ProviderPaymentState;
  recovery?: PaymentRecoveryState;
}>;

const demoPayer = Object.freeze({
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
  actorId: "cedar-payer",
  grantEpoch: 1,
});

const reconciliationCodes = new Set([
  "PAYMENT_OUTCOME_UNKNOWN",
  "RECONCILIATION_REQUIRED",
  "STALE_LEASE",
]);

const manualRecoveryCodes = new Set([
  "FINANCIAL_MISMATCH",
  "INVALID_OPERATION",
  "MERCHANT_MISMATCH",
  "NOT_FOUND",
  "PROVIDER_RESPONSE_INVALID",
  "RECONCILIATION_CAPTURE_UNRESOLVED",
  "RECONCILIATION_REQUIRED",
  "RECONCILIATION_TARGET_MISMATCH",
]);

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    },
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
  return error.code;
}

function safeApprovalUrl(value: string | null): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://www.sandbox.paypal.com"
      || url.username
      || url.password
      || url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function payerFor(
  basis: CurrentPaymentBasis,
  nomination: {
    payerEpoch: number;
    nominationEpoch: number;
  },
): Payer {
  return {
    ...demoPayer,
    obligationId: basis.obligationId,
    payerEpoch: nomination.payerEpoch,
    nominationEpoch: nomination.nominationEpoch,
  };
}

async function ensurePayer(
  dependencies: PaymentJourneyDependencies,
  basis: CurrentPaymentBasis,
): Promise<Payer> {
  const nomination = basis.nomination;
  if (
    nomination?.active
    && nomination.actorId === demoPayer.actorId
    && nomination.nominationEpoch === basis.nominationEpoch
  ) {
    return payerFor(basis, nomination);
  }
  return payerFor(
    basis,
    await dependencies.nominatePayer(basis.obligationId),
  );
}

function operation(
  snapshot: PaymentAttemptSnapshot,
  kind: "create" | "capture",
): PaymentOperationSnapshot | null {
  return snapshot.operations.find((candidate) => candidate.kind === kind)
    ?? null;
}

function hasRecoveryMetadata(
  snapshot: PaymentAttemptSnapshot,
): boolean {
  return snapshot.operations.some((candidate) =>
    Object.prototype.hasOwnProperty.call(candidate, "captureId")
  );
}

function providerStateFromSnapshot(
  snapshot: PaymentAttemptSnapshot,
  state: SafePaymentState,
): ProviderPaymentState | null {
  if (!hasRecoveryMetadata(snapshot)) return null;
  if (state === "completed") return "completed";
  if (state === "pending") return "pending";
  if (state === "reconciliation-required") return "unknown";
  return null;
}

function reconciliationTarget(
  snapshot: PaymentAttemptSnapshot,
): Readonly<{
  operationId: string;
  orderId: string;
  captureId: string;
}> | null {
  const capture = operation(snapshot, "capture");
  if (
    !snapshot.orderId
    || !capture
    || !capture.captureId
    || !["admitted", "pending", "unknown", "result"].includes(capture.state)
  ) {
    return null;
  }
  return {
    operationId: capture.operationId,
    orderId: snapshot.orderId,
    captureId: capture.captureId,
  };
}

function orderReconciliationTarget(
  snapshot: PaymentAttemptSnapshot,
): Readonly<{
  operationId: string;
  orderId: string;
}> | null {
  const capture = operation(snapshot, "capture");
  if (
    !snapshot.orderId
    || !capture
    || capture.captureId
    || !["admitted", "pending", "unknown", "result"].includes(capture.state)
  ) {
    return null;
  }
  return {
    operationId: capture.operationId,
    orderId: snapshot.orderId,
  };
}

function recoveryFromSnapshot(
  dependencies: PaymentJourneyDependencies,
  snapshot: PaymentAttemptSnapshot,
  state: SafePaymentState,
): PaymentRecoveryState | null {
  if (!hasRecoveryMetadata(snapshot)) return null;
  if (
    (reconciliationTarget(snapshot) && dependencies.reconcileCapture)
    || (
      orderReconciliationTarget(snapshot)
      && dependencies.reconcileOrderCapture
    )
  ) {
    return "refresh-available";
  }
  if (
    state === "pending"
    || state === "completed"
    || state === "reconciliation-required"
  ) {
    return "manual-recovery-required";
  }
  return null;
}

function stateFromSnapshot(
  snapshot: PaymentAttemptSnapshot | null,
): SafePaymentState {
  if (!snapshot) return "not-started";
  if (snapshot.state === "completed") return "completed";
  const create = operation(snapshot, "create");
  const capture = operation(snapshot, "capture");
  if (
    snapshot.state === "unknown"
    || create?.state === "unknown"
    || capture?.state === "unknown"
    || create?.state === "admitted"
    || capture?.state === "admitted"
    || snapshot.state === "create-admitted"
    || snapshot.state === "capture-admitted"
  ) {
    return "reconciliation-required";
  }
  if (
    snapshot.state === "pending"
    || create?.state === "pending"
    || capture?.state === "pending"
  ) {
    return "pending";
  }
  if (
    snapshot.state === "intent"
    && !snapshot.orderId
    && create?.state === "intent"
  ) {
    return "preparing";
  }
  if (
    snapshot.state === "order-available"
    && Boolean(snapshot.orderId)
    && create?.state === "result"
    && safeApprovalUrl(create?.approvalUrl ?? null)
  ) {
    return "awaiting-buyer-approval";
  }
  if (
    snapshot.state === "capture-intent"
    && Boolean(snapshot.orderId)
    && create?.state === "result"
    && Boolean(safeApprovalUrl(create.approvalUrl))
    && capture?.state === "intent"
  ) {
    return "awaiting-capture";
  }
  return "reconciliation-required";
}

async function resultFromSnapshot(
  dependencies: PaymentJourneyDependencies,
  snapshot: PaymentAttemptSnapshot | null,
): Promise<SafePaymentResult> {
  const readiness = await dependencies.inspectReadiness();
  const state = stateFromSnapshot(snapshot);
  const create = snapshot ? operation(snapshot, "create") : null;
  const approvalUrl = state === "awaiting-buyer-approval"
    ? safeApprovalUrl(create?.approvalUrl ?? null)
    : null;
  const providerState = snapshot
    ? providerStateFromSnapshot(snapshot, state)
    : null;
  const recovery = snapshot
    ? recoveryFromSnapshot(dependencies, snapshot, state)
    : null;
  return {
    state,
    readiness,
    ...(approvalUrl ? { approvalUrl } : {}),
    ...(providerState ? { providerState } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

export async function readPaymentStatus(
  dependencies: PaymentJourneyDependencies,
): Promise<SafePaymentResult> {
  const basis = await dependencies.loadCurrentPaymentBasis();
  if (!basis) {
    return {
      state: "not-started",
      readiness: await dependencies.inspectReadiness(),
    };
  }
  return resultFromSnapshot(
    dependencies,
    await dependencies.loadAttempt(basis.obligationId),
  );
}

export async function prepareCheckout(
  dependencies: PaymentJourneyDependencies,
): Promise<SafePaymentResult> {
  const basis = await dependencies.loadCurrentPaymentBasis();
  if (!basis) {
    throw Object.assign(
      new Error("The current approved payment basis is unavailable"),
      { code: "PAYMENT_BASIS_UNAVAILABLE" },
    );
  }
  const payer = await ensurePayer(dependencies, basis);
  let snapshot = await dependencies.loadAttempt(basis.obligationId);
  const currentState = stateFromSnapshot(snapshot);
  if (
    currentState !== "not-started"
    && currentState !== "preparing"
  ) {
    return resultFromSnapshot(dependencies, snapshot);
  }

  const intent = snapshot
    ? {
      attemptId: snapshot.attemptId,
      operationId: operation(snapshot, "create")?.operationId ?? "",
      providerKey: "",
      state: operation(snapshot, "create")?.state ?? "unknown",
    }
    : await dependencies.initiatePayment(
      payer,
      dependencies.createCommandId(),
    );
  if (!intent.operationId || intent.state !== "intent") {
    snapshot = await dependencies.loadAttempt(basis.obligationId);
    return resultFromSnapshot(dependencies, snapshot);
  }

  const lease = await dependencies.claimOperation(intent.operationId);
  const dispatched = await dependencies.dispatchOperation(lease, payer);
  snapshot = await dependencies.loadAttempt(basis.obligationId);
  const result = await resultFromSnapshot(dependencies, snapshot);
  const approvalUrl = safeApprovalUrl(dispatched.approvalUrl);
  if (
    result.state !== "awaiting-buyer-approval"
    || !approvalUrl
    || result.approvalUrl !== approvalUrl
  ) {
    return {
      state: "reconciliation-required",
      readiness: result.readiness,
    };
  }
  return result;
}

export async function captureCheckout(
  dependencies: PaymentJourneyDependencies,
): Promise<SafePaymentResult> {
  const basis = await dependencies.loadCurrentPaymentBasis();
  if (!basis) {
    throw Object.assign(
      new Error("The current approved payment basis is unavailable"),
      { code: "PAYMENT_BASIS_UNAVAILABLE" },
    );
  }
  const payer = await ensurePayer(dependencies, basis);
  let snapshot = await dependencies.loadAttempt(basis.obligationId);
  if (!snapshot) {
    throw Object.assign(
      new Error("Checkout has not been prepared"),
      { code: "CHECKOUT_NOT_PREPARED" },
    );
  }
  const currentState = stateFromSnapshot(snapshot);
  if (
    currentState === "completed"
    || currentState === "pending"
    || currentState === "reconciliation-required"
  ) {
    return resultFromSnapshot(dependencies, snapshot);
  }
  const create = operation(snapshot, "create");
  if (
    !snapshot.orderId
    || create?.state !== "result"
    || !safeApprovalUrl(create.approvalUrl)
  ) {
    throw Object.assign(
      new Error("The original PayPal Order is not established"),
      { code: "CHECKOUT_NOT_READY" },
    );
  }

  let capture = operation(snapshot, "capture");
  if (!capture) {
    const intent = await dependencies.requestCapture(
      payer,
      dependencies.createCommandId(),
      snapshot.attemptId,
      snapshot.orderId,
    );
    capture = {
      operationId: intent.operationId,
      kind: "capture",
      state: intent.state as PaymentOperationSnapshot["state"],
      approvalUrl: null,
    };
  }
  if (capture.state !== "intent") {
    snapshot = await dependencies.loadAttempt(basis.obligationId);
    return resultFromSnapshot(dependencies, snapshot);
  }

  const lease = await dependencies.claimOperation(capture.operationId);
  await dependencies.dispatchOperation(lease, payer);
  snapshot = await dependencies.loadAttempt(basis.obligationId);
  return resultFromSnapshot(dependencies, snapshot);
}

export async function reconcileCheckout(
  dependencies: PaymentJourneyDependencies,
): Promise<SafePaymentResult> {
  const basis = await dependencies.loadCurrentPaymentBasis();
  if (!basis) {
    throw Object.assign(
      new Error("The current approved payment basis is unavailable"),
      { code: "PAYMENT_BASIS_UNAVAILABLE" },
    );
  }
  let snapshot = await dependencies.loadAttempt(basis.obligationId);
  if (!snapshot) {
    throw Object.assign(
      new Error("Checkout has not been prepared"),
      { code: "CHECKOUT_NOT_PREPARED" },
    );
  }
  const knownCaptureTarget = reconciliationTarget(snapshot);
  const orderCaptureTarget = orderReconciliationTarget(snapshot);
  const reconcileCapture = dependencies.reconcileCapture;
  const reconcileOrderCapture = dependencies.reconcileOrderCapture;
  const reconcile = knownCaptureTarget && reconcileCapture
    ? () => reconcileCapture(knownCaptureTarget)
    : orderCaptureTarget && reconcileOrderCapture
      ? () => reconcileOrderCapture(orderCaptureTarget)
      : null;
  if (!reconcile) {
    const unresolved = await resultFromSnapshot(dependencies, snapshot);
    if (
      unresolved.state !== "pending"
      && unresolved.state !== "completed"
      && unresolved.state !== "reconciliation-required"
    ) {
      return unresolved;
    }
    return {
      ...unresolved,
      providerState: unresolved.providerState ?? "unknown",
      recovery: "manual-recovery-required",
    };
  }

  let reconciled: Readonly<{
    outcome: ProviderPaymentState;
    matchesBasis: boolean;
    completed: boolean;
  }>;
  try {
    reconciled = await reconcile();
  } catch (reconciliationError) {
    const code = errorCode(reconciliationError);
    if (!code || !manualRecoveryCodes.has(code)) {
      throw reconciliationError;
    }
    const unresolved = await resultFromSnapshot(dependencies, snapshot);
    return {
      ...unresolved,
      providerState: "unknown",
      recovery: "manual-recovery-required",
    };
  }
  snapshot = await dependencies.loadAttempt(basis.obligationId);
  const refreshed = await resultFromSnapshot(dependencies, snapshot);
  return {
    ...refreshed,
    providerState: reconciled.outcome,
    recovery: reconciled.matchesBasis
      ? "refresh-available"
      : "manual-recovery-required",
  };
}

async function authorize(
  request: Request,
  dependencies: PaymentJourneyDependencies,
): Promise<Response | null> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({ ok: false, code: "PAYMENT_ORIGIN_REQUIRED" }, 403);
  }
  if (await requestHasBytes(request)) {
    return json({ ok: false, code: "PAYMENT_INPUT_NOT_ACCEPTED" }, 422);
  }
  let session: PaymentSession | null;
  try {
    session = await dependencies.readSession();
  } catch {
    return json({ ok: false, code: "PAYMENT_ACCESS_UNAVAILABLE" }, 503);
  }
  if (!session) {
    return json({ ok: false, code: "PAYER_ACCESS_REQUIRED" }, 401);
  }
  if (session.role !== "payer") {
    return json({ ok: false, code: "PAYER_ROLE_REQUIRED" }, 403);
  }
  return null;
}

async function requestHasBytes(request: Request): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return true;
    if (Number(contentLength) > 0) return true;
  }
  if (!request.body) return false;

  const reader = request.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      if (chunk.value.byteLength > 0) return true;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function paymentFailure(error: unknown): Response {
  const code = errorCode(error);
  if (code && reconciliationCodes.has(code)) {
    return json({
      ok: false,
      code: "PAYMENT_RECONCILIATION_REQUIRED",
      state: "reconciliation-required",
    }, 409);
  }
  switch (code) {
    case "ACCESS_DENIED":
      return json({ ok: false, code: "PAYMENT_NOT_AUTHORIZED" }, 403);
    case "CHECKOUT_NOT_PREPARED":
    case "CHECKOUT_NOT_READY":
      return json({ ok: false, code }, 409);
    case "PAYMENT_BASIS_UNAVAILABLE":
    case "COLLECTION_CONFLICT":
    case "REVIEW_HOLD":
    case "STALE_CONTEXT":
    case "NOT_FOUND":
      return json({ ok: false, code: "PAYMENT_STATE_CHANGED" }, 409);
    default:
      return json({ ok: false, code: "PAYMENT_SERVICE_UNAVAILABLE" }, 503);
  }
}

async function handle(
  request: Request,
  dependencies: PaymentJourneyDependencies,
  action: (
    dependencies: PaymentJourneyDependencies,
  ) => Promise<SafePaymentResult>,
): Promise<Response> {
  const rejected = await authorize(request, dependencies);
  if (rejected) return rejected;
  try {
    return json({ ok: true, ...await action(dependencies) }, 200);
  } catch (error) {
    return paymentFailure(error);
  }
}

export function handlePaymentPreparePost(
  request: Request,
  dependencies: PaymentJourneyDependencies,
): Promise<Response> {
  return handle(request, dependencies, prepareCheckout);
}

export function handlePaymentCapturePost(
  request: Request,
  dependencies: PaymentJourneyDependencies,
): Promise<Response> {
  return handle(request, dependencies, captureCheckout);
}

export function handlePaymentStatusPost(
  request: Request,
  dependencies: PaymentJourneyDependencies,
): Promise<Response> {
  return handle(request, dependencies, readPaymentStatus);
}

export function handlePaymentReconcilePost(
  request: Request,
  dependencies: PaymentJourneyDependencies,
): Promise<Response> {
  return handle(request, dependencies, reconcileCheckout);
}
