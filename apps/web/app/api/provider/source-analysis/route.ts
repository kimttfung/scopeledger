import {
  handleProviderSourceAnalysisGet,
  handleProviderSourceAnalysisPost,
} from "./service";
import { providerSourceAnalysisDependencies } from "./runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const unavailable = () => Response.json({
  ok: false,
  code: "SOURCE_ANALYSIS_UNAVAILABLE",
  message: "Protected provider source analysis is unavailable.",
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
  } catch {
    return unavailable();
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleProviderSourceAnalysisPost(
      request,
      await providerSourceAnalysisDependencies(),
    );
  } catch {
    return unavailable();
  }
}
