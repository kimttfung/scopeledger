import {
  GeminiCandidateClient,
  geminiConfigFromEnvironment,
} from "@scopeledger/gemini-adapter";

try {
  const config = geminiConfigFromEnvironment();
  const client = new GeminiCandidateClient(config);
  console.log(JSON.stringify(await client.checkAuthentication(), null, 2));
} catch (error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  const message = error instanceof Error ? error.message : "Unknown Gemini authentication error";
  console.error(`Gemini authentication check failed [${code}]: ${message}`);
  process.exitCode = 1;
}
