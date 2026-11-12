import assert from "node:assert/strict";
import test from "node:test";
import { mailpitContainerArgs } from "../../scripts/run-mailpit.mjs";

test("Mailpit binds SMTP and UI only to loopback with an ownership label", () => {
  const args = mailpitContainerArgs();
  assert.ok(args.includes("127.0.0.1:8025:8025"));
  assert.ok(args.includes("127.0.0.1:1025:1025"));
  assert.ok(args.includes("scopeledger.mailpit.owner=scopeledger"));
  assert.equal(args.includes("--volume"), false);
  assert.equal(args.includes("--mount"), false);
});

test("Mailpit uses the pinned official image digest", () => {
  assert.ok(mailpitContainerArgs().includes(
    "axllent/mailpit:v1.27.4@sha256:df6c2541907e1be6fac21f509927cf6ed771617a1f4b361ef66d97bd05593d2d",
  ));
});
