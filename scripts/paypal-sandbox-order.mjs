import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";

const statePath = resolve(".paypal-sandbox/order.json");
const action = process.argv[2];

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function amount() {
  const value = process.env.PAYPAL_PROBE_AMOUNT ?? "1.00";
  if (!/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/.test(value) || value === "0.00") {
    throw new Error("PAYPAL_PROBE_AMOUNT must be a positive exact two-decimal USD amount");
  }
  return value;
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("No sandbox Order state exists. Run npm run paypal:sandbox:create first.");
    }
    throw error;
  }
}

async function saveState(state) {
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function admission(config, kind, operationId, orderId, gross) {
  const request = {
    schemaVersion: "scopeledger.payment-operation.v1",
    obligationId: "paypal-sandbox-probe",
    unitId: "paypal-sandbox-probe",
    version: 1,
    kind,
    merchantId: config.merchantId,
    environment: config.environment,
    currency: "USD",
    gross,
    orderId,
  };
  return {
    operationId,
    providerKey: operationId,
    kind,
    request,
    requestHash: hash(request),
  };
}

async function createOrder(client, config) {
  try {
    const existing = await loadState();
    if (existing.status !== "captured") {
      throw new Error(`An unresolved sandbox Order already exists at ${statePath}`);
    }
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("No sandbox Order state exists.")) {
      throw error;
    }
  }

  const gross = amount();
  const operationId = randomUUID();
  const result = await client.createOrder(admission(config, "create", operationId, null, gross));
  const state = {
    status: "awaiting-buyer-approval",
    environment: config.environment,
    merchantId: config.merchantId,
    gross,
    currency: "USD",
    orderId: result.observation.orderId,
    approvalUrl: result.approvalUrl,
    createOperationId: operationId,
    createdAt: new Date().toISOString(),
  };
  await saveState(state);
  console.log(JSON.stringify({
    created: true,
    amount: `${state.currency} ${state.gross}`,
    orderId: state.orderId,
    approvalUrl: state.approvalUrl,
    next: "Open approvalUrl, sign in with the Personal sandbox buyer, approve, then run npm run paypal:sandbox:capture.",
  }, null, 2));
}

async function captureOrder(client, config) {
  const state = await loadState();
  if (state.status === "captured") {
    console.log(JSON.stringify({
      captured: true,
      orderId: state.orderId,
      captureId: state.captureId,
      amount: `${state.currency} ${state.gross}`,
    }, null, 2));
    return;
  }
  if (state.status !== "awaiting-buyer-approval") {
    throw new Error(`Unsupported sandbox Order state: ${String(state.status)}`);
  }
  if (state.environment !== config.environment || state.merchantId !== config.merchantId) {
    throw new Error("Saved sandbox Order does not match the current PayPal configuration");
  }
  const operationId = randomUUID();
  const result = await client.captureOrder(admission(
    config,
    "capture",
    operationId,
    state.orderId,
    state.gross,
  ));
  const updated = {
    ...state,
    status: result.observation.outcome === "completed" ? "captured" : result.observation.outcome,
    captureOperationId: operationId,
    captureId: result.observation.captureId ?? null,
    capturedAt: new Date().toISOString(),
  };
  await saveState(updated);
  console.log(JSON.stringify({
    captured: result.observation.outcome === "completed",
    outcome: result.observation.outcome,
    orderId: result.observation.orderId,
    captureId: result.observation.captureId ?? null,
    amount: `${result.observation.currency} ${result.observation.gross}`,
  }, null, 2));
}

try {
  if (action !== "create" && action !== "capture") {
    throw new Error("Usage: paypal-sandbox-order.mjs <create|capture>");
  }
  const config = payPalConfigFromEnvironment();
  const client = new PayPalSandboxClient(config);
  if (action === "create") {
    await createOrder(client, config);
  } else {
    await captureOrder(client, config);
  }
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  const message = error instanceof Error ? error.message : "Unknown PayPal sandbox diagnostic error";
  console.error(`PayPal sandbox diagnostic failed [${code}]: ${message}`);
  process.exitCode = 1;
}
