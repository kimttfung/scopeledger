import {
  LocalEmailError,
  MailpitEmailClient,
} from "@scopeledger/email-adapter";
import type { LocalEmailMessage } from "@scopeledger/email-adapter";
import {
  NotificationPersistenceError,
  PostgresNotificationOutboxStore,
} from "@scopeledger/db";
import type {
  ClaimedNotification,
  NotificationRecipientRole,
} from "@scopeledger/db";

export type NotificationRecipient = Readonly<{
  actorId: string;
  address: string;
}>;

export type NotificationRecipientDirectory = Readonly<Record<
  NotificationRecipientRole,
  NotificationRecipient
>>;

export type NotificationDelivery = Readonly<{
  hasCaptured(messageId: string, recipient: string): Promise<boolean>;
  send(message: LocalEmailMessage): Promise<void>;
}>;

export type NotificationWorkerSummary = Readonly<{
  claimed: number;
  delivered: number;
  recovered: number;
  retried: number;
  suppressed: number;
  obsolete: number;
  manual: number;
}>;

const localHostnames = new Set(["127.0.0.1", "localhost", "::1"]);
const actorPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const localAddressPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@scopeledger[.]test$/iu;

function actorId(value: string | undefined, fallback: string): string {
  const resolved = value ?? fallback;
  if (!actorPattern.test(resolved)) {
    throw new Error("Notification recipient actor configuration is invalid");
  }
  return resolved;
}

function localAddress(value: string | undefined, name: string): string {
  if (!value || !localAddressPattern.test(value)) {
    throw new Error(`${name} must be a reserved scopeledger.test address`);
  }
  return value.toLowerCase();
}

export function notificationRecipientDirectoryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NotificationRecipientDirectory {
  return Object.freeze({
    provider: Object.freeze({
      actorId: actorId(
        environment.NOTIFICATION_PROVIDER_ACTOR_ID,
        "northstar-provider",
      ),
      address: localAddress(
        environment.EMAIL_DEMO_PROVIDER_RECIPIENT
          ?? "provider@scopeledger.test",
        "EMAIL_DEMO_PROVIDER_RECIPIENT",
      ),
    }),
    "client-approver": Object.freeze({
      actorId: actorId(
        environment.NOTIFICATION_CLIENT_APPROVER_ACTOR_ID,
        "cedar-approver",
      ),
      address: localAddress(
        environment.EMAIL_DEMO_RECIPIENT,
        "EMAIL_DEMO_RECIPIENT",
      ),
    }),
    payer: Object.freeze({
      actorId: actorId(
        environment.NOTIFICATION_PAYER_ACTOR_ID,
        "cedar-payer",
      ),
      address: localAddress(
        environment.EMAIL_DEMO_PAYER_RECIPIENT,
        "EMAIL_DEMO_PAYER_RECIPIENT",
      ),
    }),
  });
}

function mailpitOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || !localHostnames.has(url.hostname)
    || url.username
    || url.password
    || url.hash
  ) {
    throw new Error("Mailpit notification lookup must use loopback HTTP");
  }
  return new URL(url.origin);
}

function normalizedMessageId(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/^<|>$/gu, "").toLowerCase()
    : "";
}

export class MailpitNotificationDelivery implements NotificationDelivery {
  private readonly origin: URL;

  constructor(
    private readonly email: MailpitEmailClient,
    mailpitApiUrl: string,
  ) {
    this.origin = mailpitOrigin(mailpitApiUrl);
  }

  async hasCaptured(messageId: string, recipient: string): Promise<boolean> {
    const response = await fetch(new URL("/api/v1/messages?limit=100", this.origin), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error("Mailpit notification lookup failed");
    }
    const body: unknown = await response.json();
    if (
      !body
      || typeof body !== "object"
      || !("messages" in body)
      || !Array.isArray(body.messages)
      || body.messages.length > 100
    ) {
      throw new Error("Mailpit notification lookup returned invalid data");
    }
    const expectedId = `${messageId.toLowerCase()}@scopeledger.test`;
    const expectedRecipient = recipient.toLowerCase();
    return body.messages.some((message: unknown) => {
      if (!message || typeof message !== "object") return false;
      const candidate = message as {
        MessageID?: unknown;
        To?: unknown;
      };
      if (normalizedMessageId(candidate.MessageID) !== expectedId) {
        return false;
      }
      return Array.isArray(candidate.To)
        && candidate.To.some((entry: unknown) =>
          entry
          && typeof entry === "object"
          && "Address" in entry
          && typeof entry.Address === "string"
          && entry.Address.toLowerCase() === expectedRecipient);
    });
  }

  async send(message: LocalEmailMessage): Promise<void> {
    const result = await this.email.send(message);
    if (
      !result.accepted.includes(message.recipient)
      || result.rejected.length !== 0
    ) {
      throw new LocalEmailError(
        "DELIVERY_FAILED",
        "Local SMTP did not accept the notification",
      );
    }
  }
}

function notificationMessage(
  claim: ClaimedNotification,
  receiptMessageId: string,
  recipient: string,
): LocalEmailMessage {
  return {
    kind: "project-notification",
    messageId: receiptMessageId,
    recipient,
    purpose: claim.purpose,
    recipientRole: claim.recipientRole,
    projectReference: claim.projectId,
    attributedActorId: claim.attributedActorId,
    occurredAt: claim.enqueuedAt.toISOString(),
    details: claim.payload,
  };
}

function deliveryErrorCode(error: unknown): string {
  if (error instanceof LocalEmailError) {
    switch (error.code) {
      case "INVALID_CONFIG":
        return "EMAIL_CONFIG_INVALID";
      case "INVALID_MESSAGE":
        return "EMAIL_MESSAGE_INVALID";
      case "DELIVERY_FAILED":
        return "SMTP_DELIVERY_FAILED";
    }
  }
  return error instanceof NotificationPersistenceError
    ? "OUTBOX_STATE_CHANGED"
    : "DELIVERY_UNCERTAIN";
}

function permanentDeliveryError(error: unknown): boolean {
  return error instanceof LocalEmailError
    && (error.code === "INVALID_CONFIG" || error.code === "INVALID_MESSAGE");
}

export class NotificationWorker {
  private readonly backoffMilliseconds: readonly number[];

  constructor(
    private readonly store: PostgresNotificationOutboxStore,
    private readonly delivery: NotificationDelivery,
    private readonly directory: NotificationRecipientDirectory,
    private readonly options: Readonly<{
      workerId: string;
      leaseSeconds?: number;
      batchSize?: number;
      backoffMilliseconds?: readonly number[];
    }>,
  ) {
    const backoff = options.backoffMilliseconds
      ?? [30_000, 120_000, 600_000, 3_600_000];
    if (
      backoff.length < 1
      || backoff.length > 8
      || backoff.some((value) =>
        !Number.isInteger(value) || value < 1 || value > 86_400_000)
    ) {
      throw new Error("Notification retry backoff is invalid");
    }
    this.backoffMilliseconds = Object.freeze([...backoff]);
  }

  async runBatch(): Promise<NotificationWorkerSummary> {
    const claims = await this.store.claimBatch({
      workerId: this.options.workerId,
      ...(this.options.leaseSeconds === undefined
        ? {}
        : { leaseSeconds: this.options.leaseSeconds }),
      ...(this.options.batchSize === undefined
        ? {}
        : { limit: this.options.batchSize }),
    });
    const summary = {
      claimed: claims.length,
      delivered: 0,
      recovered: 0,
      retried: 0,
      suppressed: 0,
      obsolete: 0,
      manual: 0,
    };
    for (const claim of claims) {
      const recipient = this.directory[claim.recipientRole];
      let decision;
      try {
        decision = await this.store.recheckDispatch(claim, recipient.actorId);
      } catch {
        await this.retryOrManual(claim, "DISPATCH_RECHECK_FAILED");
        if (claim.attemptCount >= claim.maxAttempts) summary.manual += 1;
        else summary.retried += 1;
        continue;
      }
      if (decision.outcome === "suppressed") {
        await this.store.markSuppressed(claim, decision.reasonCode);
        summary.suppressed += 1;
        continue;
      }
      if (decision.outcome === "obsolete") {
        await this.store.markObsolete(claim, decision.reasonCode);
        summary.obsolete += 1;
        continue;
      }
      try {
        const receipt = await this.store.reserveReceipt(claim);
        if (
          receipt.status === "delivered"
          || await this.delivery.hasCaptured(
            receipt.messageId,
            recipient.address,
          )
        ) {
          await this.store.markDelivered(claim, true);
          summary.recovered += 1;
          continue;
        }
        await this.delivery.send(notificationMessage(
          claim,
          receipt.messageId,
          recipient.address,
        ));
        await this.store.markDelivered(claim, false);
        summary.delivered += 1;
      } catch (error) {
        const errorCode = deliveryErrorCode(error);
        if (permanentDeliveryError(error)) {
          await this.store.markManual(claim, errorCode);
          summary.manual += 1;
        } else {
          await this.retryOrManual(claim, errorCode);
          if (claim.attemptCount >= claim.maxAttempts) summary.manual += 1;
          else summary.retried += 1;
        }
      }
    }
    return Object.freeze(summary);
  }

  private async retryOrManual(
    claim: ClaimedNotification,
    errorCode: string,
  ): Promise<void> {
    if (claim.attemptCount >= claim.maxAttempts) {
      await this.store.markManual(claim, errorCode);
      return;
    }
    const index = Math.min(
      claim.attemptCount - 1,
      this.backoffMilliseconds.length - 1,
    );
    await this.store.scheduleRetry(
      claim,
      errorCode,
      this.backoffMilliseconds[index]!,
    );
  }
}
