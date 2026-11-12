import assert from "node:assert/strict";
import test from "node:test";
import {
  PostgresPayPalWebhookReceiptStore,
  sql,
} from "@scopeledger/db";
import { PayPalSandboxClient } from "@scopeledger/paypal-adapter";
import { refreshPaymentExceptions } from "../../../apps/web/app/api/provider/payment-exceptions/refresh.js";
import {
  captureIntent,
  fixture,
  newCommand,
  provider,
  scope,
  syntheticObservation,
} from "../ordered-consent/support/fixture.js";

process.env.IP01_DATABASE_URL ??= process.env.SCOPELEDGER_DATABASE_URL;

test("completed captures with zero exception resources refresh as a safe no-op", async (t) => {
  const f = await fixture(t);
  const captures: string[] = [];
  for (const unit of [
    await f.addUnit("unit-a", "packet-a"),
    await f.addUnit("unit-b", "packet-b"),
  ]) {
    const { payer } = await f.approveAndNominate(unit);
    const capture = await captureIntent(f.store, payer);
    const lease = await f.store.claimOperation(scope, {
      operationId: capture.operationId,
      leaseMilliseconds: 60_000,
    });
    await f.store.admitDispatch(lease, payer);
    const observation = syntheticObservation(capture.operationId, "completed");
    await f.store.recordObservation(scope, observation);
    captures.push(observation.captureId!);
  }

  const receipts = new PostgresPayPalWebhookReceiptStore(f.database);
  for (const [index, captureId] of captures.entries()) {
    await receipts.insertVerified({
      workspaceId: scope.workspaceId,
      environment: "sandbox",
      merchantId: "synthetic-merchant",
      eventId: `capture-completed-${index + 1}`,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      resourceType: "capture",
      resourceId: captureId,
      resourceStatus: "COMPLETED",
      providerCreatedAt: new Date(`2026-11-12T10:0${index}:00.000Z`),
      receivedAt: new Date(`2026-11-12T10:0${index}:01.000Z`),
      verificationReference: `capture_completed_${index + 1}`,
    });
  }

  let providerCalls = 0;
  const config = {
    environment: "sandbox" as const,
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    merchantId: "synthetic-merchant",
    returnUrl: "http://127.0.0.1:3000/payments/paypal/return",
    cancelUrl: "http://127.0.0.1:3000/payments/paypal/cancel",
    timeoutMilliseconds: 15_000,
  };
  const summary = await refreshPaymentExceptions({
    database: f.database,
    config,
    provider: new PayPalSandboxClient(config, {
      fetch: async () => {
        providerCalls += 1;
        return assert.fail(
          "Completed capture receipts are not payment-exception resources",
        );
      },
    }),
    scope: {
      workspaceId: scope.workspaceId,
      providerActorId: provider.actorId,
      providerGrantEpoch: provider.grantEpoch,
    },
  });

  assert.deepEqual(summary, {
    processed: 0,
    eventTypes: [],
    outcomes: [],
  });
  assert.equal(providerCalls, 0);
  assert.equal(
    (await sql`select 1 from protocol_history
      where event = 'payment-exception-observed'`
      .execute(f.database.kysely)).rows.length,
    0,
  );
  assert.equal((await sql`select 1 from holds`.execute(f.database.kysely)).rows.length, 0);
  assert.equal((await sql`select 1 from attempts`.execute(f.database.kysely)).rows.length, 2);
  assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 2);
});
