import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  PostgresAuthoringStore,
  PostgresNotificationOutboxStore,
  sql,
} from "@scopeledger/db";
import type {
  LocalEmailMessage,
} from "@scopeledger/email-adapter";
import {
  NotificationWorker,
} from "../../../packages/notifications/src/index.js";
import type {
  NotificationDelivery,
  NotificationRecipientDirectory,
} from "../../../packages/notifications/src/index.js";
import {
  fixture,
  newCommand,
  provider,
  scope,
  snapshot,
} from "../ordered-consent/support/fixture.js";

class CapturingDelivery implements NotificationDelivery {
  readonly captured = new Map<string, string>();
  sent = 0;

  async hasCaptured(messageId: string, recipient: string): Promise<boolean> {
    return this.captured.get(messageId) === recipient;
  }

  async send(message: LocalEmailMessage): Promise<void> {
    this.sent += 1;
    this.captured.set(message.messageId, message.recipient);
  }
}

class FailingDelivery implements NotificationDelivery {
  async hasCaptured(): Promise<boolean> {
    return false;
  }

  async send(): Promise<void> {
    throw new Error("synthetic SMTP outage");
  }
}

function directory(): NotificationRecipientDirectory {
  return Object.freeze({
    provider: Object.freeze({
      actorId: provider.actorId,
      address: "provider@scopeledger.test",
    }),
    "client-approver": Object.freeze({
      actorId: "synthetic-approver",
      address: "client@scopeledger.test",
    }),
    payer: Object.freeze({
      actorId: "synthetic-payer",
      address: "payer@scopeledger.test",
    }),
  });
}

async function questionNotification(
  proof: Awaited<ReturnType<typeof fixture>>,
): Promise<string> {
  const unit = await proof.addUnit();
  const questionId = randomUUID();
  await new PostgresAuthoringStore(proof.database).askQuestion({
    ...scope,
    questionId,
    requestId: "packet-a",
    unitId: unit.unitId,
    unitVersion: unit.version,
    askedBy: "synthetic-approver",
    exactText: "Which exact source governs this synthetic item?",
    modelProcessing: "denied",
  });
  const row = (await sql<{ id: string }>`select id::text
    from notification_outbox
    where purpose = 'client-question-submitted'
      and payload->>'questionId' = ${questionId}`.execute(proof.database.kysely))
    .rows[0];
  assert.ok(row);
  return row.id;
}

async function notificationAvailableAt(
  proof: Awaited<ReturnType<typeof fixture>>,
  notificationId: string,
): Promise<Date> {
  const row = (await sql<{ available_at: Date }>`select available_at
    from notification_outbox
    where id = ${notificationId}::uuid`
    .execute(proof.database.kysely)).rows[0];
  assert.ok(row);
  return row.available_at;
}

test("expired lease recovers a captured SMTP message without resending", async (t) => {
  const proof = await fixture(t);
  const notificationId = await questionNotification(proof);
  let now = new Date(
    (await notificationAvailableAt(proof, notificationId)).getTime() + 1,
  );
  const outbox = new PostgresNotificationOutboxStore(
    proof.database,
    () => new Date(now),
  );
  const delivery = new CapturingDelivery();
  const [crashed] = await outbox.claimBatch({
    workerId: "crashed-worker",
    limit: 1,
    leaseSeconds: 1,
  });
  assert.ok(crashed);
  const receipt = await outbox.reserveReceipt(crashed);
  delivery.captured.set(receipt.messageId, "provider@scopeledger.test");

  now = new Date(now.getTime() + 2_000);
  const summary = await new NotificationWorker(
    outbox,
    delivery,
    directory(),
    {
      workerId: "recovery-worker",
      leaseSeconds: 30,
      batchSize: 1,
      backoffMilliseconds: [1],
    },
  ).runBatch();
  assert.deepEqual(summary, {
    claimed: 1,
    delivered: 0,
    recovered: 1,
    retried: 0,
    suppressed: 0,
    obsolete: 0,
    manual: 0,
  });
  assert.equal(delivery.sent, 0);
  assert.equal((await outbox.read(notificationId))?.status, "delivered");

  const attempts = (await sql<{
    attempt_number: number;
    outcome: string;
  }>`select attempt_number,outcome
    from notification_delivery_attempts
    where notification_id = ${notificationId}::uuid
    order by attempt_number`.execute(proof.database.kysely)).rows;
  assert.deepEqual(attempts, [
    { attempt_number: 1, outcome: "lease-expired" },
    { attempt_number: 2, outcome: "recovered" },
  ]);
});

test("revoked grants suppress and obsolete versions do not dispatch", async (t) => {
  const proof = await fixture(t);
  const revokedId = await questionNotification(proof);
  await proof.store.setGrant(provider, {
    ...newCommand(),
    targetActorId: provider.actorId,
    action: "inspect",
    active: false,
    basis: "Synthetic provider notification authority revocation.",
  });
  const revokedStore = new PostgresNotificationOutboxStore(proof.database);
  const revokedSummary = await new NotificationWorker(
    revokedStore,
    new CapturingDelivery(),
    directory(),
    { workerId: "revocation-worker", batchSize: 1 },
  ).runBatch();
  assert.equal(revokedSummary.suppressed, 1);
  assert.equal((await revokedStore.read(revokedId))?.lastErrorCode,
    "AUTHORITY_REVOKED");

  await sql`update grants set active = true,epoch = epoch + 1
    where workspace_id = ${scope.workspaceId}
      and project_id = ${scope.projectId}
      and actor_id = ${provider.actorId}
      and action = 'inspect'`.execute(proof.database.kysely);
  const staleQuestionId = randomUUID();
  await new PostgresAuthoringStore(proof.database).askQuestion({
    ...scope,
    questionId: staleQuestionId,
    requestId: "packet-a",
    unitId: "unit-a",
    unitVersion: 1,
    askedBy: "synthetic-approver",
    exactText: "This question will become version-obsolete.",
    modelProcessing: "denied",
  });
  await proof.store.publish(provider, {
    ...newCommand(),
    snapshot: snapshot({ unitId: "unit-a", version: 2 }),
    expectedPreviousVersion: 1,
  });
  const stale = (await sql<{ id: string }>`select id::text
    from notification_outbox
    where payload->>'questionId' = ${staleQuestionId}`
    .execute(proof.database.kysely)).rows[0];
  assert.ok(stale);
  const staleSummary = await new NotificationWorker(
    new PostgresNotificationOutboxStore(proof.database),
    new CapturingDelivery(),
    directory(),
    { workerId: "version-worker", batchSize: 1 },
  ).runBatch();
  assert.equal(staleSummary.obsolete, 1);
  const staleRecord = await new PostgresNotificationOutboxStore(
    proof.database,
  ).read(stale.id);
  assert.equal(staleRecord?.lastErrorCode, "VERSION_OBSOLETE");
});

test("payer notices recheck collectible obligation before dispatch", async (t) => {
  const proof = await fixture(t);
  const unit = await proof.addUnit();
  const { obligationId } = await proof.approveAndNominate(unit);
  const outbox = new PostgresNotificationOutboxStore(proof.database);
  const grant = (await sql<{ epoch: number }>`select epoch
    from grants
    where workspace_id = ${scope.workspaceId}
      and project_id = ${scope.projectId}
      and actor_id = 'synthetic-payer'
      and action = 'pay'`.execute(proof.database.kysely)).rows[0];
  assert.ok(grant);
  await sql`insert into protocol_history(
      workspace_id,project_id,actor_id,event,resource_id,detail
    ) values (
      ${scope.workspaceId},${scope.projectId},${provider.actorId},
      'local-payer-authority-activated',${obligationId},
      ${JSON.stringify({
        unitId: unit.unitId,
        version: unit.version,
        payerId: "synthetic-payer",
        grantEpoch: grant.epoch,
        payerEpoch: 1,
        nominationEpoch: 1,
        approverAuthority: false,
      })}::jsonb
    )
  `.execute(proof.database.kysely);
  const queued = (await sql<{ id: string }>`select id::text
    from notification_outbox
    where purpose = 'participant-authority-activated'
      and payload->>'resourceId' = ${obligationId}
  `.execute(proof.database.kysely)).rows[0];
  assert.ok(queued);

  await sql`update obligations set collectible = false
    where workspace_id = ${scope.workspaceId}
      and project_id = ${scope.projectId}
      and id = ${obligationId}`.execute(proof.database.kysely);
  const summary = await new NotificationWorker(
    outbox,
    new CapturingDelivery(),
    directory(),
    { workerId: "payer-recheck-worker", batchSize: 1 },
  ).runBatch();
  assert.equal(summary.obsolete, 1);
  assert.equal((await outbox.read(queued.id))?.lastErrorCode,
    "PAYMENT_NOT_DUE");
});

test("delivery failures use bounded backoff and end in manual state only", async (t) => {
  const proof = await fixture(t);
  const notificationId = await questionNotification(proof);
  let now = new Date(
    (await notificationAvailableAt(proof, notificationId)).getTime() + 1,
  );
  const outbox = new PostgresNotificationOutboxStore(
    proof.database,
    () => new Date(now),
  );
  const before = (await sql<{
    current_version: number | null;
    accepted_version: number | null;
    decisions: string;
    obligations: string;
    holds: string;
  }>`select unit.current_version,unit.accepted_version,
      (select count(*)::text from decisions) as decisions,
      (select count(*)::text from obligations) as obligations,
      (select count(*)::text from holds) as holds
    from units unit
    where unit.workspace_id = ${scope.workspaceId}
      and unit.project_id = ${scope.projectId}
      and unit.id = 'unit-a'`.execute(proof.database.kysely)).rows[0];
  assert.ok(before);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const summary = await new NotificationWorker(
      outbox,
      new FailingDelivery(),
      directory(),
      {
        workerId: `retry-worker-${attempt}`,
        batchSize: 1,
        backoffMilliseconds: [1],
      },
    ).runBatch();
    assert.equal(summary.claimed, 1);
    if (attempt < 5) {
      assert.equal(summary.retried, 1);
      assert.equal((await outbox.read(notificationId))?.status, "retry");
      now = new Date(now.getTime() + 2);
    } else {
      assert.equal(summary.manual, 1);
      assert.equal((await outbox.read(notificationId))?.status, "manual");
    }
  }

  const after = (await sql<{
    current_version: number | null;
    accepted_version: number | null;
    decisions: string;
    obligations: string;
    holds: string;
  }>`select unit.current_version,unit.accepted_version,
      (select count(*)::text from decisions) as decisions,
      (select count(*)::text from obligations) as obligations,
      (select count(*)::text from holds) as holds
    from units unit
    where unit.workspace_id = ${scope.workspaceId}
      and unit.project_id = ${scope.projectId}
      and unit.id = 'unit-a'`.execute(proof.database.kysely)).rows[0];
  assert.deepEqual(after, before);
});

test("an expired final lease is terminalized instead of remaining stuck", async (t) => {
  const proof = await fixture(t);
  await proof.addUnit();
  let now = new Date("2026-11-12T19:00:00.000Z");
  const outbox = new PostgresNotificationOutboxStore(
    proof.database,
    () => new Date(now),
  );
  const queued = await outbox.enqueue({
    ...scope,
    purpose: "provider-reissue-published",
    recipientRole: "client-approver",
    attributedActorId: provider.actorId,
    sourceKind: "provider-publication",
    sourceKey: "unit-a:2",
    dedupeKey: "final-lease-crash",
    maxAttempts: 1,
    payload: {
      unitId: "unit-a",
      version: 2,
      previousVersion: 1,
    },
  });
  const [claim] = await outbox.claimBatch({
    workerId: "final-crash-worker",
    limit: 1,
    leaseSeconds: 1,
  });
  assert.equal(claim?.id, queued.notification.id);

  now = new Date(now.getTime() + 2_000);
  assert.deepEqual(await outbox.claimBatch({
    workerId: "cleanup-worker",
    limit: 1,
    leaseSeconds: 1,
  }), []);
  const terminal = await outbox.read(queued.notification.id);
  assert.equal(terminal?.status, "manual");
  assert.equal(terminal?.lastErrorCode, "LEASE_EXPIRED");
});
