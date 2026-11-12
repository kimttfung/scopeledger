import {
  handleProviderSourcePost,
  handleProviderSourcesGet,
} from "./service";
import { providerSourceDependencies } from "./runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unavailable(error: unknown): Response {
  const invalidConfiguration = error
    && typeof error === "object"
    && "code" in error
    && error.code === "EVALUATOR_CONFIGURATION_INVALID";
  return Response.json({
    ok: false,
    code: invalidConfiguration
      ? "EVALUATOR_CONFIGURATION_INVALID"
      : "SOURCE_INTAKE_UNAVAILABLE",
    message: invalidConfiguration
      ? "Evaluator limits are not safely configured."
      : "Protected provider source intake is unavailable.",
  }, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleProviderSourcesGet(
      request,
      await providerSourceDependencies(),
    );
  } catch (error) {
    return unavailable(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleProviderSourcePost(
      request,
      await providerSourceDependencies(),
    );
  } catch (error) {
    return unavailable(error);
  }
}
