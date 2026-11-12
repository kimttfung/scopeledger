import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const environmentPath = resolve(".env.local");
const content = await readFile(environmentPath, "utf8");
const match = /^ACCESS_SESSION_SECRET=(.*)$/m.exec(content);
const replaceInvalid = process.argv.includes("--replace-invalid");

if (!match) throw new Error("ACCESS_SESSION_SECRET is missing from .env.local");

if (match[1] && /^[a-f0-9]{64}$/i.test(match[1])) {
  console.log("Local access session secret already configured");
} else if (!match[1] || replaceInvalid) {
  const secret = randomBytes(32).toString("hex");
  const updated = content.replace(
    /^ACCESS_SESSION_SECRET=.*$/m,
    `ACCESS_SESSION_SECRET=${secret}`,
  );
  await writeFile(environmentPath, updated, { mode: 0o600 });
  await chmod(environmentPath, 0o600);
  console.log("Generated local access session secret in ignored .env.local");
} else {
  throw new Error("Existing ACCESS_SESSION_SECRET is invalid");
}
