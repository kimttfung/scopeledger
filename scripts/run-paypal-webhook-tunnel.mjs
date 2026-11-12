import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  cloudflaredEnvironment,
  cloudflaredTunnelArguments,
  cloudflaredVersion,
  parseCloudflaredPublicUrl,
  parseCommandLineOptions,
  parseLoopbackPort,
  safeToolingFailure,
  WebhookToolingError,
} from "./paypal-webhook-tooling.mjs";

export async function runPayPalWebhookTunnel(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const options = parseCommandLineOptions(argv, {
    valueOptions: ["port"],
  });
  const port = parseLoopbackPort(options.port ?? "3000");
  const version = await cloudflaredVersion(dependencies.runVersion);
  const start = dependencies.spawnProcess ?? spawn;
  const child = start(
    "cloudflared",
    cloudflaredTunnelArguments(port),
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: cloudflaredEnvironment(
        dependencies.environment ?? process.env,
      ),
    },
  );
  const output = dependencies.output ?? console.log;
  output(JSON.stringify({
    cloudflaredVersion: version,
    forwardingTo: `http://127.0.0.1:${port}`,
  }));

  let buffer = "";
  let publicUrl = null;
  let parseFailure = null;
  let requestedSignal = null;
  const consume = (chunk) => {
    buffer = `${buffer}${String(chunk)}`.slice(-131_072);
    try {
      const parsed = parseCloudflaredPublicUrl(buffer);
      if (parsed && !publicUrl) {
        publicUrl = parsed;
        output(JSON.stringify({
          publicWebhookUrl: parsed,
          instruction:
            "Keep this process running, then register this exact URL with the PayPal Sandbox command.",
        }));
      }
    } catch (error) {
      parseFailure = error;
      if (!child.killed) child.kill("SIGTERM");
    }
  };
  child.stdout?.on("data", consume);
  child.stderr?.on("data", consume);

  const stopOwnChild = (signal) => {
    requestedSignal = signal;
    if (!child.killed) child.kill(signal);
  };
  const onInterrupt = () => stopOwnChild("SIGINT");
  const onTerminate = () => stopOwnChild("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);

  try {
    const result = await new Promise((resolvePromise, rejectPromise) => {
      child.once("error", () => {
        rejectPromise(new WebhookToolingError(
          "CLOUDFLARED_START_FAILED",
          "cloudflared could not be started",
        ));
      });
      child.once("close", (code, signal) => {
        resolvePromise({ code, signal });
      });
    });
    if (parseFailure) throw parseFailure;
    if (requestedSignal) {
      return Object.freeze({
        stopped: true,
        signal: requestedSignal,
        publicUrl,
      });
    }
    if (result.code !== 0) {
      throw new WebhookToolingError(
        "CLOUDFLARED_EXITED",
        "cloudflared exited before the tunnel was stopped",
      );
    }
    if (!publicUrl) {
      throw new WebhookToolingError(
        "CLOUDFLARED_URL_MISSING",
        "cloudflared exited without reporting a trusted quick-tunnel URL",
      );
    }
    return Object.freeze({ stopped: true, signal: result.signal, publicUrl });
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await runPayPalWebhookTunnel();
    if (result.signal === "SIGINT") process.exitCode = 130;
    if (result.signal === "SIGTERM") process.exitCode = 143;
  } catch (error) {
    console.error(JSON.stringify(safeToolingFailure(error), null, 2));
    process.exitCode = 1;
  }
}
