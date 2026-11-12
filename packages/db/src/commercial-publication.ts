import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { ProtocolTransaction, SqlExecutor } from "./index.js";

type Scope = Readonly<{ workspaceId: string; projectId: string }>;

export type CommercialTreatment =
  | "included"
  | "waived"
  | "payable"
  | "unresolved";
export type CommercialConsentRequirement =
  | "required"
  | "not-required"
  | "not-applicable";
export type CommercialTaxTreatment =
  | "none"
  | "exclusive"
  | "inclusive"
  | "not-applicable"
  | "unresolved";
export type CommercialSourceCoverage = Readonly<{
  sourceId: string;
  version: number;
  locator: string;
  materiality: "material" | "supporting";
  coverageStatus: "covered" | "unresolved";
  analysisStatus:
    | "not-used"
    | "human-reviewed"
    | "model-output-reviewed"
    | "unresolved";
  analysisReference: string | null;
  explanation: string;
}>;
export type CommercialDependency = Readonly<{
  unitId: string;
  explanation: string;
}>;
export type CommercialPrerequisite = Readonly<{
  id: string;
  version: number;
  description: string;
  blocks: "payment" | "start" | "payment-and-start";
}>;
export type CommercialLine = Readonly<{
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
}>;
export type CommercialPrice = Readonly<{
  currency: "USD";
  paymentPolicy: "full-prepayment";
  lines: readonly CommercialLine[];
  subtotal: string;
  gross: string;
}>;
export type CommercialTax = Readonly<{
  treatment: CommercialTaxTreatment;
  amount: string;
  declaration: string;
}>;

export type CommercialPreparationWrite = Scope & Readonly<{
  preparationId: string;
  requestId: string;
  unitId: string;
  draftRevision: number;
  treatment: CommercialTreatment;
  independenceExplanation: string;
  dependencies: readonly CommercialDependency[];
  clientVisibleRationale: string;
  delivery: Readonly<{
    description: string;
    dependencies: readonly string[];
  }>;
  prerequisites: readonly CommercialPrerequisite[];
  consentRequirement: CommercialConsentRequirement;
  paymentExplanation: string;
  tax: CommercialTax;
  price: CommercialPrice | null;
  sourceCoverage: readonly CommercialSourceCoverage[];
  preparedBy: string;
}>;

export type CommercialPreparationRecord = CommercialPreparationWrite & Readonly<{
  revision: number;
  draftDigest: string;
  baselineReferences: readonly Readonly<{ id: string; version: number }>[];
  sourceCoverage: readonly Readonly<
    CommercialSourceCoverage & { sourceRecordDigest: string }
  >[];
  merchantId: string;
  environment: "sandbox" | "live";
  clientId: string;
  approverId: string;
  nominationEpoch: number;
  contextRevision: number;
  expectedPreviousVersion: number | null;
  publicationReadiness: "ready" | "blocked" | "not-applicable";
  preparedAt: Date;
  requestDigest: string;
  preparationDigest: string;
}>;

export type PublicationProvenanceRecord = Scope & Readonly<{
  preparationId: string;
  publicationCommandId: string;
  unitId: string;
  version: number;
  digest: string;
  publishedBy: string;
  publishedAt: Date;
}>;

export type CommercialPreparationErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PREPARATION_CONFLICT"
  | "STALE_DRAFT"
  | "STALE_SOURCE";

export class CommercialPreparationError extends Error {
  constructor(
    public readonly code: CommercialPreparationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommercialPreparationError";
  }
}

type PreparationRow = {
  workspace_id: string;
  project_id: string;
  preparation_id: string;
  revision: number;
  request_id: string;
  unit_id: string;
  draft_revision: number;
  draft_digest: string;
  treatment: CommercialTreatment;
  independence_explanation: string;
  client_visible_rationale: string;
  delivery_description: string;
  payment_explanation: string;
  consent_requirement: CommercialConsentRequirement;
  payment_policy: "full-prepayment" | "not-required";
  currency: "USD" | null;
  subtotal: string | null;
  tax_treatment: CommercialTaxTreatment;
  tax_amount: string;
  tax_declaration: string;
  gross: string | null;
  merchant_id: string;
  environment: "sandbox" | "live";
  client_id: string;
  approver_id: string;
  nomination_epoch: number;
  context_revision: number;
  expected_previous_version: number | null;
  publication_readiness: "ready" | "blocked" | "not-applicable";
  prepared_by: string;
  prepared_at: Date;
  request_digest: string;
  preparation_digest: string;
};

type SourceBasisRow = {
  position: number;
  source_id: string;
  source_version: number;
  source_record_digest: string;
  availability: "available" | "unavailable";
  studio_sharing: "permitted" | "denied" | "unresolved";
  model_processing: "permitted" | "denied" | "unresolved";
  model_input_review_status:
    | "cleared"
    | "not-reviewed"
    | "unresolved"
    | "prohibited-financial-data";
  acceptance_kind:
    | "provider-attested-import"
    | "in-app-record-reference"
    | "unverified";
};

const moneyPattern = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
const MAX_MINOR_UNITS = 999_999_999_999n;

function fail(
  code: CommercialPreparationErrorCode,
  message: string,
): never {
  throw new CommercialPreparationError(code, message);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("INVALID_INPUT", "Canonical number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.some((key) => record[key] === undefined)) {
      fail("INVALID_INPUT", "Canonical value is invalid");
    }
    return `{${keys.map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  fail("INVALID_INPUT", "Canonical value is invalid");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function minorUnits(value: string): bigint {
  if (!moneyPattern.test(value)) fail("INVALID_INPUT", "Exact USD money is invalid");
  const result = BigInt(value.replace(".", ""));
  if (result > MAX_MINOR_UNITS) fail("INVALID_INPUT", "Exact USD money exceeds the bound");
  return result;
}

function validateFinancialTerms(input: CommercialPreparationWrite): void {
  const tax = minorUnits(input.tax.amount);
  if (input.treatment !== "payable") {
    if (
      input.price !== null
      || tax !== 0n
      || (input.treatment !== "unresolved"
        && input.tax.treatment !== "not-applicable")
      || (input.treatment === "unresolved"
        && input.tax.treatment !== "not-applicable"
        && input.tax.treatment !== "unresolved")
      || (input.treatment === "waived"
        && input.consentRequirement === "not-applicable")
      || (input.treatment !== "waived"
        && input.consentRequirement !== "not-applicable")
    ) {
      fail("INVALID_INPUT", "Non-payable treatment has inconsistent commercial terms");
    }
    return;
  }
  const price = input.price;
  if (
    !price
    || input.consentRequirement !== "required"
    || !["none", "exclusive", "inclusive"].includes(input.tax.treatment)
    || price.currency !== "USD"
    || price.paymentPolicy !== "full-prepayment"
    || price.lines.length < 1
    || price.lines.length > 100
  ) {
    fail("INVALID_INPUT", "Payable treatment requires exact price, tax, consent, and payment terms");
  }
  let subtotal = 0n;
  const lineIds = new Set<string>();
  for (const line of price.lines) {
    if (lineIds.has(line.id)) fail("INVALID_INPUT", "Commercial line identity is duplicated");
    lineIds.add(line.id);
    if (!/^[1-9][0-9]{0,5}$/.test(line.quantity)) {
      fail("INVALID_INPUT", "Commercial line quantity is invalid");
    }
    const quantity = BigInt(line.quantity);
    const expected = minorUnits(line.unitPrice) * quantity;
    if (
      expected === 0n
      || expected > MAX_MINOR_UNITS
      || expected !== minorUnits(line.amount)
    ) {
      fail("INVALID_INPUT", "Commercial line arithmetic is invalid");
    }
    subtotal += expected;
  }
  const declaredSubtotal = minorUnits(price.subtotal);
  const gross = minorUnits(price.gross);
  const expectedGross = input.tax.treatment === "exclusive"
    ? declaredSubtotal + tax
    : declaredSubtotal;
  if (
    subtotal !== declaredSubtotal
    || subtotal > MAX_MINOR_UNITS
    || gross <= 0n
    || gross !== expectedGross
    || expectedGross > MAX_MINOR_UNITS
    || (input.tax.treatment === "none" && tax !== 0n)
    || (input.tax.treatment === "inclusive" && tax > declaredSubtotal)
  ) {
    fail("INVALID_INPUT", "Commercial subtotal, tax, or gross is invalid");
  }
}

function requestIdentity(input: CommercialPreparationWrite) {
  return {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    preparationId: input.preparationId,
    requestId: input.requestId,
    unitId: input.unitId,
    draftRevision: input.draftRevision,
    treatment: input.treatment,
    independenceExplanation: input.independenceExplanation,
    dependencies: input.dependencies,
    clientVisibleRationale: input.clientVisibleRationale,
    delivery: input.delivery,
    prerequisites: input.prerequisites,
    consentRequirement: input.consentRequirement,
    paymentExplanation: input.paymentExplanation,
    tax: input.tax,
    price: input.price,
    sourceCoverage: input.sourceCoverage,
    preparedBy: input.preparedBy,
  };
}

function sourceIsBlocked(
  source: SourceBasisRow,
  coverage: CommercialSourceCoverage,
): boolean {
  return coverage.materiality === "material" && (
    coverage.coverageStatus !== "covered"
    || coverage.analysisStatus === "unresolved"
    || source.availability !== "available"
    || source.studio_sharing !== "permitted"
    || source.acceptance_kind === "unverified"
    || (
      coverage.analysisStatus === "model-output-reviewed"
      && (
        source.model_processing !== "permitted"
        || source.model_input_review_status !== "cleared"
      )
    )
  );
}

export async function saveCommercialPreparation(
  transaction: ProtocolTransaction,
  input: CommercialPreparationWrite,
): Promise<Readonly<{ duplicate: boolean; preparation: CommercialPreparationRecord }>> {
  validateFinancialTerms(input);
  const requestDigest = digest(requestIdentity(input));
  await sql`select pg_advisory_xact_lock(hashtextextended(
    ${`${input.workspaceId}/${input.projectId}/commercial/${input.preparationId}`},0
  ))`.execute(transaction);
  const existing = await readCommercialPreparation(transaction, input);
  if (existing) {
    if (existing.requestDigest !== requestDigest) {
      fail(
        "PREPARATION_CONFLICT",
        "The scoped preparation identity already has different content",
      );
    }
    return Object.freeze({ duplicate: true, preparation: existing });
  }

  const basis = (await sql<{
    client_id: string;
    approver_id: string;
    nomination_epoch: number;
    context_revision: number;
    merchant_id: string;
    environment: "sandbox" | "live";
    packet_id: string;
    current_version: number | null;
  }>`select p.client_id,p.approver_id,p.nomination_epoch,p.context_revision,
        w.merchant_id,w.environment,u.packet_id,u.current_version
      from projects p
      join workspaces w on w.id = p.workspace_id
      join units u
        on u.workspace_id = p.workspace_id
        and u.project_id = p.id
        and u.id = ${input.unitId}
      where p.workspace_id = ${input.workspaceId}
        and p.id = ${input.projectId}
      for share of p,w
      for update of u`.execute(transaction)).rows[0];
  if (!basis || basis.packet_id !== input.requestId) {
    fail("NOT_FOUND", "The scoped request unit was not found");
  }
  await sql`insert into collection_families(workspace_id,project_id,id)
    values (${input.workspaceId},${input.projectId},${input.unitId})
    on conflict do nothing`.execute(transaction);
  const draft = (await sql<{
    state: "in-progress" | "ready-for-client-review";
    draft_digest: string;
    latest_revision: number;
  }>`select d.state,d.draft_digest,
        (
          select max(d2.revision)::integer
          from provider_authoring_draft_versions d2
          where d2.workspace_id = d.workspace_id
            and d2.project_id = d.project_id
            and d2.unit_id = d.unit_id
        ) as latest_revision
      from provider_authoring_draft_versions d
      where d.workspace_id = ${input.workspaceId}
        and d.project_id = ${input.projectId}
        and d.unit_id = ${input.unitId}
        and d.revision = ${input.draftRevision}
        and d.request_id = ${input.requestId}
      for key share`.execute(transaction)).rows[0];
  if (!draft) fail("NOT_FOUND", "The exact immutable draft revision was not found");
  if (
    draft.state !== "ready-for-client-review"
    || draft.latest_revision !== input.draftRevision
  ) {
    fail("STALE_DRAFT", "Commercial preparation requires the latest review-ready draft");
  }

  const draftSources = (await sql<SourceBasisRow>`select ds.position,
        ds.source_id,ds.source_version,sir.record_digest as source_record_digest,
        sv.availability,sir.studio_sharing,sir.model_processing,
        sir.model_input_review_status,sir.acceptance_kind
      from provider_authoring_draft_sources ds
      join source_intake_records sir
        on sir.workspace_id = ds.workspace_id
        and sir.project_id = ds.project_id
        and sir.source_id = ds.source_id
        and sir.source_version = ds.source_version
      join source_versions sv
        on sv.workspace_id = ds.workspace_id
        and sv.project_id = ds.project_id
        and sv.id = ds.source_id
        and sv.version = ds.source_version
      where ds.workspace_id = ${input.workspaceId}
        and ds.project_id = ${input.projectId}
        and ds.unit_id = ${input.unitId}
        and ds.draft_revision = ${input.draftRevision}
      order by ds.position`.execute(transaction)).rows;
  if (
    draftSources.length < 1
    || draftSources.length !== input.sourceCoverage.length
  ) {
    fail("INVALID_INPUT", "Source coverage must exactly cover the draft source inventory");
  }
  for (const [index, source] of draftSources.entries()) {
    const coverage = input.sourceCoverage[index];
    if (
      !coverage
      || coverage.sourceId !== source.source_id
      || coverage.version !== source.source_version
    ) {
      fail("INVALID_INPUT", "Source coverage order must match the exact draft source inventory");
    }
    const latest = (await sql<{ version: number }>`select max(version)::integer as version
      from source_versions
      where workspace_id = ${input.workspaceId}
        and project_id = ${input.projectId}
        and id = ${source.source_id}`.execute(transaction)).rows[0]?.version;
    if (latest !== source.source_version) {
      fail("STALE_SOURCE", "A draft source has a newer immutable version");
    }
  }

  const baselines = (await sql<{ id: string; version: number }>`
    select b.id,b.version
    from baseline_versions b
    join projects p
      on p.workspace_id = b.workspace_id
      and p.id = b.project_id
    where b.workspace_id = ${input.workspaceId}
      and b.project_id = ${input.projectId}
      and (
        p.provider_creation_digest is null
        or exists (
          select 1 from provider_baseline_confirmations c
          where c.workspace_id = b.workspace_id
            and c.project_id = b.project_id
            and c.baseline_id = b.id
            and c.baseline_version = b.version
        )
      )
    order by b.id collate "C",b.version
  `.execute(transaction)).rows;
  if (baselines.length < 1 || baselines.length > 100) {
    fail("INVALID_INPUT", "Commercial publication requires bounded confirmed baselines");
  }

  if (new Set(input.dependencies.map((entry) => entry.unitId)).size
      !== input.dependencies.length) {
    fail("INVALID_INPUT", "Commercial dependency identity is duplicated");
  }
  for (const dependency of input.dependencies) {
    if (dependency.unitId === input.unitId) {
      fail("INVALID_INPUT", "A commercial unit cannot depend on itself");
    }
    const found = await sql`select 1 from units
      where workspace_id = ${input.workspaceId}
        and project_id = ${input.projectId}
        and id = ${dependency.unitId}
      for key share`.execute(transaction);
    if (!found.rows.length) fail("NOT_FOUND", "A commercial dependency was not found");
  }

  const revision = ((await sql<{ revision: number | null }>`
    select max(revision)::integer as revision
    from provider_commercial_preparations
    where workspace_id = ${input.workspaceId}
      and project_id = ${input.projectId}
      and unit_id = ${input.unitId}
  `.execute(transaction)).rows[0]?.revision ?? 0) + 1;
  const materialBlocked = draftSources.some((source, index) =>
    sourceIsBlocked(source, input.sourceCoverage[index]!));
  const publicationReadiness = input.treatment === "included"
    ? "not-applicable" as const
    : input.treatment === "unresolved" || materialBlocked
      ? "blocked" as const
      : "ready" as const;
  const serverBasis = {
    revision,
    draftDigest: draft.draft_digest,
    baselineReferences: baselines,
    sourceRecordDigests: draftSources.map((source) => ({
      sourceId: source.source_id,
      version: source.source_version,
      digest: source.source_record_digest,
    })),
    merchantId: basis.merchant_id,
    environment: basis.environment,
    clientId: basis.client_id,
    approverId: basis.approver_id,
    nominationEpoch: basis.nomination_epoch,
    contextRevision: basis.context_revision,
    expectedPreviousVersion: basis.current_version,
    publicationReadiness,
  };
  const preparationDigest = digest({
    request: requestIdentity(input),
    serverBasis,
  });
  const price = input.price;
  await sql`insert into provider_commercial_preparations(
      workspace_id,project_id,preparation_id,revision,request_id,unit_id,
      draft_revision,draft_digest,treatment,independence_explanation,
      client_visible_rationale,delivery_description,payment_explanation,
      consent_requirement,payment_policy,currency,subtotal,tax_treatment,
      tax_amount,tax_declaration,gross,merchant_id,environment,client_id,
      approver_id,nomination_epoch,context_revision,expected_previous_version,
      publication_readiness,source_count,baseline_count,dependency_count,
      delivery_dependency_count,prerequisite_count,line_count,prepared_by,
      request_digest,preparation_digest
    ) values (
      ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
      ${revision},${input.requestId},${input.unitId},${input.draftRevision},
      ${draft.draft_digest},${input.treatment},
      ${input.independenceExplanation},${input.clientVisibleRationale},
      ${input.delivery.description},${input.paymentExplanation},
      ${input.consentRequirement},
      ${price?.paymentPolicy ?? "not-required"},${price?.currency ?? null},
      ${price?.subtotal ?? null},${input.tax.treatment},${input.tax.amount},
      ${input.tax.declaration},${price?.gross ?? null},${basis.merchant_id},
      ${basis.environment},${basis.client_id},${basis.approver_id},
      ${basis.nomination_epoch},${basis.context_revision},
      ${basis.current_version},${publicationReadiness},
      ${draftSources.length},${baselines.length},${input.dependencies.length},
      ${input.delivery.dependencies.length},${input.prerequisites.length},
      ${price?.lines.length ?? 0},${input.preparedBy},${requestDigest},
      ${preparationDigest}
    )`.execute(transaction);

  for (const [index, coverage] of input.sourceCoverage.entries()) {
    const source = draftSources[index]!;
    await sql`insert into provider_commercial_preparation_sources(
        workspace_id,project_id,preparation_id,unit_id,draft_revision,position,
        source_id,source_version,source_record_digest,locator,materiality,
        coverage_status,analysis_status,analysis_reference,explanation
      ) values (
        ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
        ${input.unitId},${input.draftRevision},${index + 1},
        ${coverage.sourceId},${coverage.version},${source.source_record_digest},
        ${coverage.locator},${coverage.materiality},${coverage.coverageStatus},
        ${coverage.analysisStatus},${coverage.analysisReference},
        ${coverage.explanation}
      )`.execute(transaction);
  }
  for (const [index, baseline] of baselines.entries()) {
    await sql`insert into provider_commercial_preparation_baselines(
        workspace_id,project_id,preparation_id,position,baseline_id,
        baseline_version
      ) values (
        ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
        ${index + 1},${baseline.id},${baseline.version}
      )`.execute(transaction);
  }
  for (const [index, dependency] of input.dependencies.entries()) {
    await sql`insert into provider_commercial_preparation_dependencies(
        workspace_id,project_id,preparation_id,unit_id,position,
        dependency_unit_id,explanation
      ) values (
        ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
        ${input.unitId},${index + 1},${dependency.unitId},
        ${dependency.explanation}
      )`.execute(transaction);
  }
  for (const [index, description] of input.delivery.dependencies.entries()) {
    await sql`insert into provider_commercial_preparation_delivery_dependencies(
        workspace_id,project_id,preparation_id,position,description
      ) values (
        ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
        ${index + 1},${description}
      )`.execute(transaction);
  }
  for (const [index, prerequisite] of input.prerequisites.entries()) {
    await sql`insert into provider_commercial_preparation_prerequisites(
        workspace_id,project_id,preparation_id,position,prerequisite_id,
        prerequisite_version,description,blocks
      ) values (
        ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
        ${index + 1},${prerequisite.id},${prerequisite.version},
        ${prerequisite.description},${prerequisite.blocks}
      )`.execute(transaction);
  }
  for (const [index, line] of (price?.lines ?? []).entries()) {
    await sql`insert into provider_commercial_preparation_lines(
        workspace_id,project_id,preparation_id,position,line_id,description,
        quantity,unit_price,amount
      ) values (
        ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
        ${index + 1},${line.id},${line.description},${Number(line.quantity)},
        ${line.unitPrice},${line.amount}
      )`.execute(transaction);
  }
  const preparation = await readCommercialPreparation(transaction, input);
  if (!preparation) fail("PREPARATION_CONFLICT", "Commercial preparation was not stored");
  return Object.freeze({ duplicate: false, preparation });
}

export async function readCommercialPreparation(
  executor: SqlExecutor,
  input: Scope & { preparationId: string },
): Promise<CommercialPreparationRecord | null> {
  const row = (await sql<PreparationRow>`select workspace_id,project_id,
      preparation_id::text,revision,request_id,unit_id,draft_revision,
      draft_digest,treatment,independence_explanation,
      client_visible_rationale,delivery_description,payment_explanation,
      consent_requirement,payment_policy,currency,subtotal,tax_treatment,
      tax_amount,tax_declaration,gross,merchant_id,environment,client_id,
      approver_id,nomination_epoch,context_revision,expected_previous_version,
      publication_readiness,prepared_by,prepared_at,request_digest,
      preparation_digest
    from provider_commercial_preparations
    where workspace_id = ${input.workspaceId}
      and project_id = ${input.projectId}
      and preparation_id = ${input.preparationId}::uuid`.execute(executor)).rows[0];
  if (!row) return null;
  const [sources, baselines, dependencies, deliveryDependencies, prerequisites, lines] =
    await Promise.all([
      sql<{
        source_id: string; source_version: number; source_record_digest: string;
        locator: string; materiality: "material" | "supporting";
        coverage_status: "covered" | "unresolved";
        analysis_status: CommercialSourceCoverage["analysisStatus"];
        analysis_reference: string | null; explanation: string;
      }>`select source_id,source_version,source_record_digest,locator,
          materiality,coverage_status,analysis_status,analysis_reference,
          explanation
        from provider_commercial_preparation_sources
        where workspace_id = ${input.workspaceId}
          and project_id = ${input.projectId}
          and preparation_id = ${input.preparationId}::uuid
        order by position`.execute(executor),
      sql<{ baseline_id: string; baseline_version: number }>`
        select baseline_id,baseline_version
        from provider_commercial_preparation_baselines
        where workspace_id = ${input.workspaceId}
          and project_id = ${input.projectId}
          and preparation_id = ${input.preparationId}::uuid
        order by position`.execute(executor),
      sql<{ dependency_unit_id: string; explanation: string }>`
        select dependency_unit_id,explanation
        from provider_commercial_preparation_dependencies
        where workspace_id = ${input.workspaceId}
          and project_id = ${input.projectId}
          and preparation_id = ${input.preparationId}::uuid
        order by position`.execute(executor),
      sql<{ description: string }>`select description
        from provider_commercial_preparation_delivery_dependencies
        where workspace_id = ${input.workspaceId}
          and project_id = ${input.projectId}
          and preparation_id = ${input.preparationId}::uuid
        order by position`.execute(executor),
      sql<{
        prerequisite_id: string; prerequisite_version: number;
        description: string; blocks: CommercialPrerequisite["blocks"];
      }>`select prerequisite_id,prerequisite_version,description,blocks
        from provider_commercial_preparation_prerequisites
        where workspace_id = ${input.workspaceId}
          and project_id = ${input.projectId}
          and preparation_id = ${input.preparationId}::uuid
        order by position`.execute(executor),
      sql<{
        line_id: string; description: string; quantity: number;
        unit_price: string; amount: string;
      }>`select line_id,description,quantity,unit_price,amount
        from provider_commercial_preparation_lines
        where workspace_id = ${input.workspaceId}
          and project_id = ${input.projectId}
          and preparation_id = ${input.preparationId}::uuid
        order by position`.execute(executor),
    ]);
  const price = row.payment_policy === "full-prepayment"
    ? Object.freeze({
      currency: "USD" as const,
      paymentPolicy: "full-prepayment" as const,
      lines: Object.freeze(lines.rows.map((line) => Object.freeze({
        id: line.line_id,
        description: line.description,
        quantity: String(line.quantity),
        unitPrice: line.unit_price,
        amount: line.amount,
      }))),
      subtotal: row.subtotal!,
      gross: row.gross!,
    })
    : null;
  return Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    preparationId: row.preparation_id,
    revision: row.revision,
    requestId: row.request_id,
    unitId: row.unit_id,
    draftRevision: row.draft_revision,
    draftDigest: row.draft_digest,
    treatment: row.treatment,
    independenceExplanation: row.independence_explanation,
    dependencies: Object.freeze(dependencies.rows.map((dependency) =>
      Object.freeze({
        unitId: dependency.dependency_unit_id,
        explanation: dependency.explanation,
      }))),
    clientVisibleRationale: row.client_visible_rationale,
    delivery: Object.freeze({
      description: row.delivery_description,
      dependencies: Object.freeze(
        deliveryDependencies.rows.map((entry) => entry.description),
      ),
    }),
    prerequisites: Object.freeze(prerequisites.rows.map((prerequisite) =>
      Object.freeze({
        id: prerequisite.prerequisite_id,
        version: prerequisite.prerequisite_version,
        description: prerequisite.description,
        blocks: prerequisite.blocks,
      }))),
    consentRequirement: row.consent_requirement,
    paymentExplanation: row.payment_explanation,
    tax: Object.freeze({
      treatment: row.tax_treatment,
      amount: row.tax_amount,
      declaration: row.tax_declaration,
    }),
    price,
    sourceCoverage: Object.freeze(sources.rows.map((source) => Object.freeze({
      sourceId: source.source_id,
      version: source.source_version,
      sourceRecordDigest: source.source_record_digest,
      locator: source.locator,
      materiality: source.materiality,
      coverageStatus: source.coverage_status,
      analysisStatus: source.analysis_status,
      analysisReference: source.analysis_reference,
      explanation: source.explanation,
    }))),
    preparedBy: row.prepared_by,
    baselineReferences: Object.freeze(baselines.rows.map((baseline) =>
      Object.freeze({
        id: baseline.baseline_id,
        version: baseline.baseline_version,
      }))),
    merchantId: row.merchant_id,
    environment: row.environment,
    clientId: row.client_id,
    approverId: row.approver_id,
    nominationEpoch: row.nomination_epoch,
    contextRevision: row.context_revision,
    expectedPreviousVersion: row.expected_previous_version,
    publicationReadiness: row.publication_readiness,
    preparedAt: new Date(row.prepared_at),
    requestDigest: row.request_digest,
    preparationDigest: row.preparation_digest,
  });
}

export async function readPublicationProvenance(
  executor: SqlExecutor,
  input: Scope & { preparationId: string },
): Promise<PublicationProvenanceRecord | null> {
  const row = (await sql<{
    workspace_id: string; project_id: string; preparation_id: string;
    publication_command_id: string; unit_id: string; version: number;
    digest: string; published_by: string; published_at: Date;
  }>`select workspace_id,project_id,preparation_id::text,
      publication_command_id::text,unit_id,version,digest,published_by,published_at
    from provider_publication_provenance
    where workspace_id = ${input.workspaceId}
      and project_id = ${input.projectId}
      and preparation_id = ${input.preparationId}::uuid`.execute(executor)).rows[0];
  return row ? Object.freeze({
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    preparationId: row.preparation_id,
    publicationCommandId: row.publication_command_id,
    unitId: row.unit_id,
    version: row.version,
    digest: row.digest,
    publishedBy: row.published_by,
    publishedAt: new Date(row.published_at),
  }) : null;
}

export async function recordPublicationProvenance(
  transaction: ProtocolTransaction,
  input: PublicationProvenanceRecord,
): Promise<void> {
  await sql`insert into provider_publication_provenance(
      workspace_id,project_id,preparation_id,publication_command_id,unit_id,
      version,digest,published_by,published_at
    ) values (
      ${input.workspaceId},${input.projectId},${input.preparationId}::uuid,
      ${input.publicationCommandId}::uuid,${input.unitId},${input.version},
      ${input.digest},${input.publishedBy},${input.publishedAt}
    )`.execute(transaction);
}
