import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = "axllent/mailpit:v1.27.4@sha256:df6c2541907e1be6fac21f509927cf6ed771617a1f4b361ef66d97bd05593d2d";
const name = "scopeledger-mailpit";
const label = "scopeledger.mailpit.owner=scopeledger";

async function docker(args) {
  return execute("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
  });
}

export function mailpitContainerArgs() {
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--label",
    label,
    "--publish",
    "127.0.0.1:8025:8025",
    "--publish",
    "127.0.0.1:1025:1025",
    "--env",
    "MP_MAX_MESSAGES=100",
    "--env",
    "MP_DATABASE=/tmp/mailpit.db",
    image,
  ];
}

async function ownership() {
  try {
    const result = await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "scopeledger.mailpit.owner"}}',
      name,
    ]);
    return result.stdout.trim();
  } catch (error) {
    if (typeof error.stderr === "string" && /No such (object|container)/i.test(error.stderr)) {
      return null;
    }
    throw error;
  }
}

async function start() {
  const owner = await ownership();
  if (owner === "scopeledger") {
    console.log("ScopeLedger Mailpit is already running");
    return;
  }
  if (owner !== null) {
    throw new Error("Refusing to use a Mailpit container not owned by ScopeLedger");
  }
  await docker(mailpitContainerArgs());
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:8025/api/v1/info");
      if (response.ok) {
        console.log("Mailpit ready: http://127.0.0.1:8025");
        return;
      }
    } catch {
      // Wait for the owned local service.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Owned Mailpit container did not become ready");
}

async function status() {
  const owner = await ownership();
  if (owner !== "scopeledger") {
    throw new Error("ScopeLedger Mailpit is not running");
  }
  const response = await fetch("http://127.0.0.1:8025/api/v1/info");
  if (!response.ok) throw new Error("Mailpit API is unavailable");
  const info = await response.json();
  console.log(JSON.stringify({
    running: true,
    inboxUrl: "http://127.0.0.1:8025",
    messages: typeof info.Messages === "number" ? info.Messages : null,
  }, null, 2));
}

async function stop() {
  const owner = await ownership();
  if (owner === null) {
    console.log("ScopeLedger Mailpit is already stopped");
    return;
  }
  if (owner !== "scopeledger") {
    throw new Error("Refusing to stop a Mailpit container not owned by ScopeLedger");
  }
  await docker(["rm", "--force", "--volumes", name]);
  console.log("Stopped only the owned ScopeLedger Mailpit container");
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const action = process.argv[2];
  try {
    if (action === "start") await start();
    else if (action === "status") await status();
    else if (action === "stop") await stop();
    else throw new Error("Usage: run-mailpit.mjs <start|status|stop>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mailpit runtime failed");
    process.exitCode = 1;
  }
}
