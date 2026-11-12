import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { sql } from "@scopeledger/db";
import type { Payer } from "@scopeledger/contracts";
import {
  availableOrder, captureIntent, fixture, newCommand, rejectsCode, scope, syntheticObservation,
} from "./support/fixture.js";

type WorkerRequest = {
  schema: string; mode: "crash" | "read"; boundary: "intent" | "admission" | "result";
  kind: "create" | "capture"; payer: Payer; attemptId?: string; operationId?: string;
};
type Inventory = {
  operation: {
    id: string; provider_key: string; request_hash: string; state: string; admitted: boolean;
    attempt_id: string; attempt_state: string; unresolved: boolean;
  };
  factCount: number; decisionCount: number;
};
async function worker<T>(request: WorkerRequest): Promise<T> {
  const child = fork(fileURLToPath(new URL("./support/crash-worker.ts", import.meta.url)), [JSON.stringify(request)], {
    execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined;
    let workerError = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Bounded child-process crash proof timed out"));
    }, 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("message", (value: unknown) => {
      if (typeof value === "object" && value !== null && "workerFailure" in value) workerError = true;
      result = value as T;
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (workerError || result === undefined
          || (request.mode === "crash" ? signal !== "SIGKILL" : code !== 0)) {
        reject(new Error(`Crash proof child failed (mode=${request.mode}, exit=${code}, signal=${signal})`));
      } else resolve(result);
    });
  });
}

for (const kind of ["create", "capture"] as const) {
  for (const boundary of ["intent", "admission", "result"] as const) {
    test(`actual SIGKILL at ${kind} ${boundary} commit survives fresh-process readback with stable operation identity`, { timeout: 20_000 }, async (t) => {
      const f = await fixture(t);
      const { payer } = await f.approveAndNominate(await f.addUnit());
      let prepared: { attemptId: string; operationId: string } | undefined;
      if (kind === "capture") {
        prepared = boundary === "intent" ? await availableOrder(f.store, payer) : await captureIntent(f.store, payer);
      } else if (boundary !== "intent") {
        prepared = await f.store.initiatePayment(payer, newCommand());
      }
      if (boundary === "result") {
        assert.ok(prepared);
        const lease = await f.store.claimOperation(scope, { operationId: prepared.operationId, leaseMilliseconds: 60_000 });
        await f.store.admitDispatch(lease, payer);
      }
      const request: WorkerRequest = {
        schema: f.schema, mode: "crash", kind, boundary, payer,
        ...(prepared ? { attemptId: prepared.attemptId, operationId: prepared.operationId } : {}),
      };
      const crashed = await worker<{ operationId: string; attemptId: string }>(request);
      assert.match(crashed.operationId, /^[a-f0-9-]{36}$/);
      const readback = await worker<Inventory>({ ...request, mode: "read", operationId: crashed.operationId });
      assert.equal(readback.operation.id, crashed.operationId);
      assert.equal(readback.operation.provider_key, crashed.operationId);
      assert.equal(readback.operation.attempt_id, crashed.attemptId);
      assert.match(readback.operation.request_hash, /^[a-f0-9]{64}$/);
      assert.equal(readback.decisionCount, 1);
      assert.equal(readback.operation.state, boundary === "intent" ? "intent" : boundary === "admission" ? "admitted" : "result");
      assert.equal(readback.operation.admitted, boundary !== "intent");
      assert.equal(readback.factCount, boundary === "result" && kind === "capture" ? 1 : 0);
      assert.equal(readback.operation.unresolved, !(boundary === "result" && kind === "capture"));
      if (boundary === "intent") {
        if (kind === "create") assert.equal((await f.store.initiatePayment(payer, newCommand())).operationId, crashed.operationId);
        else assert.equal((await f.store.requestCapture(payer, { ...newCommand(), attemptId: crashed.attemptId, orderId: "synthetic-order" })).operationId, crashed.operationId);
      } else {
        await rejectsCode(f.store.claimOperation(scope, { operationId: crashed.operationId, leaseMilliseconds: 1 }), "RECONCILIATION_REQUIRED");
        if (boundary === "admission") {
          await f.store.markOutcomeUnknown({ ...scope, operationId: crashed.operationId }, "process-recovery");
          // Recovery supplies only explicitly labeled local synthetic evidence. No automatic re-dispatch.
          await f.store.recordObservation(scope, syntheticObservation(crashed.operationId, kind === "create" ? "order-created" : "completed"));
        }
      }
      assert.equal((await sql`select 1 from attempts`.execute(f.database.kysely)).rows.length, 1);
    });
  }
}
