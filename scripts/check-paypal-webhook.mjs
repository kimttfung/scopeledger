import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectWebhookDoctor,
  parseCommandLineOptions,
  parseLoopbackPort,
  safeToolingFailure,
  SCOPELEDGER_WEBHOOK_PATH,
  WebhookToolingError,
} from "./paypal-webhook-tooling.mjs";

export async function runPayPalWebhookDoctor(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const options = parseCommandLineOptions(argv, {
    valueOptions: ["receiver-url", "url", "events", "port"],
    booleanOptions: ["tunnel"],
  });
  if (options["receiver-url"] && options.port) {
    throw new WebhookToolingError(
      "INVALID_ARGUMENT",
      "--receiver-url and --port cannot be combined",
    );
  }
  const receiverUrl = options["receiver-url"]
    ?? (options.port
      ? `http://127.0.0.1:${parseLoopbackPort(options.port)}${SCOPELEDGER_WEBHOOK_PATH}`
      : undefined);
  return inspectWebhookDoctor({
    environment: dependencies.environment ?? process.env,
    ...(receiverUrl ? { receiverUrl } : {}),
    ...(options.url ? { publicUrl: options.url } : {}),
    ...(options.events ? { eventTypes: options.events } : {}),
    tunnelRequested: options.tunnel === true,
    ...(dependencies.run ? { run: dependencies.run } : {}),
    ...(dependencies.routeAccess
      ? { routeAccess: dependencies.routeAccess }
      : {}),
  });
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await runPayPalWebhookDoctor();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify(safeToolingFailure(error), null, 2));
    process.exitCode = 1;
  }
}
