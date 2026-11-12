import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { ProtocolTransaction, SqlExecutor } from "./index.js";

type Scope = Readonly<{ workspaceId: string; projectId: string }>;

export type ProviderBaselineConfirmationRecord = Scope & Readonly<{
  baselineId: string;
  baselineVersion: number;
  requestId: string;
  sourceId: string;
  sourceVersion: number;
  sourceRecordDigest: string;
  acceptanceKind: "provider-attested-import";
  acceptanceBasis: string;
  studioSharing: "permitted";
  confirmedBy: string;
  confirmedAt: Date;
  confirmationDigest: string;
}>;

export type ProviderBaselineErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "STALE_SOURCE"
  | "SOURCE_NOT_CONFIRMABLE"
  | "BASELINE_CONFLICT";

export class ProviderBaselineError extends Error {
  constructor(
    public readonly code: ProviderBaselineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderBaselineError";
  }
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;

function fail(code: ProviderBaselineErrorCode, message: string): never {
  throw new ProviderBaselineError(code, message);
}

function identifier(value: string, name: string): string {
  if (!identifierPattern.test(value)) fail("INVALID_INPUT", `${name} is invalid`);
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function baselineId(input: Scope & { sourceId: string }): string {
  return `baseline_${digest([
    input.workspaceId,
    input.projectId,
    input.sourceId,
  ]).slice(0, 48)}`;
}

export async function readProviderBaselineConfirmation(
  executor: SqlExecutor,
  input: Scope & Readonly<{
    sourceId: string;
    sourceVersion: number;
  }>,
): Promise<ProviderBaselineConfirmationRecord | null> {
  const row = (await sql<{
    workspace_id: string;
    project_id: string;
    baseline_id: string;
    baseline_version: number;
    request_id: string;
    source_id: string;
    source_version: number;
    source_record_digest: string;
    acceptance_kind: "provider-attested-import";
    acceptance_basis: string;
    studio_sharing: "permitted";
    confirmed_by: string;
    confirmed_at: Date;
    confirmation_digest: string;
  }>`select workspace_id,project_id,baseline_id,baseline_version,request_id,
      source_id,source_version,source_record_digest,acceptance_kind,
      acceptance_basis,studio_sharing,confirmed_by,confirmed_at,
      confirmation_digest
    from provider_baseline_confirmations
    where workspace_id = ${input.workspaceId}
      and project_id = ${input.projectId}
      and source_id = ${input.sourceId}
      and source_version = ${input.sourceVersion}`.execute(executor)).rows[0];
  return row ? Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    baselineId: row.baseline_id,
    baselineVersion: row.baseline_version,
    requestId: row.request_id,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sourceRecordDigest: row.source_record_digest,
    acceptanceKind: row.acceptance_kind,
    acceptanceBasis: row.acceptance_basis,
    studioSharing: row.studio_sharing,
    confirmedBy: row.confirmed_by,
    confirmedAt: new Date(row.confirmed_at),
    confirmationDigest: row.confirmation_digest,
  }) : null;
}

export async function confirmProviderBaseline(
  transaction: ProtocolTransaction,
  input: Scope & Readonly<{
    requestId: string;
    sourceId: string;
    sourceVersion: number;
    confirmedBy: string;
  }>,
): Promise<Readonly<{
  duplicate: boolean;
  confirmation: ProviderBaselineConfirmationRecord;
}>> {
  const target = {
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    projectId: identifier(input.projectId, "projectId"),
    requestId: identifier(input.requestId, "requestId"),
    sourceId: identifier(input.sourceId, "sourceId"),
    sourceVersion: input.sourceVersion,
    confirmedBy: identifier(input.confirmedBy, "confirmedBy"),
  };
  if (!Number.isSafeInteger(target.sourceVersion) || target.sourceVersion < 1) {
    fail("INVALID_INPUT", "sourceVersion is invalid");
  }
  await sql`select pg_advisory_xact_lock(hashtextextended(
    ${`${target.workspaceId}/${target.projectId}/baseline/${target.sourceId}`},0
  ))`.execute(transaction);

  const request = await sql`select 1 from packets
    where workspace_id = ${target.workspaceId}
      and project_id = ${target.projectId}
      and id = ${target.requestId}
    for key share`.execute(transaction);
  if (!request.rows.length) fail("NOT_FOUND", "The scoped request was not found");

  const source = (await sql<{
    availability: "available" | "unavailable";
    record_digest: string;
    acceptance_kind:
      | "provider-attested-import"
      | "in-app-record-reference"
      | "unverified";
    acceptance_basis: string;
    studio_sharing: "permitted" | "denied" | "unresolved";
    provider_creation_digest: string | null;
    latest_version: number;
  }>`select sv.availability,sir.record_digest,sir.acceptance_kind,
      sir.acceptance_basis,sir.studio_sharing,p.provider_creation_digest,
      (
        select max(newer.version)::integer
        from source_versions newer
        where newer.workspace_id = sv.workspace_id
          and newer.project_id = sv.project_id
          and newer.id = sv.id
      ) as latest_version
    from source_versions sv
    join source_intake_records sir
      on sir.workspace_id = sv.workspace_id
      and sir.project_id = sv.project_id
      and sir.source_id = sv.id
      and sir.source_version = sv.version
    join projects p
      on p.workspace_id = sv.workspace_id
      and p.id = sv.project_id
    where sv.workspace_id = ${target.workspaceId}
      and sv.project_id = ${target.projectId}
      and sv.id = ${target.sourceId}
      and sv.version = ${target.sourceVersion}
    for key share of sv,sir,p`.execute(transaction)).rows[0];
  if (!source) fail("NOT_FOUND", "The exact admitted source was not found");
  if (source.latest_version !== target.sourceVersion) {
    fail("STALE_SOURCE", "A newer immutable source version exists");
  }
  if (
    source.provider_creation_digest === null
    || source.availability !== "available"
    || source.acceptance_kind !== "provider-attested-import"
    || source.studio_sharing !== "permitted"
  ) {
    fail(
      "SOURCE_NOT_CONFIRMABLE",
      "The source is unavailable or lacks confirmed provider import and sharing permission",
    );
  }

  const existing = await readProviderBaselineConfirmation(transaction, target);
  if (existing) {
    return Object.freeze({ duplicate: true, confirmation: existing });
  }

  const id = baselineId(target);
  const version = target.sourceVersion;
  const conflicting = await sql`select 1 from baseline_versions
    where workspace_id = ${target.workspaceId}
      and project_id = ${target.projectId}
      and id = ${id}
      and version = ${version}
    for key share`.execute(transaction);
  if (conflicting.rows.length) {
    fail(
      "BASELINE_CONFLICT",
      "The server-owned baseline identity already exists without matching confirmation",
    );
  }
  const confirmationDigest = digest({
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    baselineId: id,
    baselineVersion: version,
    requestId: target.requestId,
    sourceId: target.sourceId,
    sourceVersion: target.sourceVersion,
    sourceRecordDigest: source.record_digest,
    acceptanceKind: source.acceptance_kind,
    acceptanceBasis: source.acceptance_basis,
    studioSharing: source.studio_sharing,
    confirmedBy: target.confirmedBy,
  });
  await sql`insert into baseline_versions(
      workspace_id,project_id,id,version,confirmed_by
    ) values (
      ${target.workspaceId},${target.projectId},${id},${version},
      ${target.confirmedBy}
    )`.execute(transaction);
  await sql`insert into provider_baseline_confirmations(
      workspace_id,project_id,baseline_id,baseline_version,request_id,
      source_id,source_version,source_record_digest,acceptance_kind,
      acceptance_basis,studio_sharing,confirmed_by,confirmation_digest
    ) values (
      ${target.workspaceId},${target.projectId},${id},${version},
      ${target.requestId},${target.sourceId},${target.sourceVersion},
      ${source.record_digest},${source.acceptance_kind},
      ${source.acceptance_basis},${source.studio_sharing},
      ${target.confirmedBy},${confirmationDigest}
    )`.execute(transaction);
  const confirmation = await readProviderBaselineConfirmation(
    transaction,
    target,
  );
  if (!confirmation) {
    fail("BASELINE_CONFLICT", "The baseline confirmation was not stored");
  }
  return Object.freeze({ duplicate: false, confirmation });
}
