import {
  GeminiCandidateClient,
  geminiConfigFromEnvironment,
} from "@scopeledger/gemini-adapter";
import {
  ANALYSIS_DEMO_SCOPE,
  PostgresAnalysisStore,
} from "@scopeledger/db";
import { requireSameOrigin } from "../../../lib/local-access";
import { protocolDatabase } from "../../../lib/protocol-database";
import {
  evaluatorLimitConfigFromEnvironment,
  withAnalysisAdmission,
} from "../../../lib/evaluator-limits";
import {
  executeAnalysisUpload,
  responseFailure,
  validateAnalysisFormData,
  validateAnalysisRequestHeaders,
} from "./analysis-service";
import { verifiedProvider } from "./provider-api";
import { analysisParserRuntime } from "./runtime-parser";

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

  const provider = await verifiedProvider();
  if (!provider.ok) {
    return json(responseFailure(
      provider.status,
      provider.code,
      provider.message,
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

  const database = protocolDatabase();
  if (!database) {
    return json(responseFailure(
      503,
      "ANALYSIS_PERSISTENCE_UNAVAILABLE",
      "Durable analysis storage is unavailable. The PDF was not processed.",
    ));
  }
  const store = new PostgresAnalysisStore(database);
  let limitConfig: ReturnType<typeof evaluatorLimitConfigFromEnvironment>;
  try {
    limitConfig = evaluatorLimitConfigFromEnvironment();
  } catch {
    return json(responseFailure(
      503,
      "EVALUATOR_CONFIGURATION_INVALID",
      "Evaluator limits are not safely configured.",
    ));
  }
  let configuredModel: string | null = null;
  return json(await executeAnalysisUpload(formValidation.value, {
    extractPdf: analysisParserRuntime.extractPdf,
    sealParsedPdfSource: analysisParserRuntime.sealParsedPdfSource,
    requestedBySubjectDigest: provider.subjectDigest,
    persistRun: async (input) => {
      await store.saveRun(input);
    },
    admitAnalysis: (input, work) => withAnalysisAdmission(
      database,
      limitConfig,
      {
        logicalWorkspaceId: ANALYSIS_DEMO_SCOPE.workspaceId,
        logicalProjectId: ANALYSIS_DEMO_SCOPE.projectId,
        persistenceWorkspaceId: ANALYSIS_DEMO_SCOPE.workspaceId,
        persistenceProjectId: ANALYSIS_DEMO_SCOPE.projectId,
        subjectDigest: provider.subjectDigest,
        sourceVersionMode: "run-id",
        sourceVersionIds: [],
        mode: input.mode,
      },
      work,
    ),
    modelReference: () => configuredModel,
    generateCandidates: async (run) => {
      const config = geminiConfigFromEnvironment();
      configuredModel = config.model;
      const client = new GeminiCandidateClient(config);
      return client.generateCandidateClaims(run);
    },
  }));
}
