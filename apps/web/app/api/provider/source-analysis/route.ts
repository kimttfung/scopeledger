import {
  handleProviderSourceAnalysisGet,
  handleProviderSourceAnalysisPost,
} from "./service";
import { providerSourceAnalysisDependencies } from "./runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = (error?: unknown) => Response.json({
  ok: false,
  code: error
      && typeof error === "object"
      && "code" in error
      && error.code === "EVALUATOR_CONFIGURATION_INVALID"
    ? "EVALUATOR_CONFIGURATION_INVALID"
    : "SOURCE_ANALYSIS_UNAVAILABLE",
  message: error
      && typeof error === "object"
      && "code" in error
      && error.code === "EVALUATOR_CONFIGURATION_INVALID"
    ? "Evaluator limits are not safely configured."
    : "Protected provider source analysis is unavailable.",
}, {
  status: 503,
  headers: {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  },
});

export async function GET(): Promise<Response> {
  try {
    return await handleProviderSourceAnalysisGet(
      await providerSourceAnalysisDependencies(),
    );
  } catch (error) {
    return unavailable(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleProviderSourceAnalysisPost(
      request,
      await providerSourceAnalysisDependencies(),
    );
  } catch (error) {
    return unavailable(error);
  }
}
