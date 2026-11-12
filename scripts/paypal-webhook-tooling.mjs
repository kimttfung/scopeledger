import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const executeFile = promisify(execFileCallback);

export const SCOPELEDGER_WEBHOOK_PATH = "/api/paypal/webhook";
export const PAYPAL_PUBLIC_WEBHOOK_URL_ENV = "PAYPAL_WEBHOOK_URL";
export const REVIEWED_PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES = Object.freeze([
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.PAYMENT-APPROVAL.REVERSED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.REFUND.PENDING",
  "PAYMENT.REFUND.COMPLETED",
  "PAYMENT.REFUND.FAILED",
]);

const reviewedEvents = new Set(
  REVIEWED_PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES,
);
const webhookIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const cloudflaredHostPattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com$/;
const routeSourceUrl = new URL(
  "../apps/web/app/api/paypal/webhook/route.ts",
  import.meta.url,
);

export class WebhookToolingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WebhookToolingError";
    this.code = code;
  }
}

export function parseCommandLineOptions(
  argv,
  { valueOptions = [], booleanOptions = [] } = {},
) {
  const values = new Set(valueOptions);
  const booleans = new Set(booleanOptions);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) {
      throw toolingError(
        "INVALID_ARGUMENT",
        "Only documented --options are accepted",
      );
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (booleans.has(name)) {
      if (separator !== -1 || Object.hasOwn(parsed, name)) {
        throw toolingError(
          "INVALID_ARGUMENT",
          "Boolean options cannot have values or be repeated",
        );
      }
      parsed[name] = true;
      continue;
    }
    if (!values.has(name) || Object.hasOwn(parsed, name)) {
      throw toolingError(
        "INVALID_ARGUMENT",
        "An option was unknown or repeated",
      );
    }
    const value = separator === -1 ? argv[index + 1] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      throw toolingError(
        "INVALID_ARGUMENT",
        "A required option value was missing",
      );
    }
    parsed[name] = value;
    if (separator === -1) index += 1;
  }
  return Object.freeze(parsed);
}

function toolingError(code, message) {
  return new WebhookToolingError(code, message);
}

export function parseLoopbackPort(value = "3000") {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw toolingError(
      "INVALID_PORT",
      "Loopback port must be an integer from 1 to 65535",
    );
  }
  return parsed;
}

function parseUrl(value, code, message) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw toolingError(code, message);
  }
  try {
    return new URL(value);
  } catch {
    throw toolingError(code, message);
  }
}

function hasUnsafeUrlComponents(url) {
  return Boolean(
    url.username
    || url.password
    || url.search
    || url.hash,
  );
}

export function validateLocalWebhookReceiverUrl(value) {
  const url = parseUrl(
    value,
    "INVALID_LOCAL_RECEIVER_URL",
    "Local receiver must be a loopback ScopeLedger webhook URL",
  );
  const loopback = url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "::1"
    || url.hostname === "[::1]";
  if (
    url.protocol !== "http:"
    || !loopback
    || hasUnsafeUrlComponents(url)
    || url.pathname !== SCOPELEDGER_WEBHOOK_PATH
  ) {
    throw toolingError(
      "INVALID_LOCAL_RECEIVER_URL",
      "Local receiver must use HTTP loopback and the exact /api/paypal/webhook path without credentials, query, or fragment",
    );
  }
  return url.toString();
}

export function validatePublicWebhookUrl(value) {
  const url = parseUrl(
    value,
    "INVALID_PUBLIC_WEBHOOK_URL",
    "Public webhook URL must be a trusted Cloudflare quick-tunnel HTTPS URL",
  );
  if (
    url.protocol !== "https:"
    || hasUnsafeUrlComponents(url)
    || url.port
    || url.pathname !== SCOPELEDGER_WEBHOOK_PATH
    || !cloudflaredHostPattern.test(url.hostname.toLowerCase())
  ) {
    throw toolingError(
      "INVALID_PUBLIC_WEBHOOK_URL",
      "Public webhook URL must use a generated *.trycloudflare.com HTTPS host and the exact /api/paypal/webhook path without credentials, port, query, or fragment",
    );
  }
  return url.toString();
}

export function parseReviewedEventTypes(input) {
  const values = input === undefined
    ? [...REVIEWED_PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES]
    : Array.isArray(input)
      ? input
      : String(input).split(",");
  const normalized = values.map((value) => String(value).trim());
  if (
    normalized.length === 0
    || normalized.some((value) => !value)
    || new Set(normalized).size !== normalized.length
    || normalized.some((value) => !reviewedEvents.has(value))
  ) {
    throw toolingError(
      "INVALID_EVENT_TYPES",
      "Webhook event selection must be a unique non-empty subset of the reviewed PayPal Sandbox allowlist",
    );
  }
  return Object.freeze(
    REVIEWED_PAYPAL_SANDBOX_WEBHOOK_EVENT_TYPES.filter(
      (eventType) => normalized.includes(eventType),
    ),
  );
}

export function parseCloudflaredPublicUrl(output) {
  const matches = String(output).matchAll(
    /https:\/\/[a-z0-9][a-z0-9-]{0,62}\.trycloudflare\.com/gi,
  );
  const origins = new Set(
    [...matches].map((match) => new URL(match[0]).origin),
  );
  if (origins.size === 0) return null;
  if (origins.size !== 1) {
    throw toolingError(
      "AMBIGUOUS_TUNNEL_OUTPUT",
      "cloudflared reported more than one quick-tunnel URL",
    );
  }
  const [origin] = origins;
  return validatePublicWebhookUrl(`${origin}${SCOPELEDGER_WEBHOOK_PATH}`);
}

export function cloudflaredTunnelArguments(portInput = 3000) {
  const port = parseLoopbackPort(portInput);
  return Object.freeze([
    "tunnel",
    "--url",
    `http://127.0.0.1:${port}`,
  ]);
}

export function cloudflaredEnvironment(environment = process.env) {
  return Object.freeze({
    ...(environment.PATH ? { PATH: environment.PATH } : {}),
    ...(environment.LANG ? { LANG: environment.LANG } : {}),
    ...(environment.LC_ALL ? { LC_ALL: environment.LC_ALL } : {}),
    ...(environment.SYSTEMROOT
      ? { SYSTEMROOT: environment.SYSTEMROOT }
      : {}),
  });
}

export async function cloudflaredVersion(
  run = executeFile,
) {
  let result;
  try {
    result = await run("cloudflared", ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: cloudflaredEnvironment(),
    });
  } catch {
    throw toolingError(
      "CLOUDFLARED_UNAVAILABLE",
      "cloudflared is not installed or is not executable; install it manually before requesting tunnel mode",
    );
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const match = /cloudflared version ([^\s]+)/i.exec(output);
  if (!match?.[1]) {
    throw toolingError(
      "CLOUDFLARED_VERSION_INVALID",
      "cloudflared did not report a recognizable version",
    );
  }
  return match[1];
}

function check(name, ok, detail) {
  return Object.freeze({ name, ok, detail });
}

export async function inspectWebhookDoctor({
  environment = process.env,
  receiverUrl,
  publicUrl,
  eventTypes,
  tunnelRequested = false,
  run = executeFile,
  routeAccess = access,
} = {}) {
  const checks = [];
  checks.push(check(
    "sandbox-environment",
    environment.PAYPAL_ENVIRONMENT === "sandbox",
    environment.PAYPAL_ENVIRONMENT === "sandbox"
      ? "sandbox"
      : "PAYPAL_ENVIRONMENT must be sandbox",
  ));
  checks.push(check(
    "oauth-credentials",
    Boolean(environment.PAYPAL_CLIENT_ID && environment.PAYPAL_CLIENT_SECRET),
    environment.PAYPAL_CLIENT_ID && environment.PAYPAL_CLIENT_SECRET
      ? "configured"
      : "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required",
  ));

  const configuredReceiver = receiverUrl
    ?? environment.SCOPELEDGER_PAYPAL_WEBHOOK_RECEIVER_URL
    ?? "http://127.0.0.1:3000/api/paypal/webhook";
  let safeReceiver = null;
  try {
    safeReceiver = validateLocalWebhookReceiverUrl(configuredReceiver);
    await routeAccess(routeSourceUrl);
    checks.push(check(
      "local-receiver",
      true,
      `${safeReceiver} maps to the ScopeLedger receiver route`,
    ));
  } catch (error) {
    checks.push(check(
      "local-receiver",
      false,
      error instanceof WebhookToolingError
        ? error.message
        : "ScopeLedger webhook receiver route source is unavailable",
    ));
  }

  const webhookIdConfigured = typeof environment.PAYPAL_WEBHOOK_ID === "string"
    && webhookIdPattern.test(environment.PAYPAL_WEBHOOK_ID);
  checks.push(check(
    "paypal-webhook-id",
    webhookIdConfigured,
    webhookIdConfigured
      ? "configured with a valid identifier shape"
      : "PAYPAL_WEBHOOK_ID is missing or invalid",
  ));

  const configuredPublicUrl =
    publicUrl ?? environment[PAYPAL_PUBLIC_WEBHOOK_URL_ENV];
  let safePublicUrl = null;
  if (configuredPublicUrl) {
    try {
      safePublicUrl = validatePublicWebhookUrl(configuredPublicUrl);
      checks.push(check("public-webhook-url", true, safePublicUrl));
    } catch (error) {
      checks.push(check(
        "public-webhook-url",
        false,
        error instanceof Error ? error.message : "Public webhook URL is invalid",
      ));
    }
  } else {
    checks.push(check(
      "public-webhook-url",
      true,
      "not configured (optional until registration)",
    ));
  }

  let selectedEvents = [];
  try {
    selectedEvents = [...parseReviewedEventTypes(eventTypes)];
    checks.push(check(
      "event-types",
      true,
      `${selectedEvents.length} reviewed event types selected`,
    ));
  } catch (error) {
    checks.push(check(
      "event-types",
      false,
      error instanceof Error ? error.message : "Webhook event selection is invalid",
    ));
  }

  let tunnel = Object.freeze({ requested: false });
  if (tunnelRequested) {
    try {
      const version = await cloudflaredVersion(run);
      tunnel = Object.freeze({ requested: true, available: true, version });
      checks.push(check(
        "cloudflared",
        true,
        `installed (${version})`,
      ));
    } catch (error) {
      tunnel = Object.freeze({ requested: true, available: false });
      checks.push(check(
        "cloudflared",
        false,
        error instanceof Error ? error.message : "cloudflared is unavailable",
      ));
    }
  }

  return Object.freeze({
    ok: checks.every((entry) => entry.ok),
    receiverUrl: safeReceiver,
    publicUrl: safePublicUrl,
    eventTypes: Object.freeze(selectedEvents),
    tunnel,
    checks: Object.freeze(checks),
  });
}

function sameEventTypes(left, right) {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
}

function validRegistration(registration) {
  return registration
    && typeof registration === "object"
    && typeof registration.id === "string"
    && webhookIdPattern.test(registration.id)
    && typeof registration.url === "string"
    && Array.isArray(registration.eventTypes)
    && registration.eventTypes.every((value) => typeof value === "string");
}

function exactRegistrations(registrations, url) {
  return registrations.filter(
    (registration) => validRegistration(registration)
      && registration.url === url,
  );
}

function verifiedExactRegistration(registrations, url, eventTypes) {
  const exact = exactRegistrations(registrations, url);
  if (exact.length > 1) {
    throw toolingError(
      "AMBIGUOUS_WEBHOOK_REGISTRATION",
      "Multiple PayPal webhooks use the exact requested URL; resolve them manually before continuing",
    );
  }
  const registration = exact[0];
  if (!registration) return null;
  if (!sameEventTypes(registration.eventTypes, eventTypes)) {
    throw toolingError(
      "CONFLICTING_WEBHOOK_REGISTRATION",
      "The exact requested URL is registered with a different event selection; review it manually",
    );
  }
  return registration;
}

export async function ensurePayPalSandboxWebhook({
  client,
  url: urlInput,
  eventTypes: eventTypesInput,
  mode = "register",
}) {
  if (mode !== "register" && mode !== "verify") {
    throw toolingError(
      "INVALID_MANAGEMENT_MODE",
      "Webhook management mode must be register or verify",
    );
  }
  const url = validatePublicWebhookUrl(urlInput);
  const eventTypes = parseReviewedEventTypes(eventTypesInput);
  const before = await client.listWebhooks();
  const existing = verifiedExactRegistration(before, url, eventTypes);
  if (existing) {
    return Object.freeze({
      action: "reused",
      registration: existing,
      url,
      eventTypes,
    });
  }
  if (mode === "verify") {
    throw toolingError(
      "WEBHOOK_REGISTRATION_NOT_FOUND",
      "No exact PayPal webhook registration matched the requested URL and event selection",
    );
  }

  const created = await client.createWebhook({ url, eventTypes });
  if (
    !validRegistration(created)
    || created.url !== url
    || !sameEventTypes(created.eventTypes, eventTypes)
  ) {
    throw toolingError(
      "CREATED_WEBHOOK_MISMATCH",
      "PayPal created a webhook that did not match the reviewed request",
    );
  }
  const after = await client.listWebhooks();
  const verified = verifiedExactRegistration(after, url, eventTypes);
  if (!verified || verified.id !== created.id) {
    throw toolingError(
      "CREATED_WEBHOOK_NOT_VERIFIED",
      "The newly created PayPal webhook could not be verified by exact list replay",
    );
  }
  return Object.freeze({
    action: "created",
    registration: verified,
    url,
    eventTypes,
  });
}

function replaceEnvValue(content, name, value) {
  const lines = content.split(/\r?\n/);
  const matches = [];
  const assignment = new RegExp(
    `^\\s*(?:export\\s+)?${name}\\s*=`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    if (assignment.test(lines[index] ?? "")) matches.push(index);
  }
  if (matches.length > 1) {
    throw toolingError(
      "AMBIGUOUS_ENV_FILE",
      `.env.local contains duplicate ${name} assignments`,
    );
  }
  if (matches.length === 1) {
    lines[matches[0]] = `${name}=${value}`;
  } else {
    while (lines.at(-1) === "") lines.pop();
    lines.push(`${name}=${value}`, "");
  }
  return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
}

export async function writeVerifiedWebhookEnvironment({
  envPath,
  webhookId,
  publicUrl,
}) {
  if (!webhookIdPattern.test(webhookId)) {
    throw toolingError(
      "INVALID_WEBHOOK_ID",
      "Verified PayPal webhook ID has an invalid shape",
    );
  }
  const safePublicUrl = validatePublicWebhookUrl(publicUrl);
  const target = resolve(envPath);
  const metadata = await lstat(target);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.size > 1_000_000
  ) {
    throw toolingError(
      "UNSAFE_ENV_FILE",
      ".env.local must be a bounded regular non-symlink file",
    );
  }
  let content = await readFile(target, "utf8");
  content = replaceEnvValue(content, "PAYPAL_WEBHOOK_ID", webhookId);
  content = replaceEnvValue(
    content,
    PAYPAL_PUBLIC_WEBHOOK_URL_ENV,
    safePublicUrl,
  );

  const temporaryPath = `${target}.webhook-${randomUUID()}.tmp`;
  let temporary;
  try {
    temporary = await open(temporaryPath, "wx", 0o600);
    await temporary.writeFile(content, "utf8");
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await rename(temporaryPath, target);
    const directory = await open(dirname(target), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await temporary?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    updated: true,
    keys: Object.freeze([
      "PAYPAL_WEBHOOK_ID",
      PAYPAL_PUBLIC_WEBHOOK_URL_ENV,
    ]),
  });
}

export function safeToolingFailure(error) {
  if (error instanceof WebhookToolingError) {
    return Object.freeze({ code: error.code, message: error.message });
  }
  if (
    error
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
  ) {
    return Object.freeze({
      code: error.code,
      message: "PayPal webhook operation failed",
    });
  }
  return Object.freeze({
    code: "WEBHOOK_TOOLING_FAILED",
    message: "PayPal webhook operation failed",
  });
}
