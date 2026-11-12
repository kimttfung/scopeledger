import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifestRelativePath = "tests/spikes/h1-acceptance/acceptance.json";
const evidenceRelativeRoot = ".scopeledger-local/evidence";
const commandTimeoutMilliseconds = 20 * 60 * 1000;
const maximumCommandOutputBytes = 16 * 1024 * 1024;
const safeNpmScripts = new Set([
  "build",
  "lint",
  "typecheck",
  "test:access:local",
  "test:analysis",
  "test:analysis-persistence",
  "test:analysis-ui",
  "test:auth0:local",
  "test:client-decision",
  "test:client-drafts",
  "test:client-submissions",
  "test:correction-reissue",
  "test:custom-payment",
  "test:dynamic-client-review",
  "test:email:local",
  "test:evaluator-controls",
  "test:financial-audit",
  "test:gemini:local",
  "test:h1-authoring-foundation",
  "test:ip01",
  "test:notifications",
  "test:object-storage",
  "test:parser:local",
  "test:participant-lifecycle",
  "test:payment-exceptions",
  "test:payment-recovery",
  "test:payment-ui",
  "test:payment-worker",
  "test:paypal:local",
  "test:provider-authoring",
  "test:provider-participants",
  "test:provider-publication",
  "test:provider-reconciliation",
  "test:provider-records",
  "test:provider-source-analysis",
  "test:provider-source-intake",
  "test:publication-foundation",
  "test:records-export",
  "test:webhook-worker",
  "test:work-start",
]);
const summaryKeys = Object.freeze([
  "tests",
  "passed",
  "failed",
  "skipped",
  "cancelled",
  "todo",
]);
const testSummaryLabels = Object.freeze({
  tests: "tests",
  pass: "passed",
  fail: "failed",
  skipped: "skipped",
  cancelled: "cancelled",
  todo: "todo",
});

export class H1AcceptanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "H1AcceptanceError";
    this.code = code;
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function parseArguments(arguments_, repositoryRoot = root) {
  let mode = "quick";
  let explicitMode = false;
  let allowDirty = false;
  let output;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--quick" || argument === "--full") {
      if (explicitMode) {
        throw new H1AcceptanceError(
          "invalid-arguments",
          "Choose exactly one acceptance mode.",
        );
      }
      mode = argument.slice(2);
      explicitMode = true;
    } else if (argument === "--allow-dirty") {
      if (allowDirty) {
        throw new H1AcceptanceError(
          "invalid-arguments",
          "--allow-dirty may be supplied once.",
        );
      }
      allowDirty = true;
    } else if (argument === "--output") {
      if (output !== undefined || index + 1 >= arguments_.length) {
        throw new H1AcceptanceError(
          "invalid-arguments",
          "--output requires one path.",
        );
      }
      output = arguments_[index + 1];
      index += 1;
    } else {
      throw new H1AcceptanceError(
        "invalid-arguments",
        "Supported arguments are --quick, --full, --allow-dirty and --output <path>.",
      );
    }
  }

  const requestedOutput = output
    ?? `${evidenceRelativeRoot}/h1-acceptance-${mode}.json`;
  const evidenceRoot = path.resolve(repositoryRoot, evidenceRelativeRoot);
  const outputPath = path.resolve(repositoryRoot, requestedOutput);
  if (
    !isWithin(evidenceRoot, outputPath)
    || outputPath === evidenceRoot
    || path.extname(outputPath) !== ".json"
  ) {
    throw new H1AcceptanceError(
      "unsafe-output-path",
      "Acceptance output must be a JSON file under .scopeledger-local/evidence/.",
    );
  }

  return Object.freeze({
    mode,
    allowDirty,
    outputPath,
    reportPath: path.relative(repositoryRoot, outputPath).split(path.sep).join("/"),
  });
}

export function sanitizeText(value) {
  return String(value)
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]*(?:PRIVATE KEY|CERTIFICATE)-----/gi,
      "[redacted-key-material]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>]+/gi,
      "[redacted-database-url]",
    )
    .replace(
      /\b(?:api[_-]?key|client[_-]?secret|password|secret|token|authorization)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      (_match, separator) => `credential${separator}[redacted]`,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\/Users\/[^/\s"']+(?:\/[^\s"']*)?/g, "[private-path]")
    .replace(/\/home\/[^/\s"']+(?:\/[^\s"']*)?/g, "[private-path]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+(?:\\[^\s"']*)?/g, "[private-path]")
    .replace(/https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|$)|localhost(?::\d+)?(?:\/|$)|\[::1\](?::\d+)?(?:\/|$))[^\s"'<>]+/gi, "[redacted-external-url]")
    .replace(
      /\b(?:ORDER|CAPTURE|REFUND|PAYID|WH)[-_][A-Z0-9_-]{6,}\b/gi,
      "[redacted-provider-id]",
    )
    .replace(
      /\b(?:project|request|unit|payer|merchant|order|capture|refund|webhook|client)[-_ ]?(?:id|locator)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[A-Za-z0-9._-]+)/gi,
      (_match, separator) => `provider-reference${separator}[redacted]`,
    );
}

export function assertReportSafe(report, sensitiveValues = []) {
  const serialized = JSON.stringify(report);
  const forbidden = [
    /\/Users\/[^/"\s]+/,
    /\/home\/[^/"\s]+/,
    /[A-Za-z]:\\\\Users\\\\[^\\/"\s]+/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
    /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----/i,
    /\bBearer\s+(?!\[redacted\])/i,
    /\bpostgres(?:ql)?:\/\/[^/"\s]*@/i,
    /\b(?:api[_-]?key|client[_-]?secret|password|secret|token|authorization)\b\s*[:=]\s*(?!\[redacted\]|false|null|""|0)/i,
    /https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/i,
  ];
  if (forbidden.some((expression) => expression.test(serialized))) {
    throw new H1AcceptanceError(
      "unsafe-report",
      "The report contains a value that is not safe to publish.",
    );
  }
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length >= 6 && serialized.includes(value)) {
      throw new H1AcceptanceError(
        "unsafe-report",
        "The report contains a configured private value.",
      );
    }
  }
  return report;
}

function validateCommand(command) {
  if (
    !command
    || typeof command !== "object"
    || typeof command.id !== "string"
    || !/^[a-z0-9][a-z0-9-]*$/.test(command.id)
    || typeof command.label !== "string"
    || command.label.length < 3
    || !["check", "test"].includes(command.kind)
    || command.required !== true
    || command.file !== "npm"
    || !Array.isArray(command.args)
    || command.args.length !== 2
    || command.args[0] !== "run"
    || !safeNpmScripts.has(command.args[1])
  ) {
    throw new H1AcceptanceError(
      "invalid-acceptance-manifest",
      "The required H1 acceptance manifest contains an unsafe command.",
    );
  }
  if (
    command.evidenceManifest !== undefined
    && (
      typeof command.evidenceManifest !== "string"
      || !/^tests\/spikes\/[a-z0-9-]+\/acceptance\.json$/.test(
        command.evidenceManifest,
      )
    )
  ) {
    throw new H1AcceptanceError(
      "invalid-acceptance-manifest",
      "The required H1 acceptance manifest contains an unsafe evidence path.",
    );
  }
}

export function validateAcceptanceManifest(manifest) {
  if (
    !manifest
    || typeof manifest !== "object"
    || manifest.schemaVersion !== "scopeledger.h1-acceptance.v1"
    || manifest.task !== "h1-judging-acceptance"
    || manifest.profile !== "verified-local-reproducible-h1"
    || !Number.isInteger(manifest.latestMigration)
    || manifest.latestMigration < 1
    || manifest.containsPrivateRecordsOrCredentials !== false
    || !Array.isArray(manifest.privatePaths)
    || manifest.privatePaths.length < 1
    || !manifest.privatePaths.every((value) =>
      typeof value === "string"
      && value.length > 0
      && !path.isAbsolute(value)
      && !value.includes(".."))
    || !Array.isArray(manifest.localRoutes)
    || manifest.localRoutes.length < 1
    || !manifest.localRoutes.every((value) =>
      typeof value === "string" && /^\/[A-Za-z0-9/_-]*$/.test(value))
    || !Array.isArray(manifest.quickCommands)
    || manifest.quickCommands.length < 1
    || !Array.isArray(manifest.fullCommands)
    || manifest.fullCommands.length < 1
    || !manifest.inventory
    || !Array.isArray(manifest.inventory.implemented)
    || !Array.isArray(manifest.inventory.unavailable)
    || manifest.inventory.implemented.length < 1
    || manifest.inventory.unavailable.length < 1
    || ![...manifest.inventory.implemented, ...manifest.inventory.unavailable]
      .every((value) => typeof value === "string" && value.length > 2)
  ) {
    throw new H1AcceptanceError(
      "invalid-acceptance-manifest",
      "The required H1 acceptance manifest is invalid.",
    );
  }
  const commands = [...manifest.quickCommands, ...manifest.fullCommands];
  commands.forEach(validateCommand);
  const ids = commands.map((command) => command.id);
  if (new Set(ids).size !== ids.length) {
    throw new H1AcceptanceError(
      "invalid-acceptance-manifest",
      "The required H1 acceptance manifest has duplicate command IDs.",
    );
  }
  return manifest;
}

function parseEnvironment(content) {
  const environment = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) environment[match[1]] = match[2];
  }
  return environment;
}

function configured(environment, names) {
  return names.every((name) =>
    typeof environment[name] === "string" && environment[name].length > 0);
}

function localUrl(value, expectedPort) {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
      && (expectedPort === undefined || url.port === String(expectedPort))
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function recipientIsLocal(value) {
  const match = /<([^<>]+)>/.exec(value);
  const address = (match?.[1] ?? value).trim().toLowerCase();
  return /^[a-z0-9._%+-]+@scopeledger\.test$/.test(address);
}

async function defaultInspectLocalProfile(dependencies) {
  let content = "";
  let environmentFile = true;
  try {
    content = await dependencies.readFile(path.join(root, ".env.local"), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      environmentFile = false;
    } else {
      throw error;
    }
  }
  const environment = parseEnvironment(content);
  const expectedObjectRoot = path.join(root, ".scopeledger-local", "object-storage");
  let objectRootReady = false;
  if (environment.SCOPELEDGER_OBJECT_STORAGE_ROOT === expectedObjectRoot) {
    try {
      const state = await dependencies.lstat(expectedObjectRoot);
      objectRootReady = state.isDirectory()
        && !state.isSymbolicLink()
        && (state.mode & 0o077) === 0;
    } catch {
      objectRootReady = false;
    }
  }
  let databaseConfigured = false;
  try {
    const databaseUrl = new URL(environment.SCOPELEDGER_DATABASE_URL ?? "");
    databaseConfigured = configured(environment, [
      "DEV_POSTGRES_USER",
      "DEV_POSTGRES_PASSWORD",
      "DEV_POSTGRES_DATABASE",
      "SCOPELEDGER_DATABASE_SCHEMA",
    ])
      && ["postgres:", "postgresql:"].includes(databaseUrl.protocol)
      && databaseUrl.hostname === "127.0.0.1"
      && databaseUrl.port === "5433"
      && decodeURIComponent(databaseUrl.pathname.slice(1))
        === environment.DEV_POSTGRES_DATABASE
      && /^[a-z][a-z0-9_]{0,62}$/.test(
        environment.SCOPELEDGER_DATABASE_SCHEMA,
      );
  } catch {
    databaseConfigured = false;
  }
  const mailpitConfigured = environment.EMAIL_TRANSPORT === "mailpit"
    && environment.EMAIL_SMTP_HOST === "127.0.0.1"
    && environment.EMAIL_SMTP_PORT === "1025"
    && localUrl(environment.EMAIL_MAILPIT_API, 8025)
    && [
      "EMAIL_FROM",
      "EMAIL_DEMO_RECIPIENT",
      "EMAIL_DEMO_PAYER_RECIPIENT",
      "EMAIL_DEMO_PROVIDER_RECIPIENT",
    ].every((name) => recipientIsLocal(environment[name] ?? ""));
  const auth0Configured = configured(environment, [
    "AUTH0_DOMAIN",
    "AUTH0_CLIENT_ID",
    "AUTH0_CLIENT_SECRET",
    "AUTH0_SECRET",
    "APP_BASE_URL",
  ])
    && /^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(environment.AUTH0_DOMAIN)
    && /^[a-f0-9]{64}$/i.test(environment.AUTH0_SECRET)
    && localUrl(environment.APP_BASE_URL, 3000);
  const paypalSandboxConfigured = environment.PAYPAL_ENVIRONMENT === "sandbox"
    && configured(environment, [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_MERCHANT_ID",
      "PAYPAL_RETURN_URL",
      "PAYPAL_CANCEL_URL",
    ])
    && localUrl(environment.PAYPAL_RETURN_URL, 3000)
    && localUrl(environment.PAYPAL_CANCEL_URL, 3000);
  const geminiConfigured = configured(environment, [
    "GEMINI_API_KEY",
    "GEMINI_MODEL",
  ]);
  const localH1Profile = environment.SCOPELEDGER_EVALUATOR_LIMITS_PROFILE
      === "local-h1"
    && environment.SCOPELEDGER_ANALYSIS_RUN_LIMIT === "3"
    && environment.SCOPELEDGER_SOURCE_UPLOAD_COUNT_LIMIT === "5"
    && environment.SCOPELEDGER_SOURCE_UPLOAD_BYTES_LIMIT === "25000000"
    && environment.SCOPELEDGER_SOURCE_UPLOAD_WINDOW_MINUTES === "60"
    && environment.SCOPELEDGER_MODEL_CALL_BUDGET === "2";
  const sensitiveNames = /(?:PASSWORD|SECRET|TOKEN|API_KEY|CLIENT_ID|MERCHANT_ID|WEBHOOK_ID|EMAIL|OBJECT_STORAGE_ROOT|DATABASE_URL)$/;
  return {
    booleans: Object.freeze({
      environmentFile,
      localH1Profile,
      databaseConfigured,
      mailpitConfigured,
      objectRootConfigured:
        environment.SCOPELEDGER_OBJECT_STORAGE_ROOT === expectedObjectRoot,
      objectRootReady,
      accessSessionConfigured:
        /^[a-f0-9]{64}$/i.test(environment.ACCESS_SESSION_SECRET ?? ""),
      auth0Configured,
      paypalSandboxConfigured,
      geminiConfigured,
    }),
    sensitiveValues: Object.entries(environment)
      .filter(([name, value]) => sensitiveNames.test(name) && value.length >= 6)
      .map(([, value]) => value),
  };
}

export function validateRepositoryState({
  statusOutput,
  trackedFilesOutput,
  privatePaths,
  allowDirty,
}) {
  const clean = statusOutput.trim() === "";
  const trackedFiles = trackedFilesOutput.split(/\r?\n/).filter(Boolean);
  const privatePathTracked = trackedFiles.some((tracked) =>
    privatePaths.some((privatePath) =>
      tracked === privatePath || tracked.startsWith(`${privatePath}/`)));
  const failures = [];
  if (!clean && !allowDirty) failures.push("working-tree-dirty");
  if (privatePathTracked) failures.push("private-path-tracked");
  return Object.freeze({ clean, privatePathTracked, failures });
}

function validateEvidenceDocument(document) {
  if (
    !document
    || typeof document !== "object"
    || typeof document.task !== "string"
    || typeof document.profile !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(document.observedDate)
    || !document.result
    || typeof document.result !== "object"
  ) {
    return false;
  }
  const privacyEntries = Object.entries(document)
    .filter(([name]) =>
      name.startsWith("contains")
      || name === "providerResourceIdentifiersCommitted");
  if (
    privacyEntries.length === 0
    || privacyEntries.some(([, value]) => value !== false)
  ) {
    return false;
  }
  if (
    "failed" in document.result
    && (
      !Number.isInteger(document.result.failed)
      || document.result.failed !== 0
    )
  ) {
    return false;
  }
  return true;
}

async function defaultValidateEvidenceManifests(manifest, dependencies) {
  const paths = new Set([manifestRelativePath]);
  for (const command of [...manifest.quickCommands, ...manifest.fullCommands]) {
    if (command.evidenceManifest) paths.add(command.evidenceManifest);
  }
  for (const relativePath of [...paths].sort()) {
    let document;
    try {
      document = JSON.parse(
        await dependencies.readFile(path.join(root, relativePath), "utf8"),
      );
    } catch {
      throw new H1AcceptanceError(
        "invalid-evidence-manifest",
        "A required acceptance evidence manifest is missing or invalid.",
      );
    }
    if (
      relativePath !== manifestRelativePath
      && !validateEvidenceDocument(document)
    ) {
      throw new H1AcceptanceError(
        "invalid-evidence-manifest",
        "A required acceptance evidence manifest is invalid.",
      );
    }
  }
  return [...paths].sort();
}

async function defaultValidateMigrationChain(manifest, dependencies) {
  const migrationsDirectory = path.join(root, "packages/db/src/migrations");
  const names = (await dependencies.readdir(migrationsDirectory))
    .filter((name) => /^\d{3}-[a-z0-9-]+\.ts$/.test(name))
    .sort();
  if (names.length !== manifest.latestMigration) return false;
  for (let index = 0; index < names.length; index += 1) {
    const expected = String(index + 1).padStart(3, "0");
    if (!names[index].startsWith(`${expected}-`)) return false;
  }
  const databaseIndex = await dependencies.readFile(
    path.join(root, "packages/db/src/index.ts"),
    "utf8",
  );
  for (const name of names) {
    const moduleName = name.replace(/\.ts$/, ".js");
    if (!databaseIndex.includes(`./migrations/${moduleName}`)) return false;
  }
  const orderedConsent = JSON.parse(await dependencies.readFile(
    path.join(root, "tests/spikes/ordered-consent/acceptance.json"),
    "utf8",
  ));
  return orderedConsent.sqlMigration === manifest.latestMigration;
}

function stripTerminalControls(value) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

export function parseTestSummary(...outputs) {
  const observed = Object.fromEntries(
    summaryKeys.map((key) => [key, []]),
  );
  const normalized = outputs.map(stripTerminalControls).join("\n");
  const expression =
    /^\s*(?:#|ℹ\uFE0F?)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gmu;
  for (const match of normalized.matchAll(expression)) {
    observed[testSummaryLabels[match[1]]].push(Number(match[2]));
  }
  const summaries = observed.tests.length;
  const recognizedLines = Object.values(observed)
    .reduce((total, values) => total + values.length, 0);
  const complete = summaries > 0
    && summaryKeys.every((key) => observed[key].length === summaries);
  const consistent = complete
    && observed.tests.every((tests, index) =>
      tests === observed.passed[index]
        + observed.failed[index]
        + observed.skipped[index]
        + observed.cancelled[index]
        + observed.todo[index]);
  const valid = complete && consistent;
  const counts = Object.fromEntries(summaryKeys.map((key) => [
    key,
    observed[key].reduce((total, value) => total + value, 0),
  ]));
  return Object.freeze({
    ...counts,
    summaries,
    valid,
    ambiguous: recognizedLines > 0 && !valid,
  });
}

export function parseBrowserSummary(output) {
  const nodeSummary = parseTestSummary(output);
  if (nodeSummary.valid || nodeSummary.ambiguous) return nodeSummary;
  const counts = {
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
    summaries: 0,
    valid: false,
    ambiguous: false,
  };
  const labels = {
    passed: "passed",
    failed: "failed",
    skipped: "skipped",
    interrupted: "cancelled",
  };
  for (const match of output.matchAll(
    /^\s*(\d+)\s+(passed|failed|skipped|interrupted)(?:\s|$)/gm,
  )) {
    const key = labels[match[2]];
    counts[key] += Number(match[1]);
    counts.summaries += 1;
  }
  counts.tests = counts.passed
    + counts.failed
    + counts.skipped
    + counts.cancelled;
  counts.valid = counts.summaries > 0;
  return Object.freeze(counts);
}

function commandDisplay(command) {
  return `${command.file} ${command.args.join(" ")}`;
}

function internalResult({
  id,
  label,
  status,
  required = true,
  failureCode,
}) {
  return {
    id,
    label,
    command: `internal:${id}`,
    kind: "check",
    required,
    status,
    ...(failureCode ? { failureCode } : {}),
  };
}

function skippedCommand(command, failureCode) {
  return {
    id: command.id,
    label: command.label,
    command: commandDisplay(command),
    kind: command.kind,
    required: command.required,
    status: "skipped",
    failureCode,
  };
}

async function defaultExecute({ file, args, env = process.env, cwd = root }) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: commandTimeoutMilliseconds,
      maxBuffer: maximumCommandOutputBytes,
    }, (error, stdout, stderr) => {
      const exitCode = error
        ? typeof error.code === "number" ? error.code : 1
        : 0;
      resolve({
        exitCode,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      });
    });
  });
}

export function safeChildEnvironment(commandId = null) {
  const environment = {
    ...process.env,
    CI: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    SCOPELEDGER_AUTH0_DISABLED: "1",
    PAYPAL_ENVIRONMENT: "sandbox",
    PAYPAL_CLIENT_ID: "",
    PAYPAL_CLIENT_SECRET: "",
    PAYPAL_MERCHANT_ID: "",
    PAYPAL_WEBHOOK_ID: "",
    GEMINI_API_KEY: "",
    AUTH0_DOMAIN: "",
    AUTH0_CLIENT_ID: "",
    AUTH0_CLIENT_SECRET: "",
    AUTH0_SECRET: "",
    EMAIL_TRANSPORT: "mailpit",
    EMAIL_SMTP_HOST: "127.0.0.1",
    EMAIL_SMTP_PORT: "1025",
    EMAIL_FROM: "ScopeLedger <notifications@scopeledger.test>",
    EMAIL_DEMO_RECIPIENT: "client@scopeledger.test",
    EMAIL_DEMO_PAYER_RECIPIENT: "payer@scopeledger.test",
    EMAIL_DEMO_PROVIDER_RECIPIENT: "provider@scopeledger.test",
    EMAIL_MAILPIT_API: "http://127.0.0.1:8025",
  };
  delete environment.SCOPELEDGER_DEMO_DB_DISABLED;
  if (commandId === "browser-suite") {
    environment.SCOPELEDGER_DEMO_DB_DISABLED = "1";
  }
  return environment;
}

async function runManifestCommand(command, execute) {
  const execution = await execute({
    id: command.id,
    file: command.file,
    args: command.args,
    env: safeChildEnvironment(command.id),
  });
  if (execution.exitCode !== 0) {
    return {
      id: command.id,
      label: command.label,
      command: commandDisplay(command),
      kind: command.kind,
      required: command.required,
      status: "failed",
      failureCode: "command-exit-nonzero",
    };
  }
  if (command.kind === "test") {
    const counts = parseTestSummary(execution.stdout, execution.stderr);
    if (!counts.valid) {
      return {
        id: command.id,
        label: command.label,
        command: commandDisplay(command),
        kind: command.kind,
        required: command.required,
        status: "failed",
        failureCode: counts.ambiguous
          ? "test-summary-ambiguous"
          : "test-summary-missing",
      };
    }
    if (counts.failed > 0 || counts.cancelled > 0 || counts.skipped > 0) {
      return {
        id: command.id,
        label: command.label,
        command: commandDisplay(command),
        kind: command.kind,
        required: command.required,
        status: "failed",
        failureCode: counts.skipped > 0
          ? "required-test-skip"
          : "test-failure",
        counts: Object.fromEntries(
          summaryKeys.map((key) => [key, counts[key]]),
        ),
      };
    }
    return {
      id: command.id,
      label: command.label,
      command: commandDisplay(command),
      kind: command.kind,
      required: command.required,
      status: "passed",
      counts: Object.fromEntries(
        summaryKeys.map((key) => [key, counts[key]]),
      ),
    };
  }
  return {
    id: command.id,
    label: command.label,
    command: commandDisplay(command),
    kind: command.kind,
    required: command.required,
    status: "passed",
  };
}

async function defaultProbeRoutes(routes) {
  const running = await new Promise((resolve) => {
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: 3000,
    });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  if (!running) return { running: false, healthy: true };
  const request = async (route) => fetch(`http://127.0.0.1:3000${route}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  for (const route of routes) {
    let response;
    try {
      response = await request(route);
    } catch {
      return { running: true, healthy: false };
    }
    const location = response.headers.get("location");
    if (
      response.status < 200
      || response.status >= 400
      || (
        location
        && !location.startsWith("/")
        && !location.startsWith("http://127.0.0.1:")
        && !location.startsWith("http://localhost:")
      )
    ) {
      return { running: true, healthy: false };
    }
  }
  return { running: true, healthy: true };
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("No local preview port was assigned."));
      });
    });
  });
}

async function stopChild(child) {
  if (!child.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
  }
}

async function defaultRunBrowser(execute) {
  const nextBinary = path.join(root, "node_modules/next/dist/bin/next");
  try {
    const binary = await stat(nextBinary);
    if (!binary.isFile()) {
      return { availability: "unavailable" };
    }
  } catch {
    return { availability: "unavailable" };
  }
  const port = await availablePort();
  const environment = {
    ...safeChildEnvironment("browser-suite"),
    NODE_ENV: "production",
    PLAYWRIGHT_BASE_URL: `http://127.0.0.1:${port}`,
  };
  const child = spawn(
    process.execPath,
    [nextBinary, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: path.join(root, "apps/web"),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  child.stdout.resume();
  child.stderr.resume();
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (
        spawnFailed
        || child.exitCode !== null
        || child.signalCode !== null
      ) {
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          redirect: "manual",
          signal: AbortSignal.timeout(1_000),
        });
        if (response.status >= 200 && response.status < 400) {
          ready = true;
          break;
        }
      } catch {
        // The isolated preview may still be starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) {
      return {
        availability: "ran",
        execution: { exitCode: 1, stdout: "", stderr: "" },
      };
    }
    return {
      availability: "ran",
      execution: await execute({
        id: "browser-suite",
        file: "npm",
        args: ["run", "test:ui"],
        env: environment,
      }),
    };
  } finally {
    await stopChild(child);
  }
}

function generatedNextEnvironment(content) {
  return content.split(/\r?\n/).every((line) =>
    line === ""
    || line === '/// <reference types="next" />'
    || line === '/// <reference types="next/image-types/global" />'
    || /^import "\.\/\.next\/(?:dev\/)?types\/(?:routes|root-params|validator)\.d\.ts";$/.test(line)
    || line === "// NOTE: This file should not be edited"
    || line === "// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.");
}

async function captureGeneratedFile(dependencies) {
  const file = path.join(root, "apps/web/next-env.d.ts");
  try {
    const content = await dependencies.readFile(file, "utf8");
    const fileState = await dependencies.stat(file);
    return { file, content, mode: fileState.mode };
  } catch {
    return null;
  }
}

async function restoreGeneratedFile(snapshot, dependencies) {
  if (!snapshot) return;
  let current;
  try {
    current = await dependencies.readFile(snapshot.file, "utf8");
  } catch {
    return;
  }
  if (
    current !== snapshot.content
    && generatedNextEnvironment(current)
    && generatedNextEnvironment(snapshot.content)
  ) {
    await dependencies.writeFile(snapshot.file, snapshot.content, {
      mode: snapshot.mode,
    });
  }
}

function toolVersion(value) {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?/.exec(value);
  return match?.[0] ?? "unavailable";
}

function summarize(commands) {
  const commandCounts = { passed: 0, failed: 0, skipped: 0 };
  const testCounts = {
    tests: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  };
  for (const command of commands) {
    commandCounts[command.status] += 1;
    if (command.counts) {
      for (const key of summaryKeys) testCounts[key] += command.counts[key] ?? 0;
    }
  }
  return {
    passed: commandCounts.failed === 0,
    commands: commandCounts,
    tests: testCounts,
  };
}

async function readJson(relativePath, dependencies) {
  return JSON.parse(
    await dependencies.readFile(path.join(root, relativePath), "utf8"),
  );
}

export async function runAcceptance(options, overrides = {}) {
  const dependencies = {
    execute: defaultExecute,
    inspectLocalProfile: defaultInspectLocalProfile,
    lstat,
    now: () => new Date(),
    probeRoutes: defaultProbeRoutes,
    readFile,
    readdir,
    runBrowser: defaultRunBrowser,
    stat,
    validateEvidenceManifests: defaultValidateEvidenceManifests,
    validateMigrationChain: defaultValidateMigrationChain,
    writeFile,
    ...overrides,
  };
  const manifest = validateAcceptanceManifest(
    JSON.parse(await dependencies.readFile(
      path.join(root, manifestRelativePath),
      "utf8",
    )),
  );
  const packageDocument = await readJson("package.json", dependencies);
  const webPackageDocument = await readJson("apps/web/package.json", dependencies);
  const commands = [];
  const generatedFile = await captureGeneratedFile(dependencies);
  let baselineStatus = "";
  let npmVersion = "unavailable";
  let commit = "unavailable";
  let evidenceManifestPaths = [];
  let migrationChainValid = false;
  let profile = {
    booleans: {
      environmentFile: false,
      localH1Profile: false,
      databaseConfigured: false,
      mailpitConfigured: false,
      objectRootConfigured: false,
      objectRootReady: false,
      accessSessionConfigured: false,
      auth0Configured: false,
      paypalSandboxConfigured: false,
      geminiConfigured: false,
    },
    sensitiveValues: [],
  };
  let databaseRunning = false;
  let mailpitRunning = false;
  let webRunning = false;
  let routesHealthy = true;
  let postRunStatusMatches = true;
  let postgresVersion = "unavailable";

  try {
    const [
      commitExecution,
      statusExecution,
      trackedExecution,
      npmExecution,
    ] = await Promise.all([
      dependencies.execute({
        id: "git-commit",
        file: "git",
        args: ["rev-parse", "HEAD"],
      }),
      dependencies.execute({
        id: "git-status",
        file: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
      }),
      dependencies.execute({
        id: "git-tracked-files",
        file: "git",
        args: ["ls-files"],
      }),
      dependencies.execute({
        id: "npm-version",
        file: "npm",
        args: ["--version"],
      }),
    ]);
    baselineStatus = statusExecution.stdout;
    commit = commitExecution.exitCode === 0
      && /^[a-f0-9]{40}\s*$/.test(commitExecution.stdout)
      ? commitExecution.stdout.trim()
      : "unavailable";
    npmVersion = npmExecution.exitCode === 0
      ? toolVersion(npmExecution.stdout)
      : "unavailable";
    const repositoryState = validateRepositoryState({
      statusOutput: statusExecution.exitCode === 0
        ? statusExecution.stdout
        : "repository-status-unavailable",
      trackedFilesOutput: trackedExecution.exitCode === 0
        ? trackedExecution.stdout
        : "",
      privatePaths: manifest.privatePaths,
      allowDirty: options.allowDirty,
    });
    commands.push(internalResult({
      id: "repository-state",
      label: "Repository working tree",
      status: repositoryState.failures.includes("working-tree-dirty")
        || statusExecution.exitCode !== 0
        || commit === "unavailable"
        ? "failed"
        : "passed",
      failureCode: statusExecution.exitCode !== 0 || commit === "unavailable"
        ? "repository-state-unavailable"
        : repositoryState.failures.includes("working-tree-dirty")
          ? "working-tree-dirty"
          : undefined,
    }));
    commands.push(internalResult({
      id: "private-boundary",
      label: "Private tracked-path boundary",
      status: repositoryState.privatePathTracked
        || trackedExecution.exitCode !== 0
        ? "failed"
        : "passed",
      failureCode: trackedExecution.exitCode !== 0
        ? "tracked-files-unavailable"
        : repositoryState.privatePathTracked
          ? "private-path-tracked"
          : undefined,
    }));
    const gitignore = await dependencies.readFile(path.join(root, ".gitignore"), "utf8");
    commands.push(internalResult({
      id: "evidence-ignore",
      label: "Ignored evidence boundary",
      status: /^\.scopeledger-local\/\s*$/m.test(gitignore)
        || /^\/\.scopeledger-local\/\s*$/m.test(gitignore)
        ? "passed"
        : "failed",
      failureCode: /^\/?\.scopeledger-local\/\s*$/m.test(gitignore)
        ? undefined
        : "evidence-path-not-ignored",
    }));
    commands.push(internalResult({
      id: "toolchain",
      label: "Pinned local toolchain",
      status: /^26\./.test(process.versions.node)
        && /^11\./.test(npmVersion)
        && packageDocument.devDependencies?.typescript === "6.0.3"
        ? "passed"
        : "failed",
      failureCode: /^26\./.test(process.versions.node)
        && /^11\./.test(npmVersion)
        && packageDocument.devDependencies?.typescript === "6.0.3"
        ? undefined
        : "toolchain-mismatch",
    }));

    try {
      evidenceManifestPaths = await dependencies.validateEvidenceManifests(
        manifest,
        dependencies,
      );
      commands.push(internalResult({
        id: "evidence-manifests",
        label: "Acceptance evidence manifests",
        status: "passed",
      }));
    } catch {
      commands.push(internalResult({
        id: "evidence-manifests",
        label: "Acceptance evidence manifests",
        status: "failed",
        failureCode: "invalid-evidence-manifest",
      }));
    }

    try {
      migrationChainValid = await dependencies.validateMigrationChain(
        manifest,
        dependencies,
      );
    } catch {
      migrationChainValid = false;
    }
    commands.push(internalResult({
      id: "migration-chain",
      label: "Sequential migration chain",
      status: migrationChainValid ? "passed" : "failed",
      failureCode: migrationChainValid ? undefined : "invalid-migration-chain",
    }));

    try {
      profile = await dependencies.inspectLocalProfile(dependencies);
    } catch {
      profile = { ...profile, sensitiveValues: [] };
    }
    const requiredConfiguration = [
      profile.booleans.environmentFile,
      profile.booleans.localH1Profile,
      profile.booleans.databaseConfigured,
      profile.booleans.mailpitConfigured,
      profile.booleans.objectRootConfigured,
      profile.booleans.objectRootReady,
      profile.booleans.accessSessionConfigured,
    ].every(Boolean);
    commands.push(internalResult({
      id: "local-profile",
      label: "Verified local H1 profile",
      status: requiredConfiguration ? "passed" : "failed",
      failureCode: requiredConfiguration
        ? undefined
        : "local-profile-incomplete",
    }));

    if (profile.booleans.databaseConfigured) {
      const databaseStatus = await dependencies.execute({
        id: "database-status",
        file: "npm",
        args: ["run", "dev:db:status"],
      });
      databaseRunning = databaseStatus.exitCode === 0
        && /"running"\s*:\s*true/.test(databaseStatus.stdout);
      const versionMatch = /"version"\s*:\s*"([^"]+)"/.exec(
        databaseStatus.stdout,
      );
      postgresVersion = databaseRunning
        ? toolVersion(versionMatch?.[1] ?? "")
        : "unavailable";
      commands.push({
        id: "database-status",
        label: "Owned local PostgreSQL status",
        command: "npm run dev:db:status",
        kind: "check",
        required: true,
        status: databaseRunning ? "passed" : "failed",
        ...(!databaseRunning
          ? { failureCode: "database-unavailable" }
          : {}),
      });
    } else {
      commands.push({
        id: "database-status",
        label: "Owned local PostgreSQL status",
        command: "npm run dev:db:status",
        kind: "check",
        required: true,
        status: "failed",
        failureCode: "database-configuration-missing",
      });
    }

    if (profile.booleans.mailpitConfigured) {
      const mailpitStatus = await dependencies.execute({
        id: "mailpit-status",
        file: "npm",
        args: ["run", "mailpit:status"],
      });
      mailpitRunning = mailpitStatus.exitCode === 0
        && /"running"\s*:\s*true/.test(mailpitStatus.stdout);
      commands.push({
        id: "mailpit-status",
        label: "Owned local Mailpit status",
        command: "npm run mailpit:status",
        kind: "check",
        required: true,
        status: mailpitRunning ? "passed" : "failed",
        ...(!mailpitRunning ? { failureCode: "mailpit-unavailable" } : {}),
      });
    } else {
      commands.push({
        id: "mailpit-status",
        label: "Owned local Mailpit status",
        command: "npm run mailpit:status",
        kind: "check",
        required: true,
        status: "failed",
        failureCode: "mailpit-configuration-missing",
      });
    }

    const preflightFailed = commands.some((command) =>
      command.required && command.status === "failed");
    if (!preflightFailed) {
      const routeState = await dependencies.probeRoutes(manifest.localRoutes);
      webRunning = routeState.running;
      routesHealthy = routeState.healthy;
      commands.push(internalResult({
        id: "localhost-routes",
        label: "Running localhost route health",
        status: webRunning ? routesHealthy ? "passed" : "failed" : "skipped",
        required: webRunning,
        failureCode: webRunning
          ? routesHealthy ? undefined : "localhost-route-unhealthy"
          : "web-not-running",
      }));
    } else {
      commands.push(internalResult({
        id: "localhost-routes",
        label: "Running localhost route health",
        status: "skipped",
        required: false,
        failureCode: "preflight-failed",
      }));
    }

    const selected = options.mode === "full"
      ? [...manifest.quickCommands, ...manifest.fullCommands]
      : [...manifest.quickCommands];
    let blocked = commands.some((command) =>
      command.required && command.status === "failed");
    for (const command of selected) {
      if (blocked) {
        commands.push(skippedCommand(command, "prior-required-failure"));
        continue;
      }
      const result = await runManifestCommand(command, dependencies.execute);
      commands.push(result);
      if (result.required && result.status === "failed") blocked = true;
    }

    if (options.mode === "full") {
      if (blocked) {
        commands.push({
          id: "browser-suite",
          label: "Isolated production browser suite",
          command: "npm run test:ui",
          kind: "test",
          required: false,
          status: "skipped",
          failureCode: "prior-required-failure",
        });
      } else {
        let browser;
        try {
          browser = await dependencies.runBrowser(dependencies.execute);
        } catch {
          browser = {
            availability: "ran",
            execution: { exitCode: 1, stdout: "", stderr: "" },
          };
        }
        if (browser.availability === "unavailable") {
          commands.push({
            id: "browser-suite",
            label: "Isolated production browser suite",
            command: "npm run test:ui",
            kind: "test",
            required: false,
            status: "skipped",
            failureCode: "isolated-preview-unavailable",
          });
        } else {
          const browserCommand = {
            id: "browser-suite",
            label: "Isolated production browser suite",
            file: "npm",
            args: ["run", "test:ui"],
            kind: "test",
            required: true,
          };
          const execution = browser.execution;
          if (execution.exitCode !== 0) {
            commands.push({
              id: browserCommand.id,
              label: browserCommand.label,
              command: commandDisplay(browserCommand),
              kind: browserCommand.kind,
              required: true,
              status: "failed",
              failureCode: "browser-suite-failed",
            });
          } else {
            const counts = parseBrowserSummary(
              `${execution.stdout}\n${execution.stderr}`,
            );
            commands.push({
              id: browserCommand.id,
              label: browserCommand.label,
              command: commandDisplay(browserCommand),
              kind: browserCommand.kind,
              required: true,
              status: counts.valid
                && counts.failed === 0
                && counts.cancelled === 0
                && counts.skipped === 0
                ? "passed"
                : "failed",
              ...(counts.valid
                ? {
                    counts: Object.fromEntries(
                      summaryKeys.map((key) => [key, counts[key]]),
                    ),
                  }
                : {}),
              ...(!counts.valid
                ? {
                    failureCode: counts.ambiguous
                      ? "test-summary-ambiguous"
                      : "test-summary-missing",
                  }
                : counts.skipped > 0
                  ? { failureCode: "required-test-skip" }
                  : counts.failed > 0 || counts.cancelled > 0
                    ? { failureCode: "test-failure" }
                    : {}),
            });
          }
        }
      }
    }
  } finally {
    await restoreGeneratedFile(generatedFile, dependencies);
    const postStatus = await dependencies.execute({
      id: "git-status-after",
      file: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all"],
    });
    postRunStatusMatches = postStatus.exitCode === 0
      && postStatus.stdout === baselineStatus;
    commands.push(internalResult({
      id: "working-tree-after-run",
      label: "Working tree preserved by runner",
      status: postRunStatusMatches ? "passed" : "failed",
      failureCode: postRunStatusMatches
        ? undefined
        : "working-tree-changed-during-run",
    }));
  }

  const result = summarize(commands);
  const report = {
    schemaVersion: "scopeledger.h1-acceptance-report.v1",
    profile: manifest.profile,
    mode: options.mode,
    observedDate: dependencies.now().toISOString().slice(0, 10),
    commit,
    tools: {
      node: process.versions.node,
      npm: npmVersion,
      typescript: packageDocument.devDependencies?.typescript ?? "unavailable",
      next: webPackageDocument.dependencies?.next ?? "unavailable",
      playwright:
        packageDocument.devDependencies?.["@playwright/test"] ?? "unavailable",
      postgresql: postgresVersion,
    },
    commands,
    result,
    services: {
      databaseRunning,
      mailpitRunning,
      objectRootReady: profile.booleans.objectRootReady,
      webRunning,
      routesHealthy: webRunning ? routesHealthy : false,
    },
    configuration: {
      environmentFile: profile.booleans.environmentFile,
      localH1Profile: profile.booleans.localH1Profile,
      databaseConfigured: profile.booleans.databaseConfigured,
      mailpitConfigured: profile.booleans.mailpitConfigured,
      objectRootConfigured: profile.booleans.objectRootConfigured,
      accessSessionConfigured: profile.booleans.accessSessionConfigured,
      auth0Configured: profile.booleans.auth0Configured,
      paypalSandboxConfigured: profile.booleans.paypalSandboxConfigured,
      geminiConfigured: profile.booleans.geminiConfigured,
    },
    acceptance: {
      migrationChainValid,
      evidenceManifestsValid: commands.some((command) =>
        command.id === "evidence-manifests" && command.status === "passed"),
      privateBoundaryClean: commands.some((command) =>
        command.id === "private-boundary" && command.status === "passed"),
      workingTreePreserved: postRunStatusMatches,
    },
    inventory: manifest.inventory,
    evidenceManifestPaths,
    reportPath: options.reportPath,
    sideEffects: {
      externalProviderWrites: false,
      financialEffects: false,
      externalEmailDelivery: false,
    },
  };
  return assertReportSafe(report, profile.sensitiveValues);
}

async function writeReport(report, outputPath) {
  const parent = path.dirname(outputPath);
  const segments = path.relative(root, parent).split(path.sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const state = await lstat(current);
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new H1AcceptanceError(
          "unsafe-output-path",
          "Acceptance output directories must not be symbolic links.",
        );
      }
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        await mkdir(current, { mode: 0o700 });
      } else {
        throw error;
      }
    }
    await chmod(current, 0o700);
  }
  try {
    const outputState = await lstat(outputPath);
    if (!outputState.isFile() || outputState.isSymbolicLink()) {
      throw new H1AcceptanceError(
        "unsafe-output-path",
        "Acceptance output must be a regular file.",
      );
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, outputPath);
}

export async function main(arguments_ = process.argv.slice(2)) {
  try {
    const options = parseArguments(arguments_);
    const report = await runAcceptance(options);
    await writeReport(report, options.outputPath);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.result.passed ? 0 : 1;
  } catch (error) {
    const code = error instanceof H1AcceptanceError
      ? error.code
      : "acceptance-runner-failed";
    process.stderr.write(`H1 acceptance failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
