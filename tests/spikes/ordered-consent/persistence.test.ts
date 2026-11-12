import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import {
  createIsolatedProofDatabase,
  migration001,
  newProofSchema,
  PostgresAccessChallengeStore,
  PostgresPayPalApprovalLinkStore,
  PostgresPayPalWebhookReceiptStore,
  ProtocolDatabase,
  RuntimePersistenceError,
  sql,
  validateProofSchema,
} from "@scopeledger/db";
import {
  availableOrder,
  fixture,
  requiredDatabaseUrl,
  scope,
} from "./support/fixture.js";

function challengeDigest(challengeId: string, code: string): string {
  return createHmac("sha256", "synthetic-access-secret")
    .update(`${challengeId}:${code}`)
    .digest("hex");
}

function rejectsPersistenceCode(
  work: Promise<unknown>,
  code: RuntimePersistenceError["code"],
): Promise<void> {
  return assert.rejects(work, (error: unknown) =>
    error instanceof RuntimePersistenceError && error.code === code);
}

async function migrationTargets(t: TestContext) {
  const control = await createIsolatedProofDatabase(requiredDatabaseUrl());
  const databases: ProtocolDatabase[] = [];
  const schemas: string[] = [];
  t.after(async () => {
    for (const database of databases) await database.close();
    for (const schema of schemas) {
      await sql.raw(`DROP SCHEMA "${validateProofSchema(schema)}" CASCADE`)
        .execute(control.database.kysely);
    }
    await control.dispose();
  });
  return {
    control,
    create: async () => {
      const schema = newProofSchema();
      await sql.raw(`CREATE SCHEMA "${validateProofSchema(schema)}"`)
        .execute(control.database.kysely);
      const database = new ProtocolDatabase({
        connectionString: requiredDatabaseUrl(),
        schema,
        maxConnections: 2,
      });
      databases.push(database);
      schemas.push(schema);
      return database;
    },
  };
}

test("fresh PostgreSQL installation applies every reviewed migration in order", async (t) => {
  const isolated = await createIsolatedProofDatabase(requiredDatabaseUrl());
  t.after(isolated.dispose);
  const versions = (await sql<{ version: number }>`
    select version from schema_migrations order by version
  `.execute(isolated.database.kysely)).rows.map((row) => row.version);
  assert.deepEqual(versions, [1, 2]);
  const relations = (await sql<{ name: string }>`
    select c.relname as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${isolated.schema}
      and c.relname in (
        'access_challenges',
        'paypal_webhook_receipts',
        'paypal_approval_links'
      )
    order by c.relname collate "C"
  `.execute(isolated.database.kysely)).rows.map((row) => row.name);
  assert.deepEqual(relations, [
    "access_challenges",
    "paypal_approval_links",
    "paypal_webhook_receipts",
  ]);
});

test("existing migration 001 installation upgrades to 002 without replacing protocol data", async (t) => {
  const targets = await migrationTargets(t);
  const database = await targets.create();
  await database.transaction(async (transaction) => {
    await sql.raw(migration001).execute(transaction);
    await sql`insert into workspaces(id,merchant_id,environment)
      values ('upgrade-workspace','upgrade-merchant','sandbox')`.execute(transaction);
    await sql`insert into projects(workspace_id,id,client_id,approver_id)
      values ('upgrade-workspace','upgrade-project','upgrade-client','upgrade-approver')`
      .execute(transaction);
  });
  await database.migrate();
  assert.deepEqual((await sql<{ version: number }>`
    select version from schema_migrations order by version
  `.execute(database.kysely)).rows.map((row) => row.version), [1, 2]);
  assert.equal((await sql`select 1 from projects
    where workspace_id = 'upgrade-workspace' and id = 'upgrade-project'`
    .execute(database.kysely)).rows.length, 1);
  await database.migrate();
  assert.deepEqual((await sql<{ version: number }>`
    select version from schema_migrations order by version
  `.execute(database.kysely)).rows.map((row) => row.version), [1, 2]);
});

test("migration rejects gapped, unknown, and unversioned nonempty histories", async (t) => {
  const targets = await migrationTargets(t);
  for (const versions of [[2], [1, 3], [1, 2, 3]]) {
    const database = await targets.create();
    await database.transaction(async (transaction) => {
      await sql`create table schema_migrations(
        version integer primary key,
        applied_at timestamptz not null default clock_timestamp()
      )`.execute(transaction);
      for (const version of versions) {
        await sql`insert into schema_migrations(version) values (${version})`
          .execute(transaction);
      }
    });
    await assert.rejects(database.migrate(), /Unsupported protocol migration history/);
  }
  const unversioned = await targets.create();
  await unversioned.transaction(async (transaction) => {
    await sql`create table unknown_runtime_history(value integer not null)`
      .execute(transaction);
  });
  await assert.rejects(unversioned.migrate(), /Unsupported protocol migration history/);
});

test("concurrent challenge issue leaves one current record and supersedes the older commit", async (t) => {
  const f = await fixture(t);
  const a = await f.connection();
  const b = await f.connection();
  const now = new Date("2026-11-11T12:00:00.000Z");
  const stores = [
    new PostgresAccessChallengeStore(a.database, { clock: () => now }),
    new PostgresAccessChallengeStore(b.database, { clock: () => now }),
  ];
  const ids = [randomUUID(), randomUUID()];
  await Promise.all(ids.map((challengeId, index) => stores[index]!.issue({
    ...scope,
    challengeId,
    recipientReference: "client@scopeledger.test",
    role: "client-approver",
    codeDigest: challengeDigest(challengeId, `00000${index}`),
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  })));
  const rows = (await sql<{ id: string; status: string }>`select id::text,status
    from access_challenges order by id::text`.execute(f.database.kysely)).rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.status).sort(), ["active", "superseded"]);
  const superseded = rows.find((row) => row.status === "superseded")!;
  await rejectsPersistenceCode(stores[0]!.verify({
    ...scope,
    challengeId: superseded.id,
    candidateCodeDigest: challengeDigest(
      superseded.id,
      superseded.id === ids[0] ? "000000" : "000001",
    ),
  }), "CHALLENGE_SUPERSEDED");
});

test("challenge expiry is exact and five failed attempts remain durable", async (t) => {
  const f = await fixture(t);
  let now = new Date("2026-11-11T13:00:00.000Z");
  const store = new PostgresAccessChallengeStore(f.database, {
    clock: () => now,
  });
  const challengeId = randomUUID();
  await store.issue({
    ...scope,
    challengeId,
    recipientReference: "payer@scopeledger.test",
    role: "payer",
    codeDigest: challengeDigest(challengeId, "123456"),
    expiresAt: new Date(now.getTime() + 60_000),
  });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await rejectsPersistenceCode(store.verify({
      ...scope,
      challengeId,
      candidateCodeDigest: challengeDigest(challengeId, "654321"),
    }), attempt === 5
      ? "CHALLENGE_ATTEMPTS_EXHAUSTED"
      : "CHALLENGE_CODE_MISMATCH");
  }
  assert.equal((await store.read({ ...scope, challengeId }))?.attempts, 5);
  await rejectsPersistenceCode(store.verify({
    ...scope,
    challengeId,
    candidateCodeDigest: challengeDigest(challengeId, "123456"),
  }), "CHALLENGE_ATTEMPTS_EXHAUSTED");

  const expiringId = randomUUID();
  const expiresAt = new Date(now.getTime() + 60_000);
  await store.issue({
    ...scope,
    challengeId: expiringId,
    recipientReference: "expiring@scopeledger.test",
    role: "client-approver",
    codeDigest: challengeDigest(expiringId, "123456"),
    expiresAt,
  });
  now = expiresAt;
  await rejectsPersistenceCode(store.verify({
    ...scope,
    challengeId: expiringId,
    candidateCodeDigest: challengeDigest(expiringId, "123456"),
  }), "CHALLENGE_EXPIRED");
});

test("challenge issuance is rate limited per scoped recipient and role", async (t) => {
  const f = await fixture(t);
  const now = new Date("2026-11-11T13:30:00.000Z");
  const store = new PostgresAccessChallengeStore(f.database, {
    clock: () => now,
  });
  for (let index = 0; index < 3; index += 1) {
    const challengeId = randomUUID();
    await store.issue({
      ...scope,
      challengeId,
      recipientReference: "limited@scopeledger.test",
      role: "client-approver",
      codeDigest: challengeDigest(challengeId, `10000${index}`),
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
  }
  const blockedId = randomUUID();
  await rejectsPersistenceCode(store.issue({
    ...scope,
    challengeId: blockedId,
    recipientReference: "limited@scopeledger.test",
    role: "client-approver",
    codeDigest: challengeDigest(blockedId, "999999"),
    expiresAt: new Date(now.getTime() + 10 * 60_000),
  }), "CHALLENGE_RATE_LIMITED");
});

test("concurrent correct challenge verification permits one terminal transition", async (t) => {
  const f = await fixture(t);
  const a = await f.connection();
  const b = await f.connection();
  const now = new Date("2026-11-11T14:00:00.000Z");
  const issuing = new PostgresAccessChallengeStore(f.database, {
    clock: () => now,
  });
  const challengeId = randomUUID();
  const codeDigest = challengeDigest(challengeId, "246810");
  await issuing.issue({
    ...scope,
    challengeId,
    recipientReference: "race@scopeledger.test",
    role: "payer",
    codeDigest,
    expiresAt: new Date(now.getTime() + 60_000),
  });
  const results = await Promise.allSettled([
    new PostgresAccessChallengeStore(a.database, { clock: () => now }).verify({
      ...scope, challengeId, candidateCodeDigest: codeDigest,
    }),
    new PostgresAccessChallengeStore(b.database, { clock: () => now }).verify({
      ...scope, challengeId, candidateCodeDigest: codeDigest,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof RuntimePersistenceError);
  assert.equal(rejected.reason.code, "CHALLENGE_ALREADY_VERIFIED");
  assert.equal((await issuing.read({ ...scope, challengeId }))?.status, "verified");
});

test("verified webhook duplicates converge while conflicting normalized content fails closed", async (t) => {
  const f = await fixture(t);
  const a = await f.connection();
  const b = await f.connection();
  const base = {
    workspaceId: scope.workspaceId,
    environment: "sandbox" as const,
    merchantId: "synthetic-merchant",
    eventId: "WH-SYNTHETIC-EVENT",
    eventType: "PAYMENT.CAPTURE.COMPLETED" as const,
    resourceType: "capture",
    resourceId: "synthetic-capture",
    resourceStatus: "COMPLETED",
    providerCreatedAt: "2026-11-11T14:30:00.000Z",
  };
  const results = await Promise.all([
    new PostgresPayPalWebhookReceiptStore(a.database).insertVerified({
      ...base,
      receivedAt: "2026-11-11T14:30:01.000Z",
      verificationReference: "synthetic-postback-a",
    }),
    new PostgresPayPalWebhookReceiptStore(b.database).insertVerified({
      ...base,
      receivedAt: "2026-11-11T14:30:02.000Z",
      verificationReference: "synthetic-postback-b",
    }),
  ]);
  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal((await sql`select 1 from paypal_webhook_receipts`
    .execute(f.database.kysely)).rows.length, 1);
  await rejectsPersistenceCode(
    new PostgresPayPalWebhookReceiptStore(f.database).insertVerified({
      ...base,
      resourceStatus: "PENDING",
      receivedAt: "2026-11-11T14:30:03.000Z",
      verificationReference: "synthetic-postback-conflict",
    }),
    "WEBHOOK_CONFLICT",
  );
  assert.equal((await sql<{ resource_status: string }>`select resource_status
    from paypal_webhook_receipts`.execute(f.database.kysely)).rows[0]?.resource_status,
  "COMPLETED");
});

test("approval-link exact replay is idempotent and changed values cannot rewrite the record", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const create = await availableOrder(f.store, payer);
  const a = await f.connection();
  const b = await f.connection();
  const link = {
    ...scope,
    operationId: create.operationId,
    orderId: "synthetic-order",
    approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=synthetic-order",
  };
  await Promise.all([
    new PostgresPayPalApprovalLinkStore(a.database).save(link),
    new PostgresPayPalApprovalLinkStore(b.database).save(link),
  ]);
  const store = new PostgresPayPalApprovalLinkStore(f.database);
  const stored = await store.read({
    ...scope,
    operationId: create.operationId,
  });
  assert.equal(stored?.orderId, link.orderId);
  assert.equal(stored?.approvalUrl, link.approvalUrl);
  await rejectsPersistenceCode(store.save({
    ...link,
    approvalUrl: `${link.approvalUrl}&locale=en-US`,
  }), "APPROVAL_LINK_CONFLICT");
  await rejectsPersistenceCode(store.save({
    ...link,
    orderId: "different-order",
  }), "APPROVAL_LINK_CONFLICT");
  await assert.rejects(sql`update paypal_approval_links
    set approval_url = 'https://www.sandbox.paypal.com/changed'
    where operation_id = ${create.operationId}::uuid`.execute(f.database.kysely),
  /immutable protocol record/);
  await assert.rejects(sql`delete from paypal_approval_links
    where operation_id = ${create.operationId}::uuid`.execute(f.database.kysely),
  /immutable protocol record/);
});
