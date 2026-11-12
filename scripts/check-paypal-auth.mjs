import {
  PayPalSandboxClient,
  payPalConfigFromEnvironment,
} from "@scopeledger/paypal-adapter";

try {
  const config = payPalConfigFromEnvironment();
  const client = new PayPalSandboxClient(config);
  const result = await client.checkAuthentication();
  console.log(JSON.stringify({
    authenticated: true,
    environment: result.environment,
    merchantId: result.merchantId,
  }, null, 2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  const message = error instanceof Error ? error.message : "Unknown PayPal authentication error";
  console.error(`PayPal authentication check failed [${code}]: ${message}`);
  process.exitCode = 1;
}
