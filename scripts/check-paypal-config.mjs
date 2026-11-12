import { payPalConfigFromEnvironment } from "@scopeledger/paypal-adapter";

try {
  const config = payPalConfigFromEnvironment();
  console.log(JSON.stringify({
    environment: config.environment,
    merchantId: config.merchantId,
    returnOrigin: new URL(config.returnUrl).origin,
    cancelOrigin: new URL(config.cancelUrl).origin,
    webhookConfigured: Boolean(config.webhookId),
    timeoutMilliseconds: config.timeoutMilliseconds,
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown PayPal configuration error";
  console.error(`PayPal configuration check failed: ${message}`);
  process.exitCode = 1;
}
