import type { ProtocolDatabase } from "@scopeledger/db";

export const LOCAL_H1_EVALUATOR_LIMITS = Object.freeze({
  profile: "local-h1" as const,
  analysisRunsPerSubjectProject: 3,
  sourceUploadsPerProjectWindow: 5,
  sourceUploadBytesPerProjectWindow: 25_000_000,
  sourceUploadWindowMinutes: 60,
  modelCallsPerSubjectProject: 2,
});

export type EvaluatorLimitConfig = Readonly<{
  profile: "local-h1" | "production";
  analysisRunsPerSubjectProject: number;
  sourceUploadsPerProjectWindow: number;
  sourceUploadBytesPerProjectWindow: number;
  sourceUploadWindowMinutes: number;
  modelCallsPerSubjectProject: number;
}>;

export type SourceUploadLimitState = Readonly<{
  maximumCount: number;
  admittedCount: number;
  remainingCount: number;
  maximumBytes: number;
  admittedBytes: number;
  remainingBytes: number;
  windowMinutes: number;
  blocked: boolean;
}>;

export type AnalysisLimitState = Readonly<{
  maximumRuns: number;
  admittedRuns: number;
  remainingRuns: number;
  modelCallBudget: number;
  admittedModelCalls: number;
  remainingModelCalls: number;
  blocked: boolean;
  modelBlocked: boolean;
}>;

export type SourceUploadLimitScope = Readonly<{
  workspaceId: string;
  projectId: string;
}>;

export type SourceUploadAdmission = SourceUploadLimitScope & Readonly<{
  sourceId: string;
  sourceVersion: number;
  byteLength: number;
}>;

export type AnalysisLimitScope = Readonly<{
  logicalWorkspaceId: string;
  logicalProjectId: string;
  persistenceWorkspaceId: string;
  persistenceProjectId: string;
  subjectDigest: string;
  sourceVersionMode: "listed" | "run-id";
  sourceVersionIds: readonly string[];
}>;

export type AnalysisAdmission = AnalysisLimitScope & Readonly<{
  mode: "manual" | "gemini";
}>;

export type AnalysisAdmissionDecision = Readonly<{
  modelDispatchAllowed: boolean;
  state: AnalysisLimitState;
}>;

export type EvaluatorLimitErrorCode =
  | "EVALUATOR_CONFIGURATION_INVALID"
  | "SOURCE_UPLOAD_LIMIT_REACHED"
  | "SOURCE_UPLOAD_BYTES_LIMIT_REACHED"
  | "ANALYSIS_RUN_LIMIT_REACHED"
  | "EVALUATOR_ADMISSION_UNAVAILABLE";

export class EvaluatorLimitError extends Error {
  constructor(
    public readonly code: EvaluatorLimitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EvaluatorLimitError";
  }
}

const integerPattern = /^(0|[1-9][0-9]*)$/u;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function configuredInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number | null,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw === "") {
    if (fallback !== null) return fallback;
    throw new EvaluatorLimitError(
      "EVALUATOR_CONFIGURATION_INVALID",
      `${name} is required`,
    );
  }
  if (!integerPattern.test(raw)) {
    throw new EvaluatorLimitError(
      "EVALUATOR_CONFIGURATION_INVALID",
      `${name} must be an integer`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EvaluatorLimitError(
      "EVALUATOR_CONFIGURATION_INVALID",
      `${name} is outside the allowed range`,
    );
  }
  return value;
}

export function evaluatorLimitConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): EvaluatorLimitConfig {
  const requestedProfile = environment.SCOPELEDGER_EVALUATOR_LIMITS_PROFILE;
  const profile = requestedProfile
    ?? (environment.NODE_ENV === "production" ? null : "local-h1");
  if (profile !== "local-h1" && profile !== "production") {
    throw new EvaluatorLimitError(
      "EVALUATOR_CONFIGURATION_INVALID",
      "A valid evaluator limits profile is required",
    );
  }
  const defaults = profile === "local-h1"
    ? LOCAL_H1_EVALUATOR_LIMITS
    : null;
  const analysisRunsPerSubjectProject = configuredInteger(
    environment,
    "SCOPELEDGER_ANALYSIS_RUN_LIMIT",
    defaults?.analysisRunsPerSubjectProject ?? null,
    1,
    3,
  );
  const sourceUploadsPerProjectWindow = configuredInteger(
    environment,
    "SCOPELEDGER_SOURCE_UPLOAD_COUNT_LIMIT",
    defaults?.sourceUploadsPerProjectWindow ?? null,
    1,
    100,
  );
  const sourceUploadBytesPerProjectWindow = configuredInteger(
    environment,
    "SCOPELEDGER_SOURCE_UPLOAD_BYTES_LIMIT",
    defaults?.sourceUploadBytesPerProjectWindow ?? null,
    1,
    1_000_000_000,
  );
  const sourceUploadWindowMinutes = configuredInteger(
    environment,
    "SCOPELEDGER_SOURCE_UPLOAD_WINDOW_MINUTES",
    defaults?.sourceUploadWindowMinutes ?? null,
    1,
    10_080,
  );
  const modelCallsPerSubjectProject = configuredInteger(
    environment,
    "SCOPELEDGER_MODEL_CALL_BUDGET",
    defaults?.modelCallsPerSubjectProject ?? null,
    0,
    3,
  );
  if (modelCallsPerSubjectProject > analysisRunsPerSubjectProject) {
    throw new EvaluatorLimitError(
      "EVALUATOR_CONFIGURATION_INVALID",
      "The model-call budget cannot exceed the analysis-run limit",
    );
  }
  return Object.freeze({
    profile,
    analysisRunsPerSubjectProject,
    sourceUploadsPerProjectWindow,
    sourceUploadBytesPerProjectWindow,
    sourceUploadWindowMinutes,
    modelCallsPerSubjectProject,
  });
}

function sourceState(
  config: EvaluatorLimitConfig,
  admittedCount: number,
  admittedBytes: number,
): SourceUploadLimitState {
  const remainingCount = Math.max(
    0,
    config.sourceUploadsPerProjectWindow - admittedCount,
  );
  const remainingBytes = Math.max(
    0,
    config.sourceUploadBytesPerProjectWindow - admittedBytes,
  );
  return Object.freeze({
    maximumCount: config.sourceUploadsPerProjectWindow,
    admittedCount,
    remainingCount,
    maximumBytes: config.sourceUploadBytesPerProjectWindow,
    admittedBytes,
    remainingBytes,
    windowMinutes: config.sourceUploadWindowMinutes,
    blocked: remainingCount === 0 || remainingBytes === 0,
  });
}

function analysisState(
  config: EvaluatorLimitConfig,
  admittedRuns: number,
  admittedModelCalls: number,
): AnalysisLimitState {
  const remainingRuns = Math.max(
    0,
    config.analysisRunsPerSubjectProject - admittedRuns,
  );
  const remainingModelCalls = Math.max(
    0,
    config.modelCallsPerSubjectProject - admittedModelCalls,
  );
  return Object.freeze({
    maximumRuns: config.analysisRunsPerSubjectProject,
    admittedRuns,
    remainingRuns,
    modelCallBudget: config.modelCallsPerSubjectProject,
    admittedModelCalls,
    remainingModelCalls,
    blocked: remainingRuns === 0,
    modelBlocked: remainingModelCalls === 0,
  });
}

function validateSourceScope(scope: SourceUploadLimitScope): void {
  if (
    !identifierPattern.test(scope.workspaceId)
    || !identifierPattern.test(scope.projectId)
  ) {
    throw new EvaluatorLimitError(
      "EVALUATOR_ADMISSION_UNAVAILABLE",
      "Invalid source upload scope",
    );
  }
}

function validateAnalysisScope(scope: AnalysisLimitScope): void {
  if (
    !identifierPattern.test(scope.logicalWorkspaceId)
    || !identifierPattern.test(scope.logicalProjectId)
    || !identifierPattern.test(scope.persistenceWorkspaceId)
    || !identifierPattern.test(scope.persistenceProjectId)
    || !digestPattern.test(scope.subjectDigest)
    || scope.sourceVersionIds.some((value) => !uuidPattern.test(value))
  ) {
    throw new EvaluatorLimitError(
      "EVALUATOR_ADMISSION_UNAVAILABLE",
      "Invalid analysis admission scope",
    );
  }
}

async function sourceUsage(
  database: ProtocolDatabase,
  config: EvaluatorLimitConfig,
  scope: SourceUploadLimitScope,
): Promise<SourceUploadLimitState> {
  validateSourceScope(scope);
  const result = await database.pool.query<{
    admitted_count: string;
    admitted_bytes: string;
  }>(`
    select count(*)::text as admitted_count,
      coalesce(sum(declared_byte_length),0)::text as admitted_bytes
    from source_intake_records
    where workspace_id = $1
      and project_id = $2
      and source_kind = 'provider-upload'
      and recorded_at >= clock_timestamp() - ($3::double precision * interval '1 minute')
  `, [
    scope.workspaceId,
    scope.projectId,
    config.sourceUploadWindowMinutes,
  ]);
  const row = result.rows[0];
  return sourceState(
    config,
    Number(row?.admitted_count ?? 0),
    Number(row?.admitted_bytes ?? 0),
  );
}

function analysisPredicate(scope: AnalysisLimitScope): Readonly<{
  sql: string;
  parameters: readonly unknown[];
}> {
  if (scope.sourceVersionMode === "run-id") {
    return {
      sql: "and run_id = source_version_id",
      parameters: [],
    };
  }
  return {
    sql: "and source_version_id = any($4::uuid[])",
    parameters: [scope.sourceVersionIds],
  };
}

async function analysisUsage(
  database: ProtocolDatabase,
  config: EvaluatorLimitConfig,
  scope: AnalysisLimitScope,
): Promise<AnalysisLimitState> {
  validateAnalysisScope(scope);
  const predicate = analysisPredicate(scope);
  const result = await database.pool.query<{
    admitted_runs: string;
    admitted_model_calls: string;
  }>(`
    select count(*)::text as admitted_runs,
      count(*) filter (
        where provider_reference = 'google-gemini'
          and failure_code is distinct from 'MODEL_CONFIGURATION_UNAVAILABLE'
      )::text as admitted_model_calls
    from analysis_runs
    where workspace_id = $1
      and project_id = $2
      and requested_by_subject_digest = $3
      ${predicate.sql}
  `, [
    scope.persistenceWorkspaceId,
    scope.persistenceProjectId,
    scope.subjectDigest,
    ...predicate.parameters,
  ]);
  const row = result.rows[0];
  return analysisState(
    config,
    Number(row?.admitted_runs ?? 0),
    Number(row?.admitted_model_calls ?? 0),
  );
}

export async function readSourceUploadLimitState(
  database: ProtocolDatabase,
  config: EvaluatorLimitConfig,
  scope: SourceUploadLimitScope,
): Promise<SourceUploadLimitState> {
  return sourceUsage(database, config, scope);
}

export async function readAnalysisLimitState(
  database: ProtocolDatabase,
  config: EvaluatorLimitConfig,
  scope: AnalysisLimitScope,
): Promise<AnalysisLimitState> {
  return analysisUsage(database, config, scope);
}

export async function withSourceUploadAdmission<T>(
  database: ProtocolDatabase,
  config: EvaluatorLimitConfig,
  input: SourceUploadAdmission,
  work: () => Promise<T>,
): Promise<Readonly<{ value: T; state: SourceUploadLimitState }>> {
  validateSourceScope(input);
  if (
    !identifierPattern.test(input.sourceId)
    || !Number.isSafeInteger(input.sourceVersion)
    || input.sourceVersion < 1
    || !Number.isSafeInteger(input.byteLength)
    || input.byteLength < 1
  ) {
    throw new EvaluatorLimitError(
      "EVALUATOR_ADMISSION_UNAVAILABLE",
      "Invalid source admission input",
    );
  }
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '130s'");
    // Every source-intake writer must use this project lock. The immutable row
    // remains the authority; the lock only serializes count+insert admission.
    await client.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [`scopeledger:evaluator:source:${database.schema}:${input.workspaceId}:${input.projectId}`],
    );
    const duplicate = await client.query<{ present: boolean }>(`
      select exists (
        select 1
        from source_intake_records
        where workspace_id = $1
          and project_id = $2
          and source_id = $3
          and source_version = $4
      ) as present
    `, [
      input.workspaceId,
      input.projectId,
      input.sourceId,
      input.sourceVersion,
    ]);
    const before = await sourceUsage(database, config, input);
    if (!duplicate.rows[0]?.present) {
      if (before.admittedCount >= before.maximumCount) {
        throw new EvaluatorLimitError(
          "SOURCE_UPLOAD_LIMIT_REACHED",
          "The project source-upload count limit is reached",
        );
      }
      if (before.admittedBytes + input.byteLength > before.maximumBytes) {
        throw new EvaluatorLimitError(
          "SOURCE_UPLOAD_BYTES_LIMIT_REACHED",
          "The project source-upload byte limit is reached",
        );
      }
    }
    const value = await work();
    const after = await sourceUsage(database, config, input);
    await client.query("commit");
    return Object.freeze({ value, state: after });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof EvaluatorLimitError) throw error;
    throw new EvaluatorLimitError(
      "EVALUATOR_ADMISSION_UNAVAILABLE",
      "Source admission could not be serialized",
    );
  } finally {
    client.release();
  }
}

export async function withAnalysisAdmission<T>(
  database: ProtocolDatabase,
  config: EvaluatorLimitConfig,
  input: AnalysisAdmission,
  work: (decision: AnalysisAdmissionDecision) => Promise<T>,
): Promise<T> {
  validateAnalysisScope(input);
  const client = await database.pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '130s'");
    // All analysis writers use the same subject/project lock and keep it until
    // the immutable run commits. This is the no-migration concurrency invariant.
    await client.query(
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))",
      [
        `scopeledger:evaluator:analysis:${database.schema}:${input.logicalWorkspaceId}:${input.logicalProjectId}:${input.subjectDigest}`,
      ],
    );
    const state = await analysisUsage(database, config, input);
    if (state.blocked) {
      throw new EvaluatorLimitError(
        "ANALYSIS_RUN_LIMIT_REACHED",
        "The subject/project analysis-run limit is reached",
      );
    }
    const value = await work(Object.freeze({
      modelDispatchAllowed: input.mode !== "gemini" || !state.modelBlocked,
      state,
    }));
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof EvaluatorLimitError) throw error;
    throw new EvaluatorLimitError(
      "EVALUATOR_ADMISSION_UNAVAILABLE",
      "Analysis admission could not be serialized",
    );
  } finally {
    client.release();
  }
}
