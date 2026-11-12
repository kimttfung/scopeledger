import {
  GeminiCandidateClient,
  geminiConfigFromEnvironment,
} from "@scopeledger/gemini-adapter";
import {
  ANALYSIS_DEMO_SCOPE,
  PostgresAnalysisStore,
  PostgresAuthoringStore,
  sql,
} from "@scopeledger/db";
import {
  extractPdf,
  sealParsedPdfSource,
} from "@scopeledger/parser-adapter";
import { requireSameOrigin } from "../../../../lib/local-access";
import { protocolDatabase } from "../../../../lib/protocol-database";
import { verifiedProvider } from "../../analysis/provider-api";
import {
  providerSourceScopePrefix,
} from "../sources/service";
import { providerSourceStorage } from "../sources/storage-runtime";
import type {
  AuthorizedProviderSource,
  PersistedAnalysisSourceDetails,
  ProviderSourceAnalysisDependencies,
} from "./service";

const workspaceId = "demo-workspace";
const providerActorId = "northstar-provider";
const providerGrantEpoch = 1;
const MAX_SOURCE_BYTES = 10_000_000;

type RequestScopeRow = Readonly<{
  project_id: string;
  project_display_name: string;
  request_id: string;
  request_title: string;
}>;

type SourceKeyRow = Readonly<{
  source_id: string;
  source_version: number;
}>;

type AnalysisSourceRow = Readonly<{
  version_id: string;
  exact_text: string;
  parser_reference: string;
  extraction_status: "complete" | "partial";
  declared_byte_length: number;
  declared_page_count: number;
  code_point_count: number;
}>;

type AnalysisCoverageRow = Readonly<{
  page_number: number;
  status: "extracted" | "unavailable";
  start_offset: number | null;
  end_offset: number | null;
}>;

function database() {
  const current = protocolDatabase();
  if (!current) {
    throw new Error("Provider source analysis database is not configured");
  }
  return current;
}

async function listAuthorizedSources(): Promise<
  readonly AuthorizedProviderSource[]
> {
  const current = database();
  const scopes = (await sql<RequestScopeRow>`select
      p.id as project_id,
      p.provider_display_name as project_display_name,
      r.id as request_id,
      r.provider_title as request_title
    from projects p
    join grants g
      on g.workspace_id = p.workspace_id
      and g.project_id = p.id
      and g.actor_id = ${providerActorId}
      and g.action = 'inspect'
      and g.epoch = ${providerGrantEpoch}
      and g.active = true
    join packets r
      on r.workspace_id = p.workspace_id
      and r.project_id = p.id
    where p.workspace_id = ${workspaceId}
      and p.provider_creation_digest is not null
      and r.provider_creation_digest is not null
    order by p.provider_created_at desc,p.id collate "C",
      r.provider_created_at desc,r.id collate "C"
    limit 100`.execute(current.kysely)).rows;
  const authoring = new PostgresAuthoringStore(current);
  const result: AuthorizedProviderSource[] = [];
  for (const scope of scopes) {
    const prefix = `${providerSourceScopePrefix({
      workspaceId,
      projectId: scope.project_id,
      requestId: scope.request_id,
    })}%`;
    const keys = (await sql<SourceKeyRow>`select source_id,source_version
      from source_intake_records
      where workspace_id = ${workspaceId}
        and project_id = ${scope.project_id}
        and source_id like ${prefix}
      order by recorded_at desc,source_id collate "C",source_version desc
      limit 100`.execute(current.kysely)).rows;
    for (const key of keys) {
      const source = await authoring.readSourceIntake({
        workspaceId,
        projectId: scope.project_id,
        sourceId: key.source_id,
        version: key.source_version,
      });
      if (!source) continue;
      result.push(Object.freeze({
        workspaceId,
        projectId: scope.project_id,
        projectDisplayName: scope.project_display_name,
        requestId: scope.request_id,
        requestTitle: scope.request_title,
        providerActorId,
        grantEpoch: providerGrantEpoch,
        source,
      }));
    }
  }
  return Object.freeze(result);
}

async function persistedSourceDetails(
  versionId: string,
): Promise<PersistedAnalysisSourceDetails> {
  const current = database();
  const source = (await sql<AnalysisSourceRow>`select
      version_id::text,exact_text,parser_reference,extraction_status,
      declared_byte_length,declared_page_count,code_point_count
    from analysis_source_versions
    where workspace_id = ${ANALYSIS_DEMO_SCOPE.workspaceId}
      and project_id = ${ANALYSIS_DEMO_SCOPE.projectId}
      and source_id = ${ANALYSIS_DEMO_SCOPE.sourceId}
      and version_id = ${versionId}::uuid`
    .execute(current.kysely)).rows[0];
  if (!source) {
    throw new Error("Persisted analysis source is missing");
  }
  const coverage = (await sql<AnalysisCoverageRow>`select
      page_number,status,start_offset,end_offset
    from analysis_source_coverage
    where workspace_id = ${ANALYSIS_DEMO_SCOPE.workspaceId}
      and project_id = ${ANALYSIS_DEMO_SCOPE.projectId}
      and source_id = ${ANALYSIS_DEMO_SCOPE.sourceId}
      and version_id = ${versionId}::uuid
    order by page_number`.execute(current.kysely)).rows.map((entry) =>
    entry.status === "extracted"
      ? Object.freeze({
        number: entry.page_number,
        status: "extracted" as const,
        start: entry.start_offset!,
        end: entry.end_offset!,
      })
      : Object.freeze({
        number: entry.page_number,
        status: "unavailable" as const,
      }));
  return Object.freeze({
    versionId: source.version_id,
    exactText: source.exact_text,
    parserReference: source.parser_reference,
    extractionStatus: source.extraction_status,
    declaredByteLength: Number(source.declared_byte_length),
    declaredPageCount: Number(source.declared_page_count),
    codePointCount: Number(source.code_point_count),
    coverage: Object.freeze(coverage),
  });
}

export async function providerSourceAnalysisDependencies(): Promise<
  ProviderSourceAnalysisDependencies
> {
  const current = database();
  const analysis = new PostgresAnalysisStore(current);
  let configuredModel: string | null = null;
  return {
    requireSameOrigin,
    verifyProvider: verifiedProvider,
    listAuthorizedSources,
    readSourceObject: async (source) =>
      (await providerSourceStorage()).read({
        workspaceId: source.workspaceId,
        projectId: source.projectId,
        sourceId: source.source.sourceId,
        versionId: String(source.source.version),
      }, {
        maxBytes: MAX_SOURCE_BYTES,
      }),
    extractPdf,
    sealParsedPdfSource,
    generateCandidates: async (run) => {
      const config = geminiConfigFromEnvironment();
      configuredModel = config.model;
      return new GeminiCandidateClient(config).generateCandidateClaims(run);
    },
    persistRun: async (input) => (await analysis.saveRun(input)).run,
    listPersistedRuns: async (subjectDigest, limit) => {
      const runs = await analysis.listRuns({
        ...ANALYSIS_DEMO_SCOPE,
        requestedBySubjectDigest: subjectDigest,
        limit,
      });
      return Object.freeze(await Promise.all(runs.map(async (run) =>
        Object.freeze({
          run,
          source: await persistedSourceDetails(
            run.sourceReference.versionId,
          ),
          reviews: await analysis.readReviews({
            ...ANALYSIS_DEMO_SCOPE,
            runId: run.runId,
          }),
        }))));
    },
    appendReview: (input) => analysis.appendReview({
      ...ANALYSIS_DEMO_SCOPE,
      ...input,
    }),
    modelReference: () => configuredModel
      ?? (
        typeof process.env.GEMINI_MODEL === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(
          process.env.GEMINI_MODEL,
        )
          ? process.env.GEMINI_MODEL
          : null
      ),
    now: () => new Date(),
  };
}
