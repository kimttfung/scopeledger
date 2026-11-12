import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type {
  Payer,
} from "@scopeledger/contracts";
import {
  PostgresPayPalApprovalLinkStore,
  sql,
} from "@scopeledger/db";
import {
  OrderedConsentStore,
} from "@scopeledger/domain";
import {
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";
import {
  PayPalCaptureReconciler,
  PayPalPaymentWorker,
} from "@scopeledger/payment-worker";
import {
  localAccessRuntime,
  requireSameOrigin,
} from "../../../../lib/local-access";
import {
  protocolDatabase,
} from "../../../../lib/protocol-database";
import type {
  CurrentPaymentBasis,
  PaymentAttemptSnapshot,
  PaymentJourneyDependencies,
} from "./service";

const scope = Object.freeze({
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
});
const unitId = "unit-u1";
const version = 2;
const nominationActor = Object.freeze({
  ...scope,
  actorId: "cedar-approver",
  grantEpoch: 1,
});
const payerActor = Object.freeze({
  ...scope,
  actorId: "cedar-payer",
  grantEpoch: 1,
});
const nominationBasis =
  "Verified local payer access for the current approved demo obligation; exact approver continuity confirmed.";

export type DemoPaymentRuntimeResult =
  | Readonly<{
    ok: true;
    dependencies: PaymentJourneyDependencies;
  }>
  | Readonly<{
    ok: false;
    code: "PAYMENT_ACCESS_UNAVAILABLE"
      | "PAYMENT_DATABASE_UNAVAILABLE"
      | "PAYMENT_PROVIDER_CONFIG_UNAVAILABLE";
  }>;

export function demoPaymentRuntime(
  options: Readonly<{ requireProvider: boolean }>,
): DemoPaymentRuntimeResult {
  let access;
  try {
    access = localAccessRuntime();
  } catch {
    return { ok: false, code: "PAYMENT_ACCESS_UNAVAILABLE" };
  }
  if (!access) {
    return { ok: false, code: "PAYMENT_ACCESS_UNAVAILABLE" };
  }
  const database = protocolDatabase();
  if (!database) {
    return { ok: false, code: "PAYMENT_DATABASE_UNAVAILABLE" };
  }
  let client: PayPalSandboxClient | null = null;
  if (options.requireProvider) {
    try {
      client = new PayPalSandboxClient(payPalConfigFromEnvironment());
    } catch {
      return { ok: false, code: "PAYMENT_PROVIDER_CONFIG_UNAVAILABLE" };
    }
  }
  const store = new OrderedConsentStore(database);
  const approvalLinks = new PostgresPayPalApprovalLinkStore(database);

  const dependencies: PaymentJourneyDependencies = {
    requireSameOrigin,
    readSession: async () => {
      const token = (await cookies()).get(access.cookieName)?.value;
      return access.store.readSession(token);
    },
    loadCurrentPaymentBasis: async (): Promise<CurrentPaymentBasis | null> => {
      const rows = (await sql<{
        obligation_id: string;
        nomination_epoch: number;
        payer_actor_id: string | null;
        payer_epoch: number | null;
        continuity_epoch: number | null;
        payer_active: boolean | null;
      }>`
        select b.id as obligation_id,p.nomination_epoch,
          n.actor_id as payer_actor_id,n.epoch as payer_epoch,
          n.continuity_epoch,n.active as payer_active
        from projects p
        join units u
          on u.workspace_id = p.workspace_id
          and u.project_id = p.id
        join decisions d
          on d.workspace_id = u.workspace_id
          and d.project_id = u.project_id
          and d.unit_id = u.id
          and d.version = u.accepted_version
          and d.decision = 'approve'
        join obligations b
          on b.workspace_id = d.workspace_id
          and b.project_id = d.project_id
          and b.unit_id = d.unit_id
          and b.version = d.version
          and b.collectible
        left join payer_nominations n
          on n.workspace_id = b.workspace_id
          and n.project_id = b.project_id
          and n.obligation_id = b.id
        where p.workspace_id = ${scope.workspaceId}
          and p.id = ${scope.projectId}
          and u.id = ${unitId}
          and u.current_version = ${version}
          and u.accepted_version = ${version}
        limit 2
      `.execute(database.kysely)).rows;
      const row = rows.length === 1 ? rows[0] : null;
      if (!row) return null;
      const nomination = row.payer_actor_id
        && row.payer_epoch
        && row.continuity_epoch
        && row.payer_active !== null
        ? {
          actorId: row.payer_actor_id,
          payerEpoch: row.payer_epoch,
          nominationEpoch: row.continuity_epoch,
          active: row.payer_active,
        }
        : null;
      return {
        obligationId: row.obligation_id,
        nominationEpoch: row.nomination_epoch,
        nomination,
      };
    },
    nominatePayer: (obligationId) => store.nominatePayer(
      nominationActor,
      {
        commandId: randomUUID(),
        obligationId,
        payerId: payerActor.actorId,
        active: true,
        continuityConfirmed: true,
        basis: nominationBasis,
      },
    ),
    loadAttempt: async (obligationId): Promise<PaymentAttemptSnapshot | null> => {
      const attempts = (await sql<{
        attempt_id: string;
        state: PaymentAttemptSnapshot["state"];
        order_id: string | null;
      }>`
        select id::text as attempt_id,state,order_id
        from attempts
        where workspace_id = ${scope.workspaceId}
          and project_id = ${scope.projectId}
          and obligation_id = ${obligationId}
        order by created_at desc
        limit 2
      `.execute(database.kysely)).rows;
      const attempt = attempts[0];
      if (!attempt) return null;
      const operations = (await sql<{
        operation_id: string;
        kind: "create" | "capture";
        state: "intent" | "admitted" | "pending" | "unknown" | "result";
        approval_url: string | null;
        capture_id: string | null;
      }>`
        select o.id::text as operation_id,o.kind,o.state,l.approval_url,
          coalesce(
            f.capture_id,
            (
              select observation.payload->>'captureId'
              from observations observation
              where observation.workspace_id = o.workspace_id
                and observation.project_id = o.project_id
                and observation.operation_id = o.id
                and observation.matches_basis
                and observation.payload ? 'captureId'
              order by observation.recorded_at desc
              limit 1
            )
          ) as capture_id
        from operations o
        left join paypal_approval_links l
          on l.workspace_id = o.workspace_id
          and l.project_id = o.project_id
          and l.operation_id = o.id
        left join payment_facts f
          on f.workspace_id = o.workspace_id
          and f.project_id = o.project_id
          and f.operation_id = o.id
        where o.workspace_id = ${scope.workspaceId}
          and o.project_id = ${scope.projectId}
          and o.attempt_id = ${attempt.attempt_id}::uuid
        order by o.created_at
      `.execute(database.kysely)).rows;
      return {
        attemptId: attempt.attempt_id,
        state: attempt.state,
        orderId: attempt.order_id,
        operations: operations.map((candidate) => ({
          operationId: candidate.operation_id,
          kind: candidate.kind,
          state: candidate.state,
          approvalUrl: candidate.approval_url,
          captureId: candidate.capture_id,
        })),
      };
    },
    initiatePayment: (payer, commandId) => store.initiatePayment(
      payer,
      { commandId },
    ),
    requestCapture: (payer, commandId, attemptId, orderId) =>
      store.requestCapture(payer, {
        commandId,
        attemptId,
        orderId,
      }),
    claimOperation: (operationId) => store.claimOperation(scope, {
      operationId,
      leaseMilliseconds: 60_000,
    }),
    dispatchOperation: async (lease, payer: Payer) => {
      if (!client) {
        throw Object.assign(
          new Error("PayPal provider configuration is unavailable"),
          { code: "PAYMENT_PROVIDER_CONFIG_UNAVAILABLE" },
        );
      }
      const worker = new PayPalPaymentWorker(
        store,
        client,
        approvalLinks,
      );
      const result = await worker.run(lease, payer);
      return {
        approvalUrl: result.approvalLink?.approvalUrl ?? null,
      };
    },
    reconcileCapture: async (target) => {
      if (!client) {
        throw Object.assign(
          new Error("PayPal provider configuration is unavailable"),
          { code: "PAYMENT_PROVIDER_CONFIG_UNAVAILABLE" },
        );
      }
      const reconciler = new PayPalCaptureReconciler(store, client);
      return reconciler.reconcileKnownCapture(scope, target);
    },
    reconcileOrderCapture: async (target) => {
      if (!client) {
        throw Object.assign(
          new Error("PayPal provider configuration is unavailable"),
          { code: "PAYMENT_PROVIDER_CONFIG_UNAVAILABLE" },
        );
      }
      const reconciler = new PayPalCaptureReconciler(store, client);
      return reconciler.reconcileOrderCapture(scope, target);
    },
    inspectReadiness: async () => (
      await store.inspectUnit(payerActor, unitId)
    ).readiness,
    createCommandId: randomUUID,
  };
  return { ok: true, dependencies };
}
