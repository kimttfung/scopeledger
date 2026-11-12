import {
  ANALYSIS_DEMO_SCOPE,
  PostgresAnalysisStore,
} from "@scopeledger/db";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import type {
  AnalysisReviewResponse,
} from "../../../provider/analysis/types.js";
import { verifiedProvider } from "../provider-api";
import {
  reviewPersistenceFailure,
  validateReviewRequest,
} from "../review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function json(body: AnalysisReviewResponse, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "This review must originate from the ScopeLedger application.",
    }, 403);
  }
  const provider = await verifiedProvider();
  if (!provider.ok) {
    return json({
      ok: false,
      code: provider.code,
      message: provider.message,
    }, provider.status);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({
      ok: false,
      code: "INVALID_REVIEW_REQUEST",
      message: "The review request was not valid JSON.",
    }, 400);
  }
  const validation = validateReviewRequest(body);
  if (!validation.ok) {
    return json({
      ok: false,
      code: validation.code,
      message: validation.message,
    }, validation.status);
  }
  const database = protocolDatabase();
  if (!database) {
    return json({
      ok: false,
      code: "ANALYSIS_PERSISTENCE_UNAVAILABLE",
      message: "Durable analysis storage is unavailable.",
    }, 503);
  }
  try {
    const result = await new PostgresAnalysisStore(database).appendReview({
      ...ANALYSIS_DEMO_SCOPE,
      ...validation.value,
      reviewerSubjectDigest: provider.subjectDigest,
    });
    return json({
      ok: true,
      duplicate: result.duplicate,
      review: {
        reviewId: result.review.reviewId,
        runId: result.review.runId,
        reviewedAt: result.review.reviewedAt.toISOString(),
        disposition: result.review.disposition,
        note: result.review.note,
        runBasisDigest: result.review.runBasisDigest,
        candidateBasisDigest: result.review.candidateBasisDigest,
      },
    }, result.duplicate ? 200 : 201);
  } catch (error) {
    const failure = reviewPersistenceFailure(error);
    return json({
      ok: false,
      code: failure.code,
      message: failure.message,
    }, failure.status);
  }
}
