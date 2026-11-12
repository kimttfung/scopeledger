import {
  handleProviderSourcePost,
  handleProviderSourcesGet,
} from "./service";
import { providerSourceDependencies } from "./runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    return await handleProviderSourcesGet(
      request,
      await providerSourceDependencies(),
    );
  } catch {
    return Response.json({
      ok: false,
      code: "SOURCE_INTAKE_UNAVAILABLE",
      message: "Protected provider source intake is unavailable.",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handleProviderSourcePost(
      request,
      await providerSourceDependencies(),
    );
  } catch {
    return Response.json({
      ok: false,
      code: "SOURCE_INTAKE_UNAVAILABLE",
      message: "Protected provider source intake is unavailable.",
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
}
