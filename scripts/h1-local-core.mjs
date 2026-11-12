import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { DEV_POSTGRES_RUNTIME } from "./run-dev-db.mjs";
import { MAILPIT_RUNTIME } from "./run-mailpit.mjs";

const executeFile = promisify(execFile);
const EXPECTED_MIGRATIONS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const EXPECTED_ENVIRONMENT_DEFAULTS = Object.freeze({
  PAYPAL_ENVIRONMENT: "sandbox",
  PAYPAL_RETURN_URL: "http://127.0.0.1:3000/payments/paypal/return",
  PAYPAL_CANCEL_URL: "http://127.0.0.1:3000/payments/paypal/cancel",
  GEMINI_MODEL: "gemini-3.5-flash-lite",
  APP_BASE_URL: "http://127.0.0.1:3000",
  EMAIL_TRANSPORT: "mailpit",
  EMAIL_SMTP_HOST: "127.0.0.1",
  EMAIL_SMTP_PORT: "1025",
  EMAIL_MAILPIT_API: "http://127.0.0.1:8025",
  SCOPELEDGER_EVALUATOR_LIMITS_PROFILE: "local-h1",
  SCOPELEDGER_ANALYSIS_RUN_LIMIT: "3",
  SCOPELEDGER_SOURCE_UPLOAD_COUNT_LIMIT: "5",
  SCOPELEDGER_SOURCE_UPLOAD_BYTES_LIMIT: "25000000",
  SCOPELEDGER_SOURCE_UPLOAD_WINDOW_MINUTES: "60",
  SCOPELEDGER_MODEL_CALL_BUDGET: "2",
});
const PROVIDER_FIELDS = Object.freeze({
  auth0: Object.freeze([
    "AUTH0_DOMAIN",
    "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET",
    "AUTH0_SECRET",
    "APP_BASE_URL",
  ]),
  paypal: Object.freeze([
    "PAYPAL_ENVIRONMENT",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_MERCHANT_ID",
    "PAYPAL_RETURN_URL",
    "PAYPAL_CANCEL_URL",
  ]),
  gemini: Object.freeze([
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
  ]),
});
const COMMANDS = Object.freeze({
  notification: Object.freeze({
    script: "scripts/process-notifications.mjs",
    npmScript: "notifications:process",
  }),
  webhook: Object.freeze({
    script: "scripts/process-paypal-webhooks.mjs",
    npmScript: "paypal:webhooks:process",
  }),
  audit: Object.freeze({
    script: "scripts/audit-paypal-financials.mjs",
    npmScript: "paypal:financial-audit",
  }),
});

export const H1_LOCAL_PROFILE = Object.freeze({
  schemaVersion: 1,
  name: "local-reproducible",
  tools: Object.freeze({
    node: "26.0.0",
    npm: "11.12.1",
    docker: "27.3.1",
  }),
  expectedMigrations: EXPECTED_MIGRATIONS,
  webUrl: "http://127.0.0.1:3000",
  postgres: DEV_POSTGRES_RUNTIME,
  mailpit: MAILPIT_RUNTIME,
});

export const H1_LOCAL_EXIT_CODES = Object.freeze({
  ok: 0,
  notReady: 1,
  usage: 2,
  safety: 3,
});

function commandResult(result) {
  return Object.freeze({
    ok: result.ok,
    code: result.code,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  });
}

export function createCommandRunner({ cwd = process.cwd() } = {}) {
  return Object.freeze({
    async run(command, argumentsList = [], options = {}) {
      try {
        const result = await executeFile(command, argumentsList, {
          cwd: options.cwd ?? cwd,
          env: options.env ?? process.env,
          encoding: "utf8",
          timeout: options.timeout ?? 180_000,
          maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        });
        return commandResult({
          ok: true,
          code: 0,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (error) {
        const code = typeof error?.code === "number"
          ? error.code
          : error?.code === "ENOENT"
            ? 127
            : 1;
        return commandResult({
          ok: false,
          code,
          stdout: error?.stdout,
          stderr: error?.stderr,
        });
      }
    },
  });
}

function isMissing(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function safeLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function fileExists(target) {
  return Boolean(await safeLstat(target));
}

function cleanEnvValue(raw) {
  const value = raw.trim();
  if (
    value.length >= 2
    && ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvironment(content) {
  const values = Object.create(null);
  const duplicates = [];
  const malformed = [];
  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) {
      malformed.push(index + 1);
      continue;
    }
    const name = line.slice(0, separator).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      malformed.push(index + 1);
      continue;
    }
    if (Object.hasOwn(values, name)) duplicates.push(name);
    values[name] = cleanEnvValue(line.slice(separator + 1));
  }
  return Object.freeze({
    values: Object.freeze(values),
    duplicates: Object.freeze([...new Set(duplicates)].sort()),
    malformed: Object.freeze(malformed),
  });
}

async function loadEnvironment(root) {
  const envPath = path.join(root, ".env.local");
  const details = await safeLstat(envPath);
  if (!details) {
    return Object.freeze({
      exists: false,
      regular: false,
      symbolicLink: false,
      mode: null,
      values: Object.freeze(Object.create(null)),
      duplicates: Object.freeze([]),
      malformed: Object.freeze([]),
    });
  }
  if (!details.isFile()) {
    return Object.freeze({
      exists: true,
      regular: false,
      symbolicLink: details.isSymbolicLink(),
      mode: details.mode & 0o777,
      values: Object.freeze(Object.create(null)),
      duplicates: Object.freeze([]),
      malformed: Object.freeze([]),
    });
  }
  const parsed = parseEnvironment(await readFile(envPath, "utf8"));
  return Object.freeze({
    exists: true,
    regular: true,
    symbolicLink: false,
    mode: details.mode & 0o777,
    ...parsed,
  });
}

function presence(values, fields) {
  const fieldPresence = Object.fromEntries(
    fields.map((name) => [name, Boolean(values[name])]),
  );
  return Object.freeze({
    configured: Object.values(fieldPresence).every(Boolean),
    fields: Object.freeze(fieldPresence),
  });
}

function configurationPresence(values) {
  const auth0 = presence(values, PROVIDER_FIELDS.auth0);
  const paypal = presence(values, PROVIDER_FIELDS.paypal);
  const gemini = presence(values, PROVIDER_FIELDS.gemini);
  return Object.freeze({
    auth0,
    paypal: Object.freeze({
      ...paypal,
      webhookConfigured: Boolean(values.PAYPAL_WEBHOOK_ID),
    }),
    gemini,
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function refusal(result) {
  return /refusing/iu.test(result.stderr);
}

function nodeScriptArguments(script, argumentsList = [], { environment = false } = {}) {
  return [
    ...(environment ? ["--env-file-if-exists=.env.local"] : []),
    script,
    ...argumentsList,
  ];
}

async function serviceStatuses(root, runner) {
  const [postgresResult, mailpitResult] = await Promise.all([
    runner.run(
      process.execPath,
      nodeScriptArguments(
        "scripts/run-dev-db.mjs",
        ["status"],
        { environment: true },
      ),
      { cwd: root },
    ),
    runner.run(
      process.execPath,
      nodeScriptArguments("scripts/run-mailpit.mjs", ["status"]),
      { cwd: root },
    ),
  ]);
  const postgresDetails = postgresResult.ok
    ? parseJson(postgresResult.stdout)
    : null;
  const mailpitDetails = mailpitResult.ok
    ? parseJson(mailpitResult.stdout)
    : null;
  return Object.freeze({
    postgres: Object.freeze({
      running: postgresDetails?.running === true,
      ready: postgresDetails?.running === true,
      owned: postgresDetails?.running === true,
      ownershipConflict: refusal(postgresResult),
      version: typeof postgresDetails?.version === "string"
        ? postgresDetails.version
        : null,
      durable: postgresDetails?.persistentOwnedVolume
        === DEV_POSTGRES_RUNTIME.volumeName,
    }),
    mailpit: Object.freeze({
      running: mailpitDetails?.running === true,
      ready: mailpitDetails?.running === true,
      owned: mailpitDetails?.running === true,
      ownershipConflict: refusal(mailpitResult),
      messages: Number.isInteger(mailpitDetails?.messages)
        ? mailpitDetails.messages
        : null,
    }),
  });
}

function localDatabaseConfiguration(values) {
  const connectionString = values.SCOPELEDGER_DATABASE_URL;
  const schema = values.SCOPELEDGER_DATABASE_SCHEMA;
  if (!connectionString || !schema) {
    return Object.freeze({ valid: false, reason: "missing" });
  }
  if (
    !/^[a-z][a-z0-9_]{0,62}$/u.test(schema)
    || schema === "public"
    || schema === "information_schema"
    || schema.startsWith("pg_")
  ) {
    return Object.freeze({ valid: false, reason: "schema" });
  }
  try {
    const url = new URL(connectionString);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol)
      || url.hostname !== DEV_POSTGRES_RUNTIME.host
      || url.port !== String(DEV_POSTGRES_RUNTIME.hostPort)
      || url.hash
      || [...url.searchParams.keys()].some((key) => (
        ["options", "search_path", "searchpath", "schema"]
          .includes(key.trim().toLowerCase())
      ))
    ) {
      return Object.freeze({ valid: false, reason: "non-local" });
    }
    return Object.freeze({ valid: true, connectionString, schema });
  } catch {
    return Object.freeze({ valid: false, reason: "url" });
  }
}

export async function probeMigrationChain({ connectionString, schema }) {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 1_500,
    statement_timeout: 3_000,
    application_name: "scopeledger-h1-local-status",
  });
  try {
    await client.connect();
    const relation = await client.query(
      "select pg_catalog.to_regclass($1) is not null as present",
      [`${schema}.schema_migrations`],
    );
    if (relation.rows[0]?.present !== true) {
      return Object.freeze({ reachable: true, applied: Object.freeze([]) });
    }
    const result = await client.query(
      `select version from "${schema}".schema_migrations order by version`,
    );
    return Object.freeze({
      reachable: true,
      applied: Object.freeze(result.rows.map((row) => Number(row.version))),
    });
  } catch {
    return Object.freeze({ reachable: false, applied: Object.freeze([]) });
  } finally {
    await client.end().catch(() => undefined);
  }
}

function summarizeMigrations(probe, configured) {
  const applied = probe?.applied ?? [];
  const contiguous = applied.every((version, index) => version === index + 1);
  const current = Boolean(
    configured
    && probe?.reachable
    && contiguous
    && applied.length === EXPECTED_MIGRATIONS.length,
  );
  return Object.freeze({
    expected: EXPECTED_MIGRATIONS,
    applied: Object.freeze([...applied]),
    reachable: probe?.reachable === true,
    contiguous,
    current,
  });
}

function privateMode(mode, exact) {
  return mode !== null
    && (mode & 0o077) === 0
    && (exact === undefined || mode === exact);
}

async function objectStorageStatus(root, values) {
  const configuredRoot = values.SCOPELEDGER_OBJECT_STORAGE_ROOT;
  const expectedRoot = path.join(root, ".scopeledger-local", "object-storage");
  const configured = Boolean(configuredRoot);
  const expected = configured && path.resolve(configuredRoot) === expectedRoot;
  if (!configured || !path.isAbsolute(configuredRoot)) {
    return Object.freeze({
      configured,
      expected: false,
      exists: false,
      directory: false,
      private: false,
      symbolicLink: false,
      ready: false,
    });
  }
  const details = await safeLstat(configuredRoot);
  return Object.freeze({
    configured: true,
    expected,
    exists: Boolean(details),
    directory: details?.isDirectory() === true,
    private: details ? privateMode(details.mode & 0o777, 0o700) : false,
    symbolicLink: details?.isSymbolicLink() === true,
    ready: Boolean(
      expected
      && details?.isDirectory()
      && !details.isSymbolicLink()
      && privateMode(details.mode & 0o777, 0o700)
    ),
  });
}

async function webStatus(fetchImpl) {
  try {
    const response = await fetchImpl(H1_LOCAL_PROFILE.webUrl, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(1_500),
    });
    return Object.freeze({
      responding: true,
      status: response.status,
    });
  } catch {
    return Object.freeze({
      responding: false,
      status: null,
    });
  }
}

async function commandReadiness(root, values, services, migrations, configuration) {
  let manifestScripts = {};
  try {
    manifestScripts = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ).scripts ?? {};
  } catch {
    manifestScripts = {};
  }
  const files = Object.fromEntries(await Promise.all(
    Object.entries(COMMANDS).map(async ([name, command]) => [
      name,
      {
        script: await fileExists(path.join(root, command.script)),
        npmScript: typeof manifestScripts[command.npmScript] === "string",
      },
    ]),
  ));
  const databaseReady = services.postgres.ready && migrations.current;
  const emailConfigured = values.EMAIL_TRANSPORT === "mailpit"
    && values.EMAIL_SMTP_HOST === "127.0.0.1"
    && values.EMAIL_SMTP_PORT === "1025"
    && values.EMAIL_MAILPIT_API === "http://127.0.0.1:8025"
    && Boolean(values.EMAIL_FROM)
    && Boolean(values.EMAIL_DEMO_PROVIDER_RECIPIENT)
    && Boolean(values.EMAIL_DEMO_RECIPIENT)
    && Boolean(values.EMAIL_DEMO_PAYER_RECIPIENT)
    && Boolean(values.NOTIFICATION_PROVIDER_ACTOR_ID)
    && Boolean(values.NOTIFICATION_CLIENT_APPROVER_ACTOR_ID)
    && Boolean(values.NOTIFICATION_PAYER_ACTOR_ID);
  const notificationMissing = [
    ...(!files.notification.script ? ["script"] : []),
    ...(!files.notification.npmScript ? ["npm-script"] : []),
    ...(!databaseReady ? ["database"] : []),
    ...(!services.mailpit.ready ? ["mailpit"] : []),
    ...(!emailConfigured ? ["configuration"] : []),
  ];
  const webhookMissing = [
    ...(!files.webhook.script ? ["script"] : []),
    ...(!files.webhook.npmScript ? ["npm-script"] : []),
    ...(!databaseReady ? ["database"] : []),
    ...(!configuration.paypal.configured ? ["paypal-configuration"] : []),
    ...(!configuration.paypal.webhookConfigured ? ["webhook-configuration"] : []),
  ];
  const auditMissing = [
    ...(!files.audit.script ? ["script"] : []),
    ...(!files.audit.npmScript ? ["npm-script"] : []),
    ...(!databaseReady ? ["database"] : []),
    ...(!configuration.paypal.configured ? ["paypal-configuration"] : []),
  ];
  const result = (missing) => Object.freeze({
    ready: missing.length === 0,
    missing: Object.freeze(missing),
  });
  return Object.freeze({
    notification: result(notificationMissing),
    webhook: result(webhookMissing),
    audit: result(auditMissing),
  });
}

export async function runH1LocalStatus({
  root = process.cwd(),
  runner = createCommandRunner({ cwd: root }),
  fetchImpl = fetch,
  databaseProbe = probeMigrationChain,
} = {}) {
  const environment = await loadEnvironment(root);
  const configuration = configurationPresence(environment.values);
  const services = await serviceStatuses(root, runner);
  const databaseConfig = localDatabaseConfiguration(environment.values);
  const migrationProbe = services.postgres.ready && databaseConfig.valid
    ? await databaseProbe(databaseConfig)
    : null;
  const migrations = summarizeMigrations(
    migrationProbe,
    databaseConfig.valid,
  );
  const [objectStorage, web] = await Promise.all([
    objectStorageStatus(root, environment.values),
    webStatus(fetchImpl),
  ]);
  const commands = await commandReadiness(
    root,
    environment.values,
    services,
    migrations,
    configuration,
  );
  const infrastructureReady = Boolean(
    services.postgres.ready
    && services.mailpit.ready
    && migrations.current
    && objectStorage.ready
  );
  const providerConfigurationReady = Object.values(configuration)
    .every((provider) => provider.configured);
  const operationCommandsReady = Object.values(commands)
    .every((command) => command.ready);
  const safetyConflict = services.postgres.ownershipConflict
    || services.mailpit.ownershipConflict;
  const ready = Boolean(
    infrastructureReady
    && providerConfigurationReady
    && operationCommandsReady
    && web.responding
    && !safetyConflict
  );
  const exitCode = safetyConflict
    ? H1_LOCAL_EXIT_CODES.safety
    : ready
      ? H1_LOCAL_EXIT_CODES.ok
      : H1_LOCAL_EXIT_CODES.notReady;
  return Object.freeze({
    exitCode,
    report: Object.freeze({
      schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
      command: "status",
      profile: H1_LOCAL_PROFILE.name,
      ok: ready,
      infrastructureReady,
      providerConfigurationReady,
      operationCommandsReady,
      environment: Object.freeze({
        exists: environment.exists,
        regular: environment.regular,
        private: privateMode(environment.mode, 0o600),
      }),
      services,
      migrations,
      objectStorage,
      configuration,
      commands,
      web,
      webCommand: "npm run dev",
    }),
  });
}

async function toolVersions(root, runner) {
  const [nodeResult, npmResult, dockerResult] = await Promise.all([
    runner.run(process.execPath, ["--version"], { cwd: root }),
    runner.run("npm", ["--version"], { cwd: root }),
    runner.run(
      "docker",
      ["version", "--format", "{{.Client.Version}}|{{.Server.Version}}"],
      { cwd: root },
    ),
  ]);
  const node = nodeResult.ok
    ? nodeResult.stdout.trim().replace(/^v/u, "")
    : null;
  const npm = npmResult.ok ? npmResult.stdout.trim() : null;
  const [dockerClient, dockerServer] = dockerResult.ok
    ? dockerResult.stdout.trim().split("|")
    : [null, null];
  return Object.freeze({
    node: Object.freeze({
      available: nodeResult.ok,
      installed: node,
      expected: H1_LOCAL_PROFILE.tools.node,
      ok: node === H1_LOCAL_PROFILE.tools.node,
    }),
    npm: Object.freeze({
      available: npmResult.ok,
      installed: npm,
      expected: H1_LOCAL_PROFILE.tools.npm,
      ok: npm === H1_LOCAL_PROFILE.tools.npm,
    }),
    docker: Object.freeze({
      available: dockerResult.ok,
      client: dockerClient || null,
      server: dockerServer || null,
      expected: H1_LOCAL_PROFILE.tools.docker,
      ok: dockerClient === H1_LOCAL_PROFILE.tools.docker
        && dockerServer === H1_LOCAL_PROFILE.tools.docker,
    }),
  });
}

function toolingReady(tooling) {
  return Object.values(tooling).every((tool) => tool.ok);
}

async function ensureLocalEnvironment(root, create) {
  const envPath = path.join(root, ".env.local");
  const current = await safeLstat(envPath);
  if (current) {
    if (!current.isFile() || current.isSymbolicLink()) {
      return Object.freeze({
        ok: false,
        safety: true,
        created: false,
        message: "Refusing a non-regular or linked .env.local.",
        remediation: "Replace .env.local with a private regular file.",
      });
    }
    await chmod(envPath, 0o600);
    return Object.freeze({
      ok: true,
      safety: false,
      created: false,
      message: "Existing ignored .env.local retained with private permissions.",
      remediation: null,
    });
  }
  if (!create) {
    return Object.freeze({
      ok: false,
      safety: false,
      created: false,
      message: ".env.local is absent.",
      remediation:
        "Re-run prepare with --create-env to copy .env.example without overwriting an existing file.",
    });
  }
  const examplePath = path.join(root, ".env.example");
  const example = await safeLstat(examplePath);
  if (!example?.isFile() || example.isSymbolicLink()) {
    return Object.freeze({
      ok: false,
      safety: true,
      created: false,
      message: "Refusing to copy an absent, linked, or non-regular .env.example.",
      remediation: "Restore the tracked regular .env.example file.",
    });
  }
  const content = await readFile(examplePath, "utf8");
  try {
    await writeFile(envPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(envPath, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return Object.freeze({
        ok: false,
        safety: true,
        created: false,
        message: ".env.local appeared during preparation and was not overwritten.",
        remediation: "Inspect the existing .env.local, then re-run prepare.",
      });
    }
    throw error;
  }
  return Object.freeze({
    ok: true,
    safety: false,
    created: true,
    message: "Created private ignored .env.local from .env.example.",
    remediation: null,
  });
}

function preparationSteps(replaceInvalid) {
  const replacement = replaceInvalid ? ["--replace-invalid"] : [];
  return Object.freeze([
    Object.freeze({
      id: "auth0-session-secret",
      script: "scripts/prepare-auth0-secret.mjs",
      argumentsList: replacement,
      remediation:
        "Fix AUTH0_SECRET or re-run prepare with --replace-invalid.",
    }),
    Object.freeze({
      id: "access-session-secret",
      script: "scripts/prepare-access-secret.mjs",
      argumentsList: replacement,
      remediation:
        "Fix ACCESS_SESSION_SECRET or re-run prepare with --replace-invalid.",
    }),
    Object.freeze({
      id: "development-database",
      script: "scripts/prepare-dev-db.mjs",
      argumentsList: replacement,
      remediation:
        "Fix local database placeholders or re-run prepare with --replace-invalid.",
    }),
    Object.freeze({
      id: "object-storage",
      script: "scripts/prepare-object-storage.mjs",
      argumentsList: [],
      remediation: "Inspect .env.local and private object-storage permissions.",
    }),
    Object.freeze({
      id: "h1-operations",
      script: "scripts/prepare-h1-operations.mjs",
      argumentsList: [],
      remediation: "Inspect local H1 evaluator and notification settings.",
    }),
    Object.freeze({
      id: "web-environment",
      script: "scripts/prepare-web-env.mjs",
      argumentsList: [],
      remediation: "Remove an unexpected apps/web/.env.local and re-run prepare.",
    }),
  ]);
}

async function runSanitizedStep(root, runner, step) {
  const result = await runner.run(
    process.execPath,
    nodeScriptArguments(step.script, step.argumentsList),
    { cwd: root },
  );
  return Object.freeze({
    id: step.id,
    ok: result.ok,
    safety: refusal(result),
    remediation: result.ok ? null : step.remediation,
  });
}

export async function runH1LocalPrepare({
  root = process.cwd(),
  runner = createCommandRunner({ cwd: root }),
  createEnvironment = false,
  replaceInvalid = false,
} = {}) {
  const tooling = await toolVersions(root, runner);
  if (!toolingReady(tooling)) {
    return Object.freeze({
      exitCode: H1_LOCAL_EXIT_CODES.notReady,
      report: Object.freeze({
        schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
        command: "prepare",
        profile: H1_LOCAL_PROFILE.name,
        ok: false,
        tooling,
        environment: null,
        steps: Object.freeze([]),
        remediation:
          "Install the pinned Node.js, npm, and Docker versions before preparing local state.",
      }),
    });
  }
  const environment = await ensureLocalEnvironment(root, createEnvironment);
  if (!environment.ok) {
    return Object.freeze({
      exitCode: environment.safety
        ? H1_LOCAL_EXIT_CODES.safety
        : H1_LOCAL_EXIT_CODES.notReady,
      report: Object.freeze({
        schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
        command: "prepare",
        profile: H1_LOCAL_PROFILE.name,
        ok: false,
        tooling,
        environment,
        steps: Object.freeze([]),
      }),
    });
  }
  const steps = [];
  for (const step of preparationSteps(replaceInvalid)) {
    steps.push(await runSanitizedStep(root, runner, step));
  }
  const safety = steps.some((step) => step.safety);
  const ok = steps.every((step) => step.ok);
  return Object.freeze({
    exitCode: safety
      ? H1_LOCAL_EXIT_CODES.safety
      : ok
        ? H1_LOCAL_EXIT_CODES.ok
        : H1_LOCAL_EXIT_CODES.notReady,
    report: Object.freeze({
      schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
      command: "prepare",
      profile: H1_LOCAL_PROFILE.name,
      ok,
      tooling,
      environment,
      steps: Object.freeze(steps),
      nextCommand: "node scripts/h1-local.mjs start",
    }),
  });
}

async function startStep(root, runner, id, command, argumentsList, remediation) {
  const result = await runner.run(command, argumentsList, { cwd: root });
  return Object.freeze({
    id,
    ok: result.ok,
    safety: refusal(result),
    remediation: result.ok ? null : remediation,
  });
}

export async function runH1LocalStart({
  root = process.cwd(),
  runner = createCommandRunner({ cwd: root }),
  fetchImpl = fetch,
  databaseProbe = probeMigrationChain,
} = {}) {
  const tooling = await toolVersions(root, runner);
  const environment = await loadEnvironment(root);
  if (!toolingReady(tooling) || !environment.exists || !environment.regular) {
    return Object.freeze({
      exitCode: H1_LOCAL_EXIT_CODES.notReady,
      report: Object.freeze({
        schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
        command: "start",
        profile: H1_LOCAL_PROFILE.name,
        ok: false,
        tooling,
        steps: Object.freeze([]),
        remediation:
          "Run node scripts/h1-local.mjs prepare before starting local services.",
        web: Object.freeze({
          started: false,
          command: "npm run dev",
        }),
      }),
    });
  }
  const postgres = await startStep(
    root,
    runner,
    "postgres",
    process.execPath,
    nodeScriptArguments(
      "scripts/run-dev-db.mjs",
      ["start"],
      { environment: true },
    ),
    "Inspect Docker and local database configuration, then re-run start.",
  );
  const mailpit = await startStep(
    root,
    runner,
    "mailpit",
    process.execPath,
    nodeScriptArguments("scripts/run-mailpit.mjs", ["start"]),
    "Inspect Docker and loopback ports 1025/8025, then re-run start.",
  );
  const migrations = postgres.ok
    ? await startStep(
      root,
      runner,
      "migrations",
      "npm",
      ["run", "--silent", "dev:db:migrate"],
      "Inspect the existing migration history; no state was deleted or reseeded.",
    )
    : Object.freeze({
      id: "migrations",
      ok: false,
      safety: false,
      skipped: true,
      remediation: "Start the owned PostgreSQL service, then re-run start.",
    });
  const objectStorage = await startStep(
    root,
    runner,
    "object-storage",
    process.execPath,
    nodeScriptArguments("scripts/prepare-object-storage.mjs"),
    "Run prepare and inspect private object-storage permissions.",
  );
  const steps = Object.freeze([
    postgres,
    mailpit,
    migrations,
    objectStorage,
  ]);
  const status = await runH1LocalStatus({
    root,
    runner,
    fetchImpl,
    databaseProbe,
  });
  const safety = steps.some((step) => step.safety)
    || status.exitCode === H1_LOCAL_EXIT_CODES.safety;
  const infrastructureReady = steps.every((step) => step.ok)
    && status.report.infrastructureReady;
  return Object.freeze({
    exitCode: safety
      ? H1_LOCAL_EXIT_CODES.safety
      : infrastructureReady
        ? H1_LOCAL_EXIT_CODES.ok
        : H1_LOCAL_EXIT_CODES.notReady,
    report: Object.freeze({
      schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
      command: "start",
      profile: H1_LOCAL_PROFILE.name,
      ok: infrastructureReady,
      infrastructureReady,
      steps,
      status: status.report,
      statePreserved: true,
      web: Object.freeze({
        started: false,
        responding: status.report.web.responding,
        command: "npm run dev",
        message: "The web development process remains a separate explicit command.",
      }),
    }),
  });
}

export async function runH1LocalStop({
  root = process.cwd(),
  runner = createCommandRunner({ cwd: root }),
} = {}) {
  const mailpit = await startStep(
    root,
    runner,
    "mailpit",
    process.execPath,
    nodeScriptArguments("scripts/run-mailpit.mjs", ["stop"]),
    "Resolve the Mailpit ownership conflict; no other container was stopped.",
  );
  const postgres = await startStep(
    root,
    runner,
    "postgres",
    process.execPath,
    nodeScriptArguments(
      "scripts/run-dev-db.mjs",
      ["stop"],
      { environment: true },
    ),
    "Resolve the PostgreSQL ownership conflict; no other container was stopped.",
  );
  const steps = Object.freeze([mailpit, postgres]);
  const safety = steps.some((step) => step.safety);
  const ok = steps.every((step) => step.ok);
  return Object.freeze({
    exitCode: safety
      ? H1_LOCAL_EXIT_CODES.safety
      : ok
        ? H1_LOCAL_EXIT_CODES.ok
        : H1_LOCAL_EXIT_CODES.notReady,
    report: Object.freeze({
      schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
      command: "stop",
      profile: H1_LOCAL_PROFILE.name,
      ok,
      steps,
      preserved: Object.freeze({
        postgresVolume: true,
        objectFiles: true,
        webAndUserProcesses: true,
      }),
    }),
  });
}

function doctorCheck(id, status, message, remediation = null) {
  return Object.freeze({
    id,
    status,
    message,
    remediation: status === "pass" ? null : remediation,
  });
}

async function inspectContainer(root, runner, runtime) {
  const format = `{{index .Config.Labels "${runtime.ownerLabel}"}}|{{json .HostConfig.PortBindings}}|{{.Config.Image}}`;
  const result = await runner.run(
    "docker",
    ["inspect", "--format", format, runtime.containerName],
    { cwd: root },
  );
  if (!result.ok) return null;
  const [owner, rawBindings, image] = result.stdout.trim().split("|");
  const bindings = parseJson(rawBindings);
  return Object.freeze({ owner, bindings, image });
}

function bindingsAreLoopback(bindings, expected) {
  if (!bindings || typeof bindings !== "object") return false;
  const entries = Object.entries(bindings);
  if (entries.length !== expected.length) return false;
  return expected.every(({ containerPort, hostPort }) => {
    const values = bindings[`${containerPort}/tcp`];
    return Array.isArray(values)
      && values.length === 1
      && values[0]?.HostIp === "127.0.0.1"
      && values[0]?.HostPort === String(hostPort);
  });
}

async function ignoredPath(root, runner, target) {
  const result = await runner.run(
    "git",
    ["check-ignore", "--quiet", "--no-index", "--", target],
    { cwd: root },
  );
  return result.ok;
}

async function sourceMigrationChain(root) {
  const directory = path.join(root, "packages", "db", "src", "migrations");
  try {
    const entries = await readdir(directory);
    const versions = entries
      .map((entry) => /^(\d{3})-.+\.ts$/u.exec(entry)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((left, right) => left - right);
    return Object.freeze({
      versions: Object.freeze(versions),
      current: versions.length === EXPECTED_MIGRATIONS.length
        && versions.every((version, index) => version === index + 1),
    });
  } catch {
    return Object.freeze({
      versions: Object.freeze([]),
      current: false,
    });
  }
}

async function privateTree(root) {
  const stack = [root];
  let inspected = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const details = await safeLstat(current);
    if (!details) return { ok: false, reason: "missing" };
    if (details.isSymbolicLink()) return { ok: false, reason: "link" };
    if ((details.mode & 0o077) !== 0) return { ok: false, reason: "permissions" };
    inspected += 1;
    if (inspected > 1_000) return { ok: false, reason: "too-many-entries" };
    if (details.isDirectory()) {
      for (const entry of await readdir(current)) {
        stack.push(path.join(current, entry));
      }
    }
  }
  return { ok: true, reason: null };
}

async function workspaceIntegrity(root, runner) {
  try {
    const [manifest, lock] = await Promise.all([
      readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
      readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
    ]);
    const manifestWorkspaces = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : [];
    const lockWorkspaces = Array.isArray(lock.packages?.[""]?.workspaces)
      ? lock.packages[""].workspaces
      : [];
    const patternsMatch = JSON.stringify(manifestWorkspaces)
      === JSON.stringify(lockWorkspaces);
    const workspacePaths = [
      "apps/web",
      ...(await readdir(path.join(root, "packages"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name !== "adapters")
        .map((entry) => `packages/${entry.name}`),
      ...(await readdir(path.join(root, "packages", "adapters"), {
        withFileTypes: true,
      }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/adapters/${entry.name}`),
    ].sort();
    const manifests = await Promise.all(workspacePaths.map(async (workspace) => {
      const workspaceManifest = JSON.parse(
        await readFile(path.join(root, workspace, "package.json"), "utf8"),
      );
      return {
        workspace,
        name: workspaceManifest.name,
        locked: Boolean(lock.packages?.[workspace]),
      };
    }));
    const uniqueNames = new Set(manifests.map((entry) => entry.name));
    const staticOk = patternsMatch
      && manifests.every((entry) => entry.name && entry.locked)
      && uniqueNames.size === manifests.length;
    const npm = await runner.run(
      "npm",
      [
        "ls",
        "--depth=0",
        "--workspaces",
        "--include-workspace-root",
        "--json",
      ],
      { cwd: root, timeout: 180_000 },
    );
    return Object.freeze({
      ok: staticOk && npm.ok,
      workspaceCount: manifests.length,
      lockfileVersion: lock.lockfileVersion ?? null,
    });
  } catch {
    return Object.freeze({
      ok: false,
      workspaceCount: 0,
      lockfileVersion: null,
    });
  }
}

function exactLocalUrl(value, expected) {
  try {
    return new URL(value).href === new URL(expected).href;
  } catch {
    return false;
  }
}

async function configurationHealth(root, environment) {
  const issues = [];
  const warnings = [];
  if (!environment.exists || !environment.regular) {
    issues.push("environment-file");
    return Object.freeze({
      ok: false,
      issues: Object.freeze(issues),
      warnings: Object.freeze(warnings),
    });
  }
  if (environment.duplicates.length > 0) issues.push("duplicate-keys");
  if (environment.malformed.length > 0) issues.push("malformed-lines");
  let example;
  try {
    example = parseEnvironment(
      await readFile(path.join(root, ".env.example"), "utf8"),
    );
  } catch {
    issues.push("environment-example");
    return Object.freeze({
      ok: false,
      issues: Object.freeze(issues),
      warnings: Object.freeze(warnings),
    });
  }
  const expectedKeys = Object.keys(example.values).sort();
  const localKeys = Object.keys(environment.values).sort();
  const missingKeys = expectedKeys.filter(
    (name) => !Object.hasOwn(environment.values, name),
  );
  const staleKeys = localKeys.filter(
    (name) => !Object.hasOwn(example.values, name),
  );
  if (missingKeys.length > 0) issues.push("missing-template-keys");
  if (staleKeys.length > 0) warnings.push("unrecognized-local-keys");
  for (const [name, expected] of Object.entries(
    EXPECTED_ENVIRONMENT_DEFAULTS,
  )) {
    if (environment.values[name] !== expected) {
      issues.push(`invalid-${name.toLowerCase()}`);
    }
  }
  if (!/^[a-f0-9]{64}$/iu.test(environment.values.AUTH0_SECRET ?? "")) {
    issues.push("invalid-auth0-secret");
  }
  if (!/^[a-f0-9]{64}$/iu.test(environment.values.ACCESS_SESSION_SECRET ?? "")) {
    issues.push("invalid-access-secret");
  }
  if (!/^[a-f0-9]{48}$/u.test(environment.values.DEV_POSTGRES_PASSWORD ?? "")) {
    issues.push("invalid-database-password");
  }
  const database = localDatabaseConfiguration(environment.values);
  if (!database.valid) issues.push("invalid-local-database");
  if (database.valid) {
    const url = new URL(database.connectionString);
    if (
      decodeURIComponent(url.username)
        !== environment.values.DEV_POSTGRES_USER
      || decodeURIComponent(url.password)
        !== environment.values.DEV_POSTGRES_PASSWORD
      || url.pathname.slice(1) !== environment.values.DEV_POSTGRES_DATABASE
    ) {
      issues.push("stale-local-database-url");
    }
  }
  const expectedObjectRoot = path.join(
    root,
    ".scopeledger-local",
    "object-storage",
  );
  if (
    !environment.values.SCOPELEDGER_OBJECT_STORAGE_ROOT
    || path.resolve(environment.values.SCOPELEDGER_OBJECT_STORAGE_ROOT)
      !== expectedObjectRoot
  ) {
    issues.push("stale-object-storage-root");
  }
  if (
    !exactLocalUrl(
      environment.values.PAYPAL_RETURN_URL ?? "",
      EXPECTED_ENVIRONMENT_DEFAULTS.PAYPAL_RETURN_URL,
    )
    || !exactLocalUrl(
      environment.values.PAYPAL_CANCEL_URL ?? "",
      EXPECTED_ENVIRONMENT_DEFAULTS.PAYPAL_CANCEL_URL,
    )
    || !exactLocalUrl(
      environment.values.APP_BASE_URL ?? "",
      EXPECTED_ENVIRONMENT_DEFAULTS.APP_BASE_URL,
    )
    || !exactLocalUrl(
      environment.values.EMAIL_MAILPIT_API ?? "",
      EXPECTED_ENVIRONMENT_DEFAULTS.EMAIL_MAILPIT_API,
    )
  ) {
    issues.push("non-local-url");
  }
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze([...new Set(issues)].sort()),
    warnings: Object.freeze(warnings),
    missingKeys: Object.freeze(missingKeys),
    staleKeys: Object.freeze(staleKeys),
  });
}

async function validatorChecks(root, runner, configuration) {
  const definitions = [
    ["auth0", "scripts/check-auth0-config.mjs"],
    ["paypal", "scripts/check-paypal-config.mjs"],
    ["gemini", "scripts/check-gemini-config.mjs"],
  ];
  const results = {};
  for (const [name, script] of definitions) {
    if (!configuration[name].configured) {
      results[name] = Object.freeze({ ok: false, skipped: true });
      continue;
    }
    const result = await runner.run(
      process.execPath,
      nodeScriptArguments(script, [], { environment: true }),
      { cwd: root },
    );
    results[name] = Object.freeze({ ok: result.ok, skipped: false });
  }
  return Object.freeze(results);
}

export async function runH1LocalDoctor({
  root = process.cwd(),
  runner = createCommandRunner({ cwd: root }),
  fetchImpl = fetch,
  databaseProbe = probeMigrationChain,
} = {}) {
  const [tooling, status, environment, sourceMigrations, workspace] =
    await Promise.all([
      toolVersions(root, runner),
      runH1LocalStatus({ root, runner, fetchImpl, databaseProbe }),
      loadEnvironment(root),
      sourceMigrationChain(root),
      workspaceIntegrity(root, runner),
    ]);
  const checks = [];
  checks.push(doctorCheck(
    "tooling",
    toolingReady(tooling) ? "pass" : "fail",
    toolingReady(tooling)
      ? "Pinned Node.js, npm, and Docker client/server versions are available."
      : "Pinned tool versions are unavailable or mismatched.",
    "Install Node.js 26.0.0, npm 11.12.1, and Docker 27.3.1.",
  ));
  checks.push(doctorCheck(
    "workspace-integrity",
    workspace.ok ? "pass" : "fail",
    workspace.ok
      ? "Workspace manifests, lockfile entries, and installed roots agree."
      : "Workspace manifests, lockfile entries, or installed roots disagree.",
    "Run npm install with the pinned npm version and inspect workspace manifests.",
  ));

  const configuration = configurationPresence(environment.values);
  const configHealth = await configurationHealth(root, environment);
  checks.push(doctorCheck(
    "local-configuration",
    configHealth.ok ? "pass" : "fail",
    configHealth.ok
      ? "Local configuration is current and uses the local H1 profile."
      : "Local configuration is missing, stale, duplicated, or invalid.",
    "Run prepare, then edit only the remaining provider placeholders in .env.local.",
  ));

  const validators = await validatorChecks(
    root,
    runner,
    configuration,
  );
  for (const name of ["auth0", "paypal", "gemini"]) {
    checks.push(doctorCheck(
      `${name}-configuration`,
      validators[name].ok ? "pass" : "fail",
      validators[name].ok
        ? `${name} configuration passed its existing local validator.`
        : `${name} configuration is incomplete or failed its existing local validator.`,
      `Complete ${name} configuration without invoking provider APIs, then re-run doctor.`,
    ));
  }

  const envPrivate = environment.regular
    && privateMode(environment.mode, 0o600);
  const objectRoot = path.join(
    root,
    ".scopeledger-local",
    "object-storage",
  );
  const objectTree = await privateTree(objectRoot);
  let webEnvironmentLink = false;
  try {
    const webEnv = path.join(root, "apps", "web", ".env.local");
    webEnvironmentLink = (await safeLstat(webEnv))?.isSymbolicLink() === true
      && await readlink(webEnv) === "../../.env.local";
  } catch {
    webEnvironmentLink = false;
  }
  checks.push(doctorCheck(
    "private-permissions",
    envPrivate && objectTree.ok && webEnvironmentLink ? "pass" : "fail",
    envPrivate && objectTree.ok && webEnvironmentLink
      ? "Private environment and object paths have restrictive permissions."
      : "Private environment, object paths, or the web environment link are unsafe.",
    "Run prepare; remove linked object entries and restrict private paths to owner access.",
  ));

  const ignored = await Promise.all([
    ignoredPath(root, runner, ".env.local"),
    ignoredPath(root, runner, ".scopeledger-local"),
    ignoredPath(root, runner, "apps/web/.env.local"),
  ]);
  checks.push(doctorCheck(
    "ignored-private-paths",
    ignored.every(Boolean) ? "pass" : "fail",
    ignored.every(Boolean)
      ? "Private local paths are ignored by Git."
      : "One or more private local paths are not ignored by Git.",
    "Restore the repository ignore rules before handling local credentials or objects.",
  ));

  checks.push(doctorCheck(
    "migration-source-chain",
    sourceMigrations.current ? "pass" : "fail",
    sourceMigrations.current
      ? "Reviewed migration sources form the contiguous 1-9 chain."
      : "Migration source files do not form the reviewed 1-9 chain.",
    "Restore the reviewed packages/db migration chain before judging.",
  ));
  checks.push(doctorCheck(
    "database-migration-chain",
    status.report.migrations.current ? "pass" : "fail",
    status.report.migrations.current
      ? "The owned local database has the contiguous 1-9 chain."
      : "The owned local database is stopped, unreachable, or not at migration 9.",
    "Run start to apply migrations; never delete or reseed existing state automatically.",
  ));

  const [postgresInspect, mailpitInspect] = await Promise.all([
    status.report.services.postgres.running
      ? inspectContainer(root, runner, DEV_POSTGRES_RUNTIME)
      : null,
    status.report.services.mailpit.running
      ? inspectContainer(root, runner, MAILPIT_RUNTIME)
      : null,
  ]);
  const postgresBinding = !status.report.services.postgres.running
    ? false
    : Boolean(
      postgresInspect?.owner === DEV_POSTGRES_RUNTIME.owner
      && postgresInspect.image === DEV_POSTGRES_RUNTIME.image
      && bindingsAreLoopback(postgresInspect.bindings, [{
        containerPort: DEV_POSTGRES_RUNTIME.containerPort,
        hostPort: DEV_POSTGRES_RUNTIME.hostPort,
      }]),
    );
  const mailpitBinding = !status.report.services.mailpit.running
    ? false
    : Boolean(
      mailpitInspect?.owner === MAILPIT_RUNTIME.owner
      && mailpitInspect.image === MAILPIT_RUNTIME.image
      && bindingsAreLoopback(mailpitInspect.bindings, [
        {
          containerPort: MAILPIT_RUNTIME.smtpContainerPort,
          hostPort: MAILPIT_RUNTIME.smtpHostPort,
        },
        {
          containerPort: MAILPIT_RUNTIME.apiContainerPort,
          hostPort: MAILPIT_RUNTIME.apiHostPort,
        },
      ]),
    );
  checks.push(doctorCheck(
    "loopback-container-bindings",
    postgresBinding && mailpitBinding ? "pass" : "fail",
    postgresBinding && mailpitBinding
      ? "Owned pinned containers expose only the expected loopback ports."
      : "Owned services are stopped or container ownership/image/bindings are unexpected.",
    "Run start; resolve any container-name conflict instead of adopting another container.",
  ));

  checks.push(doctorCheck(
    "operation-commands",
    status.report.operationCommandsReady ? "pass" : "fail",
    status.report.operationCommandsReady
      ? "Notification, webhook, and audit commands are locally ready."
      : "One or more notification, webhook, or audit commands are not ready.",
    "Build packages, complete local configuration, and start owned services.",
  ));
  checks.push(doctorCheck(
    "localhost-web",
    status.report.web.responding ? "pass" : "warn",
    status.report.web.responding
      ? "The localhost web process responds."
      : "The localhost web process is not responding; it is intentionally not managed.",
    "Run npm run dev in a separate terminal.",
  ));

  const failed = checks.some((check) => check.status === "fail");
  const safety = status.exitCode === H1_LOCAL_EXIT_CODES.safety;
  return Object.freeze({
    exitCode: safety
      ? H1_LOCAL_EXIT_CODES.safety
      : failed
        ? H1_LOCAL_EXIT_CODES.notReady
        : H1_LOCAL_EXIT_CODES.ok,
    report: Object.freeze({
      schemaVersion: H1_LOCAL_PROFILE.schemaVersion,
      command: "doctor",
      profile: H1_LOCAL_PROFILE.name,
      ok: !failed && !safety,
      tooling,
      checks: Object.freeze(checks),
      migrationChain: Object.freeze({
        expected: EXPECTED_MIGRATIONS,
        source: sourceMigrations.versions,
        applied: status.report.migrations.applied,
        current: sourceMigrations.current && status.report.migrations.current,
      }),
      configuration: Object.freeze({
        presence: configuration,
        health: configHealth,
        validators,
      }),
      workspace,
      status: status.report,
      providerCallsMade: false,
      financialStateMutated: false,
    }),
  });
}

export function h1LocalUsage() {
  return [
    "Usage: node scripts/h1-local.mjs <prepare|start|status|doctor|stop> [options]",
    "",
    "Options:",
    "  --json             Print machine-readable JSON.",
    "  --create-env       prepare only: create .env.local from .env.example if absent.",
    "  --replace-invalid  prepare only: replace invalid generated local secrets.",
  ].join("\n");
}

export function parseH1LocalArguments(argumentsList) {
  const json = argumentsList.includes("--json");
  const positional = argumentsList.filter((argument) => !argument.startsWith("-"));
  const flags = argumentsList.filter((argument) => argument.startsWith("-"));
  if (flags.includes("--help") || flags.includes("-h")) {
    return Object.freeze({ help: true, json });
  }
  const command = positional[0];
  if (!["prepare", "start", "status", "doctor", "stop"].includes(command)) {
    return Object.freeze({
      error: "Expected one command: prepare, start, status, doctor, or stop.",
      json,
    });
  }
  if (positional.length !== 1) {
    return Object.freeze({
      error: "Only one command may be supplied.",
      json,
    });
  }
  const allowed = new Set(["--json"]);
  if (command === "prepare") {
    allowed.add("--create-env");
    allowed.add("--replace-invalid");
  }
  const unsupported = flags.filter((flag) => !allowed.has(flag));
  if (unsupported.length > 0) {
    return Object.freeze({
      error: `Unsupported option for ${command}: ${unsupported[0]}`,
      json,
    });
  }
  return Object.freeze({
    command,
    json,
    createEnvironment: flags.includes("--create-env"),
    replaceInvalid: flags.includes("--replace-invalid"),
  });
}

export async function runH1LocalCommand(parsed, dependencies = {}) {
  if (parsed.command === "prepare") {
    return runH1LocalPrepare({
      ...dependencies,
      createEnvironment: parsed.createEnvironment,
      replaceInvalid: parsed.replaceInvalid,
    });
  }
  if (parsed.command === "start") return runH1LocalStart(dependencies);
  if (parsed.command === "status") return runH1LocalStatus(dependencies);
  if (parsed.command === "doctor") return runH1LocalDoctor(dependencies);
  if (parsed.command === "stop") return runH1LocalStop(dependencies);
  throw new Error("Unsupported H1 local command");
}

function stepLines(steps) {
  return steps.map((step) => {
    const marker = step.ok ? "ok" : step.skipped ? "skipped" : "failed";
    return `- ${step.id}: ${marker}`;
  });
}

export function formatH1LocalReport(report) {
  if (report.command === "status") {
    return [
      `ScopeLedger H1 local status: ${report.ok ? "ready" : "not ready"}`,
      `- PostgreSQL: ${report.services.postgres.ready ? "ready" : "not ready"}`,
      `- Mailpit: ${report.services.mailpit.ready ? "ready" : "not ready"}`,
      `- Migrations 1-9: ${report.migrations.current ? "current" : "not current"}`,
      `- Private object root: ${report.objectStorage.ready ? "ready" : "not ready"}`,
      `- Auth0 configuration: ${report.configuration.auth0.configured ? "present" : "incomplete"}`,
      `- PayPal configuration: ${report.configuration.paypal.configured ? "present" : "incomplete"}`,
      `- Gemini configuration: ${report.configuration.gemini.configured ? "present" : "incomplete"}`,
      `- Notification command: ${report.commands.notification.ready ? "ready" : "not ready"}`,
      `- Webhook command: ${report.commands.webhook.ready ? "ready" : "not ready"}`,
      `- Audit command: ${report.commands.audit.ready ? "ready" : "not ready"}`,
      `- Localhost web: ${report.web.responding ? `responding (${report.web.status})` : "not responding"}`,
      `Web remains explicit: ${report.webCommand}`,
    ].join("\n");
  }
  if (report.command === "doctor") {
    return [
      `ScopeLedger H1 local doctor: ${report.ok ? "healthy" : "action required"}`,
      ...report.checks.map((check) => (
        `- ${check.id}: ${check.status} — ${check.message}`
      )),
    ].join("\n");
  }
  if (report.command === "prepare") {
    return [
      `ScopeLedger H1 local prepare: ${report.ok ? "complete" : "incomplete"}`,
      ...(report.environment ? [`- environment: ${report.environment.message}`] : []),
      ...stepLines(report.steps),
      ...(report.remediation ? [`Remediation: ${report.remediation}`] : []),
    ].join("\n");
  }
  if (report.command === "start") {
    return [
      `ScopeLedger H1 local start: ${report.ok ? "infrastructure ready" : "incomplete"}`,
      ...stepLines(report.steps),
      `- existing database and object state: preserved`,
      `- web process: not managed; run ${report.web.command}`,
      ...(report.remediation ? [`Remediation: ${report.remediation}`] : []),
    ].join("\n");
  }
  if (report.command === "stop") {
    return [
      `ScopeLedger H1 local stop: ${report.ok ? "complete" : "incomplete"}`,
      ...stepLines(report.steps),
      "- PostgreSQL named volume and object files: preserved",
      "- web and user processes: untouched",
    ].join("\n");
  }
  return JSON.stringify(report, null, 2);
}
