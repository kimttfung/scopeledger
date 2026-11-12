import sanitizeHtml from "sanitize-html";
import { z } from "zod";

const addressSchema = z.looseObject({
  Name: z.string(),
  Address: z.email(),
});

const summarySchema = z.looseObject({
  ID: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  MessageID: z.string().min(1).max(512),
  Subject: z.string().min(1).max(512),
});

const messagesSchema = z.looseObject({
  messages: z.array(summarySchema),
});

const messageSchema = z.looseObject({
  ID: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  MessageID: z.string().min(1).max(512),
  Subject: z.string().min(1).max(512),
  From: addressSchema,
  To: z.array(addressSchema).min(1).max(10),
  HTML: z.string().max(100_000),
  Text: z.string().max(100_000),
});

export type CapturedEmail = Readonly<{
  id: string;
  subject: string;
  html: string;
  text: string;
}>;

function mailpitOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.username
    || url.password
  ) {
    throw new Error("Mailpit origin must use loopback HTTP");
  }
  return url;
}

function normalizeMessageId(value: string): string {
  return value.replace(/^<|>$/g, "");
}

export async function findCapturedEmailId(
  apiOrigin: string,
  stableMessageId: string,
): Promise<string | null> {
  const origin = mailpitOrigin(apiOrigin);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(
      new URL("/api/v1/messages?limit=100", origin),
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Mailpit message list was unavailable");
    const parsed = messagesSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Mailpit message list was invalid");
    const match = parsed.data.messages.find(
      (message) => normalizeMessageId(message.MessageID)
        === `${stableMessageId}@scopeledger.test`,
    );
    if (match) return match.ID;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export function sanitizeScopeLedgerEmail(input: unknown): CapturedEmail {
  const parsed = messageSchema.safeParse(input);
  if (!parsed.success) throw new Error("Captured email is invalid");
  const message = parsed.data;
  if (
    message.From.Address !== "notifications@scopeledger.test"
    || !message.Subject.startsWith("ScopeLedger ")
    || !normalizeMessageId(message.MessageID).endsWith("@scopeledger.test")
    || message.To.some(
      (recipient) => !recipient.Address.endsWith("@scopeledger.test"),
    )
  ) {
    throw new Error("Captured email is outside the ScopeLedger local boundary");
  }
  return Object.freeze({
    id: message.ID,
    subject: message.Subject,
    text: message.Text,
    html: sanitizeHtml(message.HTML, {
      allowedTags: ["p", "strong", "em", "br", "ul", "ol", "li", "a"],
      allowedAttributes: {},
      disallowedTagsMode: "discard",
      allowProtocolRelative: false,
    }),
  });
}

export async function readCapturedEmail(
  apiOrigin: string,
  messageId: string,
): Promise<CapturedEmail> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(messageId)) {
    throw new Error("Mailpit message ID is invalid");
  }
  const response = await fetch(
    new URL(`/api/v1/message/${messageId}`, mailpitOrigin(apiOrigin)),
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("Mailpit message was unavailable");
  return sanitizeScopeLedgerEmail(await response.json());
}
