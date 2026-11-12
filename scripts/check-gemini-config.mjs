import { geminiConfigFromEnvironment } from "@scopeledger/gemini-adapter";

try {
  const config = geminiConfigFromEnvironment();
  console.log(JSON.stringify({
    provider: "google-gemini",
    model: config.model,
    timeoutMilliseconds: config.timeoutMilliseconds,
    apiKeyConfigured: true,
  }, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown Gemini configuration error";
  console.error(`Gemini configuration check failed: ${message}`);
  process.exitCode = 1;
}
