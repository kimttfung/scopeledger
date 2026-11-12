import { ProtocolDatabase, sql, validateProofSchema } from "@scopeledger/db";
import { OrderedConsentStore } from "@scopeledger/domain";
import { parseInput, payerSchema, z } from "@scopeledger/contracts";
import { newCommand, requiredDatabaseUrl, scope, syntheticObservation } from "./fixture.js";

const request = parseInput(z.strictObject({
  schema: z.string(), mode: z.enum(["crash", "read"]),
  boundary: z.enum(["intent", "admission", "result"]),
  kind: z.enum(["create", "capture"]),
  payer: payerSchema, attemptId: z.uuid().optional(), operationId: z.uuid().optional(),
}), JSON.parse(process.argv[2] ?? "null"));
const database = new ProtocolDatabase({ connectionString: requiredDatabaseUrl(), schema: validateProofSchema(request.schema), maxConnections: 1 });
const store = new OrderedConsentStore(database, { observationMode: "local-synthetic-proof" });

function send(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("Crash proof requires an IPC child"));
    process.send(value, (error) => { if (error) reject(error); else resolve(); });
  });
}

try {
  if (request.mode === "read") {
    const operation = (await sql<{
      id: string; provider_key: string; request_hash: string; state: string; admitted: boolean;
      attempt_id: string; attempt_state: string; unresolved: boolean;
    }>`select o.id,o.provider_key,o.request_hash,o.state,o.admitted_at is not null as admitted,
      a.id as attempt_id,a.state as attempt_state,a.resolved_at is null as unresolved
      from operations o join attempts a on a.workspace_id = o.workspace_id and a.project_id = o.project_id and a.id = o.attempt_id
      where o.id = ${request.operationId}::uuid`.execute(database.kysely)).rows[0];
    const facts = (await sql<{ count: string }>`select count(*)::text as count from payment_facts`.execute(database.kysely)).rows[0]?.count;
    const decisions = (await sql<{ count: string }>`select count(*)::text as count from decisions`.execute(database.kysely)).rows[0]?.count;
    await send({ operation, factCount: Number(facts), decisionCount: Number(decisions) });
    await database.close();
    process.disconnect?.();
  } else {
    let operationId = request.operationId;
    let attemptId = request.attemptId;
    if (request.boundary === "intent") {
      const intent = request.kind === "create"
        ? await store.initiatePayment(request.payer, newCommand())
        : await store.requestCapture(request.payer, { ...newCommand(), attemptId, orderId: "synthetic-order" });
      operationId = intent.operationId;
      attemptId = intent.attemptId;
    } else if (request.boundary === "admission") {
      const lease = await store.claimOperation(scope, { operationId, leaseMilliseconds: 60_000 });
      await store.admitDispatch(lease, request.payer);
    } else {
      await store.recordObservation(scope, syntheticObservation(operationId!, request.kind === "create" ? "order-created" : "completed"));
    }
    // This is an actual OS process crash AFTER the selected durable commit, not a thrown exception.
    await send({ boundary: request.boundary, kind: request.kind, operationId, attemptId });
    process.kill(process.pid, "SIGKILL");
  }
} catch (error) {
  // Deliberately omit connection strings, SQL inputs and source/provider payloads.
  await send({ workerFailure: error instanceof Error ? error.name : "UnknownFailure" });
  await database.close();
  process.exitCode = 1;
  process.disconnect?.();
}
