import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = path.join(root, ".env.local");
const defaults = Object.freeze({
  EMAIL_DEMO_PROVIDER_RECIPIENT: "provider@scopeledger.test",
  NOTIFICATION_PROVIDER_ACTOR_ID: "northstar-provider",
  NOTIFICATION_CLIENT_APPROVER_ACTOR_ID: "cedar-approver",
  NOTIFICATION_PAYER_ACTOR_ID: "cedar-payer",
  SCOPELEDGER_EVALUATOR_LIMITS_PROFILE: "local-h1",
  SCOPELEDGER_ANALYSIS_RUN_LIMIT: "3",
  SCOPELEDGER_SOURCE_UPLOAD_COUNT_LIMIT: "5",
  SCOPELEDGER_SOURCE_UPLOAD_BYTES_LIMIT: "25000000",
  SCOPELEDGER_SOURCE_UPLOAD_WINDOW_MINUTES: "60",
  SCOPELEDGER_MODEL_CALL_BUDGET: "2",
});

let content;
try {
  content = await readFile(envPath, "utf8");
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    throw new Error("Create .env.local from .env.example before preparing H1 operations.");
  }
  throw error;
}

for (const [name, value] of Object.entries(defaults)) {
  const expression = new RegExp(`^${name}=(.*)$`, "m");
  const match = expression.exec(content);
  if (!match) {
    content = `${content.trimEnd()}\n${name}=${value}\n`;
  } else if (!match[1]) {
    content = content.replace(expression, `${name}=${value}`);
  }
}

const temporaryPath = `${envPath}.h1-operations.tmp`;
await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, envPath);

console.log("Prepared local H1 notification and evaluator controls.");
