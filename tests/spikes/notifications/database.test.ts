import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  NotificationPersistenceError,
  PostgresAuthoringStore,
  PostgresNotificationOutboxStore,
  sql,
} from "@scopeledger/db";
import {
  fixture,
  provider,
  scope,
} from "../ordered-consent/support/fixture.js";

test("migration 009 installs bounded durable outbox and event hooks", async (t) => {
  const proof = await fixture(t);
  const versions = (await sql<{ version: number }>`select version
    from schema_migrations order by version`.execute(proof.database.kysely))
    .rows.map((row) => row.version);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const tables = (await sql<{ name: string }>`select table_name as name
    from information_schema.tables
    where table_schema = current_schema()
      and table_name like 'notification_%'
    order by table_name`.execute(proof.database.kysely)).rows
    .map((row) => row.name);
  assert.deepEqual(tables, [
    "notification_delivery_attempts",
    "notification_delivery_receipts",
    "notification_outbox",
  ]);

  const triggers = (await sql<{ name: string }>`select trigger_name as name
    from information_schema.triggers
    where trigger_schema = current_schema()
      and trigger_name like 'enqueue_%notification%'
    order by trigger_name`.execute(proof.database.kysely)).rows
    .map((row) => row.name);
  assert.deepEqual(triggers, [
    "enqueue_client_correction_notification",
    "enqueue_client_question_notification",
    "enqueue_participant_and_payment_notifications",
    "enqueue_provider_correction_assessment_notification",
    "enqueue_provider_question_response_notification",
    "enqueue_provider_reissue_notification",
  ]);
});

test("question enqueue is atomic, idempotent, and excludes submitted text", async (t) => {
  const proof = await fixture(t);
  const unit = await proof.addUnit();
  const authoring = new PostgresAuthoringStore(proof.database);
  const questionId = randomUUID();
  const input = {
    ...scope,
    questionId,
    requestId: "packet-a",
    unitId: unit.unitId,
    unitVersion: unit.version,
    askedBy: "synthetic-approver",
    exactText: "Private exact client wording must not enter the outbox.",
    modelProcessing: "denied" as const,
  };
  const first = await authoring.askQuestion(input);
  const duplicate = await authoring.askQuestion(input);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);

  const rows = (await sql<{
    payload: unknown;
    count: string;
  }>`select min(payload::text)::jsonb as payload,count(*)::text as count
    from notification_outbox
    where workspace_id = ${scope.workspaceId}
      and project_id = ${scope.projectId}
      and purpose = 'client-question-submitted'
    group by workspace_id,project_id`.execute(proof.database.kysely)).rows;
  assert.equal(rows[0]?.count, "1");
  assert.deepEqual(rows[0]?.payload, {
    unitId: unit.unitId,
    requestId: "packet-a",
    questionId,
    unitVersion: 1,
  });
  const serialized = JSON.stringify(rows[0]?.payload);
  assert.doesNotMatch(serialized, /Private exact client wording/iu);
  assert.doesNotMatch(serialized, /@/u);
});

test("typed enqueue rolls back atomically and enforces idempotency content", async (t) => {
  const proof = await fixture(t);
  await proof.addUnit();
  const notifications = new PostgresNotificationOutboxStore(proof.database);
  const intent = {
    ...scope,
    purpose: "provider-reissue-published" as const,
    recipientRole: "client-approver" as const,
    attributedActorId: provider.actorId,
    sourceKind: "provider-publication" as const,
    sourceKey: "unit-a:2",
    dedupeKey: "reissue:unit-a:2",
    payload: {
      unitId: "unit-a",
      version: 2,
      previousVersion: 1,
    },
  };

  await assert.rejects(
    proof.database.transaction(async (transaction) => {
      await notifications.enqueue(intent, transaction);
      throw new Error("force rollback");
    }),
    /force rollback/u,
  );
  const rolledBack = await sql<{ count: string }>`select count(*)::text as count
    from notification_outbox
    where dedupe_key = ${intent.dedupeKey}`.execute(proof.database.kysely);
  assert.equal(rolledBack.rows[0]?.count, "0");

  const first = await notifications.enqueue(intent);
  const replay = await notifications.enqueue(intent);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.notification.id, first.notification.id);

  await assert.rejects(
    notifications.enqueue({
      ...intent,
      payload: {
        unitId: "unit-a",
        version: 3,
        previousVersion: 2,
      },
    }),
    (error: unknown) => error instanceof NotificationPersistenceError
      && error.code === "NOTIFICATION_CONFLICT",
  );
});

test("unsafe payloads are rejected before persistence and by PostgreSQL", async (t) => {
  const proof = await fixture(t);
  await proof.addUnit();
  const notifications = new PostgresNotificationOutboxStore(proof.database);
  await assert.rejects(
    notifications.enqueue({
      ...scope,
      purpose: "client-question-submitted",
      recipientRole: "provider",
      attributedActorId: "synthetic-approver",
      sourceKind: "client-question",
      sourceKey: randomUUID(),
      dedupeKey: `unsafe:${randomUUID()}`,
      payload: {
        questionId: randomUUID(),
        requestId: "packet-a",
        unitId: "unit-a",
        unitVersion: 1,
        email: "person@example.com",
      } as never,
    }),
    (error: unknown) => error instanceof NotificationPersistenceError
      && error.code === "INVALID_INPUT",
  );

  await assert.rejects(
    sql`insert into notification_outbox(
        id,workspace_id,project_id,purpose,recipient_role,
        attributed_actor_id,source_kind,source_key,dedupe_key,payload
      ) values (
        ${randomUUID()}::uuid,${scope.workspaceId},${scope.projectId},
        'client-question-submitted','provider','synthetic-approver',
        'client-question',${randomUUID()},${`unsafe:${randomUUID()}`},
        ${JSON.stringify({
          questionId: randomUUID(),
          requestId: "packet-a",
          unitId: "unit-a",
          unitVersion: 1,
          privateNote: "do not persist",
        })}::jsonb
      )`.execute(proof.database.kysely),
    (error: unknown) => typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "23514",
  );
});
