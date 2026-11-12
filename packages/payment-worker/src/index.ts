import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  commandIdentifier,
  identifier,
  parseInput,
  z,
} from "@scopeledger/contracts";
import type {
  Lease,
  Payer,
  PaymentObservation,
} from "@scopeledger/contracts";
import type {
  DispatchAdmission,
} from "@scopeledger/domain";
import type {
  PayPalCaptureDetails,
  PayPalExecutionResult,
} from "@scopeledger/paypal-adapter";
import {
  captureNormalizationAdmission,
} from "./reconciliation-admission.js";

export * from "./reconciliation-admission.js";
export * from "./webhook-processor.js";

export type PaymentWorkerErrorCode =
  | "APPROVAL_LINK_INVALID"
  | "APPROVAL_LINK_STORAGE_FAILED"
  | "RECONCILIATION_TARGET_MISMATCH";

export class PaymentWorkerError extends Error {
  constructor(
    public readonly code: PaymentWorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PaymentWorkerError";
  }
}

export interface PaymentDispatchStore {
  dispatch(
    lease: Lease,
    payer: Payer,
    transport: (
      admission: DispatchAdmission,
    ) => Promise<PaymentObservation>,
  ): Promise<DispatchAdmission>;
}

export interface PayPalPaymentClient {
  execute(admission: unknown): Promise<PayPalExecutionResult>;
}

type Scope = {
  readonly workspaceId: string;
  readonly projectId: string;
};

export interface CaptureReconciliationStore {
  captureReconciliationAdmission(
    scope: Scope,
    orderId: string,
  ): Promise<DispatchAdmission>;
  recordObservation(
    scope: Scope,
    observation: PaymentObservation,
  ): Promise<{ matchesBasis: boolean; completed: boolean }>;
}

export interface PayPalCaptureReconciliationClient {
  retrieveCaptureDetails(captureId: string): Promise<PayPalCaptureDetails>;
  captureObservationFromDetails(
    admission: DispatchAdmission,
    details: PayPalCaptureDetails,
  ): PaymentObservation;
}

const approvalLinkSchema = z.strictObject({
  workspaceId: identifier,
  projectId: identifier,
  operationId: commandIdentifier,
  orderId: identifier,
  approvalUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.origin === "https://www.sandbox.paypal.com"
      && !url.username
      && !url.password;
  }, "Expected a validated PayPal sandbox approval URL"),
});

export type ApprovalLink = Readonly<z.infer<typeof approvalLinkSchema>>;

export interface ApprovalLinkStore {
  save(link: ApprovalLink): Promise<void>;
}

export type PaymentWorkerResult = Readonly<{
  admission: DispatchAdmission;
  approvalLink: ApprovalLink | null;
}>;

export class PayPalPaymentWorker {
  constructor(
    private readonly store: PaymentDispatchStore,
    private readonly client: PayPalPaymentClient,
    private readonly approvalLinks: ApprovalLinkStore,
  ) {}

  async run(
    lease: Lease,
    payer: Payer,
  ): Promise<PaymentWorkerResult> {
    const execution: {
      create: Extract<PayPalExecutionResult, { kind: "create" }> | null;
    } = { create: null };
    const admission = await this.store.dispatch(
      lease,
      payer,
      async (dispatchAdmission) => {
        const result = await this.client.execute(dispatchAdmission);
        if (result.kind === "create") execution.create = result;
        return result.observation;
      },
    );

    let approvalLink: ApprovalLink | null = null;
    const createResult = execution.create;
    if (createResult !== null) {
      approvalLink = parseInput(approvalLinkSchema, {
        workspaceId: lease.workspaceId,
        projectId: lease.projectId,
        operationId: admission.operationId,
        orderId: createResult.observation.orderId,
        approvalUrl: createResult.approvalUrl,
      });
      await this.approvalLinks.save(approvalLink);
    }

    return Object.freeze({ admission, approvalLink });
  }
}

export class PayPalCaptureReconciler {
  constructor(
    private readonly store: CaptureReconciliationStore,
    private readonly client: PayPalCaptureReconciliationClient,
  ) {}

  async reconcile(
    scope: Scope,
    captureId: string,
  ): Promise<{
    readonly orderId: string;
    readonly matchesBasis: boolean;
    readonly completed: boolean;
  }> {
    const details = await this.client.retrieveCaptureDetails(captureId);
    const admission = await this.store.captureReconciliationAdmission(
      scope,
      details.orderId,
    );
    const observation = this.client.captureObservationFromDetails(
      captureNormalizationAdmission(admission),
      details,
    );
    const reduced = await this.store.recordObservation(scope, observation);
    return Object.freeze({
      orderId: details.orderId,
      ...reduced,
    });
  }

  async reconcileKnownCapture(
    scope: Scope,
    targetInput: Readonly<{
      operationId: string;
      orderId: string;
      captureId: string;
    }>,
  ): Promise<{
    readonly outcome: "pending" | "unknown" | "completed";
    readonly matchesBasis: boolean;
    readonly completed: boolean;
  }> {
    const target = parseInput(
      z.strictObject({
        operationId: commandIdentifier,
        orderId: identifier,
        captureId: identifier,
      }),
      targetInput,
    );
    const details = await this.client.retrieveCaptureDetails(target.captureId);
    if (
      details.captureId !== target.captureId
      || details.orderId !== target.orderId
    ) {
      throw new PaymentWorkerError(
        "RECONCILIATION_TARGET_MISMATCH",
        "Authoritative capture identity did not match the server-known payment attempt",
      );
    }
    const admission = await this.store.captureReconciliationAdmission(
      scope,
      target.orderId,
    );
    if (
      admission.operationId !== target.operationId
      || admission.kind !== "capture"
    ) {
      throw new PaymentWorkerError(
        "RECONCILIATION_TARGET_MISMATCH",
        "The server-known capture operation changed during reconciliation",
      );
    }
    const observation = this.client.captureObservationFromDetails(
      captureNormalizationAdmission(admission),
      details,
    );
    if (
      observation.operationId !== target.operationId
      || observation.orderId !== target.orderId
      || observation.captureId !== target.captureId
      || observation.outcome === "order-created"
    ) {
      throw new PaymentWorkerError(
        "RECONCILIATION_TARGET_MISMATCH",
        "Normalized capture evidence did not match the stable operation identity",
      );
    }
    const reduced = await this.store.recordObservation(scope, observation);
    return Object.freeze({
      outcome: observation.outcome,
      ...reduced,
    });
  }
}

type StoredApprovalLink = ApprovalLink & {
  readonly schemaVersion: "scopeledger.paypal-approval-link.v1";
  readonly storedAt: string;
};

export class FileApprovalLinkStore implements ApprovalLinkStore {
  private readonly root: string;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
  }

  async save(input: ApprovalLink): Promise<void> {
    const link = parseInput(approvalLinkSchema, input);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = resolve(this.root, `${link.operationId}.json`);
    if (!path.startsWith(`${this.root}/`)) {
      throw new PaymentWorkerError(
        "APPROVAL_LINK_STORAGE_FAILED",
        "Approval-link path escaped its configured store",
      );
    }
    const stored: StoredApprovalLink = Object.freeze({
      schemaVersion: "scopeledger.paypal-approval-link.v1",
      ...link,
      storedAt: new Date().toISOString(),
    });
    let file;
    try {
      file = await open(path, "wx", 0o600);
      await file.writeFile(`${JSON.stringify(stored)}\n`, "utf8");
      await file.sync();
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        const existing = JSON.parse(await readFile(path, "utf8")) as Partial<StoredApprovalLink>;
        if (
          existing.operationId === link.operationId
          && existing.orderId === link.orderId
          && existing.approvalUrl === link.approvalUrl
          && existing.workspaceId === link.workspaceId
          && existing.projectId === link.projectId
        ) {
          return;
        }
        throw new PaymentWorkerError(
          "APPROVAL_LINK_STORAGE_FAILED",
          "An operation cannot change its stored PayPal approval link",
        );
      }
      if (error instanceof PaymentWorkerError) throw error;
      throw new PaymentWorkerError(
        "APPROVAL_LINK_STORAGE_FAILED",
        "PayPal approval link could not be durably stored",
      );
    } finally {
      await file?.close();
    }
    try {
      const directory = await open(this.root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      throw new PaymentWorkerError(
        "APPROVAL_LINK_STORAGE_FAILED",
        "Approval-link store could not be durably synchronized",
      );
    }
  }
}
