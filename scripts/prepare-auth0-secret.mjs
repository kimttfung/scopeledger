import { randomBytes } from "node:crypto";
import {
  chmod,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

const environmentPath = resolve(".env.local");
const content = await readFile(environmentPath, "utf8");
const match = /^AUTH0_SECRET=(.*)$/m.exec(content);
const replaceInvalid = process.argv.includes("--replace-invalid");

if (!match) {
  throw new Error("AUTH0_SECRET is missing from .env.local");
}

if (match[1]) {
  if (!/^[a-f0-9]{64}$/i.test(match[1])) {
    if (!replaceInvalid) {
      throw new Error("Existing AUTH0_SECRET is not a 32-byte hexadecimal value");
    }
    const secret = randomBytes(32).toString("hex");
    const updated = content.replace(/^AUTH0_SECRET=.*$/m, `AUTH0_SECRET=${secret}`);
    await writeFile(environmentPath, updated, { mode: 0o600 });
    await chmod(environmentPath, 0o600);
    console.log("Replaced invalid Auth0 session-secret placeholder in ignored .env.local");
  } else {
    console.log("Auth0 session secret already configured");
  }
} else {
  const secret = randomBytes(32).toString("hex");
  const updated = content.replace(/^AUTH0_SECRET=$/m, `AUTH0_SECRET=${secret}`);
  await writeFile(environmentPath, updated, { mode: 0o600 });
  await chmod(environmentPath, 0o600);
  console.log("Generated Auth0 session secret in ignored .env.local");
}
