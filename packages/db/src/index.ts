import { randomBytes } from "node:crypto";
import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { ColumnType, Generated, Transaction } from "kysely";
import { migration001 } from "./migrations/001-ordered-consent.js";
import { migration002 } from "./migrations/002-runtime-persistence.js";
import { migration003 } from "./migrations/003-analysis-persistence.js";
import { migration004 } from "./migrations/004-authoring-foundation.js";
import { migration005 } from "./migrations/005-commercial-publication.js";
import { migration006 } from "./migrations/006-provider-baseline-confirmation.js";
import { migration007 } from "./migrations/007-provider-reconciliation.js";
import { migration008 } from "./migrations/008-client-review-drafts.js";
import { migration009 } from "./migrations/009-notification-outbox.js";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;
interface Scope { workspace_id: string; project_id: string }
export interface Database {
  workspaces: { id: string; merchant_id: string; environment: "sandbox" | "live" };
  projects: { workspace_id: string; id: string; client_id: string; approver_id: string; nomination_epoch: Generated<number>; context_revision: Generated<number>; provider_display_name: Generated<string | null>; provider_created_by: Generated<string | null>; provider_created_at: Generated<Date | null>; provider_initial_client_id: Generated<string | null>; provider_initial_approver_id: Generated<string | null>; provider_creation_digest: Generated<string | null> };
  grants: Scope & { actor_id: string; action: string; epoch: Generated<number>; active: Generated<boolean> };
  packets: Scope & { id: string; provider_title: Generated<string | null>; provider_created_by: Generated<string | null>; provider_created_at: Generated<Date | null>; provider_creation_digest: Generated<string | null> };
  units: Scope & { id: string; packet_id: string; current_version: number | null; accepted_version: number | null };
  unit_versions: Scope & { unit_id: string; version: number; snapshot: Json; canonical_bytes: Buffer; digest: string; published_by: string; published_at: Timestamp };
  decisions: Scope & { unit_id: string; version: number; decision: "approve" | "decline"; actor_id: string; nomination_epoch: number; digest: string; attestation: Json; resolution: Json; recorded_at: Timestamp };
  obligations: Scope & { id: string; unit_id: string; version: number; family_id: string; merchant_id: string; environment: string; currency: string; gross: string; collectible: Generated<boolean>; replaces_id: string | null };
  attempts: Scope & { id: string; obligation_id: string; initiated_by: string; payer_epoch: number; nomination_epoch: number; state: string; order_id: string | null; resolved_at: Timestamp | null; capture_forbidden: Generated<boolean>; created_at: Timestamp };
  operations: Scope & { id: string; attempt_id: string; kind: "create" | "capture"; request: Json; request_hash: string; provider_key: string; state: string; lease_token: string | null; lease_generation: Generated<number>; lease_expires_at: Timestamp | null; admitted_at: Timestamp | null; admission: Json; result: Json; created_at: Timestamp };
  access_challenges: Scope & { id: string; recipient_reference: string; role: "client-approver" | "payer"; code_digest: string; issued_at: Timestamp; expires_at: Timestamp; attempts: Generated<number>; status: Generated<"active" | "verified" | "superseded">; verified_at: Timestamp | null };
  paypal_webhook_receipts: { workspace_id: string; environment: "sandbox" | "live"; merchant_id: string; event_id: string; event_type: string; resource_type: string; resource_id: string | null; resource_status: string | null; provider_created_at: Timestamp; received_at: Timestamp; verification_reference: string };
  paypal_approval_links: Scope & { operation_id: string; order_id: string; approval_url: string; stored_at: Timestamp };
  analysis_scopes: Scope & { purpose: "synthetic-provider-analysis"; created_at: Timestamp };
  analysis_source_identities: Scope & { source_id: string; source_kind: "provider-upload"; created_at: Timestamp };
  analysis_source_versions: Scope & { source_id: string; version_id: string; exact_text: string; exact_text_digest: string; parser_reference: string; extraction_status: "complete" | "partial"; declared_byte_length: number; declared_page_count: number; extracted_page_count: number; code_point_count: number; record_digest: string; recorded_at: Timestamp };
  analysis_source_provenance: Scope & { source_id: string; version_id: string; origin: "other"; supplied_by: "authenticated-provider"; content_attestation: "synthetic-or-permitted"; attested_at: Timestamp };
  analysis_source_permissions: Scope & { source_id: string; version_id: string; studio_sharing: "permitted"; model_processing: "permitted" | "denied"; model_input_review: "cleared" | "not-reviewed"; reviewed_by_subject_digest: string | null; reviewed_at: Timestamp | null };
  analysis_source_coverage: Scope & { source_id: string; version_id: string; page_number: number; status: "extracted" | "unavailable"; start_offset: number | null; end_offset: number | null; reason_code: "parser-reported-unavailable" | null };
  analysis_runs: Scope & { run_id: string; requested_by_subject_digest: string; source_id: string; source_version_id: string; provider_reference: "manual" | "google-gemini"; model_reference: string | null; candidate_schema_reference: "scopeledger.analysis-candidates.v1"; config_reference: "scopeledger.analysis.manual.v1" | "scopeledger.gemini.server-config.v1"; status: "manual-review-ready" | "candidate-ready" | "model-failed"; candidate_payload: Json | null; candidate_digest: string | null; failure_code: string | null; failure_message: string | null; human_review_required: true; publication_blocked: true; run_digest: string; created_at: Timestamp };
  analysis_human_reviews: Scope & { review_id: string; run_id: string; reviewer_subject_digest: string; reviewed_at: Timestamp; disposition: "accept" | "edit" | "reject" | "manual"; note: string; run_basis_digest: string; candidate_basis_digest: string | null };
  source_intake_records: Scope & { source_id: string; source_version: number; source_kind: "provider-upload" | "provider-note" | "client-supplied" | "external-reference"; media_type: string; original_name: string | null; declared_byte_length: number; content_digest: string | null; provenance_origin: "agreement" | "amendment" | "correspondence" | "request" | "prior-decision" | "correction" | "other"; supplied_by: string; origin_reference: string | null; acceptance_kind: "provider-attested-import" | "in-app-record-reference" | "unverified"; acceptance_basis: string; studio_sharing: "permitted" | "denied" | "unresolved"; model_processing: "permitted" | "denied" | "unresolved"; model_input_review_status: "cleared" | "not-reviewed" | "unresolved" | "prohibited-financial-data"; model_reviewed_by: string | null; model_reviewed_at: Timestamp | null; model_review_basis: string; recorded_at: Timestamp; record_digest: string };
  provider_authoring_draft_versions: Scope & { request_id: string; unit_id: string; revision: number; state: "in-progress" | "ready-for-client-review"; title: string; summary: string; scope_items: Json; exclusion_items: Json; source_count: number; draft_digest: string; authored_by: string; created_at: Timestamp };
  provider_authoring_draft_sources: Scope & { unit_id: string; draft_revision: number; position: number; source_id: string; source_version: number };
  provider_commercial_preparations: Scope & {
    preparation_id: string; revision: number; request_id: string; unit_id: string;
    draft_revision: number; draft_digest: string;
    treatment: "included" | "waived" | "payable" | "unresolved";
    independence_explanation: string; client_visible_rationale: string;
    delivery_description: string; payment_explanation: string;
    consent_requirement: "required" | "not-required" | "not-applicable";
    payment_policy: "full-prepayment" | "not-required";
    currency: "USD" | null; subtotal: string | null;
    tax_treatment: "none" | "exclusive" | "inclusive" | "not-applicable" | "unresolved";
    tax_amount: string; tax_declaration: string; gross: string | null;
    merchant_id: string; environment: "sandbox" | "live"; client_id: string;
    approver_id: string; nomination_epoch: number; context_revision: number;
    expected_previous_version: number | null;
    publication_readiness: "ready" | "blocked" | "not-applicable";
    source_count: number; baseline_count: number; dependency_count: number;
    delivery_dependency_count: number; prerequisite_count: number; line_count: number;
    prepared_by: string; prepared_at: Timestamp; request_digest: string;
    preparation_digest: string;
  };
  provider_commercial_preparation_sources: Scope & {
    preparation_id: string; unit_id: string; draft_revision: number; position: number;
    source_id: string; source_version: number; source_record_digest: string;
    locator: string; materiality: "material" | "supporting";
    coverage_status: "covered" | "unresolved";
    analysis_status: "not-used" | "human-reviewed" | "model-output-reviewed" | "unresolved";
    analysis_reference: string | null; explanation: string;
  };
  provider_commercial_preparation_baselines: Scope & {
    preparation_id: string; position: number; baseline_id: string; baseline_version: number;
  };
  provider_commercial_preparation_dependencies: Scope & {
    preparation_id: string; unit_id: string; position: number;
    dependency_unit_id: string; explanation: string;
  };
  provider_commercial_preparation_delivery_dependencies: Scope & {
    preparation_id: string; position: number; description: string;
  };
  provider_commercial_preparation_prerequisites: Scope & {
    preparation_id: string; position: number; prerequisite_id: string;
    prerequisite_version: number; description: string;
    blocks: "payment" | "start" | "payment-and-start";
  };
  provider_commercial_preparation_lines: Scope & {
    preparation_id: string; position: number; line_id: string; description: string;
    quantity: number; unit_price: string; amount: string;
  };
  provider_publication_provenance: Scope & {
    preparation_id: string; publication_command_id: string; unit_id: string;
    version: number; digest: string; published_by: string; published_at: Timestamp;
  };
  provider_baseline_confirmations: Scope & {
    baseline_id: string; baseline_version: number; request_id: string;
    source_id: string; source_version: number; source_record_digest: string;
    acceptance_kind: "provider-attested-import"; acceptance_basis: string;
    studio_sharing: "permitted"; confirmed_by: string; confirmed_at: Timestamp;
    confirmation_digest: string;
  };
  client_questions: Scope & { question_id: string; request_id: string; unit_id: string; unit_version: number; asked_by: string; exact_text: string; model_processing: "permitted" | "denied"; communication_effect: Generated<"communication-only">; asked_at: Timestamp; record_digest: string };
  provider_question_responses: Scope & { question_id: string; revision: number; command_id: string; request_digest: string; status: "answered" | "needs-client-information" | "closed"; response_text: string; responded_by: string; responded_at: Timestamp; record_digest: string };
  provider_reconciliation_assessments: Scope & { concern_id: string; assessment_revision: number; command_id: string; request_digest: string; applicability: "no-material-change" | "material-change" | "needs-information"; request_id: string; unit_id: string; unit_version: number; unit_digest: string; response_revision: number; provider_response: string; source_review: string; assessed_by: string; assessed_at: Timestamp; draft_revision: number | null; draft_digest: string | null; record_digest: string };
  client_review_drafts: Scope & {
    request_id: string;
    unit_id: string;
    participant_subject_digest: string;
    actor_id: string;
    nomination_epoch: number;
    kind: "question" | "correction";
    revision: number;
    exact_text: string;
    correction_source_text: string | null;
    model_processing: "permitted" | "denied";
    draft_digest: string;
    created_at: Timestamp;
    updated_at: Timestamp;
    expires_at: Timestamp;
  };
  notification_outbox: Scope & {
    id: string;
    purpose: string;
    recipient_role: string;
    attributed_actor_id: string;
    source_kind: string;
    source_key: string;
    dedupe_key: string;
    payload: Json;
    status: Generated<string>;
    max_attempts: Generated<number>;
    attempt_count: Generated<number>;
    available_at: Generated<Date>;
    enqueued_at: Generated<Date>;
    lease_token: string | null;
    lease_owner: string | null;
    lease_expires_at: Timestamp | null;
    last_attempt_at: Timestamp | null;
    last_error_code: string | null;
    delivered_at: Timestamp | null;
    terminal_at: Timestamp | null;
  };
  notification_delivery_attempts: {
    notification_id: string;
    attempt_number: number;
    lease_token: string;
    worker_id: string;
    started_at: Timestamp;
    completed_at: Timestamp | null;
    outcome: string | null;
    error_code: string | null;
  };
  notification_delivery_receipts: {
    notification_id: string;
    message_id: string;
    transport: "mailpit";
    status: "reserved" | "delivered";
    reserved_at: Timestamp;
    delivered_at: Timestamp | null;
  };
}
export type ProtocolTransaction = Transaction<Database>;
export type SqlExecutor = Kysely<Database> | ProtocolTransaction;

export function validateSchemaName(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema) || schema === "public"
      || schema === "information_schema" || schema.startsWith("pg_")) {
    throw new Error("Unsafe protocol schema name");
  }
  return schema;
}

export function newProofSchema(): string {
  return `ip01_${randomBytes(12).toString("hex")}`;
}

export function validateProofSchema(schema: string): string {
  if (!/^ip01_[a-f0-9]{24}$/.test(schema)) throw new Error("Expected an isolated generated IP-01 schema");
  return schema;
}

function retryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "40001" || error.code === "40P01");
}

function validateConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("Protocol database requires a valid PostgreSQL connection URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Protocol database requires a PostgreSQL connection URL");
  }
  for (const key of url.searchParams.keys()) {
    if (["options", "search_path", "searchpath", "schema"].includes(key.trim().toLowerCase())) {
      throw new Error("Connection URL cannot override protocol session namespace settings");
    }
  }
  return connectionString;
}

export class ProtocolDatabase {
  readonly pool: pg.Pool;
  readonly kysely: Kysely<Database>;
  readonly schema: string;

  constructor(options: { connectionString: string; schema: string; maxConnections?: number }) {
    this.schema = validateSchemaName(options.schema);
    this.pool = new pg.Pool({
      connectionString: validateConnectionString(options.connectionString),
      max: options.maxConnections ?? 12,
      options: `-csearch_path=${this.schema},pg_catalog,pg_temp -cstatement_timeout=15000 -clock_timeout=10000`,
    });
    this.kysely = new Kysely<Database>({ dialect: new PostgresDialect({ pool: this.pool }) });
  }

  /** Only database serialization/deadlock failures retry; callbacks must contain database work only. */
  async transaction<T>(work: (transaction: ProtocolTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.kysely.transaction().setIsolationLevel("read committed").execute(async (transaction) => {
          const target = await sql<{ present: boolean }>`select exists (
            select 1 from pg_catalog.pg_namespace where nspname = ${this.schema}
          ) as present`.execute(transaction);
          if (!target.rows[0]?.present) throw new Error("Dedicated protocol target schema does not exist");
          // SET LOCAL defeats a pooled session's prior SET without leaking settings on release.
          await sql`select pg_catalog.set_config('search_path', ${`"${this.schema}", pg_catalog, pg_temp`}, true)`.execute(transaction);
          const active = await sql<{ schema: string | null }>`select pg_catalog.current_schema() as schema`.execute(transaction);
          if (active.rows[0]?.schema !== this.schema) throw new Error("Dedicated protocol target schema is not accessible");
          return work(transaction);
        });
      } catch (error) {
        if (!retryable(error) || attempt >= 3) throw error;
      }
    }
  }

  async migrate(): Promise<void> {
    await this.transaction(async (transaction) => {
      await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(${`scopeledger-migrate:${this.schema}`}))`.execute(transaction);
      const exists = await sql<{ present: boolean }>`select pg_catalog.to_regclass(${`${this.schema}.schema_migrations`}) is not null as present`.execute(transaction);
      let applied: number[] = [];
      if (exists.rows[0]?.present) {
        applied = (await sql<{ version: number }>`
          select version from ${sql.table(`${this.schema}.schema_migrations`)} order by version
        `.execute(transaction)).rows.map((row) => row.version);
        if (applied.length === 0) throw new Error("Unsupported protocol migration history");
      } else {
        const relations = await sql<{ name: string }>`
          select c.relname as name
          from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = ${this.schema}
            and c.relkind in ('r','p','v','m','S','f')
          limit 1
        `.execute(transaction);
        if (relations.rows.length) throw new Error("Unsupported protocol migration history");
      }
      const migrations = [
        { version: 1, source: migration001 },
        { version: 2, source: migration002 },
        { version: 3, source: migration003 },
        { version: 4, source: migration004 },
        { version: 5, source: migration005 },
        { version: 6, source: migration006 },
        { version: 7, source: migration007 },
        { version: 8, source: migration008 },
        { version: 9, source: migration009 },
      ] as const;
      if (applied.some((version, index) => version !== index + 1)
          || applied.length > migrations.length) {
        throw new Error("Unsupported protocol migration history");
      }
      for (const migration of migrations.slice(applied.length)) {
        await sql.raw(migration.source).execute(transaction);
        const recorded = await sql<{ present: boolean }>`
          select exists (
            select 1 from ${sql.table(`${this.schema}.schema_migrations`)}
            where version = ${migration.version}
          ) as present
        `.execute(transaction);
        if (!recorded.rows[0]?.present) {
          throw new Error(`Reviewed migration ${migration.version} did not record its version`);
        }
      }
    });
  }

  async close(): Promise<void> {
    await this.kysely.destroy();
  }
}

/** Schema creation/drop is restricted to freshly generated proof namespaces, never public data. */
export async function createIsolatedProofDatabase(connectionString: string): Promise<{
  database: ProtocolDatabase; schema: string; dispose: () => Promise<void>;
}> {
  const schema = newProofSchema();
  const database = new ProtocolDatabase({ connectionString, schema });
  await sql.raw(`CREATE SCHEMA "${validateProofSchema(schema)}"`).execute(database.kysely);
  try {
    await database.migrate();
  } catch (error) {
    await sql.raw(`DROP SCHEMA "${validateProofSchema(schema)}" CASCADE`).execute(database.kysely);
    await database.close();
    throw error;
  }
  return {
    database, schema,
    dispose: async () => {
      try {
        await sql.raw(`DROP SCHEMA "${validateProofSchema(schema)}" CASCADE`).execute(database.kysely);
      } finally {
        await database.close();
      }
    },
  };
}

export {
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  sql,
};
export * from "./runtime-persistence.js";
export * from "./analysis-persistence.js";
export * from "./authoring-foundation.js";
export * from "./commercial-publication.js";
export * from "./provider-baseline.js";
export * from "./client-review-drafts.js";
export * from "./notification-persistence.js";
