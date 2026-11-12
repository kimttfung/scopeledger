import {
  handleProviderSourceAnalysisReviewPost,
} from "../service";
import { providerSourceAnalysisDependencies } from "../runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleProviderSourceAnalysisReviewPost(
      request,
      await providerSourceAnalysisDependencies(),
    );
  } catch {
    return Response.json({
      ok: false,
      code: "SOURCE_ANALYSIS_REVIEW_UNAVAILABLE",
      message: "Protected provider source analysis review is unavailable.",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
