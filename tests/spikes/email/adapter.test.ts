import assert from "node:assert/strict";
import test from "node:test";
import {
  MailpitEmailClient,
  LocalEmailError,
  parseLocalEmailConfig,
} from "@scopeledger/email-adapter";

test("local email configuration is loopback-only", () => {
  assert.deepEqual(parseLocalEmailConfig({
    transport: "mailpit",
    host: "127.0.0.1",
    port: 1025,
    from: "ScopeLedger <notifications@scopeledger.test>",
  }), {
    transport: "mailpit",
    host: "127.0.0.1",
    port: 1025,
    from: "ScopeLedger <notifications@scopeledger.test>",
  });

  test("local email rejects non-local recipients before SMTP", async () => {
    const client = new MailpitEmailClient({
      transport: "mailpit",
      host: "127.0.0.1",
      port: 65_534,
      from: "ScopeLedger <notifications@scopeledger.test>",
    });
    await assert.rejects(
      () => client.send({
        kind: "verification-code",
        messageId: "11111111-1111-4111-8111-111111111111",
        recipient: "real-person@example.com",
        code: "123456",
        purpose: "client-access",
        expiresAt: "2026-11-11T12:10:00Z",
      }),
      (error: unknown) => error instanceof LocalEmailError
        && error.code === "INVALID_MESSAGE",
    );
  });

  test("local invitations reject external or credential-bearing URLs", async () => {
    const client = new MailpitEmailClient({
      transport: "mailpit",
      host: "127.0.0.1",
      port: 65_534,
      from: "ScopeLedger <notifications@scopeledger.test>",
    });
    for (const invitationUrl of [
      "https://example.com/invite",
      "http://user:password@127.0.0.1:3000/invite",
      "http://127.0.0.1:3000/invite#secret",
    ]) {
      await assert.rejects(
        () => client.send({
          kind: "invitation-link",
          messageId: "22222222-2222-4222-8222-222222222222",
          recipient: "client@scopeledger.test",
          invitationUrl,
          role: "client-approver",
          expiresAt: "2026-11-11T12:10:00Z",
        }),
        (error: unknown) => error instanceof LocalEmailError
          && error.code === "INVALID_MESSAGE",
      );
    }
  });
  assert.throws(() => parseLocalEmailConfig({
    transport: "mailpit",
    host: "smtp.example.com",
    port: 587,
    from: "ScopeLedger <notifications@scopeledger.test>",
  }), LocalEmailError);
});
