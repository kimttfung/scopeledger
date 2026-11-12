import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const locatorPatterns = {
  project: /^slr1p_[A-Za-z0-9_-]{43}$/u,
  request: /^slr1r_[A-Za-z0-9_-]{43}$/u,
  unit: /^slr1u_[A-Za-z0-9_-]{43}$/u,
  payer: /^slr1y_[A-Za-z0-9_-]{43}$/u,
} as const;
const secretPattern = /^[a-f0-9]{64}$/iu;

export type ReviewLocators = Readonly<{
  projectLocator: string;
  requestLocator: string;
  unitLocator: string;
}>;

export type ReviewSession = Readonly<{
  subject: string;
  role: "client-approver" | "payer";
}>;

export type ReviewReadiness =
  | "awaiting-agreement"
  | "review-hold"
  | "awaiting-payment"
  | "awaiting-prerequisite"
  | "financial-recheck"
  | "ready";

export type ReviewProjection = Readonly<{
  project: Readonly<{
    label: string;
  }>;
  request: Readonly<{
    label: string;
  }>;
  unit: Readonly<{
    title: string;
    version: number;
    publishedAt: string;
    treatment: "payable" | "additional-waived";
    approverCondition: string;
    scope: readonly string[];
    exclusions: readonly string[];
    rationale: string;
    timing: Readonly<{
      description: string;
      deliveryDependencies: readonly string[];
    }>;
    dependencies: readonly Readonly<{
      explanation: string;
    }>[];
    prerequisites: readonly Readonly<{
      description: string;
      blocks: "payment" | "start" | "payment-and-start";
    }>[];
  }>;
  commercial:
    | Readonly<{
      kind: "payable";
      policy: "full-prepayment";
      currency: "USD";
      lines: readonly Readonly<{
        description: string;
        quantity: string;
        unitPrice: string;
        amount: string;
      }>[];
      subtotal: string;
      tax: Readonly<{
        treatment: "none" | "exclusive" | "inclusive";
        amount: string;
        declaration: string;
      }>;
      gross: string;
    }>
    | Readonly<{
      kind: "additional-waived";
      policy: "not-required";
      explanation: string;
    }>;
  attribution: Readonly<{
    sources: readonly Readonly<{
      label: string;
      version: number;
      availability: "available" | "unavailable";
      origin: string | null;
      coverage: string;
    }>[];
    baselines: readonly Readonly<{
      label: string;
      version: number;
      coverage: "Confirmed published baseline";
    }>[];
  }>;
  reissue: null | Readonly<{
    previousVersion: number;
    correctionContexts: readonly Readonly<{
      statement: string;
      claimedSourceType: string;
      sourceAvailability: "available" | "unavailable";
      providerResponse: string;
      sourceReview: string;
      responseRevision: number;
      assessedAt: string;
    }>[];
    differences: readonly Readonly<{
      field: string;
      before: readonly string[];
      current: readonly string[];
    }>[];
  }>;
  facts: Readonly<{
    decision: Readonly<{
      status: "not-recorded" | "approved" | "declined";
      version: number;
      recordedAt: string | null;
    }>;
    payment: Readonly<{
      status:
        | "not-required"
        | "not-authorized"
        | "not-initiated"
        | "in-progress"
        | "processing"
        | "outcome-unknown"
        | "verified";
      verifiedAt: string | null;
    }>;
    readiness: ReviewReadiness;
    acceptedVersion: number | null;
    holds: readonly Readonly<{
      reason: string;
    }>[];
    workStart: Readonly<{
      recorded: boolean;
      version: number | null;
      recordedAt: string | null;
    }>;
  }>;
  history: Readonly<{
    previousVersionCount: number;
    previousVersions: readonly Readonly<{
      version: number;
      publishedAt: string;
      decision: Readonly<{
        status: "not-recorded" | "approved" | "declined";
        recordedAt: string | null;
      }>;
      obligation: null | Readonly<{
        currency: "USD";
        gross: string;
        collectionStatus: "active" | "retired";
        paymentStatus: "not-initiated" | "attempted" | "verified";
        verifiedAt: string | null;
      }>;
    }>[];
    additionalPreviousVersions: number;
  }>;
  actions: Readonly<{
    endpoint: string;
    decision: Readonly<{
      available: boolean;
      responseAcknowledgementCount: number;
    }>;
    question: Readonly<{
      available: true;
    }>;
    correction: Readonly<{
      available: true;
    }>;
    payment: Readonly<{
      available: boolean;
      url: string | null;
    }>;
  }>;
}>;

export type ReviewLoadFailureCode =
  | "REVIEW_ACCESS_UNAVAILABLE"
  | "CLIENT_ACCESS_REQUIRED"
  | "CLIENT_APPROVER_REQUIRED"
  | "REVIEW_NOT_AUTHORIZED"
  | "REVIEW_NOT_AVAILABLE"
  | "REVIEW_STATE_CHANGED";

export type ReviewLoadResult =
  | Readonly<{ ok: true; review: ReviewProjection }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 404 | 409 | 503;
    code: ReviewLoadFailureCode;
  }>;

export type ReviewDependencies = Readonly<{
  readSession: () => Promise<ReviewSession | null>;
  loadReview: (
    locators: ReviewLocators,
    session: ReviewSession,
  ) => Promise<ReviewProjection>;
}>;

export class ReviewLoadError extends Error {
  constructor(
    public readonly code:
      | "ACCESS_DENIED"
      | "NOT_FOUND"
      | "STALE_RECORD"
      | "MALFORMED_RECORD",
  ) {
    super(code);
    this.name = "ReviewLoadError";
  }
}

export const privateReviewHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "Surrogate-Control": "no-store",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function locator(
  secret: Buffer,
  prefix: "slr1p_" | "slr1r_" | "slr1u_" | "slr1y_",
  parts: readonly string[],
): string {
  const digest = createHmac("sha256", secret)
    .update(["scopeledger.review.v1", prefix, ...parts].join("\u0000"))
    .digest("base64url");
  return `${prefix}${digest}`;
}

export class ReviewLocatorCodec {
  private readonly secret: Buffer;

  constructor(secret: string) {
    if (!secretPattern.test(secret)) {
      throw new Error("Review locator secret must be a 32-byte hexadecimal value");
    }
    this.secret = Buffer.from(secret, "hex");
  }

  project(workspaceId: string, projectId: string): string {
    return locator(this.secret, "slr1p_", [workspaceId, projectId]);
  }

  request(
    workspaceId: string,
    projectId: string,
    requestId: string,
  ): string {
    return locator(this.secret, "slr1r_", [
      workspaceId,
      projectId,
      requestId,
    ]);
  }

  unit(
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
  ): string {
    return locator(this.secret, "slr1u_", [
      workspaceId,
      projectId,
      requestId,
      unitId,
    ]);
  }

  mutationUnit(
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
    version: number,
    digest: string,
  ): string {
    return locator(this.secret, "slr1u_", [
      "mutation",
      workspaceId,
      projectId,
      requestId,
      unitId,
      String(version),
      digest,
    ]);
  }

  payer(
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
    version: number,
    digest: string,
    obligationId: string,
    payerId: string,
  ): string {
    return locator(this.secret, "slr1y_", [
      workspaceId,
      projectId,
      requestId,
      unitId,
      String(version),
      digest,
      obligationId,
      payerId,
    ]);
  }

  matchesProject(
    candidate: string,
    workspaceId: string,
    projectId: string,
  ): boolean {
    return safeEqual(candidate, this.project(workspaceId, projectId));
  }

  matchesRequest(
    candidate: string,
    workspaceId: string,
    projectId: string,
    requestId: string,
  ): boolean {
    return safeEqual(
      candidate,
      this.request(workspaceId, projectId, requestId),
    );
  }

  matchesUnit(
    candidate: string,
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
  ): boolean {
    return safeEqual(
      candidate,
      this.unit(workspaceId, projectId, requestId, unitId),
    );
  }

  matchesMutationUnit(
    candidate: string,
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
    version: number,
    digest: string,
  ): boolean {
    return safeEqual(
      candidate,
      this.mutationUnit(
        workspaceId,
        projectId,
        requestId,
        unitId,
        version,
        digest,
      ),
    );
  }

  matchesPayer(
    candidate: string,
    workspaceId: string,
    projectId: string,
    requestId: string,
    unitId: string,
    version: number,
    digest: string,
    obligationId: string,
    payerId: string,
  ): boolean {
    return safeEqual(
      candidate,
      this.payer(
        workspaceId,
        projectId,
        requestId,
        unitId,
        version,
        digest,
        obligationId,
        payerId,
      ),
    );
  }
}

export function validPayerLocator(locatorValue: string): boolean {
  return locatorPatterns.payer.test(locatorValue);
}

export function validReviewLocators(
  locators: ReviewLocators,
): boolean {
  return locatorPatterns.project.test(locators.projectLocator)
    && locatorPatterns.request.test(locators.requestLocator)
    && locatorPatterns.unit.test(locators.unitLocator);
}

export function isReviewPrefetch(headers: Headers): boolean {
  return headers.get("purpose")?.toLowerCase() === "prefetch"
    || headers.get("sec-purpose")?.toLowerCase().includes("prefetch") === true
    || headers.get("next-router-prefetch") === "1"
    || headers.get("x-middleware-prefetch") === "1";
}

export async function loadScopedReview(
  locators: ReviewLocators,
  dependencies: ReviewDependencies,
): Promise<ReviewLoadResult> {
  if (!validReviewLocators(locators)) {
    return {
      ok: false,
      status: 404,
      code: "REVIEW_NOT_AVAILABLE",
    };
  }

  let session: ReviewSession | null;
  try {
    session = await dependencies.readSession();
  } catch {
    return {
      ok: false,
      status: 503,
      code: "REVIEW_ACCESS_UNAVAILABLE",
    };
  }
  if (!session) {
    return {
      ok: false,
      status: 401,
      code: "CLIENT_ACCESS_REQUIRED",
    };
  }
  if (session.role !== "client-approver") {
    return {
      ok: false,
      status: 403,
      code: "CLIENT_APPROVER_REQUIRED",
    };
  }

  try {
    return {
      ok: true,
      review: await dependencies.loadReview(locators, session),
    };
  } catch (error) {
    if (error instanceof ReviewLoadError) {
      switch (error.code) {
        case "ACCESS_DENIED":
          return {
            ok: false,
            status: 403,
            code: "REVIEW_NOT_AUTHORIZED",
          };
        case "NOT_FOUND":
          return {
            ok: false,
            status: 404,
            code: "REVIEW_NOT_AVAILABLE",
          };
        case "STALE_RECORD":
        case "MALFORMED_RECORD":
          return {
            ok: false,
            status: 409,
            code: "REVIEW_STATE_CHANGED",
          };
      }
    }
    return {
      ok: false,
      status: 503,
      code: "REVIEW_ACCESS_UNAVAILABLE",
    };
  }
}

function json(body: object, status: number): Response {
  return Response.json(body, {
    status,
    headers: privateReviewHeaders,
  });
}

export async function handleReviewGet(
  request: Request,
  locators: ReviewLocators,
  dependencies: ReviewDependencies,
): Promise<Response> {
  if (isReviewPrefetch(request.headers)) {
    return json({
      ok: false,
      code: "REVIEW_PREFETCH_REJECTED",
    }, 403);
  }
  const result = await loadScopedReview(locators, dependencies);
  if (!result.ok) {
    return json({
      ok: false,
      code: result.code,
    }, result.status);
  }
  return json({
    ok: true,
    review: result.review,
  }, 200);
}
