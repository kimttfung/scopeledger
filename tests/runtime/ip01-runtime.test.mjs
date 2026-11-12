import assert from "node:assert/strict";
import test from "node:test";
import {
  postgresContainerArgs,
  redactDatabaseCredentials,
  validateProofDatabaseUrl,
  validateProofDatabaseState,
} from "../../scripts/run-ip01.mjs";

test("accepts only explicitly named proof databases", () => {
  assert.equal(validateProofDatabaseUrl("postgresql://127.0.0.1/scopeledger_ip01").pathname, "/scopeledger_ip01");
  assert.equal(validateProofDatabaseUrl("postgres://localhost:55432/scopeledger_ip01_abc123").port, "55432");
  for (const value of [
    "not-a-url",
    "https://example.test/scopeledger_ip01",
    "postgresql://localhost/app",
    "postgresql://localhost/scopeledger_ip01/other",
    "postgresql://localhost/scopeledger_ip01%2Fother",
    "postgresql://localhost/",
    "postgresql://localhost/" + "scopeledger_ip01_" + "x".repeat(64),
  ]) {
    assert.throws(() => validateProofDatabaseUrl(value));
  }
});

test("validation errors do not echo connection credentials", () => {
  const secret = "private-example-password";
  assert.throws(
    () => validateProofDatabaseUrl(`postgresql://proof:${secret}@localhost/production`),
    (error) => !String(error).includes(secret),
  );
});

test("checks the connected database identity, not only the URL path", () => {
  const valid = { database: "scopeledger_ip01_abc123", version: "17.0", fsync: "on", synchronousCommit: "on" };
  assert.equal(validateProofDatabaseState(valid), valid);
  for (const database of ["production", "app", "", null]) {
    assert.throws(() => validateProofDatabaseState({ ...valid, database }));
  }
  assert.throws(() => validateProofDatabaseState(null));
});

test("refuses database settings that cannot establish durable acknowledgment", () => {
  const valid = { database: "scopeledger_ip01", version: "17.0", fsync: "on", synchronousCommit: "on" };
  assert.throws(() => validateProofDatabaseState({ ...valid, fsync: "off" }));
  assert.throws(() => validateProofDatabaseState({ ...valid, synchronousCommit: "off" }));
  assert.throws(() => validateProofDatabaseState({ ...valid, version: "" }));
});

test("redacts complete URLs and encoded or decoded passwords", () => {
  const url = "postgresql://proof:secret%40example@localhost/scopeledger_ip01";
  const text = `Connection ${url} failed; secret@example; secret%40example`;
  const redacted = redactDatabaseCredentials(text, url);
  assert.equal(redacted.includes(url), false);
  assert.equal(redacted.includes("secret@example"), false);
  assert.equal(redacted.includes("secret%40example"), false);
  assert.ok(redacted.includes("[redacted PostgreSQL URL]"));
  assert.equal(redactDatabaseCredentials("Invalid configuration.", "not-a-url"), "Invalid configuration.");
  assert.equal(
    redactDatabaseCredentials("bad-secret", "postgresql://proof:bad-secret@localhost/application"),
    "[redacted]",
  );
});

test("container startup binds only loopback, uses durable commit settings and no host mounts", () => {
  const runId = "a".repeat(32);
  const args = postgresContainerArgs({ name: `scopeledger-ip01-${runId}`, runId });
  assert.ok(args.includes("127.0.0.1::5432"));
  assert.ok(args.includes("fsync=on"));
  assert.ok(args.includes("synchronous_commit=on"));
  assert.ok(args.includes(`scopeledger.ip01.run=${runId}`));
  assert.equal(args.includes("--volume"), false);
  assert.equal(args.includes("--mount"), false);
  assert.equal(args.includes("--privileged"), false);
  assert.match(args.at(-5), /^postgres:17@sha256:[a-f0-9]{64}$/);
  assert.deepEqual(args.slice(-4), ["-c", "fsync=on", "-c", "synchronous_commit=on"]);
});

test("rejects unowned or option-shaped container identities", () => {
  assert.throws(() => postgresContainerArgs({ name: "--privileged", runId: "a".repeat(32) }));
  assert.throws(() => postgresContainerArgs({ name: `scopeledger-ip01-${"a".repeat(32)}`, runId: "unknown" }));
  assert.throws(() => postgresContainerArgs({ name: `scopeledger-ip01-${"a".repeat(32)}`, runId: "b".repeat(32) }));
});
