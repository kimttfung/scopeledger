import assert from "node:assert/strict";
import test from "node:test";
import {
  ip02ContainerArgs,
  validateIp02State,
} from "../../scripts/run-ip02.mjs";

const runId = "a".repeat(32);

test("IP-02 container binds PostgreSQL only to loopback with an ownership label", () => {
  const args = ip02ContainerArgs({
    name: `scopeledger-ip02-${runId}`,
    runId,
  });
  assert.ok(args.includes("127.0.0.1::5432"));
  assert.ok(args.includes(`scopeledger.ip02.run=${runId}`));
  assert.equal(args.includes("--volume"), false);
  assert.equal(args.includes("--mount"), false);
});

test("IP-02 runtime refuses unrelated container identities", () => {
  assert.throws(
    () => ip02ContainerArgs({ name: "postgres", runId }),
    /Invalid owned IP-02 container identity/,
  );
  assert.throws(
    () => ip02ContainerArgs({
      name: `scopeledger-ip02-${runId}`,
      runId: "not-a-run-id",
    }),
    /Invalid owned IP-02 container identity/,
  );
});

test("IP-02 state must retain exact owned database and schema identities", () => {
  const state = {
    status: "awaiting-buyer-approval",
    runId,
    containerName: `scopeledger-ip02-${runId}`,
    database: `scopeledger_ip02_${runId}`,
    schema: `ip02_${"b".repeat(24)}`,
    connectionUrl: `postgresql://user:secret@127.0.0.1:5432/scopeledger_ip02_${runId}`,
  };
  assert.equal(validateIp02State(state), state);
  assert.throws(
    () => validateIp02State({ ...state, containerName: "postgres" }),
    /does not own its container/,
  );
  assert.throws(
    () => validateIp02State({ ...state, database: "application" }),
    /dedicated database/,
  );
  assert.throws(
    () => validateIp02State({ ...state, schema: "public" }),
    /dedicated schema/,
  );
});
