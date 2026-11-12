import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeScopeLedgerEmail,
} from "../../../apps/web/lib/mailpit-message.js";

test("native email preview keeps safe formatting and strips active content", () => {
  const message = sanitizeScopeLedgerEmail({
    ID: "message-id",
    MessageID: "stable-id@scopeledger.test",
    Subject: "ScopeLedger client access verification code",
    From: {
      Name: "ScopeLedger",
      Address: "notifications@scopeledger.test",
    },
    To: [{ Name: "", Address: "client@scopeledger.test" }],
    Text: "Code 123456",
    HTML: '<p>Code <strong>123456</strong></p><script>alert(1)</script><a href="https://evil.example">link</a>',
  });
  assert.match(message.html, /<strong>123456<\/strong>/);
  assert.equal(message.html.includes("<script"), false);
  assert.equal(message.html.includes("href="), false);
});

test("native email preview rejects spoofed senders and external recipients", () => {
  for (const changed of [
    { from: "attacker@example.com", to: "client@scopeledger.test" },
    { from: "notifications@scopeledger.test", to: "person@example.com" },
  ]) {
    assert.throws(() => sanitizeScopeLedgerEmail({
      ID: "message-id",
      MessageID: "stable-id@scopeledger.test",
      Subject: "ScopeLedger client access verification code",
      From: { Name: "ScopeLedger", Address: changed.from },
      To: [{ Name: "", Address: changed.to }],
      Text: "Code",
      HTML: "<p>Code</p>",
    }));
  }
});
