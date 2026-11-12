import { createHash } from "node:crypto";
import { cookies } from "next/headers";
import { AccessSessionCodec } from "@scopeledger/access";
import {
  PostgresPayPalApprovalLinkStore,
  sql,
} from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import {
  parsePayPalConfig,
  payPalConfigFromEnvironment,
  PayPalSandboxClient,
} from "@scopeledger/paypal-adapter";
import {
  PayPalCaptureReconciler,
  PayPalPaymentWorker,
} from "@scopeledger/payment-worker";
import {
  localAccessRuntime,
  requireSameOrigin,
} from "../../../lib/local-access";
import { protocolDatabase } from "../../../lib/protocol-database";
import {
  customPaymentActors,
  loadPayerPaymentTarget,
  type ApprovedPaymentTarget,
  type PaymentLocators,
} from "./database";
import {
  payerPagePath,
  type CustomPaymentDependencies,
  type PaymentAttemptSnapshot,
} from "./service";
import { ReviewLocatorCodec } from "../review/service";

function deterministicUuid(parts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex");
  const variant = (
    (Number.parseInt(hex[16]!, 16) & 0x3) | 0x8
  ).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function appBaseUrl(): URL {
  const value = process.env.APP_BASE_URL;
  if (!value) throw new Error("APP_BASE_URL is unavailable");
  const url = new URL(value);
  if (
    url.username
    || url.password
    || url.hash
    || (
      url.protocol !== "https:"
      && !(
        url.protocol === "http:"
        && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      )
    )
  ) {
    throw new Error("APP_BASE_URL is invalid");
  }
  return url;
}

function providerClient(locators: PaymentLocators): PayPalSandboxClient {
  const base = payPalConfigFromEnvironment();
  const payerPath = payerPagePath(locators);
  return new PayPalSandboxClient(parsePayPalConfig({
    ...base,
    returnUrl: new URL(`${payerPath}/return`, appBaseUrl()).toString(),
    cancelUrl: new URL(`${payerPath}/cancel`, appBaseUrl()).toString(),
  }));
}

export function customPaymentDependencies(): CustomPaymentDependencies | null {
  const access = localAccessRuntime();
  const database = protocolDatabase();
  const secret = process.env.ACCESS_SESSION_SECRET;
  if (!access || !database || !secret) return null;
  const codec = new ReviewLocatorCodec(secret);
  const expectedSubject = new AccessSessionCodec(secret).subject(
    access.payerRecipient,
    "payer",
  );
  const store = new OrderedConsentStore(database);
  const approvalLinks = new PostgresPayPalApprovalLinkStore(database);

  return Object.freeze({
    requireSameOrigin,
    readSession: async () => {
      const token = (await cookies()).get(access.cookieName)?.value;
      return access.store.readSession(token);
    },
    loadTarget: (locators, session) => loadPayerPaymentTarget({
      database,
      codec,
      locators,
      subject: session.subject,
      expectedSubject,
    }),
    loadAttempt: async (
      target: ApprovedPaymentTarget,
    ): Promise<PaymentAttemptSnapshot | null> => {
      const attempts = (await sql<{
        attempt_id: string;
        state: PaymentAttemptSnapshot["state"];
        order_id: string | null;
      }>`select id::text as attempt_id,state,order_id
        from attempts
        where workspace_id = ${target.workspaceId}
          and project_id = ${target.projectId}
          and obligation_id = ${target.obligationId}
        order by created_at desc
        limit 2`
        .execute(database.kysely)).rows;
      if (attempts.length > 1) {
        throw Object.assign(new Error("Duplicate payment attempts"), {
          code: "STALE_RECORD",
        });
      }
      const attempt = attempts[0];
      if (!attempt) return null;
      const operations = (await sql<{
        operation_id: string;
        kind: "create" | "capture";
        state: "intent" | "admitted" | "pending" | "unknown" | "result";
        approval_url: string | null;
        capture_id: string | null;
      }>`select o.id::text as operation_id,o.kind,o.state,l.approval_url,
          coalesce(
            fact.capture_id,
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
        left join payment_facts fact
          on fact.workspace_id = o.workspace_id
          and fact.project_id = o.project_id
          and fact.operation_id = o.id
        where o.workspace_id = ${target.workspaceId}
          and o.project_id = ${target.projectId}
          and o.attempt_id = ${attempt.attempt_id}::uuid
        order by o.created_at`
        .execute(database.kysely)).rows;
      return Object.freeze({
        attemptId: attempt.attempt_id,
        state: attempt.state,
        orderId: attempt.order_id,
        operations: Object.freeze(operations.map((candidate) =>
          Object.freeze({
            operationId: candidate.operation_id,
            kind: candidate.kind,
            state: candidate.state,
            approvalUrl: candidate.approval_url,
            captureId: candidate.capture_id,
          }))),
      });
    },
    initiatePayment: (target, commandId) =>
      store.initiatePayment(target.payer!, { commandId }),
    requestCapture: (target, commandId, attemptId, orderId) =>
      store.requestCapture(target.payer!, {
        commandId,
        attemptId,
        orderId,
      }),
    claimOperation: (target, operationId) => store.claimOperation({
      workspaceId: target.workspaceId,
      projectId: target.projectId,
    }, {
      operationId,
      leaseMilliseconds: 60_000,
    }),
    dispatchOperation: async (target, locators, lease) => {
      const worker = new PayPalPaymentWorker(
        store,
        providerClient(locators),
        approvalLinks,
      );
      const result = await worker.run(lease, target.payer!);
      return {
        approvalUrl: result.approvalLink?.approvalUrl ?? null,
      };
    },
    reconcileCapture: (target, capture) =>
      new PayPalCaptureReconciler(
        store,
        providerClient({
          projectLocator: codec.project(
            target.workspaceId,
            target.projectId,
          ),
          requestLocator: codec.request(
            target.workspaceId,
            target.projectId,
            target.requestId,
          ),
          unitLocator: codec.unit(
            target.workspaceId,
            target.projectId,
            target.requestId,
            target.unitId,
          ),
          payerLocator: codec.payer(
            target.workspaceId,
            target.projectId,
            target.requestId,
            target.unitId,
            target.version,
            target.digest,
            target.obligationId,
            customPaymentActors.payerActorId,
          ),
        }),
      ).reconcileKnownCapture({
        workspaceId: target.workspaceId,
        projectId: target.projectId,
      }, capture),
    reconcileOrderCapture: (target, capture) =>
      new PayPalCaptureReconciler(
        store,
        providerClient({
          projectLocator: codec.project(
            target.workspaceId,
            target.projectId,
          ),
          requestLocator: codec.request(
            target.workspaceId,
            target.projectId,
            target.requestId,
          ),
          unitLocator: codec.unit(
            target.workspaceId,
            target.projectId,
            target.requestId,
            target.unitId,
          ),
          payerLocator: codec.payer(
            target.workspaceId,
            target.projectId,
            target.requestId,
            target.unitId,
            target.version,
            target.digest,
            target.obligationId,
            customPaymentActors.payerActorId,
          ),
        }),
      ).reconcileOrderCapture({
        workspaceId: target.workspaceId,
        projectId: target.projectId,
      }, capture),
    inspectReadiness: async (target) => (
      await store.inspectUnit({
        workspaceId: target.workspaceId,
        projectId: target.projectId,
        actorId: customPaymentActors.providerActorId,
        grantEpoch: target.providerInspectGrantEpoch,
      }, target.unitId)
    ).readiness,
    createCommandId: (kind, target) => deterministicUuid([
      "scopeledger.custom-payment-operation.v1",
      kind,
      target.workspaceId,
      target.projectId,
      target.requestId,
      target.unitId,
      String(target.version),
      target.digest,
      target.obligationId,
      customPaymentActors.payerActorId,
      String(target.payer?.grantEpoch ?? 0),
      String(target.payer?.payerEpoch ?? 0),
      String(target.projectNominationEpoch),
    ]),
  });
}
