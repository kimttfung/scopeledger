import nodemailer from "nodemailer";
import { z } from "zod";

export type LocalEmailErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_MESSAGE"
  | "DELIVERY_FAILED";

export class LocalEmailError extends Error {
  constructor(
    public readonly code: LocalEmailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalEmailError";
  }
}

const localHost = z.enum(["127.0.0.1", "localhost", "::1"]);
const localAddress = z.email().refine(
  (value) => value.toLowerCase().endsWith("@scopeledger.test"),
  "Local Mailpit recipients must use the reserved scopeledger.test domain",
);
const sender = z.string().regex(
  /^ScopeLedger <notifications@scopeledger\.test>$/,
);

const configSchema = z.strictObject({
  transport: z.literal("mailpit"),
  host: localHost,
  port: z.number().int().min(1).max(65_535),
  from: sender,
});

export type LocalEmailConfig = z.infer<typeof configSchema>;

export function parseLocalEmailConfig(input: unknown): LocalEmailConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new LocalEmailError(
      "INVALID_CONFIG",
      `Local email configuration is invalid: ${parsed.error.issues.map((issue) => issue.path.join(".") || "$").join(", ")}`,
    );
  }
  return parsed.data;
}

export function localEmailConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): LocalEmailConfig {
  return parseLocalEmailConfig({
    transport: environment.EMAIL_TRANSPORT,
    host: environment.EMAIL_SMTP_HOST,
    port: Number(environment.EMAIL_SMTP_PORT),
    from: environment.EMAIL_FROM,
  });
}

const messageIdentitySchema = z.strictObject({
  messageId: z.uuid(),
  recipient: localAddress,
});
const baseMessageSchema = messageIdentitySchema.extend({
  expiresAt: z.iso.datetime(),
});

const verificationMessageSchema = baseMessageSchema.extend({
  kind: z.literal("verification-code"),
  code: z.string().regex(/^[0-9]{6}$/),
  purpose: z.enum(["client-access", "payer-access"]),
});

const invitationMessageSchema = baseMessageSchema.extend({
  kind: z.literal("invitation-link"),
  invitationUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      && !url.username
      && !url.password
      && !url.hash;
  }, "Local invitation links must use loopback HTTP"),
  role: z.enum(["client-approver", "context-contributor", "payer"]),
});

const notificationPurpose = z.enum([
  "client-question-submitted",
  "client-correction-submitted",
  "provider-question-responded",
  "provider-correction-assessed",
  "provider-reissue-published",
  "participant-authority-activated",
  "participant-authority-revoked",
  "participant-authority-restored",
  "payment-exception-observed",
]);
const notificationDetailValue = z.union([
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  z.null(),
]);
const notificationDetailKeys = new Set([
  "questionId",
  "requestId",
  "unitId",
  "unitVersion",
  "concernId",
  "responseRevision",
  "status",
  "assessmentRevision",
  "applicability",
  "reissueDraftRevision",
  "version",
  "previousVersion",
  "role",
  "change",
  "resourceId",
  "authorityEpoch",
  "observationSequence",
  "kind",
  "state",
]);
const notificationKeysByPurpose: Readonly<Record<
  z.infer<typeof notificationPurpose>,
  readonly string[]
>> = Object.freeze({
  "client-question-submitted": [
    "questionId", "requestId", "unitId", "unitVersion",
  ],
  "client-correction-submitted": [
    "concernId", "requestId", "unitId", "unitVersion",
  ],
  "provider-question-responded": [
    "questionId", "responseRevision", "status", "unitId", "unitVersion",
  ],
  "provider-correction-assessed": [
    "applicability",
    "assessmentRevision",
    "concernId",
    "reissueDraftRevision",
    "unitId",
    "unitVersion",
  ],
  "provider-reissue-published": [
    "previousVersion", "unitId", "version",
  ],
  "participant-authority-activated": [
    "authorityEpoch", "change", "resourceId", "role", "unitId", "version",
  ],
  "participant-authority-revoked": [
    "authorityEpoch", "change", "resourceId", "role", "unitId", "version",
  ],
  "participant-authority-restored": [
    "authorityEpoch", "change", "resourceId", "role", "unitId", "version",
  ],
  "payment-exception-observed": [
    "kind", "observationSequence", "state", "unitId", "version",
  ],
});
const projectNotificationMessageSchema = messageIdentitySchema.extend({
  kind: z.literal("project-notification"),
  purpose: notificationPurpose,
  recipientRole: z.enum(["provider", "client-approver", "payer"]),
  projectReference: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/,
  ),
  attributedActorId: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/,
  ),
  occurredAt: z.iso.datetime(),
  details: z.record(z.string(), notificationDetailValue),
}).superRefine((value, context) => {
  const actual = Object.keys(value.details).sort();
  const expected = [...notificationKeysByPurpose[value.purpose]].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) =>
      key !== expected[index] || !notificationDetailKeys.has(key))
    || Buffer.byteLength(JSON.stringify(value.details), "utf8") > 4096
  ) {
    context.addIssue({
      code: "custom",
      path: ["details"],
      message: "Notification details are not template-safe",
    });
  }
});

const localMessageSchema = z.union([
  verificationMessageSchema,
  invitationMessageSchema,
  projectNotificationMessageSchema,
]);

export type LocalEmailMessage = z.infer<typeof localMessageSchema>;

export type LocalDeliveryResult = Readonly<{
  messageId: string;
  accepted: readonly string[];
  rejected: readonly string[];
}>;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMessage(message: LocalEmailMessage): {
  subject: string;
  text: string;
  html: string;
} {
  if (message.kind === "verification-code") {
    const purpose = message.purpose === "payer-access"
      ? "payer access"
      : "client access";
    return {
      subject: `ScopeLedger ${purpose} verification code`,
      text: [
        `Your ScopeLedger ${purpose} verification code is: ${message.code}`,
        `It expires at ${message.expiresAt}.`,
        "This code does not approve terms or authorize payment.",
      ].join("\n\n"),
      html: [
        `<p>Your ScopeLedger ${escapeHtml(purpose)} verification code is:</p>`,
        `<p><strong>${message.code}</strong></p>`,
        `<p>It expires at ${escapeHtml(message.expiresAt)}.</p>`,
        "<p>This code does not approve terms or authorize payment.</p>",
      ].join(""),
    };
  }
  if (message.kind === "invitation-link") return {
    subject: `ScopeLedger ${message.role} invitation`,
    text: [
      `Open this local ScopeLedger invitation: ${message.invitationUrl}`,
      `It expires at ${message.expiresAt}.`,
      "Opening the link does not approve terms or initiate payment.",
    ].join("\n\n"),
    html: [
      `<p>Open this local ScopeLedger ${escapeHtml(message.role)} invitation:</p>`,
      `<p><a href="${escapeHtml(message.invitationUrl)}">Open invitation</a></p>`,
      `<p>It expires at ${escapeHtml(message.expiresAt)}.</p>`,
      "<p>Opening the link does not approve terms or initiate payment.</p>",
    ].join(""),
  };
  const subjectByPurpose: Readonly<Record<typeof message.purpose, string>> = {
    "client-question-submitted": "Client question submitted",
    "client-correction-submitted": "Client correction submitted",
    "provider-question-responded": "Provider question response recorded",
    "provider-correction-assessed": "Provider correction assessment recorded",
    "provider-reissue-published": "Corrected terms published",
    "participant-authority-activated": "Participant authority activated",
    "participant-authority-revoked": "Participant authority revoked",
    "participant-authority-restored": "Participant authority restored",
    "payment-exception-observed": "Payment exception observed",
  };
  const detailLines = Object.entries(message.details)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}: ${String(value)}`);
  const detailHtml = Object.entries(message.details)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) =>
      `<li><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(value))}</li>`)
    .join("");
  return {
    subject: `ScopeLedger · ${subjectByPurpose[message.purpose]}`,
    text: [
      subjectByPurpose[message.purpose],
      `Project: ${message.projectReference}`,
      `Recipient role: ${message.recipientRole}`,
      `Recorded by: ${message.attributedActorId}`,
      `Recorded at: ${message.occurredAt}`,
      ...detailLines,
      "This notice does not approve terms, authorize payment, change readiness, or start work.",
    ].join("\n"),
    html: [
      `<p><strong>${escapeHtml(subjectByPurpose[message.purpose])}</strong></p>`,
      `<p>Project: ${escapeHtml(message.projectReference)}</p>`,
      `<p>Recipient role: ${escapeHtml(message.recipientRole)}</p>`,
      `<p>Recorded by: ${escapeHtml(message.attributedActorId)}</p>`,
      `<p>Recorded at: ${escapeHtml(message.occurredAt)}</p>`,
      `<ul>${detailHtml}</ul>`,
      "<p>This notice does not approve terms, authorize payment, change readiness, or start work.</p>",
    ].join(""),
  };
}

export class MailpitEmailClient {
  private readonly config: LocalEmailConfig;

  constructor(configInput: unknown) {
    this.config = parseLocalEmailConfig(configInput);
  }

  async send(input: unknown): Promise<LocalDeliveryResult> {
    const parsed = localMessageSchema.safeParse(input);
    if (!parsed.success) {
      throw new LocalEmailError(
        "INVALID_MESSAGE",
        `Local email message is invalid: ${parsed.error.issues.map((issue) => issue.path.join(".") || "$").join(", ")}`,
      );
    }
    const rendered = renderMessage(parsed.data);
    const transport = nodemailer.createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
    try {
      const result = await transport.sendMail({
        messageId: `<${parsed.data.messageId}@scopeledger.test>`,
        from: this.config.from,
        to: parsed.data.recipient,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: {
          "X-ScopeLedger-Message": parsed.data.messageId,
          "X-ScopeLedger-Purpose": parsed.data.kind === "project-notification"
            ? parsed.data.purpose
            : parsed.data.kind,
        },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return Object.freeze({
        messageId: parsed.data.messageId,
        accepted: Object.freeze(result.accepted.map(String)),
        rejected: Object.freeze(result.rejected.map(String)),
      });
    } catch {
      throw new LocalEmailError(
        "DELIVERY_FAILED",
        "Local SMTP delivery did not complete",
      );
    } finally {
      transport.close();
    }
  }
}
