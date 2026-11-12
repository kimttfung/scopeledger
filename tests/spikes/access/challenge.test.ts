import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccessError,
  FileAccessStore,
} from "@scopeledger/access";

function fixture(root: string, start = Date.parse("2026-11-11T12:00:00Z")) {
  let now = start;
  const codes = ["123456", "234567", "345678", "456789"];
  const store = new FileAccessStore({
    rootDirectory: root,
    secret: "a".repeat(64),
    clock: () => new Date(now),
    codeGenerator: () => {
      const code = codes.shift();
      assert.ok(code);
      return code;
    },
  });
  return {
    store,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

test("codes are stored only as digests and successful sessions contain no email", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeledger-access-"));
  const f = fixture(root);
  try {
    const issued = await f.store.issue({
      recipient: "client@scopeledger.test",
      role: "client-approver",
    });
    const record = await readFile(join(root, `${issued.challengeId}.json`), "utf8");
    assert.equal(record.includes("123456"), false);
    assert.match(record, /"codeDigest":"[a-f0-9]{64}"/);
    const session = await f.store.verify({
      challengeId: issued.challengeId,
      code: "123456",
    });
    assert.equal("recipient" in session, false);
    assert.equal(session.role, "client-approver");
    const token = f.store.mintSession(session);
    assert.deepEqual(f.store.readSession(token), session);
    assert.equal(f.store.readSession(`${token}tampered`), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("new challenges supersede active older codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeledger-access-"));
  const f = fixture(root);
  try {
    const old = await f.store.issue({
      recipient: "client@scopeledger.test",
      role: "client-approver",
    });
    const current = await f.store.issue({
      recipient: "client@scopeledger.test",
      role: "client-approver",
    });
    await assert.rejects(
      () => f.store.verify({ challengeId: old.challengeId, code: "123456" }),
      (error: unknown) => error instanceof AccessError
        && error.code === "SUPERSEDED",
    );
    assert.equal((await f.store.verify({
      challengeId: current.challengeId,
      code: "234567",
    })).role, "client-approver");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrong codes consume bounded attempts and expiration fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeledger-access-"));
  const f = fixture(root);
  try {
    const issued = await f.store.issue({
      recipient: "payer@scopeledger.test",
      role: "payer",
    });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await assert.rejects(
        () => f.store.verify({
          challengeId: issued.challengeId,
          code: "000000",
        }),
        (error: unknown) => error instanceof AccessError
          && error.code === (attempt === 5
            ? "ATTEMPTS_EXHAUSTED"
            : "CODE_MISMATCH"),
      );
    }
    const expiring = await f.store.issue({
      recipient: "client2@scopeledger.test",
      role: "client-approver",
    });
    f.advance(10 * 60_000);
    await assert.rejects(
      () => f.store.verify({
        challengeId: expiring.challengeId,
        code: "234567",
      }),
      (error: unknown) => error instanceof AccessError
        && error.code === "EXPIRED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("challenge issuance is rate limited per local recipient and role", async () => {
  const root = await mkdtemp(join(tmpdir(), "scopeledger-access-"));
  const f = fixture(root);
  try {
    for (let count = 0; count < 3; count += 1) {
      await f.store.issue({
        recipient: "client@scopeledger.test",
        role: "client-approver",
      });
    }
    await assert.rejects(
      () => f.store.issue({
        recipient: "client@scopeledger.test",
        role: "client-approver",
      }),
      (error: unknown) => error instanceof AccessError
        && error.code === "RATE_LIMITED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
