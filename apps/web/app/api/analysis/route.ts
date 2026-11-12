import {
  GeminiCandidateClient,
  geminiConfigFromEnvironment,
} from "@scopeledger/gemini-adapter";
import {
  extractPdf,
  sealParsedPdfSource,
} from "@scopeledger/parser-adapter";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { requireSameOrigin } from "../../../lib/local-access";
import { providerAssurance } from "../../../lib/provider-session";
import {
  executeAnalysisUpload,
  responseFailure,
  validateAnalysisFormData,
  validateAnalysisRequestHeaders,
} from "./analysis-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

function json(execution: Awaited<ReturnType<typeof executeAnalysisUpload>>): Response {
  return Response.json(execution.body, {
    status: execution.status,
    headers: responseHeaders,
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
  } catch {
    return json(responseFailure(
      403,
      "SAME_ORIGIN_REQUIRED",
      "This upload must originate from the ScopeLedger application.",
    ));
  }

  if (!auth0Environment.configured || !auth0) {
    return json(responseFailure(
      503,
      "AUTHENTICATION_UNAVAILABLE",
      "Provider authentication is unavailable.",
    ));
  }

  let session;
  try {
    session = await auth0.getSession();
  } catch {
    return json(responseFailure(
      503,
      "AUTHENTICATION_UNAVAILABLE",
      "Provider authentication is temporarily unavailable.",
    ));
  }
  if (!session) {
    return json(responseFailure(
      401,
      "AUTHENTICATION_REQUIRED",
      "Sign in before uploading a provider PDF.",
    ));
  }
  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return json(responseFailure(
      403,
      "PROVIDER_ASSURANCE_REQUIRED",
      "Verified email and MFA assurance are required.",
    ));
  }

  const headerValidation = validateAnalysisRequestHeaders(request.headers);
  if (!headerValidation.ok) {
    return json(responseFailure(
      headerValidation.status,
      headerValidation.code,
      headerValidation.message,
    ));
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json(responseFailure(
      400,
      "INVALID_MULTIPART",
      "The multipart upload could not be read.",
    ));
  }
  const formValidation = validateAnalysisFormData(formData);
  if (!formValidation.ok) {
    return json(responseFailure(
      formValidation.status,
      formValidation.code,
      formValidation.message,
    ));
  }

  return json(await executeAnalysisUpload(formValidation.value, {
    extractPdf,
    sealParsedPdfSource,
    generateCandidates: async (run) => {
      const client = new GeminiCandidateClient(
        geminiConfigFromEnvironment(),
      );
      return client.generateCandidateClaims(run);
    },
  }));
}
