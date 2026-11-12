import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "@scopeledger/db";
import type {
  PaymentExceptionAdmission,
  PaymentExceptionObservation,
} from "@scopeledger/domain";
import {
  captureIntent,
  fixture,
  newCommand,
  provider,
  rejectsCode,
  scope,
  syntheticObservation,
} from "../ordered-consent/support/fixture.js";

process.env.IP01_DATABASE_URL ??= process.env.SCOPELEDGER_DATABASE_URL;

function exception(
  admission: PaymentExceptionAdmission,
  input: Readonly<{
    kind: PaymentExceptionObservation["kind"];
    state: PaymentExceptionObservation["state"];
    resourceId: string;
    affectedGross: string | null;
    providerStatus: string;
  }>,
): PaymentExceptionObservation {
  return Object.freeze({
    provider: "paypal",
    kind: input.kind,
    state: input.state,
    operationId: admission.operationId,
    resourceId: input.resourceId,
    orderId: admission.orderId,
    captureId: admission.captureId,
    merchantId: admission.merchantId,
    environment: admission.environment,
    currency: admission.currency,
    captureGross: admission.gross,
    affectedGross: input.affectedGross,
    providerStatus: input.providerStatus,
    evidence: {
      kind: "synthetic-fault" as const,
      scenario:
        "Local payment-exception proof fixture; no provider call occurred",
    },
  });
}

test("refund and reversal facts stay separate, maintain one hold and never recollect", async (t) => {
  const f = await fixture(t);
  const { payer } = await f.approveAndNominate(await f.addUnit());
  const capture = await captureIntent(f.store, payer);
  const lease = await f.store.claimOperation(scope, {
    operationId: capture.operationId,
    leaseMilliseconds: 60_000,
  });
  await f.store.admitDispatch(lease, payer);
  const completed = syntheticObservation(capture.operationId, "completed");
  await f.store.recordObservation(scope, completed);
  const admission = await f.store.paymentExceptionAdmission(
    scope,
    completed.captureId,
  );
  const workStart = await f.store.observeWorkStart(provider, {
    ...newCommand(),
    unitId: "unit-a",
  });
  const settlementBefore = (await sql<{
    result: unknown;
    fact_evidence: unknown;
    verified_at: Date;
  }>`select o.result,f.evidence as fact_evidence,f.verified_at
    from operations o
    join payment_facts f on f.operation_id = o.id
    where o.id = ${capture.operationId}::uuid`
    .execute(f.database.kysely)).rows[0];

  const observations = [
    exception(admission, {
      kind: "refund",
      state: "partial-refund",
      resourceId: "REFUND_PARTIAL",
      affectedGross: "75.00",
      providerStatus: "COMPLETED",
    }),
    exception(admission, {
      kind: "refund",
      state: "full-refund",
      resourceId: "REFUND_FULL",
      affectedGross: "300.00",
      providerStatus: "COMPLETED",
    }),
    exception(admission, {
      kind: "capture-reversal",
      state: "reversed",
      resourceId: admission.captureId,
      affectedGross: "300.00",
      providerStatus: "REVERSED",
    }),
    exception(admission, {
      kind: "capture-reversal",
      state: "unknown",
      resourceId: admission.captureId,
      affectedGross: null,
      providerStatus: "AUTHORITATIVE_REFRESH_FAILED",
    }),
    exception(admission, {
      kind: "refund",
      state: "mismatch",
      resourceId: "REFUND_MISMATCH",
      affectedGross: null,
      providerStatus: "AUTHORITATIVE_RESOURCE_MISMATCH",
    }),
  ];
  for (const observation of observations) {
    const reduced = await f.store.recordPaymentExceptionObservation(
      scope,
      observation,
    );
    assert.equal(reduced.holdActive, true);
    assert.equal(reduced.readinessWithheld, true);
  }
  assert.equal(
    (await f.store.recordPaymentExceptionObservation(
      scope,
      observations[0]!,
    )).duplicate,
    true,
  );
  const failed = exception(admission, {
    kind: "refund",
    state: "failed",
    resourceId: "REFUND_PARTIAL",
    affectedGross: null,
    providerStatus: "FAILED",
  });
  assert.deepEqual(
    await f.store.recordPaymentExceptionObservation(scope, failed),
    {
      duplicate: false,
      holdActive: true,
      readinessWithheld: true,
    },
  );

  const history = (await sql<{
    event: string;
    state: string;
  }>`select event,detail->>'state' as state
    from protocol_history
    where event = 'payment-exception-observed'
    order by sequence`.execute(f.database.kysely)).rows;
  assert.deepEqual(
    history.map(({ state }) => state),
    [
      "partial-refund",
      "full-refund",
      "reversed",
      "unknown",
      "mismatch",
      "failed",
    ],
  );
  assert.equal(
    (await sql`select 1 from holds
      where reason = 'financial' and resolved_at is null`
      .execute(f.database.kysely)).rows.length,
    1,
  );
  assert.equal((await f.store.inspectUnit(provider, "unit-a")).readiness, "review-hold");
  assert.deepEqual(
    await f.store.observeWorkStart(provider, {
      ...newCommand(),
      unitId: "unit-a",
    }),
    workStart,
  );
  await rejectsCode(f.store.initiatePayment(payer, newCommand()), "REVIEW_HOLD");
  assert.equal((await sql`select 1 from attempts`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await sql`select 1 from obligations`.execute(f.database.kysely)).rows.length, 1);
  assert.equal((await sql`select 1 from payment_facts`.execute(f.database.kysely)).rows.length, 1);
  assert.deepEqual((await sql<{
    result: unknown;
    fact_evidence: unknown;
    verified_at: Date;
  }>`select o.result,f.evidence as fact_evidence,f.verified_at
    from operations o
    join payment_facts f on f.operation_id = o.id
    where o.id = ${capture.operationId}::uuid`
    .execute(f.database.kysely)).rows[0], settlementBefore);
  assert.equal(
    (await sql`select 1 from protocol_history where event = 'work-started'`
      .execute(f.database.kysely)).rows.length,
    1,
  );
});
