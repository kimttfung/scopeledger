import {
  ANALYSIS_DEMO_SCOPE,
  PostgresAnalysisStore,
} from "@scopeledger/db";
import { protocolDatabase } from "../../../../lib/protocol-database";
import type {
  AnalysisRunsResponse,
  StoredAnalysisRun,
} from "../../../provider/analysis/types.js";
import { verifiedProvider } from "../provider-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function json(body: AnalysisRunsResponse, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

export async function GET(): Promise<Response> {
  const provider = await verifiedProvider();
  if (!provider.ok) {
    return json({
      ok: false,
      code: provider.code,
      message: provider.message,
    }, provider.status);
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
    const store = new PostgresAnalysisStore(database);
    const runs = await store.listRuns({
      ...ANALYSIS_DEMO_SCOPE,
      requestedBySubjectDigest: provider.subjectDigest,
      limit: 20,
    });
    const serialized: StoredAnalysisRun[] = await Promise.all(runs.map(
      async (run) => {
        const reviews = await store.readReviews({
          ...ANALYSIS_DEMO_SCOPE,
          runId: run.runId,
        });
        return {
          runId: run.runId,
          status: run.status,
          recordedAt: run.createdAt.toISOString(),
          sourceDigest: run.sourceDigest,
          parserReference: run.parserReference,
          providerReference: run.providerReference,
          modelReference: run.modelReference,
          humanReviewRequired: true,
          publicationBlocked: true,
          candidateCount: run.candidatePayload?.candidates.length ?? 0,
          candidates: run.candidatePayload?.candidates ?? [],
          missingContext: run.candidatePayload?.missingContext ?? [],
          failureCode: run.failureDiagnostic?.code ?? null,
          reviews: reviews.map((review) => ({
            reviewId: review.reviewId,
            runId: review.runId,
            reviewedAt: review.reviewedAt.toISOString(),
            disposition: review.disposition,
            note: review.note,
            runBasisDigest: review.runBasisDigest,
            candidateBasisDigest: review.candidateBasisDigest,
          })),
        };
      },
    ));
    return json({ ok: true, runs: serialized });
  } catch {
    return json({
      ok: false,
      code: "ANALYSIS_RUNS_READ_FAILED",
      message: "Persisted analysis runs could not be read.",
    }, 503);
  }
}
