import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  freezePublishedUnit,
} from "@scopeledger/contracts";
import {
  PostgresPayPalApprovalLinkStore,
  ProtocolDatabase,
  sql,
} from "@scopeledger/db";
import {
  OrderedConsentStore,
} from "@scopeledger/domain";
import {
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";
import {
  PayPalPaymentWorker,
} from "@scopeledger/payment-worker";

const execute = promisify(execFile);
const statePath = resolve(".paypal-sandbox/ip02-state.json");
const image = "postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f";
const databasePattern = /^scopeledger_ip02_[a-f0-9]{32}$/;
const schemaPattern = /^ip02_[a-f0-9]{24}$/;
const runPattern = /^[a-f0-9]{32}$/;
const scope = {
  workspaceId: "ip02-workspace",
  projectId: "ip02-project",
};
const provider = {
  ...scope,
  actorId: "ip02-provider",
  grantEpoch: 1,
};
const approver = {
  ...scope,
  actorId: "ip02-approver",
  grantEpoch: 1,
};
const payerActor = {
  ...scope,
  actorId: "ip02-payer",
  grantEpoch: 1,
};
const unitId = "ip02-unit";

function command() {
  return { commandId: randomUUID() };
}

function snapshot(merchantId) {
  return {
    schemaVersion: "scopeledger.published-unit.v1",
    serializationVersion: "scopeledger.canonical-json.v1",
    ...scope,
    clientId: "ip02-client",
    unitId,
    version: 1,
    contextRevision: 1,
    title: "IP-02 sandbox payment proof",
    treatment: "payable",
    scope: ["One synthetic sandbox integration proof"],
    exclusions: ["No production service or live payment"],
    dependencies: [],
    baselineReferences: [{ id: "ip02-baseline", version: 1 }],
    sourceReferences: [{
      id: "ip02-source",
      version: 1,
      locator: "Synthetic IP-02 source",
      availability: "available",
    }],
    rationale: "Provider-reviewed synthetic rationale for the bounded PayPal sandbox proof.",
    approver: {
      actorId: approver.actorId,
      nominationEpoch: 1,
      condition: "Named synthetic approver with exact-version authority attestation",
    },
    timing: {
      description: "No delivery; integration proof only",
      deliveryDependencies: [],
    },
    prerequisites: [],
    reconciliation: [],
    payment: {
      policy: "full-prepayment",
      financial: {
        currency: "USD",
        merchantId,
        environment: "sandbox",
        lines: [{
          id: "proof",
          description: "Synthetic IP-02 payment proof",
          quantity: "1",
          unitPrice: "1.00",
          amount: "1.00",
        }],
        subtotal: "1.00",
        tax: {
          treatment: "none",
          amount: "0.00",
          declaration: "Synthetic no-tax sandbox proof",
        },
        gross: "1.00",
      },
    },
    financialEffect: { kind: "new" },
  };
}

async function docker(args, options = {}) {
  return execute("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

export function ip02ContainerArgs({ name, runId }) {
  if (!runPattern.test(runId) || name !== `scopeledger-ip02-${runId}`) {
    throw new Error("Invalid owned IP-02 container identity");
  }
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--label",
    `scopeledger.ip02.run=${runId}`,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_USER",
    "--env",
    "POSTGRES_PASSWORD",
    "--env",
    "POSTGRES_DB",
    image,
    "-c",
    "fsync=on",
    "-c",
    "synchronous_commit=on",
  ];
}

export function validateIp02State(state) {
  if (!state || typeof state !== "object") throw new Error("Invalid IP-02 state");
  if (typeof state.runId !== "string" || !runPattern.test(state.runId)) {
    throw new Error("Invalid IP-02 run identity");
  }
  if (state.containerName !== `scopeledger-ip02-${state.runId}`) {
    throw new Error("IP-02 state does not own its container");
  }
  if (typeof state.database !== "string" || !databasePattern.test(state.database)) {
    throw new Error("IP-02 state does not name its dedicated database");
  }
  if (typeof state.schema !== "string" || !schemaPattern.test(state.schema)) {
    throw new Error("IP-02 state does not name its dedicated schema");
  }
  const url = new URL(state.connectionUrl);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || decodeURIComponent(url.pathname.slice(1)) !== state.database
    || !url.hostname
  ) {
    throw new Error("IP-02 state has an unsafe database URL");
  }
  if (!["seeding", "awaiting-buyer-approval", "captured"].includes(state.status)) {
    throw new Error("IP-02 state has an unsupported status");
  }
  return state;
}

async function loadState() {
  return validateIp02State(JSON.parse(await readFile(statePath, "utf8")));
}

async function saveState(state) {
  validateIp02State(state);
  await mkdir(resolve(".paypal-sandbox"), { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, statePath);
}

async function verifyOwnedContainer(state) {
  const inspected = await docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "scopeledger.ip02.run"}}',
    state.containerName,
  ]);
  if (inspected.stdout.trim() !== state.runId) {
    throw new Error("Refusing IP-02 operation: container ownership label differs");
  }
}

async function cleanup(state) {
  await verifyOwnedContainer(state);
  await docker(["rm", "--force", "--volumes", state.containerName]);
  await rm(statePath, { force: true });
  await rm(resolve(".paypal-sandbox/approval-links"), {
    recursive: true,
    force: true,
  });
}

async function connect(state) {
  await verifyOwnedContainer(state);
  return new ProtocolDatabase({
    connectionString: state.connectionUrl,
    schema: state.schema,
  });
}

async function startDatabase(config) {
  const runId = randomUUID().replaceAll("-", "");
  const containerName = `scopeledger-ip02-${runId}`;
  const database = `scopeledger_ip02_${runId}`;
  const user = "scopeledger_ip02";
  const password = randomBytes(24).toString("hex");
  await docker(ip02ContainerArgs({ name: containerName, runId }), {
    env: {
      ...process.env,
      POSTGRES_USER: user,
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
    },
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await docker([
        "exec",
        containerName,
        "pg_isready",
        "--quiet",
        "--host",
        "127.0.0.1",
        "--username",
        user,
        "--dbname",
        database,
      ]);
      ready = true;
      break;
    } catch (error) {
      if (error.code !== 1 && error.code !== 2) throw error;
      await delay(250);
    }
  }
  if (!ready) throw new Error("IP-02 PostgreSQL container did not become ready");
  const portResult = await docker([
    "inspect",
    "--format",
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',
    containerName,
  ]);
  const port = portResult.stdout.trim();
  if (!/^\d+$/.test(port)) throw new Error("Docker returned an invalid PostgreSQL port");
  const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
  url.username = user;
  url.password = password;
  const schema = `ip02_${randomBytes(12).toString("hex")}`;
  const state = {
    status: "seeding",
    runId,
    containerName,
    database,
    schema,
    connectionUrl: url.href,
    merchantId: config.merchantId,
    createdAt: new Date().toISOString(),
  };
  await saveState(state);
  const protocol = new ProtocolDatabase({
    connectionString: state.connectionUrl,
    schema,
  });
  await sql.raw(`CREATE SCHEMA "${schema}"`).execute(protocol.kysely);
  await protocol.migrate();
  return { state, protocol };
}

async function seedAndCreate() {
  try {
    await loadState();
    throw new Error("An IP-02 run already exists; use status, capture, or cleanup");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      if (error instanceof SyntaxError) throw error;
      if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
    }
  }

  const config = payPalConfigFromEnvironment();
  const { state, protocol } = await startDatabase(config);
  try {
    const store = new OrderedConsentStore(protocol);
    await sql`insert into workspaces(id,merchant_id,environment)
      values (${scope.workspaceId},${config.merchantId},'sandbox')`.execute(protocol.kysely);
    await sql`insert into projects(workspace_id,id,client_id,approver_id)
      values (${scope.workspaceId},${scope.projectId},'ip02-client',${approver.actorId})`.execute(protocol.kysely);
    for (const [actor, actions] of [
      [provider, ["publish", "review", "nominate", "inspect"]],
      [approver, ["decide", "nominate", "inspect"]],
      [payerActor, ["pay", "inspect"]],
    ]) {
      for (const action of actions) {
        await sql`insert into grants(workspace_id,project_id,actor_id,action)
          values (${scope.workspaceId},${scope.projectId},${actor.actorId},${action})`.execute(protocol.kysely);
      }
    }
    await store.registerContext(provider, {
      ...command(),
      baseline: { id: "ip02-baseline", version: 1 },
      sources: [{ id: "ip02-source", version: 1, availability: "available" }],
    });
    await store.createPacket(provider, { ...command(), packetId: "ip02-packet" });
    await store.createUnit(provider, {
      ...command(),
      packetId: "ip02-packet",
      unitId,
    });
    const published = snapshot(config.merchantId);
    await store.publish(provider, {
      ...command(),
      snapshot: published,
      expectedPreviousVersion: null,
    });
    const decision = await store.decide(approver, {
      ...command(),
      unitId,
      version: 1,
      digest: freezePublishedUnit(published).digest,
      decision: "approve",
      attestation: {
        reviewedExactVersion: true,
        authority: true,
        statement: "Explicit synthetic IP-02 exact-version authority attestation",
      },
    });
    if (!decision.obligationId) throw new Error("Approval did not create an obligation");
    const nomination = await store.nominatePayer(approver, {
      ...command(),
      obligationId: decision.obligationId,
      payerId: payerActor.actorId,
      active: true,
      continuityConfirmed: true,
      basis: "Synthetic obligation-scoped IP-02 payer nomination",
    });
    const payer = {
      ...payerActor,
      obligationId: decision.obligationId,
      ...nomination,
    };
    const intent = await store.initiatePayment(payer, command());
    const lease = await store.claimOperation(scope, {
      operationId: intent.operationId,
      leaseMilliseconds: 60_000,
    });
    const worker = new PayPalPaymentWorker(
      store,
      new PayPalSandboxClient(config),
      new PostgresPayPalApprovalLinkStore(protocol),
    );
    const result = await worker.run(lease, payer);
    if (!result.approvalLink) throw new Error("Create dispatch did not produce an approval link");
    const updated = {
      ...state,
      status: "awaiting-buyer-approval",
      obligationId: decision.obligationId,
      payer,
      attemptId: intent.attemptId,
      createOperationId: intent.operationId,
      orderId: result.approvalLink.orderId,
      approvalUrl: result.approvalLink.approvalUrl,
    };
    await saveState(updated);
    console.log(JSON.stringify({
      status: updated.status,
      amount: "USD 1.00",
      approvalUrl: updated.approvalUrl,
      next: "Approve with the Personal sandbox buyer, then run npm run ip02:capture.",
    }, null, 2));
  } catch (error) {
    await protocol.close();
    try {
      await cleanup(state);
    } catch {
      // Preserve the original failure; owned cleanup can be retried explicitly.
    }
    throw error;
  }
  await protocol.close();
}

async function capture() {
  const state = await loadState();
  if (state.status === "captured") {
    console.log(JSON.stringify({
      status: state.status,
      readiness: state.readiness,
      amount: "USD 1.00",
    }, null, 2));
    return;
  }
  if (state.status !== "awaiting-buyer-approval") {
    throw new Error(`IP-02 capture requires awaiting-buyer-approval, found ${state.status}`);
  }
  const config = payPalConfigFromEnvironment();
  if (config.merchantId !== state.merchantId) {
    throw new Error("Current PayPal merchant differs from the durable IP-02 run");
  }
  const protocol = await connect(state);
  try {
    const store = new OrderedConsentStore(protocol);
    const intent = await store.requestCapture(state.payer, {
      ...command(),
      attemptId: state.attemptId,
      orderId: state.orderId,
    });
    const lease = await store.claimOperation(scope, {
      operationId: intent.operationId,
      leaseMilliseconds: 60_000,
    });
    const worker = new PayPalPaymentWorker(
      store,
      new PayPalSandboxClient(config),
      new PostgresPayPalApprovalLinkStore(protocol),
    );
    await worker.run(lease, state.payer);
    const inspected = await store.inspectUnit(provider, unitId);
    const updated = {
      ...state,
      status: "captured",
      captureOperationId: intent.operationId,
      readiness: inspected.readiness,
      capturedAt: new Date().toISOString(),
    };
    await saveState(updated);
    console.log(JSON.stringify({
      status: updated.status,
      readiness: updated.readiness,
      amount: "USD 1.00",
      providerIdentifiersPrinted: false,
    }, null, 2));
  } finally {
    await protocol.close();
  }
}

async function status() {
  const state = await loadState();
  const protocol = await connect(state);
  try {
    const store = new OrderedConsentStore(protocol);
    const inspected = await store.inspectUnit(provider, unitId);
    console.log(JSON.stringify({
      status: state.status,
      readiness: inspected.readiness,
      amount: "USD 1.00",
      containerOwned: true,
      providerIdentifiersPrinted: false,
    }, null, 2));
  } finally {
    await protocol.close();
  }
}

async function main() {
  const action = process.argv[2];
  if (!["create", "capture", "status", "cleanup"].includes(action)) {
    throw new Error("Usage: run-ip02.mjs <create|capture|status|cleanup>");
  }
  if (action === "create") await seedAndCreate();
  if (action === "capture") await capture();
  if (action === "status") await status();
  if (action === "cleanup") {
    const state = await loadState();
    await cleanup(state);
    console.log("Removed only the owned IP-02 container and ignored local state.");
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown IP-02 runner error";
    console.error(`IP-02 runner failed: ${message.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted PostgreSQL URL]")}`);
    process.exitCode = 1;
  }
}
