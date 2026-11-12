import { randomInt, randomUUID } from "node:crypto";
import {
  MailpitEmailClient,
  localEmailConfigFromEnvironment,
} from "@scopeledger/email-adapter";

const recipient = process.env.EMAIL_DEMO_RECIPIENT;
if (!recipient) throw new Error("EMAIL_DEMO_RECIPIENT is required");

const messageId = randomUUID();
const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
const client = new MailpitEmailClient(localEmailConfigFromEnvironment());

const result = await client.send({
  kind: "verification-code",
  messageId,
  recipient,
  code,
  purpose: "client-access",
  expiresAt,
});

const apiOrigin = new URL(process.env.EMAIL_MAILPIT_API ?? "http://127.0.0.1:8025");
if (
  apiOrigin.protocol !== "http:"
  || !["127.0.0.1", "localhost", "::1"].includes(apiOrigin.hostname)
) {
  throw new Error("EMAIL_MAILPIT_API must use local loopback HTTP");
}
const response = await fetch(new URL("/api/v1/messages?limit=100", apiOrigin));
if (!response.ok) throw new Error("Mailpit message API was unavailable");
const inbox = await response.json();
const messages = Array.isArray(inbox.messages) ? inbox.messages : [];
const captured = messages.find((message) =>
  message.MessageID === `${messageId}@scopeledger.test`
  || message.MessageID === `<${messageId}@scopeledger.test>`
);
if (!captured) throw new Error("Mailpit did not capture the sent message");

console.log(JSON.stringify({
  delivered: result.accepted.includes(recipient),
  rejectedCount: result.rejected.length,
  captured: true,
  subject: captured.Subject,
  recipient,
  inboxUrl: apiOrigin.origin,
  verificationCodePrinted: false,
}, null, 2));
