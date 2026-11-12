import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PayPalSandboxWebhookManagementClient,
  payPalSandboxManagementConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";
import {
  ensurePayPalSandboxWebhook,
  parseCommandLineOptions,
  safeToolingFailure,
  WebhookToolingError,
  writeVerifiedWebhookEnvironment,
} from "./paypal-webhook-tooling.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

export async function runPayPalSandboxWebhookManagement(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const options = parseCommandLineOptions(argv, {
    valueOptions: ["mode", "url", "events"],
    booleanOptions: ["write-env"],
  });
  if (!options.url) {
    throw new WebhookToolingError(
      "PUBLIC_WEBHOOK_URL_REQUIRED",
      "Usage: --url https://<quick-tunnel>.trycloudflare.com/api/paypal/webhook [--mode register|verify] [--events <comma-list>] [--write-env]",
    );
  }
  const environment = dependencies.environment ?? process.env;
  const client = dependencies.client
    ?? new PayPalSandboxWebhookManagementClient(
      payPalSandboxManagementConfigFromEnvironment(environment),
      dependencies.fetch ? { fetch: dependencies.fetch } : {},
    );
  const result = await ensurePayPalSandboxWebhook({
    client,
    url: options.url,
    ...(options.events ? { eventTypes: options.events } : {}),
    mode: options.mode ?? "register",
  });

  let environmentUpdate = Object.freeze({
    updated: false,
    keys: Object.freeze([]),
  });
  if (options["write-env"]) {
    environmentUpdate = await writeVerifiedWebhookEnvironment({
      envPath: dependencies.envPath ?? resolve(root, ".env.local"),
      webhookId: result.registration.id,
      publicUrl: result.url,
    });
  }

  return Object.freeze({
    verified: true,
    environment: "sandbox",
    action: result.action,
    webhookId: result.registration.id,
    url: result.url,
    eventTypes: result.eventTypes,
    environmentUpdate,
    nextSteps: environmentUpdate.updated
      ? Object.freeze([
        "Restart the local web process so PAYPAL_WEBHOOK_ID is reloaded.",
        "Keep the tunnel process running while PayPal Sandbox delivers events.",
      ])
      : Object.freeze([
        `Set PAYPAL_WEBHOOK_ID=${result.registration.id} in ignored .env.local.`,
        `Set PAYPAL_WEBHOOK_URL=${result.url} in ignored .env.local.`,
        "Re-run with --write-env to update only those two keys atomically.",
      ]),
    unregisterGuidance:
      "No webhook was deleted. Remove stale registrations manually in PayPal Sandbox only after checking the exact webhook ID and URL.",
  });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(
      await runPayPalSandboxWebhookManagement(),
      null,
      2,
    ));
  } catch (error) {
    console.error(JSON.stringify(safeToolingFailure(error), null, 2));
    process.exitCode = 1;
  }
}
