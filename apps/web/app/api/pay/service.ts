import type {
  Lease,
  Payer,
} from "@scopeledger/contracts";
import type {
  IntentResult,
} from "@scopeledger/domain";
export type PaymentLocators = Readonly<{
  projectLocator: string;
  requestLocator: string;
  unitLocator: string;
  payerLocator: string;
}>;

export type ApprovedPaymentTarget = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  unitId: string;
  version: number;
  digest: string;
  obligationId: string;
  projectNominationEpoch: number;
  providerInspectGrantEpoch: number;
  providerPublishGrantEpoch: number;
  projectLabel: string;
  requestLabel: string;
  unitTitle: string;
  currency: "USD";
  gross: string;
  payer: Payer | null;
  activatedAt: string | null;
}>;

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

export type PaymentSession = Readonly<{
  subject: string;
  role: "client-approver" | "payer";
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

export type CustomPaymentDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  readSession: () => Promise<PaymentSession | null>;
  loadTarget: (
    locators: PaymentLocators,
    session: PaymentSession,
  ) => Promise<ApprovedPaymentTarget>;
  loadAttempt: (
    target: ApprovedPaymentTarget,
  ) => Promise<PaymentAttemptSnapshot | null>;
  initiatePayment: (
    target: ApprovedPaymentTarget,
    commandId: string,
  ) => Promise<IntentResult>;
  requestCapture: (
    target: ApprovedPaymentTarget,
    commandId: string,
    attemptId: string,
    orderId: string,
  ) => Promise<IntentResult>;
  claimOperation: (
    target: ApprovedPaymentTarget,
    operationId: string,
  ) => Promise<Lease>;
  dispatchOperation: (
    target: ApprovedPaymentTarget,
    locators: PaymentLocators,
    lease: Lease,
  ) => Promise<Readonly<{ approvalUrl: string | null }>>;
  reconcileCapture?: (
    target: ApprovedPaymentTarget,
    capture: Readonly<{
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
    target: ApprovedPaymentTarget,
    capture: Readonly<{
      operationId: string;
      orderId: string;
    }>,
  ) => Promise<Readonly<{
    outcome: Exclude<ProviderPaymentState, "unknown">;
    matchesBasis: boolean;
    completed: boolean;
  }>>;
  inspectReadiness: (
    target: ApprovedPaymentTarget,
  ) => Promise<PaymentReadiness>;
  createCommandId: (
    kind: "create" | "capture",
    target: ApprovedPaymentTarget,
  ) => string;
}>;

export type SafePaymentResult = Readonly<{
  state: SafePaymentState;
  readiness: PaymentReadiness;
  providerState?: ProviderPaymentState;
  recovery?: PaymentRecoveryState;
}>;

export type CustomPaymentProjection = Readonly<{
  projectLabel: string;
  requestLabel: string;
  unitTitle: string;
  currency: "USD";
  gross: string;
  payment: SafePaymentResult;
  endpoints: Readonly<{
    prepare: string;
    approval: string;
    status: string;
    capture: string;
    reconcile: string;
    return: string;
    cancel: string;
  }>;
}>;

export type CustomPaymentLoadResult =
  | Readonly<{ ok: true; payment: CustomPaymentProjection }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 404 | 409 | 503;
    code:
      | "PAYMENT_ACCESS_UNAVAILABLE"
      | "PAYER_ACCESS_REQUIRED"
      | "PAYER_ROLE_REQUIRED"
      | "PAYMENT_NOT_AUTHORIZED"
      | "PAYMENT_NOT_AVAILABLE"
      | "PAYMENT_STATE_CHANGED";
  }>;

type InternalPaymentResult = SafePaymentResult & Readonly<{
  approvalUrl?: string;
}>;

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

const privateHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "Surrogate-Control": "no-store",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

function json(body: object, status: number): Response {
  return Response.json(body, { status, headers: privateHeaders });
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function validPaymentLocators(locators: PaymentLocators): boolean {
  return /^slr1p_[A-Za-z0-9_-]{43}$/u.test(locators.projectLocator)
    && /^slr1r_[A-Za-z0-9_-]{43}$/u.test(locators.requestLocator)
    && /^slr1u_[A-Za-z0-9_-]{43}$/u.test(locators.unitLocator)
    && /^slr1y_[A-Za-z0-9_-]{43}$/u.test(locators.payerLocator);
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

function payer(target: ApprovedPaymentTarget): Payer {
  if (!target.payer) {
    throw Object.assign(new Error("Payer authority is unavailable"), {
      code: "ACCESS_DENIED",
    });
  }
  return target.payer;
}

function operation(
  snapshot: PaymentAttemptSnapshot,
  kind: "create" | "capture",
): PaymentOperationSnapshot | null {
  return snapshot.operations.find((candidate) => candidate.kind === kind)
    ?? null;
}

function hasRecoveryMetadata(snapshot: PaymentAttemptSnapshot): boolean {
  return snapshot.operations.some((candidate) =>
    Object.prototype.hasOwnProperty.call(candidate, "captureId")
  );
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
    && safeApprovalUrl(create.approvalUrl)
  ) {
    return "awaiting-buyer-approval";
  }
  if (
    snapshot.state === "capture-intent"
    && Boolean(snapshot.orderId)
    && create?.state === "result"
    && safeApprovalUrl(create.approvalUrl)
    && capture?.state === "intent"
  ) {
    return "awaiting-capture";
  }
  return "reconciliation-required";
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
    || !capture?.captureId
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
  dependencies: CustomPaymentDependencies,
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

async function resultFromSnapshot(
  dependencies: CustomPaymentDependencies,
  target: ApprovedPaymentTarget,
  snapshot: PaymentAttemptSnapshot | null,
): Promise<InternalPaymentResult> {
  const readiness = await dependencies.inspectReadiness(target);
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

function publicResult(result: InternalPaymentResult): SafePaymentResult {
  const {
    state,
    readiness,
    providerState,
    recovery,
  } = result;
  return {
    state,
    readiness,
    ...(providerState ? { providerState } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function endpointBase(locators: PaymentLocators): string {
  return [
    "/api/pay",
    locators.projectLocator,
    locators.requestLocator,
    locators.unitLocator,
    locators.payerLocator,
  ].join("/");
}

export function payerPagePath(locators: PaymentLocators): string {
  return [
    "/pay",
    locators.projectLocator,
    locators.requestLocator,
    locators.unitLocator,
    locators.payerLocator,
  ].join("/");
}

function projection(
  target: ApprovedPaymentTarget,
  locators: PaymentLocators,
  payment: SafePaymentResult,
): CustomPaymentProjection {
  const api = endpointBase(locators);
  const page = payerPagePath(locators);
  return Object.freeze({
    projectLabel: target.projectLabel,
    requestLabel: target.requestLabel,
    unitTitle: target.unitTitle,
    currency: target.currency,
    gross: target.gross,
    payment,
    endpoints: Object.freeze({
      prepare: `${api}/prepare`,
      approval: `${api}/approval`,
      status: `${api}/status`,
      capture: `${api}/capture`,
      reconcile: `${api}/reconcile`,
      return: `${page}/return`,
      cancel: `${page}/cancel`,
    }),
  });
}

async function authorizedTarget(
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<
  | Readonly<{
    ok: true;
    target: ApprovedPaymentTarget;
    session: PaymentSession;
  }>
  | Exclude<CustomPaymentLoadResult, { ok: true }>
> {
  if (!validPaymentLocators(locators)) {
    return { ok: false, status: 404, code: "PAYMENT_NOT_AVAILABLE" };
  }
  let session;
  try {
    session = await dependencies.readSession();
  } catch {
    return { ok: false, status: 503, code: "PAYMENT_ACCESS_UNAVAILABLE" };
  }
  if (!session) {
    return { ok: false, status: 401, code: "PAYER_ACCESS_REQUIRED" };
  }
  if (session.role !== "payer") {
    return { ok: false, status: 403, code: "PAYER_ROLE_REQUIRED" };
  }
  try {
    return {
      ok: true,
      target: await dependencies.loadTarget(locators, session),
      session,
    };
  } catch (error) {
    switch (errorCode(error)) {
      case "ACCESS_DENIED":
        return { ok: false, status: 403, code: "PAYMENT_NOT_AUTHORIZED" };
      case "NOT_FOUND":
        return { ok: false, status: 404, code: "PAYMENT_NOT_AVAILABLE" };
      case "STALE_RECORD":
      case "MALFORMED_RECORD":
        return { ok: false, status: 409, code: "PAYMENT_STATE_CHANGED" };
      default:
        return { ok: false, status: 503, code: "PAYMENT_ACCESS_UNAVAILABLE" };
    }
  }
}

export async function loadCustomPayment(
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<CustomPaymentLoadResult> {
  const authorized = await authorizedTarget(locators, dependencies);
  if (!authorized.ok) return authorized;
  try {
    const snapshot = await dependencies.loadAttempt(authorized.target);
    return {
      ok: true,
      payment: projection(
        authorized.target,
        locators,
        publicResult(await resultFromSnapshot(
          dependencies,
          authorized.target,
          snapshot,
        )),
      ),
    };
  } catch (error) {
    return paymentLoadFailure(error);
  }
}

export async function prepareCheckout(
  dependencies: CustomPaymentDependencies,
  locators: PaymentLocators,
  target: ApprovedPaymentTarget,
): Promise<InternalPaymentResult> {
  payer(target);
  let snapshot = await dependencies.loadAttempt(target);
  const currentState = stateFromSnapshot(snapshot);
  if (currentState !== "not-started" && currentState !== "preparing") {
    return resultFromSnapshot(dependencies, target, snapshot);
  }
  const intent = snapshot
    ? {
      attemptId: snapshot.attemptId,
      operationId: operation(snapshot, "create")?.operationId ?? "",
      providerKey: "",
      state: operation(snapshot, "create")?.state ?? "unknown",
    }
    : await dependencies.initiatePayment(
      target,
      dependencies.createCommandId("create", target),
    );
  if (!intent.operationId || intent.state !== "intent") {
    snapshot = await dependencies.loadAttempt(target);
    return resultFromSnapshot(dependencies, target, snapshot);
  }
  const lease = await dependencies.claimOperation(target, intent.operationId);
  const dispatched = await dependencies.dispatchOperation(
    target,
    locators,
    lease,
  );
  snapshot = await dependencies.loadAttempt(target);
  const result = await resultFromSnapshot(dependencies, target, snapshot);
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
  dependencies: CustomPaymentDependencies,
  locators: PaymentLocators,
  target: ApprovedPaymentTarget,
): Promise<InternalPaymentResult> {
  payer(target);
  let snapshot = await dependencies.loadAttempt(target);
  if (!snapshot) {
    throw Object.assign(new Error("Checkout has not been prepared"), {
      code: "CHECKOUT_NOT_PREPARED",
    });
  }
  const currentState = stateFromSnapshot(snapshot);
  if (
    currentState === "completed"
    || currentState === "pending"
    || currentState === "reconciliation-required"
  ) {
    return resultFromSnapshot(dependencies, target, snapshot);
  }
  const create = operation(snapshot, "create");
  if (
    !snapshot.orderId
    || create?.state !== "result"
    || !safeApprovalUrl(create.approvalUrl)
  ) {
    throw Object.assign(new Error("Checkout is not ready"), {
      code: "CHECKOUT_NOT_READY",
    });
  }
  let capture = operation(snapshot, "capture");
  if (!capture) {
    const intent = await dependencies.requestCapture(
      target,
      dependencies.createCommandId("capture", target),
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
    snapshot = await dependencies.loadAttempt(target);
    return resultFromSnapshot(dependencies, target, snapshot);
  }
  const lease = await dependencies.claimOperation(
    target,
    capture.operationId,
  );
  await dependencies.dispatchOperation(
    target,
    locators,
    lease,
  );
  snapshot = await dependencies.loadAttempt(target);
  return resultFromSnapshot(dependencies, target, snapshot);
}

export async function reconcileCheckout(
  dependencies: CustomPaymentDependencies,
  target: ApprovedPaymentTarget,
): Promise<InternalPaymentResult> {
  let snapshot = await dependencies.loadAttempt(target);
  if (!snapshot) {
    throw Object.assign(new Error("Checkout has not been prepared"), {
      code: "CHECKOUT_NOT_PREPARED",
    });
  }
  const known = reconciliationTarget(snapshot);
  const discovered = orderReconciliationTarget(snapshot);
  const reconcile = known && dependencies.reconcileCapture
    ? () => dependencies.reconcileCapture!(target, known)
    : discovered && dependencies.reconcileOrderCapture
      ? () => dependencies.reconcileOrderCapture!(target, discovered)
      : null;
  if (!reconcile) {
    const unresolved = await resultFromSnapshot(
      dependencies,
      target,
      snapshot,
    );
    return {
      ...unresolved,
      providerState: unresolved.providerState ?? "unknown",
      recovery: "manual-recovery-required",
    };
  }
  let reconciled;
  try {
    reconciled = await reconcile();
  } catch (error) {
    const code = errorCode(error);
    if (!code || !manualRecoveryCodes.has(code)) throw error;
    const unresolved = await resultFromSnapshot(
      dependencies,
      target,
      snapshot,
    );
    return {
      ...unresolved,
      providerState: "unknown",
      recovery: "manual-recovery-required",
    };
  }
  snapshot = await dependencies.loadAttempt(target);
  const refreshed = await resultFromSnapshot(
    dependencies,
    target,
    snapshot,
  );
  return {
    ...refreshed,
    providerState: reconciled.outcome,
    recovery: reconciled.matchesBasis
      ? "refresh-available"
      : "manual-recovery-required",
  };
}

async function requestHasBytes(request: Request): Promise<boolean> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > 0) return true;
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

function paymentLoadFailure(
  error: unknown,
): Exclude<CustomPaymentLoadResult, { ok: true }> {
  switch (errorCode(error)) {
    case "ACCESS_DENIED":
      return { ok: false, status: 403, code: "PAYMENT_NOT_AUTHORIZED" };
    case "NOT_FOUND":
      return { ok: false, status: 404, code: "PAYMENT_NOT_AVAILABLE" };
    case "STALE_CONTEXT":
    case "STALE_RECORD":
    case "MALFORMED_RECORD":
    case "COLLECTION_CONFLICT":
    case "REVIEW_HOLD":
      return { ok: false, status: 409, code: "PAYMENT_STATE_CHANGED" };
    default:
      return { ok: false, status: 503, code: "PAYMENT_ACCESS_UNAVAILABLE" };
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
    case "COLLECTION_CONFLICT":
    case "REVIEW_HOLD":
    case "STALE_CONTEXT":
    case "NOT_FOUND":
      return json({ ok: false, code: "PAYMENT_STATE_CHANGED" }, 409);
    default:
      return json({ ok: false, code: "PAYMENT_SERVICE_UNAVAILABLE" }, 503);
  }
}

async function authorizeMutation(
  request: Request,
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<
  | Readonly<{ ok: true; target: ApprovedPaymentTarget }>
  | Readonly<{ ok: false; response: Response }>
> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return {
      ok: false,
      response: json({ ok: false, code: "PAYMENT_ORIGIN_REQUIRED" }, 403),
    };
  }
  if (await requestHasBytes(request)) {
    return {
      ok: false,
      response: json({
        ok: false,
        code: "PAYMENT_INPUT_NOT_ACCEPTED",
      }, 422),
    };
  }
  const authorized = await authorizedTarget(locators, dependencies);
  if (!authorized.ok) {
    return {
      ok: false,
      response: json({ ok: false, code: authorized.code }, authorized.status),
    };
  }
  return { ok: true, target: authorized.target };
}

async function handleMutation(
  request: Request,
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
  action: (
    target: ApprovedPaymentTarget,
  ) => Promise<InternalPaymentResult>,
): Promise<Response> {
  const authorized = await authorizeMutation(request, locators, dependencies);
  if (!authorized.ok) return authorized.response;
  try {
    return json({
      ok: true,
      ...publicResult(await action(authorized.target)),
    }, 200);
  } catch (error) {
    return paymentFailure(error);
  }
}

export async function handlePaymentPreparePost(
  request: Request,
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<Response> {
  const authorized = await authorizeMutation(request, locators, dependencies);
  if (!authorized.ok) return authorized.response;
  try {
    const result = await prepareCheckout(
      dependencies,
      locators,
      authorized.target,
    );
    return json({
      ok: true,
      ...publicResult(result),
      ...(result.approvalUrl
        ? { checkoutUrl: `${endpointBase(locators)}/approval` }
        : {}),
    }, 200);
  } catch (error) {
    return paymentFailure(error);
  }
}

export async function handlePaymentApprovalGet(
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<Response> {
  const authorized = await authorizedTarget(locators, dependencies);
  if (!authorized.ok) {
    return json({ ok: false, code: authorized.code }, authorized.status);
  }
  try {
    const result = await resultFromSnapshot(
      dependencies,
      authorized.target,
      await dependencies.loadAttempt(authorized.target),
    );
    if (
      result.state !== "awaiting-buyer-approval"
      || !result.approvalUrl
    ) {
      return json({ ok: false, code: "CHECKOUT_NOT_READY" }, 409);
    }
    return Response.redirect(result.approvalUrl, 303);
  } catch (error) {
    return paymentFailure(error);
  }
}

export function handlePaymentStatusPost(
  request: Request,
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<Response> {
  return handleMutation(request, locators, dependencies, async (target) =>
    resultFromSnapshot(
      dependencies,
      target,
      await dependencies.loadAttempt(target),
    ));
}

export function handlePaymentCapturePost(
  request: Request,
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<Response> {
  return handleMutation(request, locators, dependencies, (target) =>
    captureCheckout(dependencies, locators, target));
}

export function handlePaymentReconcilePost(
  request: Request,
  locators: PaymentLocators,
  dependencies: CustomPaymentDependencies,
): Promise<Response> {
  return handleMutation(request, locators, dependencies, (target) =>
    reconcileCheckout(dependencies, target));
}
