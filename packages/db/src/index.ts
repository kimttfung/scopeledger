import { randomBytes } from "node:crypto";
import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import type { ColumnType, Generated, Transaction } from "kysely";
import { migration001 } from "./migrations/001-ordered-consent.js";
import { migration002 } from "./migrations/002-runtime-persistence.js";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;
interface Scope { workspace_id: string; project_id: string }
export interface Database {
  workspaces: { id: string; merchant_id: string; environment: "sandbox" | "live" };
  projects: { workspace_id: string; id: string; client_id: string; approver_id: string; nomination_epoch: Generated<number>; context_revision: Generated<number> };
  grants: Scope & { actor_id: string; action: string; epoch: Generated<number>; active: Generated<boolean> };
  packets: Scope & { id: string };
  units: Scope & { id: string; packet_id: string; current_version: number | null; accepted_version: number | null };
  unit_versions: Scope & { unit_id: string; version: number; snapshot: Json; canonical_bytes: Buffer; digest: string; published_by: string; published_at: Timestamp };
  decisions: Scope & { unit_id: string; version: number; decision: "approve" | "decline"; actor_id: string; nomination_epoch: number; digest: string; attestation: Json; resolution: Json; recorded_at: Timestamp };
  obligations: Scope & { id: string; unit_id: string; version: number; family_id: string; merchant_id: string; environment: string; currency: string; gross: string; collectible: Generated<boolean>; replaces_id: string | null };
  attempts: Scope & { id: string; obligation_id: string; initiated_by: string; payer_epoch: number; nomination_epoch: number; state: string; order_id: string | null; resolved_at: Timestamp | null; capture_forbidden: Generated<boolean>; created_at: Timestamp };
  operations: Scope & { id: string; attempt_id: string; kind: "create" | "capture"; request: Json; request_hash: string; provider_key: string; state: string; lease_token: string | null; lease_generation: Generated<number>; lease_expires_at: Timestamp | null; admitted_at: Timestamp | null; admission: Json; result: Json; created_at: Timestamp };
  access_challenges: Scope & { id: string; recipient_reference: string; role: "client-approver" | "payer"; code_digest: string; issued_at: Timestamp; expires_at: Timestamp; attempts: Generated<number>; status: Generated<"active" | "verified" | "superseded">; verified_at: Timestamp | null };
  paypal_webhook_receipts: { workspace_id: string; environment: "sandbox" | "live"; merchant_id: string; event_id: string; event_type: string; resource_type: string; resource_id: string | null; resource_status: string | null; provider_created_at: Timestamp; received_at: Timestamp; verification_reference: string };
  paypal_approval_links: Scope & { operation_id: string; order_id: string; approval_url: string; stored_at: Timestamp };
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

export { migration001, migration002, sql };
export * from "./runtime-persistence.js";
