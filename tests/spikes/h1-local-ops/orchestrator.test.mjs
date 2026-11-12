import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  H1_LOCAL_EXIT_CODES,
  parseH1LocalArguments,
  runH1LocalPrepare,
  runH1LocalStart,
  runH1LocalStatus,
  runH1LocalStop,
} from "../../../scripts/h1-local-core.mjs";
import { devPostgresStopArgs } from "../../../scripts/run-dev-db.mjs";
import { mailpitStopArgs } from "../../../scripts/run-mailpit.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function result({ ok = true, stdout = "", stderr = "", code } = {}) {
  return {
    ok,
    code: code ?? (ok ? 0 : 1),
    stdout,
    stderr,
  };
}

function fakeRunner(handler) {
  const calls = [];
  return {
    calls,
    async run(command, argumentsList, options) {
      const call = {
        command,
        argumentsList: [...argumentsList],
        cwd: options?.cwd,
      };
      calls.push(call);
      return handler(call);
    },
  };
}

function toolingResult(call) {
  if (call.argumentsList.join(" ") === "--version") {
    if (call.command === process.execPath) return result({ stdout: "v26.0.0\n" });
    if (call.command === "npm") return result({ stdout: "11.12.1\n" });
  }
  if (
    call.command === "docker"
    && call.argumentsList[0] === "version"
  ) {
    return result({ stdout: "27.3.1|27.3.1\n" });
  }
  return null;
}

async function fixture(t, { environment = true } = {}) {
  const root = path.join(
    repositoryRoot,
    ".scopeledger-local",
    "h1-local-tests",
    randomUUID(),
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const objectRoot = path.join(root, ".scopeledger-local", "object-storage");
  await mkdir(objectRoot, { recursive: true, mode: 0o700 });
  await chmod(objectRoot, 0o700);
  const example = [
    "PAYPAL_ENVIRONMENT=sandbox",
    "PAYPAL_CLIENT_ID=",
    "PAYPAL_CLIENT_SECRET=",
    "PAYPAL_MERCHANT_ID=",
    "PAYPAL_RETURN_URL=http://127.0.0.1:3000/payments/paypal/return",
    "PAYPAL_CANCEL_URL=http://127.0.0.1:3000/payments/paypal/cancel",
    "PAYPAL_WEBHOOK_ID=",
    "GEMINI_API_KEY=",
    "GEMINI_MODEL=gemini-3.5-flash-lite",
    "AUTH0_DOMAIN=",
    "AUTH0_CLIENT_ID=",
    "AUTH0_CLIENT_SECRET=",
    "AUTH0_SECRET=",
    "APP_BASE_URL=http://127.0.0.1:3000",
    "EMAIL_TRANSPORT=mailpit",
    "EMAIL_SMTP_HOST=127.0.0.1",
    "EMAIL_SMTP_PORT=1025",
    "EMAIL_FROM=ScopeLedger <notifications@scopeledger.test>",
    "EMAIL_DEMO_RECIPIENT=client@scopeledger.test",
    "EMAIL_DEMO_PAYER_RECIPIENT=payer@scopeledger.test",
    "EMAIL_DEMO_PROVIDER_RECIPIENT=provider@scopeledger.test",
    "EMAIL_MAILPIT_API=http://127.0.0.1:8025",
    "NOTIFICATION_PROVIDER_ACTOR_ID=northstar-provider",
    "NOTIFICATION_CLIENT_APPROVER_ACTOR_ID=cedar-approver",
    "NOTIFICATION_PAYER_ACTOR_ID=cedar-payer",
    "DEV_POSTGRES_USER=scopeledger_dev",
    "DEV_POSTGRES_PASSWORD=",
    "DEV_POSTGRES_DATABASE=scopeledger_dev",
    "SCOPELEDGER_DATABASE_URL=",
    "SCOPELEDGER_DATABASE_SCHEMA=scopeledger_dev",
    "SCOPELEDGER_OBJECT_STORAGE_ROOT=",
    "",
  ].join("\n");
  await writeFile(path.join(root, ".env.example"), example, { mode: 0o644 });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      scripts: {
        "notifications:process": "node scripts/process-notifications.mjs",
        "paypal:webhooks:process": "node scripts/process-paypal-webhooks.mjs",
        "paypal:financial-audit": "node scripts/audit-paypal-financials.mjs",
      },
    }),
    "utf8",
  );
  if (environment) {
    const password = "a".repeat(48);
    const configured = example
      .replace("PAYPAL_CLIENT_ID=", "PAYPAL_CLIENT_ID=client")
      .replace("PAYPAL_CLIENT_SECRET=", "PAYPAL_CLIENT_SECRET=secret")
      .replace("PAYPAL_MERCHANT_ID=", "PAYPAL_MERCHANT_ID=merchant")
      .replace("PAYPAL_WEBHOOK_ID=", "PAYPAL_WEBHOOK_ID=webhook")
      .replace("GEMINI_API_KEY=", "GEMINI_API_KEY=gemini")
      .replace("AUTH0_DOMAIN=", "AUTH0_DOMAIN=example.auth0.test")
      .replace("AUTH0_CLIENT_ID=", "AUTH0_CLIENT_ID=auth0-client")
      .replace("AUTH0_CLIENT_SECRET=", "AUTH0_CLIENT_SECRET=auth0-secret")
      .replace("AUTH0_SECRET=", `AUTH0_SECRET=${"b".repeat(64)}`)
      .replace(
        "DEV_POSTGRES_PASSWORD=",
        `DEV_POSTGRES_PASSWORD=${password}`,
      )
      .replace(
        "SCOPELEDGER_DATABASE_URL=",
        `SCOPELEDGER_DATABASE_URL=postgresql://scopeledger_dev:${password}@127.0.0.1:5433/scopeledger_dev`,
      )
      .replace(
        "SCOPELEDGER_OBJECT_STORAGE_ROOT=",
        `SCOPELEDGER_OBJECT_STORAGE_ROOT=${objectRoot}`,
      );
    await writeFile(path.join(root, ".env.local"), configured, { mode: 0o600 });
    await chmod(path.join(root, ".env.local"), 0o600);
  }
  for (const target of [
    "scripts/process-notifications.mjs",
    "scripts/process-paypal-webhooks.mjs",
    "scripts/audit-paypal-financials.mjs",
  ]) {
    const file = path.join(root, target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "", "utf8");
  }
  return root;
}

function runningServiceResult(call) {
  const joined = call.argumentsList.join(" ");
  if (joined.includes("run-dev-db.mjs status")) {
    return result({
      stdout: JSON.stringify({
        running: true,
        version: "17.11",
        persistentOwnedVolume: "scopeledger-dev-postgres-data",
      }),
    });
  }
  if (joined.includes("run-mailpit.mjs status")) {
    return result({
      stdout: JSON.stringify({ running: true, messages: 0 }),
    });
  }
  return null;
}

test("prepare requires an explicit flag before creating .env.local", async (t) => {
  const root = await fixture(t, { environment: false });
  const runner = fakeRunner((call) => (
    toolingResult(call) ?? result({ ok: false })
  ));

  const response = await runH1LocalPrepare({ root, runner });

  assert.equal(response.exitCode, H1_LOCAL_EXIT_CODES.notReady);
  assert.equal(response.report.environment.created, false);
  assert.equal(await stat(path.join(root, ".env.local")).catch(() => null), null);
  assert.equal(
    runner.calls.some((call) => call.argumentsList.some(
      (argument) => argument.includes("prepare-auth0-secret.mjs"),
    )),
    false,
  );
});

test("prepare copies the template privately and invokes existing mechanisms", async (t) => {
  const root = await fixture(t, { environment: false });
  const runner = fakeRunner((call) => (
    toolingResult(call) ?? result()
  ));

  const response = await runH1LocalPrepare({
    root,
    runner,
    createEnvironment: true,
  });

  assert.equal(response.exitCode, H1_LOCAL_EXIT_CODES.ok);
  assert.equal(response.report.environment.created, true);
  assert.equal((await stat(path.join(root, ".env.local"))).mode & 0o777, 0o600);
  assert.equal(
    await readFile(path.join(root, ".env.local"), "utf8"),
    await readFile(path.join(root, ".env.example"), "utf8"),
  );
  const invoked = runner.calls
    .flatMap((call) => call.argumentsList)
    .filter((argument) => argument.startsWith("scripts/prepare-"));
  assert.deepEqual(invoked, [
    "scripts/prepare-auth0-secret.mjs",
    "scripts/prepare-access-secret.mjs",
    "scripts/prepare-dev-db.mjs",
    "scripts/prepare-object-storage.mjs",
    "scripts/prepare-h1-operations.mjs",
    "scripts/prepare-web-env.mjs",
  ]);
});

test("prepare redacts child failures and uses a stable non-ready exit", async (t) => {
  const root = await fixture(t);
  const runner = fakeRunner((call) => {
    const tool = toolingResult(call);
    if (tool) return tool;
    if (call.argumentsList.includes("scripts/prepare-auth0-secret.mjs")) {
      return result({
        ok: false,
        stderr: "invalid value: never-echo-this-secret",
      });
    }
    return result();
  });

  const response = await runH1LocalPrepare({ root, runner });

  assert.equal(response.exitCode, H1_LOCAL_EXIT_CODES.notReady);
  assert.equal(response.report.ok, false);
  assert.equal(
    JSON.stringify(response.report).includes("never-echo-this-secret"),
    false,
  );
});

test("start manages only owned infrastructure and leaves web explicit", async (t) => {
  const root = await fixture(t);
  const runner = fakeRunner((call) => {
    const tool = toolingResult(call);
    if (tool) return tool;
    const service = runningServiceResult(call);
    if (service) return service;
    return result();
  });

  const response = await runH1LocalStart({
    root,
    runner,
    databaseProbe: async () => ({
      reachable: true,
      applied: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    }),
    fetchImpl: async () => ({ status: 200 }),
  });

  assert.equal(response.exitCode, H1_LOCAL_EXIT_CODES.ok);
  assert.equal(response.report.infrastructureReady, true);
  assert.equal(response.report.web.started, false);
  assert.equal(response.report.web.command, "npm run dev");
  const commands = runner.calls.map(
    (call) => `${call.command} ${call.argumentsList.join(" ")}`,
  );
  assert.equal(commands.some((command) => command.includes("run-dev-db.mjs start")), true);
  assert.equal(commands.some((command) => command.includes("run-mailpit.mjs start")), true);
  assert.equal(commands.some((command) => command.includes("dev:db:migrate")), true);
  assert.equal(commands.some((command) => command.includes("prepare-object-storage.mjs")), true);
  assert.equal(commands.some((command) => /\bnpm run dev\b/u.test(command)), false);
  assert.equal(commands.some((command) => command.includes("seed")), false);
});

test("status is honest about a partial start without provider calls", async (t) => {
  const root = await fixture(t);
  const runner = fakeRunner((call) => {
    if (call.argumentsList.join(" ").includes("run-dev-db.mjs status")) {
      return result({
        stdout: JSON.stringify({
          running: true,
          version: "17.11",
          persistentOwnedVolume: "scopeledger-dev-postgres-data",
        }),
      });
    }
    if (call.argumentsList.join(" ").includes("run-mailpit.mjs status")) {
      return result({ ok: false, stderr: "Mailpit is not running" });
    }
    return result({ ok: false });
  });
  const fetches = [];

  const response = await runH1LocalStatus({
    root,
    runner,
    databaseProbe: async () => ({
      reachable: true,
      applied: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    }),
    fetchImpl: async (url) => {
      fetches.push(url);
      assert.equal(url, "http://127.0.0.1:3000");
      return { status: 200 };
    },
  });

  assert.equal(response.exitCode, H1_LOCAL_EXIT_CODES.notReady);
  assert.equal(response.report.services.postgres.ready, true);
  assert.equal(response.report.services.mailpit.ready, false);
  assert.equal(response.report.infrastructureReady, false);
  assert.deepEqual(fetches, ["http://127.0.0.1:3000"]);
});

test("stop invokes only owned service CLIs and preserves durable state", async () => {
  const runner = fakeRunner(() => result());

  const response = await runH1LocalStop({
    root: repositoryRoot,
    runner,
  });

  assert.equal(response.exitCode, H1_LOCAL_EXIT_CODES.ok);
  assert.deepEqual(
    runner.calls.map((call) => call.argumentsList.at(-1)),
    ["stop", "stop"],
  );
  assert.equal(response.report.preserved.postgresVolume, true);
  assert.equal(response.report.preserved.objectFiles, true);
  assert.equal(response.report.preserved.webAndUserProcesses, true);
  assert.equal(
    runner.calls.some((call) => call.command === "docker"),
    false,
  );
  assert.deepEqual(devPostgresStopArgs(), [
    "rm",
    "--force",
    "scopeledger-dev-postgres",
  ]);
  assert.deepEqual(mailpitStopArgs(), [
    "rm",
    "--force",
    "scopeledger-mailpit",
  ]);
});

test("stop returns the stable safety code for an ownership refusal", async () => {
  const runner = fakeRunner((call) => (
    call.argumentsList.includes("scripts/run-dev-db.mjs")
      ? result({
        ok: false,
        stderr: "Refusing to stop a development container not owned by ScopeLedger",
      })
      : result()
  ));

  const response = await runH1LocalStop({
    root: repositoryRoot,
    runner,
  });

  assert.equal(response.exitCode, H1_LOCAL_EXIT_CODES.safety);
  assert.equal(response.report.steps[1].safety, true);
});

test("CLI parsing keeps usage errors stable", () => {
  assert.deepEqual(
    parseH1LocalArguments(["start", "--create-env", "--json"]),
    {
      error: "Unsupported option for start: --create-env",
      json: true,
    },
  );
  assert.equal(
    parseH1LocalArguments(["prepare", "--create-env"]).createEnvironment,
    true,
  );
});
