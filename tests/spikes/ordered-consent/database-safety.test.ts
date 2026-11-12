import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createIsolatedProofDatabase, newProofSchema, ProtocolDatabase, sql, validateProofSchema } from "@scopeledger/db";
import { requiredDatabaseUrl } from "./support/fixture.js";

async function namespaceFixture(t: TestContext) {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  const connections: ProtocolDatabase[] = [];
  const schemas: string[] = [];
  t.after(async () => {
    for (const connection of connections) await connection.close();
    for (const schema of schemas) {
      await sql.raw(`DROP SCHEMA "${validateProofSchema(schema)}" CASCADE`).execute(isolated.database.kysely);
    }
    await isolated.dispose();
  });
  return {
    ...isolated,
    connection: (schema: string) => {
      const database = new ProtocolDatabase({ connectionString: requiredDatabaseUrl(), schema, maxConnections: 1 });
      connections.push(database);
      return database;
    },
    createTarget: async () => {
      const schema = newProofSchema();
      await sql.raw(`CREATE SCHEMA "${validateProofSchema(schema)}"`).execute(isolated.database.kysely);
      schemas.push(schema);
      return schema;
    },
  };
}

async function protectedRelations(database: ProtocolDatabase) {
  // Catalog metadata only: no reads/writes of unrelated table contents.
  return (await sql<{ namespace: string; relation: string; kind: string; oid: string }>`
    select n.nspname as namespace,c.relname as relation,c.relkind as kind,c.oid::text as oid
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','pg_catalog','information_schema')
    order by n.nspname collate "C",c.relname collate "C",c.oid
  `.execute(database.kysely)).rows;
}

test("absent dedicated target fails before migration DDL or transaction callback without falling back into a protected namespace", async (t) => {
  const f = await namespaceFixture(t);
  const before = await protectedRelations(f.database);
  const absentName = newProofSchema();
  const absent = f.connection(absentName);
  await assert.rejects(absent.migrate(), /Dedicated protocol target schema does not exist/);
  let invoked = false;
  await assert.rejects(absent.transaction(async (transaction) => {
    invoked = true;
    await sql.raw("CREATE TABLE proof_absent_target_marker (value integer)").execute(transaction);
  }), /Dedicated protocol target schema does not exist/);
  assert.equal(invoked, false);
  assert.equal((await sql`select 1 from pg_catalog.pg_namespace where nspname = ${absentName}`.execute(f.database.kysely)).rows.length, 0);
  assert.deepEqual(await protectedRelations(f.database), before);
});

test("reserved information_schema/public/pg namespaces are rejected before connecting and leave catalog relations unchanged", async (t) => {
  const f = await namespaceFixture(t);
  const before = await protectedRelations(f.database);
  for (const schema of ["information_schema", "public", "pg_catalog", "pg_toast", "pg_temp_1", "pg_toast_temp_1"]) {
    assert.throws(() => new ProtocolDatabase({ connectionString: requiredDatabaseUrl(), schema }), /Unsafe protocol schema name/);
  }
  assert.deepEqual(await protectedRelations(f.database), before);
});

test("URL namespace overrides fail closed and pooled search_path changes cannot redirect migrations or transactions", async (t) => {
  const f = await namespaceFixture(t);
  const before = await protectedRelations(f.database);
  const target = await f.createTarget();
  for (const [key, value] of [
    ["options", "-c search_path=public,pg_catalog"],
    ["options", "-csearch_path=pg_catalog,public"],
    ["search_path", "public,pg_catalog"],
    ["searchpath", "pg_catalog"],
    ["schema", "information_schema"],
    ["OPTIONS", "-csearch_path=public"],
  ]) {
    const url = new URL(requiredDatabaseUrl());
    url.searchParams.set(key!, value!);
    assert.throws(() => new ProtocolDatabase({ connectionString: url.toString(), schema: target }), /cannot override protocol session namespace/);
  }
  const encoded = new URL(requiredDatabaseUrl());
  encoded.search = "?%6fptions=-csearch_path%3Dpublic";
  assert.throws(() => new ProtocolDatabase({ connectionString: encoded.toString(), schema: target }), /cannot override protocol session namespace/);

  const database = f.connection(target);
  // Simulate a trusted pooled connection previously used with a different session path.
  await database.pool.query("SET search_path = public, pg_catalog");
  await database.migrate();
  await database.transaction(async (transaction) => {
    const active = (await sql<{ schema: string }>`select pg_catalog.current_schema() as schema`.execute(transaction)).rows[0];
    assert.equal(active?.schema, target);
    await sql.raw("CREATE TABLE proof_namespace_marker (value integer NOT NULL); INSERT INTO proof_namespace_marker VALUES (1)").execute(transaction);
  });
  await database.transaction(async (transaction) => {
    await sql`update proof_namespace_marker set value = value + 1`.execute(transaction);
  });
  await database.migrate();
  const routed = (await sql<{ value: number }>`select value from ${sql.table(`${target}.proof_namespace_marker`)}`.execute(f.database.kysely)).rows[0];
  assert.equal(routed?.value, 2);
  assert.equal((await sql`select 1 from ${sql.table(`${target}.schema_migrations`)} where version = 1`.execute(f.database.kysely)).rows.length, 1);
  assert.deepEqual(await protectedRelations(f.database), before);
});
