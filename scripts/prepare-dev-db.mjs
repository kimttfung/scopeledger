import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(".env.local");
let content = await readFile(path, "utf8");
const replaceInvalid = process.argv.includes("--replace-invalid");
const user = /^DEV_POSTGRES_USER=(.*)$/m.exec(content)?.[1];
const database = /^DEV_POSTGRES_DATABASE=(.*)$/m.exec(content)?.[1];
const current = /^DEV_POSTGRES_PASSWORD=(.*)$/m.exec(content)?.[1] ?? "";

if (!user || !/^[a-z][a-z0-9_]{0,62}$/.test(user)) {
  throw new Error("DEV_POSTGRES_USER is missing or invalid");
}
if (!database || !/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
  throw new Error("DEV_POSTGRES_DATABASE is missing or invalid");
}

let password = current;
if (!/^[a-f0-9]{48}$/.test(password)) {
  if (password && !replaceInvalid) {
    throw new Error("Existing DEV_POSTGRES_PASSWORD is invalid");
  }
  password = randomBytes(24).toString("hex");
  content = content.replace(
    /^DEV_POSTGRES_PASSWORD=.*$/m,
    `DEV_POSTGRES_PASSWORD=${password}`,
  );
}

const url = new URL(`postgresql://127.0.0.1:5433/${database}`);
url.username = user;
url.password = password;
content = content.replace(
  /^SCOPELEDGER_DATABASE_URL=.*$/m,
  `SCOPELEDGER_DATABASE_URL=${url.href}`,
);

await writeFile(path, content, { mode: 0o600 });
await chmod(path, 0o600);
console.log("Prepared ignored local PostgreSQL credentials and connection URL");
