import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Lease,
  Payer,
  PaymentObservation,
} from "@scopeledger/contracts";
import type {
  DispatchAdmission,
} from "@scopeledger/domain";
import type {
  PayPalExecutionResult,
} from "@scopeledger/paypal-adapter";
import {
  FileApprovalLinkStore,
  PayPalCaptureReconciler,
  PayPalPaymentWorker,
  PaymentWorkerError,
} from "@scopeledger/payment-worker";
import type {
  ApprovalLinkStore,
  PaymentDispatchStore,
  PayPalPaymentClient,
} from "@scopeledger/payment-worker";

const lease: Lease = {
  workspaceId: "workspace",
  projectId: "project",
  operationId: "11111111-1111-4111-8111-111111111111",
  token: "22222222-2222-4222-8222-222222222222",
  generation: 1,
};

const payer: Payer = {
  workspaceId: "workspace",
  projectId: "project",
  actorId: "payer",
  grantEpoch: 1,
  obligationId: "obligation",
  payerEpoch: 1,
  nominationEpoch: 1,
};

function admission(kind: "create" | "capture"): DispatchAdmission {
  return {
    dispatchAllowed: true,
    reconciliationRequired: false,
    operationId: lease.operationId,
    providerKey: lease.operationId,
    kind,
    request: { kind },
    requestHash: "a".repeat(64),
  };
}

function observation(outcome: "order-created" | "completed"): PaymentObservation {
  return {
    operationId: lease.operationId,
    evidence: {
      kind: "synthetic-fault",
      scenario: "Local payment-worker sequencing fixture; no provider call occurred",
    },
    merchantId: "merchant",
    environment: "sandbox",
    currency: "USD",
    gross: "1.00",
    orderId: "ORDER123",
    outcome,
    ...(outcome === "completed" ? { captureId: "CAPTURE123" } : {}),
  };
}

test("create stores the approval link only after domain observation succeeds", async () => {
  const sequence: string[] = [];
  const store: PaymentDispatchStore = {
    async dispatch(_lease, _payer, transport) {
      sequence.push("dispatch-admitted");
      await transport(admission("create"));
      sequence.push("domain-observation-recorded");
      return admission("create");
    },
  };
  const client: PayPalPaymentClient = {
    async execute(): Promise<PayPalExecutionResult> {
      sequence.push("provider-executed");
      return {
        kind: "create",
        observation: observation("order-created"),
        approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123",
      };
    },
  };
  const approvalLinks: ApprovalLinkStore = {
    async save() {
      sequence.push("approval-link-stored");
    },
  };
  const worker = new PayPalPaymentWorker(store, client, approvalLinks);
  const result = await worker.run(lease, payer);
  assert.deepEqual(sequence, [
    "dispatch-admitted",
    "provider-executed",
    "domain-observation-recorded",
    "approval-link-stored",
  ]);
  assert.equal(result.approvalLink?.orderId, "ORDER123");
});

test("capture records provider observation without creating an approval link", async () => {
  let saves = 0;
  const store: PaymentDispatchStore = {
    async dispatch(_lease, _payer, transport) {
      await transport(admission("capture"));
      return admission("capture");
    },
  };
  const client: PayPalPaymentClient = {
    async execute() {
      return { kind: "capture", observation: observation("completed") };
    },
  };
  const worker = new PayPalPaymentWorker(store, client, {
    async save() {
      saves += 1;
    },
  });
  const result = await worker.run(lease, payer);
  assert.equal(result.approvalLink, null);
  assert.equal(saves, 0);
});

test("provider failure cannot create an approval link", async () => {
  let saves = 0;
  const store: PaymentDispatchStore = {
    async dispatch(_lease, _payer, transport) {
      return transport(admission("create")).then(() => admission("create"));
    },
  };
  const client: PayPalPaymentClient = {
    async execute(): Promise<never> {
      throw new Error("Synthetic provider failure");
    },
  };
  const worker = new PayPalPaymentWorker(store, client, {
    async save() {
      saves += 1;
    },
  });
  await assert.rejects(() => worker.run(lease, payer), /Synthetic provider failure/);
  assert.equal(saves, 0);
});

test("file approval-link storage is private, idempotent and immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeledger-approval-links-"));
  const store = new FileApprovalLinkStore(root);
  const link = {
    workspaceId: lease.workspaceId,
    projectId: lease.projectId,
    operationId: lease.operationId,
    orderId: "ORDER123",
    approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER123",
  };
  try {
    await store.save(link);
    await store.save(link);
    const stored = JSON.parse(await readFile(join(root, `${lease.operationId}.json`), "utf8")) as {
      approvalUrl: string;
    };
    assert.equal(stored.approvalUrl, link.approvalUrl);
    await assert.rejects(
      () => store.save({
        ...link,
        approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=CHANGED",
      }),
      (error: unknown) => error instanceof PaymentWorkerError
        && error.code === "APPROVAL_LINK_STORAGE_FAILED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture webhook reconciliation re-fetches provider state before reducing the admitted operation", async () => {
  const sequence: string[] = [];
  const reconciler = new PayPalCaptureReconciler(
    {
      async captureReconciliationAdmission(_scope, receivedOrderId) {
        sequence.push(`admission:${receivedOrderId}`);
        return admission("capture");
      },
      async recordObservation(_scope, received) {
        sequence.push(`record:${received.outcome}`);
        return { matchesBasis: true, completed: true };
      },
    },
    {
      async retrieveCaptureDetails(receivedCaptureId) {
        sequence.push(`retrieve:${receivedCaptureId}`);
        return {
          captureId: receivedCaptureId,
          orderId: "ORDER123",
          status: "COMPLETED",
          merchantId: "merchant",
          currency: "USD",
          gross: "1.00",
          evidence: {
            kind: "synthetic-fault",
            scenario: "Local webhook reconciliation sequencing fixture",
          },
        };
      },
      captureObservationFromDetails(receivedAdmission, details) {
        sequence.push(`normalize:${details.status}`);
        return {
          ...observation("completed"),
          operationId: receivedAdmission.operationId,
          orderId: details.orderId,
          captureId: details.captureId,
        };
      },
    },
  );
  const result = await reconciler.reconcile(scopeFromLease(), "CAPTURE123");
  assert.deepEqual(sequence, [
    "retrieve:CAPTURE123",
    "admission:ORDER123",
    "normalize:COMPLETED",
    "record:completed",
  ]);
  assert.deepEqual(result, {
    orderId: "ORDER123",
    matchesBasis: true,
    completed: true,
  });
});

function scopeFromLease() {
  return {
    workspaceId: lease.workspaceId,
    projectId: lease.projectId,
  };
}
