import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  LocalEmailError,
  MailpitEmailClient,
  localEmailConfigFromEnvironment,
} from "@scopeledger/email-adapter";
import {
  MailpitNotificationDelivery,
} from "../../../packages/notifications/src/index.js";

test("local notification delivery stays inside reserved Mailpit recipients", async () => {
  const api = process.env.EMAIL_MAILPIT_API;
  const recipient = process.env.EMAIL_DEMO_RECIPIENT;
  assert.ok(api, "EMAIL_MAILPIT_API is required for the local SMTP boundary");
  assert.ok(recipient, "EMAIL_DEMO_RECIPIENT is required for local SMTP");
  const email = new MailpitEmailClient(localEmailConfigFromEnvironment());
  const delivery = new MailpitNotificationDelivery(email, api);
  const messageId = randomUUID();
  await delivery.send({
    kind: "project-notification",
    messageId,
    recipient,
    purpose: "provider-question-responded",
    recipientRole: "client-approver",
    projectReference: "synthetic-project",
    attributedActorId: "synthetic-provider",
    occurredAt: "2026-11-12T17:00:00.000Z",
    details: {
      questionId: randomUUID(),
      unitId: "unit-a",
      unitVersion: 1,
      responseRevision: 1,
      status: "answered",
    },
  });
  assert.equal(await delivery.hasCaptured(messageId, recipient), true);

  await assert.rejects(
    email.send({
      kind: "project-notification",
      messageId: randomUUID(),
      recipient: "person@example.com",
      purpose: "provider-question-responded",
      recipientRole: "client-approver",
      projectReference: "synthetic-project",
      attributedActorId: "synthetic-provider",
      occurredAt: "2026-11-12T17:00:00.000Z",
      details: {
        questionId: randomUUID(),
        unitId: "unit-a",
        unitVersion: 1,
        responseRevision: 1,
        status: "answered",
      },
    }),
    (error: unknown) => error instanceof LocalEmailError
      && error.code === "INVALID_MESSAGE",
  );
});
