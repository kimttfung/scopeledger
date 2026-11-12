import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  cloudflaredEnvironment,
  cloudflaredTunnelArguments,
  inspectWebhookDoctor,
  parseCloudflaredPublicUrl,
  WebhookToolingError,
  writeVerifiedWebhookEnvironment,
} from "../../../scripts/paypal-webhook-tooling.mjs";
import {
  runPayPalWebhookTunnel,
} from "../../../scripts/run-paypal-webhook-tunnel.mjs";

const publicUrl =
  "https://scopeledger-h1.trycloudflare.com/api/paypal/webhook";
const scratch = resolve(
  ".scopeledger-local",
  `webhook-tooling-test-${randomUUID()}`,
);

before(async () => {
  await mkdir(scratch, { recursive: true, mode: 0o700 });
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("doctor validates safe status without printing credentials or tokens", async () => {
  const result = await inspectWebhookDoctor({
    environment: {
      PAYPAL_ENVIRONMENT: "sandbox",
      PAYPAL_CLIENT_ID: "client-id-must-not-print",
      PAYPAL_CLIENT_SECRET: "client-secret-must-not-print",
      PAYPAL_WEBHOOK_ID: "WH_VALID",
      PAYPAL_WEBHOOK_URL: publicUrl,
    },
    tunnelRequested: true,
    routeAccess: async () => undefined,
    run: async (command, args) => {
      assert.equal(command, "cloudflared");
      assert.deepEqual(args, ["--version"]);
      return {
        stdout: "cloudflared version 2026.10.7 (built today)",
        stderr: "",
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tunnel, {
    requested: true,
    available: true,
    version: "2026.10.7",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("client-id-must-not-print"), false);
  assert.equal(serialized.includes("client-secret-must-not-print"), false);
});

test("doctor reports missing webhook ID and unavailable requested tunnel", async () => {
  const result = await inspectWebhookDoctor({
    environment: {
      PAYPAL_ENVIRONMENT: "sandbox",
      PAYPAL_CLIENT_ID: "configured",
      PAYPAL_CLIENT_SECRET: "configured",
    },
    routeAccess: async () => undefined,
    tunnelRequested: true,
    run: async () => {
      throw new Error("not installed");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find(({ name }) => name === "paypal-webhook-id")?.ok,
    false,
  );
  assert.deepEqual(result.tunnel, {
    requested: true,
    available: false,
  });
});

test("atomic env update changes only the verified webhook ID and public URL", async () => {
  const envPath = resolve(scratch, ".env.local");
  const original = [
    "PAYPAL_ENVIRONMENT=sandbox",
    "PAYPAL_CLIENT_ID=client-id",
    "PAYPAL_CLIENT_SECRET=secret-value",
    "PAYPAL_WEBHOOK_ID=WH_OLD",
    "OTHER_VALUE=unchanged",
    "",
  ].join("\n");
  await writeFile(envPath, original, { mode: 0o644 });
  await chmod(envPath, 0o644);

  const result = await writeVerifiedWebhookEnvironment({
    envPath,
    webhookId: "WH_NEW",
    publicUrl,
  });
  assert.deepEqual(result, {
    updated: true,
    keys: ["PAYPAL_WEBHOOK_ID", "PAYPAL_WEBHOOK_URL"],
  });
  assert.equal(
    await readFile(envPath, "utf8"),
    [
      "PAYPAL_ENVIRONMENT=sandbox",
      "PAYPAL_CLIENT_ID=client-id",
      "PAYPAL_CLIENT_SECRET=secret-value",
      "PAYPAL_WEBHOOK_ID=WH_NEW",
      "OTHER_VALUE=unchanged",
      `PAYPAL_WEBHOOK_URL=${publicUrl}`,
      "",
    ].join("\n"),
  );
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(scratch)).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("env update rejects duplicate managed keys without changing the file", async () => {
  const envPath = resolve(scratch, ".env-duplicate.local");
  const original = [
    "PAYPAL_WEBHOOK_ID=WH_ONE",
    "PAYPAL_WEBHOOK_ID=WH_TWO",
    "",
  ].join("\n");
  await writeFile(envPath, original, { mode: 0o600 });
  await assert.rejects(
    () => writeVerifiedWebhookEnvironment({
      envPath,
      webhookId: "WH_NEW",
      publicUrl,
    }),
    (error) => error instanceof WebhookToolingError
      && error.code === "AMBIGUOUS_ENV_FILE",
  );
  assert.equal(await readFile(envPath, "utf8"), original);
});

test("cloudflared output parser reports only the trusted HTTPS webhook endpoint", () => {
  const output = [
    "INF Requesting new quick Tunnel on trycloudflare.com...",
    "INF +------------------------------------------------------+",
    "INF | https://scopeledger-h1.trycloudflare.com            |",
    "INF +------------------------------------------------------+",
  ].join("\n");
  assert.equal(parseCloudflaredPublicUrl(output), publicUrl);
  assert.equal(
    parseCloudflaredPublicUrl("https://example.com/not-trusted"),
    null,
  );
  assert.throws(
    () => parseCloudflaredPublicUrl(
      "https://one.trycloudflare.com https://two.trycloudflare.com",
    ),
    (error) => error instanceof WebhookToolingError
      && error.code === "AMBIGUOUS_TUNNEL_OUTPUT",
  );
});

test("tunnel arguments are fixed to cloudflared and loopback HTTP", () => {
  assert.deepEqual(
    cloudflaredTunnelArguments(3210),
    ["tunnel", "--url", "http://127.0.0.1:3210"],
  );
  assert.throws(
    () => cloudflaredTunnelArguments("not-a-port"),
    WebhookToolingError,
  );
  assert.deepEqual(
    cloudflaredEnvironment({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      PAYPAL_CLIENT_SECRET: "must-not-be-inherited",
      TUNNEL_TOKEN: "must-not-be-inherited",
    }),
    {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
    },
  );
});

test("tunnel runner starts one fixed child and reports only the parsed public URL", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let spawnCall;
  const output = [];
  const run = runPayPalWebhookTunnel(["--port", "3210"], {
    environment: {
      PATH: "/usr/bin",
      PAYPAL_CLIENT_SECRET: "must-not-be-inherited",
      TUNNEL_TOKEN: "must-not-be-inherited",
    },
    runVersion: async () => ({
      stdout: "cloudflared version 2026.10.7",
      stderr: "",
    }),
    spawnProcess(command, args, options) {
      spawnCall = { command, args, options };
      queueMicrotask(() => {
        child.stderr.write(
          "INF https://scopeledger-h1.trycloudflare.com\n",
        );
        child.emit("close", 0, null);
      });
      return child;
    },
    output(value) {
      output.push(value);
    },
  });
  const result = await run;

  assert.deepEqual(spawnCall, {
    command: "cloudflared",
    args: ["tunnel", "--url", "http://127.0.0.1:3210"],
    options: {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin" },
    },
  });
  assert.deepEqual(result, {
    stopped: true,
    signal: null,
    publicUrl,
  });
  const serialized = output.join("\n");
  assert.equal(serialized.includes(publicUrl), true);
  assert.equal(serialized.includes("must-not-be-inherited"), false);
});
