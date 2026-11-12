import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const image = "postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f";
const proofDatabaseName = /^scopeledger_ip01(?:_[a-zA-Z0-9]+)?$/;

export function validateProofDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("IP01_DATABASE_URL must be a PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("IP01_DATABASE_URL must use postgres: or postgresql:.");
  }
  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
    decodeURIComponent(url.password);
  } catch {
    throw new Error("IP01_DATABASE_URL contains invalid URL encoding.");
  }
  if (database.length > 63 || !proofDatabaseName.test(database)) {
    throw new Error("Refusing the database: use a dedicated scopeledger_ip01 or scopeledger_ip01_<suffix> database, never an application database.");
  }
  if (!url.hostname) throw new Error("IP01_DATABASE_URL must name its database host.");
  return url;
}

export function validateProofDatabaseState(state) {
  if (!state || typeof state !== "object"
    || typeof state.database !== "string"
    || state.database.length > 63
    || !proofDatabaseName.test(state.database)) {
    throw new Error("Refusing the connected database: its actual identity is not a dedicated IP-01 proof database.");
  }
  if (state.fsync !== "on" || state.synchronousCommit !== "on") {
    throw new Error("IP-01 requires fsync=on and synchronous_commit=on; unsafe database durability settings cannot prove the contract.");
  }
  if (typeof state.version !== "string" || !state.version) {
    throw new Error("PostgreSQL did not return its server version.");
  }
  return state;
}

async function verifyDatabase(connectionUrl, runId) {
  const client = new pg.Client({
    connectionString: connectionUrl,
    connectionTimeoutMillis: 10000,
    application_name: `scopeledger-ip01-runtime-${runId}`,
  });
  try {
    await client.connect();
    const result = await client.query(`SELECT current_database() AS database,
      current_setting('server_version') AS version,
      current_setting('fsync') AS fsync,
      current_setting('synchronous_commit') AS "synchronousCommit"`);
    return validateProofDatabaseState(result.rows[0]);
  } finally {
    await client.end();
  }
}

export function redactDatabaseCredentials(text, connectionUrl) {
  let safe = text.replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[redacted PostgreSQL URL]");
  if (connectionUrl) {
    let url;
    try {
      url = new URL(connectionUrl);
    } catch (error) {
      if (error instanceof TypeError) return safe;
      throw error;
    }
    const passwords = new Set([url.password]);
    try {
      passwords.add(decodeURIComponent(url.password));
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
    }
    for (const password of passwords) {
      if (password) safe = safe.split(password).join("[redacted]");
    }
  }
  return safe;
}

export function postgresContainerArgs({ name, runId }) {
  if (!/^[a-f0-9]{32}$/.test(runId) || name !== `scopeledger-ip01-${runId}`) {
    throw new Error("Invalid owned proof-container identity.");
  }
  return [
    "run", "--detach", "--rm", "--name", name,
    "--label", `scopeledger.ip01.run=${runId}`,
    "--publish", "127.0.0.1::5432",
    "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB",
    image, "-c", "fsync=on", "-c", "synchronous_commit=on",
  ];
}

async function docker(args, options = {}) {
  return execute("docker", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

function streamRedacted(stream, destination, connectionUrl) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) destination.write(redactDatabaseCredentials(line, connectionUrl) + "\n");
  });
  stream.on("end", () => {
    if (pending) destination.write(redactDatabaseCredentials(pending, connectionUrl));
  });
}

async function runTests(connectionUrl, runId, suite, onChild) {
  const directory = path.join(root, "tests/spikes", suite);
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => path.join(directory, name));
  if (!files.length) throw new Error("No IP-01 proof tests exist; refusing an empty successful run.");
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test", "--test-concurrency=1", ...files,
  ], {
    cwd: root,
    env: { ...process.env, IP01_DATABASE_URL: connectionUrl, IP01_RUN_ID: runId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  onChild(child);
  streamRedacted(child.stdout, process.stdout, connectionUrl);
  streamRedacted(child.stderr, process.stderr, connectionUrl);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        console.error(`IP-01 test process was terminated by ${signal}.`);
        resolve(1);
      } else if (typeof code === "number") {
        resolve(code);
      } else {
        reject(new Error("The IP-01 test process exited without a result."));
      }
    });
  });
}

async function cleanupOwnedContainer(name, runId) {
  let inspected;
  try {
    inspected = await docker(["inspect", "--format", '{{index .Config.Labels "scopeledger.ip01.run"}}', name]);
  } catch (error) {
    if (typeof error.stderr === "string" && /No such (object|container)/i.test(error.stderr)) return;
    throw error;
  }
  if (inspected.stdout.trim() !== runId) {
    throw new Error("Refusing cleanup: the container does not have this proof run's ownership label.");
  }
  await docker(["rm", "--force", "--volumes", name]);
}

export async function main() {
  const arguments_ = process.argv.slice(2);
  const suiteArgument = arguments_.find((argument) => argument.startsWith("--suite="));
  const suite = suiteArgument?.slice("--suite=".length) ?? "ordered-consent";
  const supportedSuites = new Set([
    "ordered-consent",
    "analysis-persistence",
    "h1-authoring-foundation",
    "publication-foundation",
    "provider-participants",
    "records-export",
  ]);
  if (
    !supportedSuites.has(suite)
    || arguments_.some((argument) =>
      argument !== "--check-runtime" && argument !== suiteArgument)
  ) {
    console.error("Unknown proof runner argument. Supported arguments are --check-runtime and --suite=ordered-consent|analysis-persistence|h1-authoring-foundation|publication-foundation|provider-participants|records-export.");
    process.exitCode = 1;
    return;
  }
  const checkRuntimeOnly = arguments_.includes("--check-runtime");
  const runId = randomUUID().replaceAll("-", "");
  const name = `scopeledger-ip01-${runId}`;
  let attemptedContainer = false;
  let connectionUrl = process.env.IP01_DATABASE_URL;
  let child;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    child?.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    if (connectionUrl) {
      validateProofDatabaseUrl(connectionUrl);
      console.log("IP-01: using the explicitly configured dedicated proof database; the database itself will not be dropped.");
    } else {
      try {
        await docker(["version", "--format", "{{.Server.Version}}"]);
      } catch {
        throw new Error("Docker is not available. Start Docker Desktop and rerun npm run test:ip01, or explicitly configure IP01_DATABASE_URL for a dedicated scopeledger_ip01 database. No proof ran.");
      }
      const password = randomBytes(24).toString("hex");
      const database = `scopeledger_ip01_${runId}`;
      const user = "scopeledger_proof";
      attemptedContainer = true;
      await docker(postgresContainerArgs({ name, runId }), {
        env: {
          ...process.env,
          POSTGRES_USER: user,
          POSTGRES_PASSWORD: password,
          POSTGRES_DB: database,
        },
      });
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (interrupted) throw new Error("The proof was interrupted before PostgreSQL became ready.");
        try {
          await docker(["exec", name, "pg_isready", "--quiet", "--host", "127.0.0.1", "--username", user, "--dbname", database]);
          ready = true;
          break;
        } catch (error) {
          if (error.code !== 1 && error.code !== 2) throw error;
          await delay(250);
        }
      }
      if (!ready) throw new Error("The isolated PostgreSQL server did not become ready; no proof result can be claimed.");
      const portResult = await docker(["inspect", "--format", '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name]);
      const port = portResult.stdout.trim();
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        throw new Error("Docker returned an invalid PostgreSQL port.");
      }
      const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
      url.username = user;
      url.password = password;
      connectionUrl = url.href;
      validateProofDatabaseUrl(connectionUrl);
      const digest = await docker(["image", "inspect", "--format", "{{json .RepoDigests}}", image]);
      console.log(`IP-01 image identity: ${digest.stdout.trim()}`);
    }
    if (interrupted) throw new Error("The proof was interrupted before test execution.");
    const state = await verifyDatabase(connectionUrl, runId);
    console.log(`IP-01: real PostgreSQL ${state.version}, fsync=on, synchronous_commit=on, isolated synthetic data.`);
    if (checkRuntimeOnly) {
      console.log("Runtime verified. No IP-01 acceptance tests were run by this readiness check.");
      return;
    }
    console.log("Evidence profile: local deterministic faults and PostgreSQL transactions; not actual PayPal, identity, model, or R1 restore evidence.");
    const code = await runTests(connectionUrl, runId, suite, (running) => { child = running; });
    process.exitCode = interrupted ? 130 : code;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The IP-01 runtime failed.";
    console.error(redactDatabaseCredentials(message, connectionUrl));
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    if (attemptedContainer) {
      try {
        await cleanupOwnedContainer(name, runId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown cleanup error.";
        console.error(`Cleanup failed for owned container ${name}: ${redactDatabaseCredentials(message, connectionUrl)}`);
        console.error("Remove only that container after Docker is available; no other services or data were targeted.");
        process.exitCode = 1;
      }
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
