import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = "postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f";
const containerName = "scopeledger-dev-postgres";
const volumeName = "scopeledger-dev-postgres-data";
const owner = "scopeledger";

async function docker(args, options = {}) {
  return execute("docker", args, {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
}

export function devPostgresContainerArgs() {
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--label",
    `scopeledger.dev.owner=${owner}`,
    "--publish",
    "127.0.0.1:5433:5432",
    "--env",
    "POSTGRES_USER",
    "--env",
    "POSTGRES_PASSWORD",
    "--env",
    "POSTGRES_DB",
    "--volume",
    `${volumeName}:/var/lib/postgresql/data`,
    image,
    "-c",
    "fsync=on",
    "-c",
    "synchronous_commit=on",
  ];
}

async function inspectContainerOwner() {
  try {
    const result = await docker([
      "inspect",
      "--format",
      '{{index .Config.Labels "scopeledger.dev.owner"}}',
      containerName,
    ]);
    return result.stdout.trim();
  } catch (error) {
    if (typeof error.stderr === "string" && /No such (object|container)/i.test(error.stderr)) {
      return null;
    }
    throw error;
  }
}

async function ensureVolume() {
  try {
    const result = await docker([
      "volume",
      "inspect",
      "--format",
      '{{index .Labels "scopeledger.dev.owner"}}',
      volumeName,
    ]);
    if (result.stdout.trim() !== owner) {
      throw new Error("Refusing a development volume not owned by ScopeLedger");
    }
  } catch (error) {
    if (typeof error.stderr === "string" && /no such volume/i.test(error.stderr)) {
      await docker([
        "volume",
        "create",
        "--label",
        `scopeledger.dev.owner=${owner}`,
        volumeName,
      ]);
      return;
    }
    throw error;
  }
}

function requiredEnvironment() {
  const user = process.env.DEV_POSTGRES_USER;
  const password = process.env.DEV_POSTGRES_PASSWORD;
  const database = process.env.DEV_POSTGRES_DATABASE;
  if (
    !user
    || !password
    || !database
    || !/^[a-z][a-z0-9_]{0,62}$/.test(user)
    || !/^[a-z][a-z0-9_]{0,62}$/.test(database)
    || !/^[a-f0-9]{48}$/.test(password)
  ) {
    throw new Error("Run npm run prepare:dev-db before starting PostgreSQL");
  }
  return { user, password, database };
}

async function start() {
  const currentOwner = await inspectContainerOwner();
  if (currentOwner === owner) {
    console.log("ScopeLedger development PostgreSQL is already running");
    return;
  }
  if (currentOwner !== null) {
    throw new Error("Refusing a development container not owned by ScopeLedger");
  }
  const config = requiredEnvironment();
  await ensureVolume();
  await docker(devPostgresContainerArgs(), {
    env: {
      ...process.env,
      POSTGRES_USER: config.user,
      POSTGRES_PASSWORD: config.password,
      POSTGRES_DB: config.database,
    },
  });
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
        config.user,
        "--dbname",
        config.database,
      ]);
      console.log("ScopeLedger development PostgreSQL ready on 127.0.0.1:5433");
      return;
    } catch (error) {
      if (error.code !== 1 && error.code !== 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("Development PostgreSQL did not become ready");
}

async function status() {
  if (await inspectContainerOwner() !== owner) {
    throw new Error("ScopeLedger development PostgreSQL is not running");
  }
  const config = requiredEnvironment();
  const result = await docker([
    "exec",
    containerName,
    "psql",
    "--username",
    config.user,
    "--dbname",
    config.database,
    "--tuples-only",
    "--no-align",
    "--command",
    "select current_database(), current_setting('server_version'), current_setting('fsync'), current_setting('synchronous_commit')",
  ]);
  const [database, version, fsync, synchronousCommit] = result.stdout.trim().split("|");
  console.log(JSON.stringify({
    running: true,
    database,
    version,
    fsync,
    synchronousCommit,
    persistentOwnedVolume: volumeName,
  }, null, 2));
}

async function stop() {
  const currentOwner = await inspectContainerOwner();
  if (currentOwner === null) {
    console.log("ScopeLedger development PostgreSQL is already stopped");
    return;
  }
  if (currentOwner !== owner) {
    throw new Error("Refusing to stop a development container not owned by ScopeLedger");
  }
  await docker(["rm", "--force", "--volumes", containerName]);
  console.log("Stopped only the owned container; persistent database volume was retained");
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
    else throw new Error("Usage: run-dev-db.mjs <start|status|stop>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Development PostgreSQL failed");
    process.exitCode = 1;
  }
}
